/**
 * Daemon child process entry point.
 *
 * Spawned detached by `autopilot start`. Writes its own PID file, wires
 * production dependencies, and calls DaemonRunner.run().
 *
 * Accepts configuration via environment variables injected by `start`:
 *   AUTOPILOT_DATA_DIR      — override for the data directory (standard)
 *   AUTOPILOT_DAEMON_CWD   — working directory of the repository to operate on
 */
import { appPaths } from "../platform/paths.js";
import { RunStore } from "../persistence/run-store.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { RunService } from "../workflow/run-service.js";
import { RecoveryService } from "../workflow/recovery-service.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import { resolveRepositoryContext, safeProcessEnv } from "../github/repository-context.js";
import { ProcessRunner } from "../platform/process-runner.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import { PidFile } from "./pid-file.js";
import { QueueStore } from "./queue-store.js";
import { PendingQueueStore } from "./pending-queue-store.js";
import { LogFile } from "./log-file.js";
import { DaemonRunner } from "./daemon-runner.js";

async function main(): Promise<void> {
  const cwd = process.env.AUTOPILOT_DAEMON_CWD ?? process.cwd();
  const paths = appPaths();
  const logFile = new LogFile({ logPath: paths.logPath, daemonDir: paths.daemonDir });
  const pidFile = new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir });

  // Write our own PID (never the parent's)
  pidFile.writePid(process.pid);

  try {
    const processRunner = new ProcessRunner();
    const repository = await resolveRepositoryContext(cwd, processRunner);
    const config = await loadRepositoryConfig(repository.root);
    
    const github = await GitHubAdapter.create(repository.root, processRunner);
    const runStore = new RunStore(paths.dbPath);
    const artifactStore = new ArtifactStore(paths);
    const workspaceManager = new WorkspaceManager({
      processRunner,
      repository,
      policy: config.workspace,
    });

    // Read overrides written by `autopilot start` into the queue file
    const queueStore = new QueueStore({ queuePath: paths.queuePath, daemonDir: paths.daemonDir });
    const pendingQueueStore = new PendingQueueStore({ pendingQueuePath: paths.pendingQueuePath, daemonDir: paths.daemonDir });
    const queue = queueStore.read();
    if (queue === null) {
      logFile.error("daemon-entry: no queue.json found — exiting");
      process.exit(1);
    }

    const runService = new RunService({
      cwd,
      dataDir: paths.dataDir,
      processRunner,
    });

    const recoveryService = new RecoveryService({
      runStore,
      artifacts: artifactStore,
      paths,
      workspaceManager,
      github,
      processRunner,
      repository,
      baseBranch: config.workspace.baseBranch,
      runService,
    });

    const runner = new DaemonRunner({
      pidFile,
      queueStore,
      pendingQueueStore,
      logFile,
      github: {
        addLabel: (number, name) => github.addLabel(number, name),
        removeLabel: (number, name) => github.removeLabel(number, name),
      },
      runService: {
        start: (issueNumber, overrides) => runService.start(issueNumber, overrides),
        resume: (runId, overrides) => runService.resume(runId, overrides),
      },
      recoveryService: {
        reconcile: (runId) => recoveryService.reconcile(runId),
        resume: (runId, overrides) => recoveryService.resume(runId, overrides),
      },
      runStore: {
        listNonterminalRuns: () => runStore.listNonterminalRuns(),
        transition: (id, from, to, ref) => runStore.transition(id, from as any, to as any, ref),
      },
      overrides: queue.overrides ?? {},
    });

    await runner.run();
  } catch (err) {
    logFile.error(`daemon fatal error: ${err instanceof Error ? err.message : String(err)}`);
    pidFile.delete();
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`daemon-entry uncaught: ${err}\n`);
  process.exit(1);
});
