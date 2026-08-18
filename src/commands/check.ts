import { Command } from "commander";
import type { ResolvedRoleModel } from "../config/load-config.js";
import {
  DEFAULT_PI_MODEL,
  loadRepositoryConfig,
  resolveRoleModel,
} from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry, RoleModelOverride } from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import {
  assertRepositoryMatches,
  resolveRepositoryContext,
} from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { ReadinessReport } from "../readiness/readiness-service.js";
import { ReadinessService } from "../readiness/readiness-service.js";

export interface CheckCommandDeps {
  /** Repository root to operate on; defaults to the current working directory. */
  cwd?: string;
  processRunner?: ProcessRunner;
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  /** Override the Pi executable used for refiner sessions. */
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  /** Test seam: construct the GitHub port bound to the resolved repository. */
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  /** Test seam: construct the readiness service from resolved inputs. */
  createReadiness?: (deps: {
    repository: RepositoryContext;
    config: AutopilotConfig;
    github: GitHubPort;
    refinerModel: ResolvedRoleModel;
  }) => Pick<ReadinessService, "check">;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface CheckOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
}

/**
 * `autopilot check <issue>` — assess whether a GitHub issue is ready for
 * autonomous execution. Strictly read-only: the command never mutates
 * GitHub and never creates a workspace.
 */
export function registerCheckCommand(
  program: Command,
  deps: CheckCommandDeps = {},
): void {
  program
    .command("check")
    .description(
      "Assess whether a GitHub issue is ready for autonomous execution (read-only)",
    )
    .argument("<issue>", "issue number, or owner/repo#number matching the local origin")
    .option("--json", "emit a machine-readable readiness report")
    .option("--model <model>", "override the refiner model")
    .option("--thinking <level>", "override the refiner thinking level")
    .action(async (issueRef: string, opts: CheckOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const report = await runCheck(issueRef, opts, deps);
        if (opts.json === true) {
          stdout(JSON.stringify(report, null, 2));
        } else {
          printHumanReport(report, stdout);
        }
        setExitCode(report.status === "READY" ? 0 : 2);
      } catch (error) {
        stderr(
          `autopilot check: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

async function runCheck(
  issueRef: string,
  opts: CheckOptions,
  deps: CheckCommandDeps,
): Promise<ReadinessReport> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const { number } = resolveIssueRef(issueRef, ctx);

  const config = await loadRepositoryConfig(ctx.root);
  const github =
    deps.createGitHub !== undefined
      ? await deps.createGitHub(ctx, runner)
      : await GitHubAdapter.create(ctx.root, runner);

  const paths: AppPaths = appPaths(deps.dataDir);
  const refinerModel = resolveRefinerModel(opts, config, deps.piDefaultModel);
  const readiness =
    deps.createReadiness !== undefined
      ? deps.createReadiness({ repository: ctx, config, github, refinerModel })
      : new ReadinessService({
          repository: ctx,
          config,
          github,
          pi: new PiRunner(runner, deps.piCommand),
          artifacts: new ArtifactStore(paths),
          paths,
          refinerModel,
        });

  return readiness.check(number);
}

function resolveIssueRef(
  issueRef: string,
  ctx: RepositoryContext,
): { number: number } {
  const trimmed = issueRef.trim();
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare !== null) {
    return { number: Number(bare[1]) };
  }
  const qualified = /^([^/]+)\/([^/]+)#(\d+)$/.exec(trimmed);
  if (qualified !== null) {
    assertRepositoryMatches(ctx, {
      owner: qualified[1] ?? "",
      repo: qualified[2] ?? "",
    });
    return { number: Number(qualified[3]) };
  }
  throw new Error(
    `invalid issue reference '${issueRef}' (expected <number> or <owner>/<repo>#<number>)`,
  );
}

function resolveRefinerModel(
  opts: CheckOptions,
  config: AutopilotConfig,
  piDefault: RoleModelEntry | undefined,
): ResolvedRoleModel {
  const override: RoleModelOverride = {};
  if (opts.model !== undefined) {
    override.model = opts.model;
  }
  if (opts.thinking !== undefined) {
    const parsed = ThinkingLevelSchema.safeParse(opts.thinking);
    if (!parsed.success) {
      throw new Error(
        `invalid thinking level '${opts.thinking}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
      );
    }
    override.thinking = parsed.data;
  }
  return resolveRoleModel(
    "refiner",
    override.model !== undefined || override.thinking !== undefined
      ? override
      : null,
    config.agents,
    null,
    piDefault ?? DEFAULT_PI_MODEL,
  );
}

function printHumanReport(
  report: ReadinessReport,
  stdout: (text: string) => void,
): void {
  stdout(
    `Issue: ${report.repository.owner}/${report.repository.repo}#${report.issueNumber}`,
  );
  stdout(`Status: ${report.status}`);
  if (report.status === "READY" && report.snapshot !== null) {
    stdout(`Objective: ${report.snapshot.objective}`);
    stdout(`Acceptance criteria: ${report.snapshot.acceptanceCriteria.length}`);
    return;
  }
  if (report.gaps.length > 0) {
    stdout("Gaps:");
    for (const gap of report.gaps) {
      stdout(`  - [${gap.code}] ${gap.message}`);
      stdout(`    suggestion: ${gap.suggestion}`);
    }
  }
  if (report.ambiguities.length > 0) {
    stdout("Ambiguities:");
    for (const ambiguity of report.ambiguities) {
      stdout(`  - ${ambiguity.type}: ${ambiguity.description}`);
    }
  }
  if (report.missingInformation.length > 0) {
    stdout("Missing information:");
    for (const item of report.missingInformation) stdout(`  - ${item}`);
  }
  if (report.suggestions.length > 0) {
    stdout("Suggestions:");
    for (const item of report.suggestions) stdout(`  - ${item}`);
  }
}
