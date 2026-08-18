import { Command } from "commander";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { RoleModelOverride } from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { RunStore } from "../persistence/run-store.js";
import { appPaths } from "../platform/paths.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { RecoveryService } from "../workflow/recovery-service.js";
import type { RunOverrides, RunServiceDeps, RunSummary } from "../workflow/run-service.js";
import { RunService } from "../workflow/run-service.js";

export interface ResumeCommandDeps extends RunServiceDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface ResumeOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
}

function exitCodeFor(summary: RunSummary): number {
  if (summary.stage === "PR_OPEN") return 0;
  if (summary.stage === "NEEDS_REFINEMENT" || summary.stage === "BLOCKED") return 2;
  return 1;
}

function resolveOverrides(opts: ResumeOptions): RunOverrides {
  const override: RoleModelOverride = {};
  if (opts.model !== undefined) override.model = opts.model;
  if (opts.thinking !== undefined) {
    const parsed = ThinkingLevelSchema.safeParse(opts.thinking);
    if (!parsed.success) {
      throw new Error(
        `invalid thinking level '${opts.thinking}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
      );
    }
    override.thinking = parsed.data;
  }
  if (override.model === undefined && override.thinking === undefined) return {};
  return { implementer: override, reviewer: override };
}

/**
 * `autopilot resume <run-id>` — continue a `BLOCKED` run with one fresh,
 * transcript-free correction attempt in its preserved workspace. Requires
 * the run to be currently `BLOCKED`; every other stage (including every
 * terminal stage) is rejected. Routes through `RecoveryService.resume`
 * (which re-validates BLOCKED and then delegates to `RunService.resume`),
 * consistent with `abandon.ts` routing through `RecoveryService.abandon` —
 * `RecoveryService` is the single coordination point for both operator
 * recovery actions.
 */
export function registerResumeCommand(
  program: Command,
  deps: ResumeCommandDeps = {},
): void {
  program
    .command("resume")
    .description("Resume a BLOCKED run with a fresh correction attempt")
    .argument("<run-id>", "run id")
    .option("--json", "emit a machine-readable run summary")
    .option("--model <model>", "override the model for the resumed attempt")
    .option("--thinking <level>", "override the thinking level for the resumed attempt")
    .action(async (runId: string, opts: ResumeOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      const paths = appPaths(deps.dataDir);
      const runStore = new RunStore(paths.dbPath);
      try {
        const overrides = resolveOverrides(opts);
        const runner = deps.processRunner ?? new ProcessRunnerImpl();
        const ctx =
          deps.createRepositoryContext !== undefined
            ? await deps.createRepositoryContext(deps.cwd ?? process.cwd(), runner)
            : await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
        const config = await loadRepositoryConfig(ctx.root);
        const github =
          deps.createGitHub !== undefined
            ? await deps.createGitHub(ctx, runner)
            : await GitHubAdapter.create(ctx.root, runner);

        const runService = new RunService(deps);
        const service = new RecoveryService({
          runStore,
          artifacts: new ArtifactStore(paths),
          paths,
          workspaceManager: new WorkspaceManager({
            processRunner: runner,
            repository: ctx,
            policy: config.workspace,
          }),
          github,
          processRunner: runner,
          repository: ctx,
          baseBranch: config.workspace.baseBranch,
          runService,
        });
        const summary = await service.resume(runId, overrides);
        if (opts.json === true) {
          stdout(JSON.stringify(summary, null, 2));
        } else {
          printHumanSummary(summary, stdout);
        }
        setExitCode(exitCodeFor(summary));
      } catch (error) {
        stderr(
          `autopilot resume: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      } finally {
        runStore.close();
      }
    });
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
