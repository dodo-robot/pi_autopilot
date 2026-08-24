import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { DEFAULT_PI_MODEL, loadRepositoryConfig, resolveRoleModel } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry } from "../config/schema.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import type { ReconciliationReport } from "../reconciliation/reconciliation-service.js";
import { ReconciliationService as ReconciliationServiceImpl } from "../reconciliation/reconciliation-service.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";
import { resolveIssueRef } from "./args.js";

export interface ReconcileCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  createReconciliation?: (deps: {
    repository: RepositoryContext;
    config: AutopilotConfig;
    github: GitHubPort;
    reconcilerModel: ResolvedRoleModel;
    reconcilerTimeoutMs: number;
    analysisId: string;
    now: () => string;
  }) => Pick<ReconciliationServiceImpl, "reconcile">;
  analysisId?: string;
  now?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  isTTY?: boolean;
}

interface ReconcileOptions {
  json?: boolean;
  requirements?: string[];
}

const DEFAULT_REQUIREMENTS_FILE = "requirements.md";
const PATCH_ORDER = [
  "KEEP",
  "ENRICH_ISSUE",
  "CREATE_ISSUE",
  "ADD_DEPENDENCY",
  "REMOVE_DEPENDENCY",
  "MARK_STALE",
  "NEEDS_HUMAN",
] as const;

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * `autopilot reconcile <epic>` — compare an epic's existing issues against
 * requirement docs and the repository, and propose a patch plan. Strictly
 * read-only against GitHub; always dry-run in this milestone.
 */
export function registerReconcileCommand(
  program: Command,
  deps: ReconcileCommandDeps = {},
): void {
  program
    .command("reconcile")
    .description(
      "Reconcile an epic's backlog against requirement docs and the repository, proposing a patch plan (read-only, always dry-run)",
    )
    .argument("<epic>", "epic issue number, or owner/repo#number matching the local origin")
    .option(
      "--requirements <path>",
      "requirement/architecture doc or directory to include (repeatable)",
      collectPath,
      [] as string[],
    )
    .option("--json", "emit the reconciliation report as machine-readable JSON")
    .action(async (epicRef: string, opts: ReconcileOptions) => {
      const stdout =
        deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr =
        deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const reporter =
          opts.json === true ? null : createReporter(stdout, deps.isTTY);
        try {
          const report = await runReconcile(epicRef, opts, deps, reporter);
          if (opts.json === true) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            printHumanReport(report, stdout);
          }
          setExitCode(0);
        } finally {
          reporter?.close();
        }
      } catch (error) {
        stderr(
          `autopilot reconcile: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

async function runReconcile(
  epicRef: string,
  opts: ReconcileOptions,
  deps: ReconcileCommandDeps,
  reporter: Reporter | null,
): Promise<ReconciliationReport> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const { number } = resolveIssueRef(epicRef, ctx);

  const config = await loadRepositoryConfig(ctx.root);
  const github =
    deps.createGitHub !== undefined
      ? await deps.createGitHub(ctx, runner)
      : await GitHubAdapter.create(ctx.root, runner);

  const explicitPaths =
    opts.requirements !== undefined && opts.requirements.length > 0
      ? opts.requirements
      : config.reconciliation.requirementsPaths;
  const requirementDocs =
    explicitPaths !== undefined
      ? readRequirementDocs(ctx.root, explicitPaths)
      : readDefaultRequirementDocs(ctx.root);

  const paths: AppPaths = appPaths(deps.dataDir);
  const reconcilerModel = resolveRoleModel(
    "reconciler",
    null,
    config.agents,
    null,
    deps.piDefaultModel ?? DEFAULT_PI_MODEL,
  );
  const reconcilerTimeoutMs = config.budgets.reconciler.timeoutMinutes * 60_000;

  const analysisId = deps.analysisId ?? `reconcile-${Date.now()}-${number}`;
  const now = deps.now ?? (() => new Date().toISOString());

  const service =
    deps.createReconciliation !== undefined
      ? deps.createReconciliation({
          repository: ctx,
          config,
          github,
          reconcilerModel,
          reconcilerTimeoutMs,
          analysisId,
          now,
        })
      : new ReconciliationServiceImpl({
          repository: ctx,
          config,
          github,
          pi: new PiRunner(runner, deps.piCommand),
          artifacts: new ArtifactStore(paths),
          paths,
          reconcilerModel,
          reconcilerTimeoutMs,
          analysisId: () => analysisId,
          now,
        });

  const repoRef = `${ctx.repository.owner}/${ctx.repository.repo}`;
  reporter?.line(
    `→ reconciling epic #${number} against ${requirementDocs.length} requirement doc(s) (${repoRef})`,
  );
  reporter?.setSpinner(`reconciling epic #${number}`);
  try {
    const report = await service.reconcile(number, requirementDocs);
    reporter?.stopSpinner({
      commit: `reconciliation complete (${report.patches.length} patch${
        report.patches.length === 1 ? "" : "es"
      })`,
    });
    return report;
  } finally {
    reporter?.stopSpinner();
  }
}

/** Expand a configured/explicit requirements entry: a directory contributes
 * its top-level *.md files (sorted); a file contributes itself. Throws if
 * the path does not exist — explicit configuration is never silently
 * skipped. */
function expandDocPath(root: string, relativePath: string): string[] {
  const abs = path.resolve(root, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`requirements path not found: ${relativePath}`);
  }
  if (statSync(abs).isDirectory()) {
    return readdirSync(abs)
      .filter((entry) => entry.endsWith(".md"))
      .sort()
      .map((entry) => path.join(relativePath, entry));
  }
  return [relativePath];
}

function readRequirementDocs(root: string, requestedPaths: string[]): RequirementDoc[] {
  const docs: RequirementDoc[] = [];
  for (const requested of requestedPaths) {
    for (const relative of expandDocPath(root, requested)) {
      docs.push({ path: relative, content: readFileSync(path.resolve(root, relative), "utf8") });
    }
  }
  return docs;
}

/** No explicit `reconciliation.requirementsPaths` or `--requirements` was
 * given: fall back to `requirements.md` at the repository root if it
 * exists, otherwise no requirement documents at all (never an error). */
function readDefaultRequirementDocs(root: string): RequirementDoc[] {
  const abs = path.resolve(root, DEFAULT_REQUIREMENTS_FILE);
  if (!existsSync(abs)) return [];
  return [{ path: DEFAULT_REQUIREMENTS_FILE, content: readFileSync(abs, "utf8") }];
}

function printHumanReport(
  report: ReconciliationReport,
  stdout: (text: string) => void,
): void {
  stdout(`Repository: ${report.repository.owner}/${report.repository.repo}`);
  stdout(`Epic #${report.epicRef}`);

  // An idempotency-downgraded KEEP for an issue that also carries a more
  // specific (non-KEEP) patch is redundant noise — the more specific patch
  // already explains the issue's state, and a bare KEEP next to it would
  // read as a contradiction (e.g. "correct as-is" beside "superseded").
  const issuesWithMoreSpecificPatch = new Set(
    report.patches
      .filter((p) => p.type !== "KEEP" && p.type !== "CREATE_ISSUE")
      .map((p) => p.issue)
      .filter((issue): issue is number => issue !== null),
  );

  for (const type of PATCH_ORDER) {
    let group = report.patches.filter((patch) => patch.type === type);
    if (type === "KEEP") {
      group = group.filter(
        (patch) => !issuesWithMoreSpecificPatch.has((patch as { issue: number }).issue),
      );
    }
    if (group.length === 0) continue;
    stdout("");
    stdout(type);
    for (const patch of group) {
      stdout(`  ${describePatch(patch)} [${patch.policy}]`);
    }
  }

  stdout("");
  stdout("COVERAGE");
  const parts = [`${report.summary.requirementsCovered}/${report.summary.requirementsTotal} requirements covered`];
  if (report.summary.requirementsPartial > 0) parts.push(`${report.summary.requirementsPartial} partial`);
  if (report.summary.requirementsMissing > 0) parts.push(`${report.summary.requirementsMissing} missing`);
  stdout(`  ${parts.join(", ")}`);
  for (const entry of report.coverage.filter((e) => e.status === "missing")) {
    stdout(`  ${entry.requirementId} is currently uncovered`);
  }
  stdout(`Analysis ID: ${report.analysisId}`);
}

function describePatch(patch: ReconciliationReport["patches"][number]): string {
  switch (patch.type) {
    case "KEEP":
    case "ENRICH_ISSUE":
    case "MARK_STALE":
      return `#${patch.issue} — ${patch.reason}`;
    case "CREATE_ISSUE":
      return `${patch.spec.title} — ${patch.reason}`;
    case "ADD_DEPENDENCY":
      return `#${patch.issue} depends on #${patch.dependsOn} — ${patch.reason}`;
    case "REMOVE_DEPENDENCY":
      return `#${patch.issue} no longer depends on #${patch.dependsOn} — ${patch.reason}`;
    case "SPLIT_ISSUE":
      return `#${patch.issue} split into ${patch.children.length} issues — ${patch.reason}`;
    case "NEEDS_HUMAN":
      return `${patch.issue !== null ? `#${patch.issue} — ` : ""}${patch.reason}`;
  }
}
