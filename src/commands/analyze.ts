import { Command } from "commander";
import type { BacklogAnalyst } from "../analysis/backlog-analyst.js";
import { BacklogAnalyst as BacklogAnalystImpl } from "../analysis/backlog-analyst.js";
import { isEpicBody } from "../analysis/issue-set.js";
import type { BacklogReport } from "../domain/backlog.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { loadRepositoryConfig } from "../config/load-config.js";
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
import type { ReadinessService } from "../readiness/readiness-service.js";
import { ReadinessService as ReadinessServiceImpl } from "../readiness/readiness-service.js";
import {
  resolveIssueRefs,
  resolveRefinerModel,
  resolveRefinerTimeout,
} from "./args.js";

export interface AnalyzeCommandDeps {
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
    refinerTimeoutMs: number;
  }) => Pick<ReadinessService, "check">;
  /** Test seam: construct the backlog analyst from resolved inputs. */
  createAnalyst?: (deps: {
    repository: RepositoryContext;
    config: AutopilotConfig;
    github: GitHubPort;
    readiness: Pick<ReadinessService, "check">;
    refinerModel: ResolvedRoleModel;
    refinerTimeoutMs: number;
    analysisId: string;
    now: () => string;
  }) => Pick<BacklogAnalyst, "analyzeIssues">;
  /** Inject the analysis namespace (tests use a deterministic id). */
  analysisId?: string;
  /** Inject the clock for `generatedAt`. */
  now?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface AnalyzeOptions {
  json?: boolean;
  deep?: boolean;
  model?: string;
  thinking?: string;
  refinerTimeout?: number;
  minReady?: string;
}

/**
 * `autopilot analyze <ref> [moreRefs...]` — analyze an epic or an explicit
 * issue set for backlog readiness. Strictly read-only: never mutates GitHub.
 */
export function registerAnalyzeCommand(
  program: Command,
  deps: AnalyzeCommandDeps = {},
): void {
  program
    .command("analyze")
    .description(
      "Analyze an epic (or explicit issue set) for backlog readiness (read-only)",
    )
    .argument("<ref>", "issue/epic number, or owner/repo#number matching the local origin")
    .argument("[moreRefs...]", "additional issue references in an explicit set")
    .option("--json", "emit the backlog report as machine-readable JSON")
    .option("--deep", "run a full refiner session and readiness gate on every issue")
    .option("--model <model>", "override the refiner model")
    .option("--thinking <level>", "override the refiner thinking level")
    .option("--refiner-timeout <minutes>", "override the refiner session timeout in minutes")
    .option("--min-ready <n>", "require at least this many READY issues; exit non-zero otherwise")
    .action(
      async (ref: string, moreRefs: string[], opts: AnalyzeOptions) => {
        const stdout =
          deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
        const stderr =
          deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
        const setExitCode = deps.setExitCode ?? ((code: number) => {
          process.exitCode = code;
        });
        try {
          const report = await runAnalyze(ref, moreRefs, opts, deps);
          if (opts.json === true) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            printHumanReport(report, stdout);
          }
          const minReady =
            opts.minReady !== undefined ? Number(opts.minReady) : undefined;
          setExitCode(exitCodeFor(report, minReady));
        } catch (error) {
          stderr(
            `autopilot analyze: ${error instanceof Error ? error.message : String(error)}`,
          );
          setExitCode(1);
        }
      },
    );
}

function exitCodeFor(report: BacklogReport, minReady: number | undefined): number {
  if (minReady !== undefined && report.executable.length < minReady) {
    return 2;
  }
  if (report.summary.needsRefinement > 0 || report.executable.length === 0) {
    return 2;
  }
  return 0;
}

async function runAnalyze(
  ref: string,
  moreRefs: string[],
  opts: AnalyzeOptions,
  deps: AnalyzeCommandDeps,
): Promise<BacklogReport> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);

  const config = await loadRepositoryConfig(ctx.root);
  const github =
    deps.createGitHub !== undefined
      ? await deps.createGitHub(ctx, runner)
      : await GitHubAdapter.create(ctx.root, runner);

  const paths: AppPaths = appPaths(deps.dataDir);
  const refinerModel = resolveRefinerModel(
    {
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.thinking === undefined ? {} : { thinking: opts.thinking }),
    },
    config,
    deps.piDefaultModel,
  );
  const refinerTimeoutMs = resolveRefinerTimeout(opts.refinerTimeout, config);

  const readiness =
    deps.createReadiness !== undefined
      ? deps.createReadiness({ repository: ctx, config, github, refinerModel, refinerTimeoutMs })
      : new ReadinessServiceImpl({
          repository: ctx,
          config,
          github,
          pi: new PiRunner(runner, deps.piCommand),
          artifacts: new ArtifactStore(paths),
          paths,
          refinerModel,
          refinerTimeoutMs,
        });

  const analysisId = deps.analysisId ?? `analyze-${Date.now()}`;
  const now = deps.now ?? (() => new Date().toISOString());

  const analyst =
    deps.createAnalyst !== undefined
      ? deps.createAnalyst({
          repository: ctx,
          config,
          github,
          readiness,
          refinerModel,
          refinerTimeoutMs,
          analysisId,
          now,
        })
      : new BacklogAnalystImpl({
          repository: ctx,
          config,
          github,
          readiness,
          artifacts: new ArtifactStore(paths),
          paths,
          refinerModel,
          refinerTimeoutMs,
          analysisId,
          now,
        });

  // Epic-vs-explicit-set decision: a single bare ref whose body parses as an
  // epic is analyzed as an epic (its checklist refs are merged); every other
  // input is treated as an explicit set.
  const numbers = resolveIssueRefs([ref, ...moreRefs], ctx);

  let epicRef: number | null = null;
  let requestedRefs: number[] = numbers;
  if (moreRefs.length === 0 && numbers.length === 1) {
    const single = numbers[0]!;
    const issue = await github.getIssue(single);
    if (isEpicBody(issue.body)) {
      epicRef = single;
      // The analyst discovers the epic's checklist children from the epic
      // body and merges them itself; the epic container is not a leaf task.
      requestedRefs = [];
    }
  }

  const report = await analyst.analyzeIssues({
    epicRef,
    requestedRefs,
    deep: opts.deep === true,
  });
  return report;
}

function printHumanReport(
  report: BacklogReport,
  stdout: (text: string) => void,
): void {
  stdout(`Repository: ${report.repository.owner}/${report.repository.repo}`);
  for (const issue of report.issues) {
    stdout(
      `[${issue.classification}] #${issue.issueNumber} ${issue.title} (${issue.url})`,
    );
  }
  stdout(`Executable: ${report.executable.length > 0 ? report.executable.join(", ") : "(none)"}`);
  stdout(`Needs work: ${report.needsWork.length > 0 ? report.needsWork.join(", ") : "(none)"}`);
  stdout(
    `Summary: ${report.summary.ready} ready, ${report.summary.needsRefinement} needsRefinement, ` +
      `${report.summary.blocked} blocked, ${report.summary.ambiguous} ambiguous, ` +
      `${report.summary.skipped} skipped, ${report.summary.unresolved} unresolved`,
  );
  stdout(`Refiner sessions: ${report.refinerSessions}`);
  stdout(`Analysis ID: ${report.analysisId}`);
}
