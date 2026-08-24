import type { RunOverrides, RunSummary } from "../workflow/run-service.js";
import type { PidFile } from "./pid-file.js";
import type { QueueStore, CompletedRun, DaemonQueue } from "./queue-store.js";
import type { LogFile } from "./log-file.js";
import type { PendingQueueStore } from "./pending-queue-store.js";
import { AGENT_READY_LABEL, AGENT_IN_PROGRESS_LABEL } from "../analysis/label-reconciliation.js";
import { UNKNOWN_WORKSPACE_SCOPE } from "../scheduler/state.js";
import {
  findStartableIssue,
  refreshConflictStates,
  markIssueRunning,
  completeIssue,
  toCompletedRun,
} from "../scheduler/scheduler.js";

export interface SchedulerExecutor {
  start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
}

export interface DaemonRunnerDeps {
  pidFile: Pick<PidFile, "writePid" | "delete">;
  queueStore: Pick<QueueStore, "read" | "write">;
  pendingQueueStore: Pick<PendingQueueStore, "drainAll">;
  logFile: Pick<LogFile, "info" | "error">;
  github: {
    addLabel(number: number, name: string): Promise<void>;
    removeLabel(number: number, name: string): Promise<void>;
  };
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

  private async claim(issueNumber: number): Promise<void> {
    try {
      await this.deps.github.removeLabel(issueNumber, AGENT_READY_LABEL);
      await this.deps.github.addLabel(issueNumber, AGENT_IN_PROGRESS_LABEL);
    } catch (err) {
      this.deps.logFile.error(
        `claim label update failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async release(issueNumber: number, stage: string): Promise<void> {
    try {
      if (stage === "PR_OPEN") {
        await this.deps.github.removeLabel(issueNumber, AGENT_IN_PROGRESS_LABEL);
      } else if (stage === "NEEDS_REFINEMENT") {
        await this.deps.github.removeLabel(issueNumber, AGENT_IN_PROGRESS_LABEL);
        await this.deps.github.removeLabel(issueNumber, AGENT_READY_LABEL);
      }
      // BLOCKED / FAILED: no-op — agent:in-progress stays as a "needs a human" signal.
    } catch (err) {
      this.deps.logFile.error(
        `release label update failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private mergePending(queue: DaemonQueue): void {
    const pending = this.deps.pendingQueueStore.drainAll();
    if (pending.length === 0) return;
    const existing = new Set(queue.issues);
    const toAdd = pending.filter((n) => !existing.has(n));
    if (toAdd.length === 0) return;
    queue.issues.push(...toAdd);
    if (queue.scheduler !== undefined) {
      queue.scheduler = {
        ...queue.scheduler,
        issues: [
          ...queue.scheduler.issues,
          ...toAdd.map((issueNumber) => ({
            issueNumber,
            state: "PENDING" as const,
            dependencies: [],
            workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
            reason: "pending queue entry",
            runId: null,
            outcome: null,
          })),
        ],
        lastUpdatedAt: new Date().toISOString(),
      };
    }
    this.deps.queueStore.write(queue);
    this.deps.logFile.info(`merged ${toAdd.length} pending issue(s): [${toAdd.join(",")}]`);
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

    this.mergePending(queue);

    if (queue.scheduler === undefined) {
      await this.runSequentialQueue(queue);
    } else {
      await this.runSchedulerQueue(queue);
    }

    pidFile.delete();
    exit(0);
  }

  private async runSequentialQueue(queue: DaemonQueue): Promise<void> {
    const { queueStore, logFile, runService, overrides } = this.deps;

    // --- Main queue loop ---
    while (queue.currentIndex < queue.issues.length && !this.stopRequested) {
      const issueNumber = queue.issues[queue.currentIndex]!;
      logFile.info(`starting run issue=${issueNumber}`);

      await this.claim(issueNumber);

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

      await this.release(issueNumber, summary.stage);

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
      this.mergePending(queue);
    }

    if (this.stopRequested) {
      logFile.info("daemon exiting cleanly after stage boundary");
    } else {
      logFile.info(
        `queue exhausted — ${queue.completedRuns.length} run(s) completed`,
      );
    }
  }

  private async runSchedulerQueue(queue: DaemonQueue): Promise<void> {
    const active = new Set<Promise<void>>();

    const launchAvailable = (): void => {
      for (;;) {
        if (queue.scheduler === undefined) return;
        if (active.size >= queue.scheduler.policy.maxConcurrentRuns) return;
        queue.scheduler = refreshConflictStates(queue.scheduler);
        this.deps.queueStore.write(queue);
        const candidate = findStartableIssue(queue.scheduler, new Date().toISOString());
        if (candidate === null) return;
        const startedAt = new Date().toISOString();
        queue.scheduler = markIssueRunning(queue.scheduler, candidate.issueNumber, null, startedAt);
        this.deps.queueStore.write(queue);
        const promise = this.runOneScheduledIssue(queue, candidate.issueNumber)
          .finally(() => { active.delete(promise); });
        active.add(promise);
      }
    };

    launchAvailable();
    while (active.size > 0) {
      await Promise.race(active);
      this.mergePending(queue);
      launchAvailable();
      if (this.stopRequested) break;
    }

    if (this.stopRequested) {
      this.deps.logFile.info("daemon exiting cleanly after stage boundary");
    } else {
      this.deps.logFile.info(
        `queue exhausted — ${queue.completedRuns.length} run(s) completed`,
      );
    }
  }

  private async runOneScheduledIssue(queue: DaemonQueue, issueNumber: number): Promise<void> {
    this.deps.logFile.info(`starting run issue=${issueNumber}`);
    const claimPromise = this.claim(issueNumber);
    let summary: RunSummary;
    try {
      summary = await this.deps.runService.start(issueNumber, this.deps.overrides);
    } catch (err) {
      this.deps.logFile.error(`run failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
      summary = { runId: `failed-${issueNumber}`, stage: "FAILED", repository: queue.repository, issueNumber, publication: null, reason: err instanceof Error ? err.message : String(err) };
    }
    await claimPromise;
    await this.release(issueNumber, summary.stage);
    this.deps.logFile.info(`run complete issue=${issueNumber} outcome=${summary.stage}`);
    const completedAt = new Date().toISOString();
    queue.scheduler = completeIssue(queue.scheduler!, summary, completedAt);
    queue.completedRuns.push(toCompletedRun(summary, completedAt));
    queue.currentIndex = queue.completedRuns.length;
    this.deps.queueStore.write(queue);
  }
}
