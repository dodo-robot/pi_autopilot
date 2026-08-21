import type { RunOverrides, RunSummary } from "../workflow/run-service.js";
import type { PidFile } from "./pid-file.js";
import type { QueueStore, CompletedRun } from "./queue-store.js";
import type { LogFile } from "./log-file.js";

export interface DaemonRunnerDeps {
  pidFile: Pick<PidFile, "writePid" | "delete">;
  queueStore: Pick<QueueStore, "read" | "write">;
  logFile: Pick<LogFile, "info" | "error">;
  runService: {
    start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
    resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
  };
  recoveryService: {
    reconcile(runId: string): Promise<{ runId: string; stage: string; actions: unknown[] }>;
    resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
  };
  runStore: {
    listNonterminalRuns(): Array<{ id: string; issueNumber: number; stage: string }>;
    transition(runId: string, from: string, to: string, evidenceRef: string | null): void;
  };
  overrides: RunOverrides;
  registerSignalHandler?: (signal: string, handler: () => void) => void;
  exit?: (code: number) => void;
}

export class DaemonRunner {
  private stopRequested = false;
  private readonly deps: DaemonRunnerDeps;

  constructor(deps: DaemonRunnerDeps) {
    this.deps = deps;
  }

  async run(): Promise<void> {
    const { pidFile, queueStore, logFile, runStore, recoveryService, runService, overrides } =
      this.deps;
    const registerSignal =
      this.deps.registerSignalHandler ??
      ((sig: string, handler: () => void) => process.on(sig, handler));
    const exit = this.deps.exit ?? ((code: number) => process.exit(code));

    registerSignal("SIGTERM", () => {
      logFile.info("SIGTERM received — finishing current stage");
      this.stopRequested = true;
    });
    registerSignal("SIGINT", () => {
      logFile.info("SIGINT received — finishing current stage");
      this.stopRequested = true;
    });

    const queue = queueStore.read();
    if (queue === null) {
      logFile.error("no queue found — exiting");
      exit(1);
      return;
    }

    logFile.info(
      `daemon started pid=${process.pid} queue=[${queue.issues.join(",")}]`,
    );

    // --- Crash reconciliation ---
    const nonterminal = runStore.listNonterminalRuns();
    for (const run of nonterminal) {
      logFile.info(`reconciliation: found interrupted run ${run.id} issue=${run.issueNumber}`);
      try {
        const summary = await recoveryService.resume(run.id, overrides);
        logFile.info(
          `reconciliation: resumed run ${run.id} → outcome=${summary.stage}`,
        );
      } catch (err) {
        logFile.error(
          `reconciliation: resume failed for ${run.id} — marking FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          runStore.transition(run.id, run.stage, "FAILED", null);
        } catch {
          // best-effort
        }
      }
    }
    if (nonterminal.length === 0) {
      logFile.info("reconciliation: no interrupted runs found");
    }

    // --- Main queue loop ---
    while (queue.currentIndex < queue.issues.length && !this.stopRequested) {
      const issueNumber = queue.issues[queue.currentIndex]!;
      logFile.info(`starting run issue=${issueNumber}`);

      let summary: RunSummary;
      try {
        summary = await runService.start(issueNumber, overrides);
      } catch (err) {
        logFile.error(
          `run failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary = {
          runId: `failed-${issueNumber}`,
          stage: "FAILED",
          repository: queue.repository,
          issueNumber,
          publication: null,
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      logFile.info(`run complete issue=${issueNumber} outcome=${summary.stage}`);

      const completed: CompletedRun = {
        issueNumber,
        outcome: summary.stage as CompletedRun["outcome"],
        completedAt: new Date().toISOString(),
        runId: summary.runId,
      };
      queue.completedRuns.push(completed);
      queue.currentIndex += 1;
      queueStore.write(queue);
    }

    if (this.stopRequested) {
      logFile.info("daemon exiting cleanly after stage boundary");
    } else {
      logFile.info(
        `queue exhausted — ${queue.completedRuns.length} run(s) completed`,
      );
    }

    pidFile.delete();
    exit(0);
  }
}
