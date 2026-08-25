import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DEFAULT_PI_MODEL, loadRepositoryConfig, resolveRoleModel } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry, RoleModelOverride } from "../config/schema.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import { ProjectsAdapter } from "../github/projects-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner, PiRunError } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import { ApplyService } from "../bootstrap/apply-service.js";
import type { ExtendedGitHubPort } from "../bootstrap/apply-service.js";
import { BootstrapService, BootstrapSizeError } from "../bootstrap/bootstrap-service.js";
import { PlanStore } from "../bootstrap/plan-store.js";

export interface BootstrapCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  isTTY?: boolean;
  /** Test seam: override the full plan phase. */
  planFn?: (docs: RequirementDoc[]) => Promise<{ planId: string; markdownPath: string }>;
  /** Test seam: override the full apply phase. */
  applyFn?: (planId: string) => Promise<void>;
}

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const DEFAULT_REQUIREMENTS_FILE = "requirements.md";
const DEFAULT_REQUIREMENTS_DIR = "requirements";

export function registerBootstrapCommand(
  program: Command,
  deps: BootstrapCommandDeps = {},
): void {
  program
    .command("bootstrap")
    .description("Seed a GitHub project backlog from requirement documents")
    .option("--plan", "analyse requirement docs and produce a bootstrap plan")
    .option("--apply <plan-id>", "apply a saved bootstrap plan to GitHub")
    .option(
      "--requirements <path>",
      "requirement doc or directory (repeatable)",
      collectPath,
      [] as string[],
    )
    .option("--out <dir>", "output directory for plan files")
    .option(
      "--bootstrap-timeout <minutes>",
      "override the bootstrapper session timeout in minutes (default: from bootstrap.timeoutMinutes or 90)",
    )
    .option(
      "--bootstrapper-model <model>",
      "override the bootstrapper model (highest precedence; overrides agents.bootstrapper in .pi/autopilot.yaml)",
    )
    .option("--json", "emit machine-readable output")
    .action(async (opts: { plan?: boolean; apply?: string; requirements: string[]; out?: string; bootstrapTimeout?: number; bootstrapperModel?: string; json?: boolean }) => {
      const stdout = deps.stdout ?? ((t) => process.stdout.write(`${t}\n`));
      const stderr = deps.stderr ?? ((t) => process.stderr.write(`${t}\n`));
      const setExitCode = deps.setExitCode ?? ((code) => { process.exitCode = code; });

      if (!opts.plan && !opts.apply) {
        stderr("autopilot bootstrap: must provide --plan or --apply <plan-id>");
        setExitCode(1);
        return;
      }

      try {
        if (opts.plan) {
          const docs = await resolveRequirementDocs(opts.requirements, deps.cwd ?? process.cwd());
          const result = deps.planFn
            ? await deps.planFn(docs)
            : await runPlan(docs, opts, deps);
          stdout(`Plan ID: ${result.planId}`);
          stdout(`Preview: ${result.markdownPath}`);
          stdout(`\nTo apply: autopilot bootstrap --apply ${result.planId}`);
          setExitCode(0);
        } else if (opts.apply) {
          if (deps.applyFn) {
            await deps.applyFn(opts.apply);
          } else {
            await runApply(opts.apply, deps, stdout);
          }
          setExitCode(0);
        }
      } catch (error) {
        if (error instanceof BootstrapSizeError) {
          stderr(error.message);
          setExitCode(2);
        } else if (error instanceof PiRunError) {
          stderr(`autopilot bootstrap: ${error.message}`);
          const diag = error.diagnostics;
          if (diag.stderr) stderr(diag.stderr.slice(0, 2000));
          setExitCode(1);
        } else {
          stderr(`autopilot bootstrap: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof Error && error.cause) {
            const cause = error.cause;
            stderr(`caused by: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
          setExitCode(1);
        }
      }
    });
}

async function runPlan(
  docs: RequirementDoc[],
  opts: { out?: string; bootstrapTimeout?: number; bootstrapperModel?: string },
  deps: BootstrapCommandDeps,
): Promise<{ planId: string; markdownPath: string }> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const cwd = deps.cwd ?? process.cwd();
  const ctx = await resolveRepositoryContext(cwd, runner);
  const config = await loadConfigOrDefault(ctx.root);
  const paths = appPaths(deps.dataDir ?? opts.out);
  const artifacts = new ArtifactStore(paths);
  // CLI --bootstrapper-model overrides everything (highest precedence), matching
  // how resolveRoleModel treats a CLI override above repo/user config.
  const cliOverride: RoleModelOverride | null = opts.bootstrapperModel !== undefined
    ? { model: opts.bootstrapperModel }
    : null;
  const bootstrapperModel = resolveRoleModel(
    "bootstrapper",
    cliOverride,
    config.agents,
    null,
    deps.piDefaultModel ?? DEFAULT_PI_MODEL,
  );
  const hasExistingConfig = existsSync(path.join(ctx.root, ".pi", "autopilot.yaml"));
  // Timeout precedence: CLI flag > bootstrap.timeoutMinutes config > 90 default.
  const configuredTimeout =
    (config as { bootstrap?: { timeoutMinutes?: number } }).bootstrap?.timeoutMinutes ?? 90;
  const bootstrapperTimeoutMs = (opts.bootstrapTimeout ?? configuredTimeout) * 60_000;
  const service = new BootstrapService({
    repository: ctx,
    config,
    pi: new PiRunner(runner, deps.piCommand),
    artifacts,
    paths,
    bootstrapperModel,
    hasExistingConfig,
    bootstrapperTimeoutMs,
  });
  return service.plan(docs);
}

async function runApply(
  planId: string,
  deps: BootstrapCommandDeps,
  stdout: (msg: string) => void,
): Promise<void> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const cwd = deps.cwd ?? process.cwd();
  const ctx = await resolveRepositoryContext(cwd, runner);
  const paths = appPaths(deps.dataDir);
  const artifacts = new ArtifactStore(paths);
  const store = new PlanStore(artifacts);
  const github = await GitHubAdapter.create(ctx.root, runner);
  const projects = await ProjectsAdapter.create(ctx.root, runner);
  const service = new ApplyService({
    planStore: store,
    github: github as ExtendedGitHubPort,
    projects,
    repositoryRoot: ctx.root,
    stdout,
  });
  await service.apply(planId);
}

async function loadConfigOrDefault(root: string): Promise<AutopilotConfig> {
  try {
    return await loadRepositoryConfig(root);
  } catch {
    // No config yet — bootstrap is the first thing this repo runs
    const { AutopilotConfigSchema } = await import("../config/schema.js");
    return AutopilotConfigSchema.parse({
      version: 1,
      commands: { verify: ["npm test"] },
    });
  }
}

async function resolveRequirementDocs(
  requested: string[],
  cwd: string,
): Promise<RequirementDoc[]> {
  if (requested.length > 0) {
    return readDocPaths(cwd, requested);
  }
  // Fallback: requirements/ directory, then requirements.md
  const dir = path.join(cwd, DEFAULT_REQUIREMENTS_DIR);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return readDocPaths(cwd, files.map((f) => path.join(DEFAULT_REQUIREMENTS_DIR, f)));
  }
  const file = path.join(cwd, DEFAULT_REQUIREMENTS_FILE);
  if (existsSync(file)) {
    return [{ path: DEFAULT_REQUIREMENTS_FILE, content: readFileSync(file, "utf8") }];
  }
  return [];
}

function readDocPaths(cwd: string, paths: string[]): RequirementDoc[] {
  return paths.map((p) => ({
    path: p,
    content: readFileSync(path.resolve(cwd, p), "utf8"),
  }));
}
