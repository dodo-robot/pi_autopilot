import { Command } from "commander";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { RunStore } from "../persistence/run-store.js";
import { appPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { RecoveryService } from "../workflow/recovery-service.js";

export interface AbandonCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  /** Test seam: resolve the repository context (tests use a fixture repo). */
  createRepositoryContext?: (
    cwd: string,
    runner: ProcessRunner,
  ) => Promise<RepositoryContext>;
  /** Test seam: construct the GitHub port bound to the resolved repository. */
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface AbandonOptions {
  json?: boolean;
}

/**
 * `autopilot abandon <run-id>` — mark a nonterminal run `CANCELLED` via a
 * compare-and-set transition. Never deletes the run's worktree or branch;
 * they remain in place for diagnosis, exactly like a blocked/failed run.
 */
export function registerAbandonCommand(
  program: Command,
  deps: AbandonCommandDeps = {},
): void {
  program
    .command("abandon")
    .description("Mark a run CANCELLED without deleting its worktree or branch")
    .argument("<run-id>", "run id")
    .option("--json", "emit a machine-readable result")
    .action(async (runId: string, opts: AbandonOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      const paths = appPaths(deps.dataDir);
      const runStore = new RunStore(paths.dbPath);
      try {
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
        });

        const run = await service.abandon(runId);
        if (opts.json === true) {
          stdout(JSON.stringify(run, null, 2));
        } else {
          stdout(`Run: ${run.id}`);
          stdout(`Stage: ${run.stage}`);
        }
        setExitCode(0);
      } catch (error) {
        stderr(
          `autopilot abandon: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      } finally {
        runStore.close();
      }
    });
}
