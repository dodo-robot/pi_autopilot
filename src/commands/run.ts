import { Command } from "commander";
import type { RoleModelEntry, RoleModelOverride } from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { TaskSnapshot } from "../domain/contracts.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { assertRepositoryMatches } from "../github/repository-context.js";
import { appPaths } from "../platform/paths.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { RunStore } from "../persistence/run-store.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import type { RunOverrides, RunSummary } from "../workflow/run-service.js";
import { RunService } from "../workflow/run-service.js";
import type { RunServiceDeps } from "../workflow/run-service.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";

export interface RunCommandDeps extends RunServiceDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  /** Override terminal detection (tests simulate a pegged TTY). */
  isTTY?: boolean;
}

interface RunOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
  refinerModel?: string;
  refinerThinking?: string;
  implementerModel?: string;
  implementerThinking?: string;
  reviewerModel?: string;
  reviewerThinking?: string;
  /** Discard any existing worktree/run record for this issue and start clean. */
  fresh?: boolean;
}

/**
 * `autopilot run <issue>` — run one GitHub issue end to end through
 * bounded implementation, verification, review, and publication in an
 * isolated workspace. Exit code `0` only for `PR_OPEN`, `2` for
 * `NEEDS_REFINEMENT`/`BLOCKED`, and `1` for any other failure.
 */
export function registerRunCommand(program: Command, deps: RunCommandDeps = {}): void {
  program
    .command("run")
    .description(
      "Run a GitHub issue end to end through bounded implementation, verification, review, and publication",
    )
    .argument("<issue>", "issue number, or owner/repo#number matching the local origin")
    .option("--json", "emit a machine-readable run summary")
    .option("--model <model>", "override the model for every role")
    .option("--thinking <level>", "override the thinking level for every role")
    .option("--refiner-model <model>", "override the refiner model")
    .option("--refiner-thinking <level>", "override the refiner thinking level")
    .option("--implementer-model <model>", "override the implementer model")
    .option("--implementer-thinking <level>", "override the implementer thinking level")
    .option("--reviewer-model <model>", "override the reviewer model")
    .option("--reviewer-thinking <level>", "override the reviewer thinking level")
    .option("--fresh", "discard any existing worktree/run for this issue and start clean")
    .action(async (issueRef: string, opts: RunOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      // Interactive progress is silent in --json mode so stdout stays pure JSON.
      const reporter =
        opts.json === true ? null : createReporter(stdout, deps.isTTY);
      try {
        const summary = await runIssue(issueRef, opts, deps, reporter);
        if (opts.json === true) {
          stdout(JSON.stringify(summary, null, 2));
        } else {
          printHumanSummary(summary, stdout);
        }
        setExitCode(exitCodeFor(summary));
      } catch (error) {
        stderr(`autopilot run: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(1);
      } finally {
        reporter?.close();
      }
    });
}

function exitCodeFor(summary: RunSummary): number {
  if (summary.stage === "PR_OPEN") return 0;
  if (summary.stage === "NEEDS_REFINEMENT" || summary.stage === "BLOCKED") return 2;
  return 1;
}

async function runIssue(
  issueRef: string,
  opts: RunOptions,
  deps: RunCommandDeps,
  reporter: Reporter | null,
): Promise<RunSummary> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx =
    deps.createRepositoryContext !== undefined
      ? await deps.createRepositoryContext(deps.cwd ?? process.cwd(), runner)
      : await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const { number } = resolveIssueRef(issueRef, ctx);

  if (opts.fresh === true) {
    await discardExistingRun(ctx, number, deps, runner);
  }

  const overrides = resolveOverrides(opts);
  const service = new RunService({
    ...deps,
    ...(reporter === null ? {} : { onProgress: (text: string) => reporter.line(text) }),
  });
  const ref = `${ctx.repository.owner}/${ctx.repository.repo}#${number}`;
  reporter?.line(`→ running issue ${ref}`);
  reporter?.setSpinner(`orchestrating pipeline for ${ref}`);
  const summary = await service.start(number, overrides);
  reporter?.stopSpinner({ commit: `run completed (${summary.stage})` });

  if (opts.json !== true && reporter !== null) {
    printTransitions(deps, summary.runId, (text) => reporter.line(text));
  }
  return summary;
}

/**
 * `--fresh` pre-step: drop the most recent run record for this issue and
 * discard its worktree/branch so a clean run can start. No-op when there is
 * no prior run. FAILED is terminal, so this intentionally uses
 * `getMostRecentRunForIssue` (any stage) rather than `getActiveRunForIssue`.
 */
async function discardExistingRun(
  ctx: RepositoryContext,
  issueNumber: number,
  deps: RunCommandDeps,
  runner: ProcessRunner,
): Promise<void> {
  const paths = appPaths(deps.dataDir);
  const runStore = new RunStore(paths.dbPath);
  try {
    const run = runStore.getMostRecentRunForIssue(
      ctx.repository.owner,
      ctx.repository.repo,
      issueNumber,
    );
    if (run === null) return;

    const config = await loadRepositoryConfig(ctx.root);
    const artifacts = new ArtifactStore(paths);
    let title = "";
    if (run.taskSnapshotRef !== null) {
      try {
        const snapshot = await artifacts.readJson<TaskSnapshot>(
          run.id,
          run.taskSnapshotRef,
        );
        title = snapshot.objective ?? "";
      } catch {
        // Snapshot artifact missing is fine: fall back to the issue-only branch.
      }
    }

    const workspaceManager = new WorkspaceManager({
      processRunner: runner,
      repository: ctx,
      policy: config.workspace,
    });
    const workspace = workspaceManager.locate({
      runId: run.id,
      issueNumber,
      title,
      baseBranch: config.workspace.baseBranch,
    });
    // Guarantee the run record is dropped even if discarding the worktree
    // throws (e.g. a git worktree remove fails). Otherwise the record would
    // be orphaned with no worktree to locate, and a repeat `--fresh` could
    // get stuck trying to discard a workspace that no longer exists.
    try {
      await workspaceManager.discard(workspace);
    } finally {
      runStore.dropRun(run.id);
    }
  } finally {
    runStore.close();
  }
}

/** Print the persisted stage transitions for this run, in order. */
function printTransitions(
  deps: RunCommandDeps,
  runId: string,
  stdout: (text: string) => void,
): void {
  const paths = appPaths(deps.dataDir);
  const store = new RunStore(paths.dbPath);
  try {
    for (const transition of store.transitions(runId)) {
      stdout(`  ${transition.from} -> ${transition.to}`);
    }
  } finally {
    store.close();
  }
}

function printHumanSummary(summary: RunSummary, stdout: (text: string) => void): void {
  stdout(
    `Issue: ${summary.repository.owner}/${summary.repository.repo}#${String(summary.issueNumber)}`,
  );
  stdout(`Run: ${summary.runId}`);
  stdout(`Stage: ${summary.stage}`);
  if (summary.reason !== null) {
    stdout(`Reason: ${summary.reason}`);
  }
  if (summary.publication !== null) {
    stdout(`Pull request: ${summary.publication.pullRequest.url}`);
  }
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

function resolveOverrides(opts: RunOptions): RunOverrides {
  const globalOverride: RoleModelOverride = {};
  if (opts.model !== undefined) globalOverride.model = opts.model;
  if (opts.thinking !== undefined) globalOverride.thinking = parseThinking(opts.thinking);

  const overrides: RunOverrides = {};
  const refiner = mergeOverride(globalOverride, opts.refinerModel, opts.refinerThinking);
  const implementer = mergeOverride(globalOverride, opts.implementerModel, opts.implementerThinking);
  const reviewer = mergeOverride(globalOverride, opts.reviewerModel, opts.reviewerThinking);
  if (refiner !== undefined) overrides.refiner = refiner;
  if (implementer !== undefined) overrides.implementer = implementer;
  if (reviewer !== undefined) overrides.reviewer = reviewer;
  return overrides;
}

function mergeOverride(
  base: RoleModelOverride,
  model: string | undefined,
  thinking: string | undefined,
): RoleModelOverride | undefined {
  const override: RoleModelOverride = { ...base };
  if (model !== undefined) override.model = model;
  if (thinking !== undefined) override.thinking = parseThinking(thinking);
  return override.model !== undefined || override.thinking !== undefined ? override : undefined;
}

function parseThinking(value: string): RoleModelEntry["thinking"] {
  const parsed = ThinkingLevelSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid thinking level '${value}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
    );
  }
  return parsed.data;
}
