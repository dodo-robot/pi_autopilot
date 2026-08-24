import { describe, it, expect, vi, beforeEach } from "vitest";
import { DaemonRunner } from "../../../src/daemon/daemon-runner.js";
import type { DaemonRunnerDeps } from "../../../src/daemon/daemon-runner.js";
import { AGENT_READY_LABEL, AGENT_IN_PROGRESS_LABEL } from "../../../src/analysis/label-reconciliation.js";
import { createInitialSchedulerState } from "../../../src/scheduler/state.js";

function makeDeps(overrides: Partial<DaemonRunnerDeps> = {}): DaemonRunnerDeps {
  return {
    pidFile: {
      writePid: vi.fn(),
      delete: vi.fn(),
    } as any,
    queueStore: {
      read: vi.fn().mockReturnValue({
        repository: { owner: "acme", repo: "widgets" },
        issues: [28, 29],
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        completedRuns: [],
      }),
      write: vi.fn(),
    } as any,
    logFile: {
      info: vi.fn(),
      error: vi.fn(),
    } as any,
    github: {
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    } as any,
    pendingQueueStore: {
      drainAll: vi.fn().mockReturnValue([]),
    } as any,
    runService: {
      start: vi.fn().mockResolvedValue({
        runId: "run-abc",
        stage: "PR_OPEN",
        repository: { owner: "acme", repo: "widgets" },
        issueNumber: 28,
        publication: null,
        reason: null,
      }),
      resume: vi.fn(),
    },
    recoveryService: {
      reconcile: vi.fn().mockResolvedValue({ runId: "run-x", stage: "BLOCKED", actions: [] }),
      resume: vi.fn(),
    },
    runStore: {
      listNonterminalRuns: vi.fn().mockReturnValue([]),
      transition: vi.fn(),
    },
    overrides: {},
    registerSignalHandler: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
}

describe("DaemonRunner", () => {
  it("runs through all issues and records outcomes", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "BLOCKED", issueNumber: 29, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    const runner = new DaemonRunner(deps);
    await runner.run();

    expect(deps.runService.start).toHaveBeenCalledTimes(2);
    expect(deps.runService.start).toHaveBeenNthCalledWith(1, 28, {});
    expect(deps.runService.start).toHaveBeenNthCalledWith(2, 29, {});
    // queue written twice (once per issue completion)
    expect(deps.queueStore.write).toHaveBeenCalledTimes(2);
    // pid file deleted on clean exit
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("skips BLOCKED/NEEDS_REFINEMENT and continues to next issue", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "NEEDS_REFINEMENT", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 29, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
  });

  it("handles empty queue without calling RunService", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" },
      issues: [],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      completedRuns: [],
    });
    await new DaemonRunner(deps).run();
    expect(deps.runService.start).not.toHaveBeenCalled();
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("stops after current issue when SIGTERM is received between issues", async () => {
    let sigtermHandler: (() => void) | undefined;
    const registerSignalHandler = vi.fn().mockImplementation((_sig: string, handler: () => void) => {
      sigtermHandler = handler;
    });
    const deps = makeDeps({ registerSignalHandler });
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        sigtermHandler?.(); // fire SIGTERM while issue 28 is "running"
        return { runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null };
      });

    await new DaemonRunner(deps).run();
    // Should have run issue 28 (completed the stage), but not 29
    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("auto-resumes a nonterminal run before the queue", async () => {
    const deps = makeDeps();
    (deps.runStore.listNonterminalRuns as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "run-interrupted", issueNumber: 27, stage: "BLOCKED" },
    ]);
    (deps.recoveryService.resume as ReturnType<typeof vi.fn>).mockResolvedValue({
      runId: "run-interrupted",
      stage: "PR_OPEN",
      issueNumber: 27,
      repository: { owner: "acme", repo: "widgets" },
      publication: null,
      reason: null,
    });

    await new DaemonRunner(deps).run();
    // resume called before queue issues
    expect(deps.recoveryService.resume).toHaveBeenCalledWith("run-interrupted", {});
    // then queue issues run
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
  });

  it("marks interrupted run FAILED and continues when resume throws", async () => {
    const deps = makeDeps();
    (deps.runStore.listNonterminalRuns as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "run-bad", issueNumber: 27, stage: "FAILED" },
    ]);
    (deps.recoveryService.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("worktree missing"),
    );

    await new DaemonRunner(deps).run();
    // transition called to mark FAILED
    expect(deps.runStore.transition).toHaveBeenCalled();
    // queue still runs
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
  });
});

describe("DaemonRunner claim/release labels", () => {
  it("claims (removes agent:ready, adds agent:in-progress) before starting a run", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
    expect(deps.github.addLabel).toHaveBeenCalledWith(28, AGENT_IN_PROGRESS_LABEL);
    // Claim must happen before runService.start is called
    const removeOrder = (deps.github.removeLabel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const startOrder = (deps.runService.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(removeOrder).toBeLessThan(startOrder);
  });

  it("releases agent:in-progress only, on PR_OPEN", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    // Called once for the claim's remove(agent:ready), then once more for release's remove(agent:in-progress)
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_IN_PROGRESS_LABEL);
    expect(deps.github.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("leaves agent:in-progress in place on BLOCKED", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "BLOCKED", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    // Only the claim's removeLabel(agent:ready) call — no release removeLabel(agent:in-progress)
    expect(deps.github.removeLabel).toHaveBeenCalledTimes(1);
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
  });

  it("leaves agent:in-progress in place on FAILED", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "FAILED", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.github.removeLabel).toHaveBeenCalledTimes(1);
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
  });

  it("removes both labels on NEEDS_REFINEMENT", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "NEEDS_REFINEMENT", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    // Claim removes agent:ready (1), release removes agent:in-progress then agent:ready (2 more) = 3 total
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_IN_PROGRESS_LABEL);
    expect(deps.github.removeLabel).toHaveBeenCalledTimes(3);
  });

  it("never blocks the run when the claim label write throws", async () => {
    const deps = makeDeps();
    (deps.github.removeLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rate limited"));
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    expect(deps.logFile.error).toHaveBeenCalled();
  });

  it("never blocks queue advancement when the release label write throws", async () => {
    const deps = makeDeps();
    (deps.github.removeLabel as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // claim succeeds
      .mockRejectedValueOnce(new Error("rate limited")); // release fails
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.queueStore.write).toHaveBeenCalled();
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });
});

describe("DaemonRunner pending queue merge", () => {
  it("drains pending once before the loop starts, merging new issues onto the queue", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([99]) // pre-loop drain
      .mockReturnValue([]);      // subsequent drains
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(2);
    expect(deps.runService.start).toHaveBeenNthCalledWith(2, 99, {});
  });

  it("drains pending once per loop iteration", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });

    await new DaemonRunner(deps).run();

    // Once before the loop + once after the single iteration = 2 calls
    expect(deps.pendingQueueStore.drainAll).toHaveBeenCalledTimes(2);
  });

  it("deduplicates pending issues already present anywhere in the full queue", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([28]) // already in queue.issues — must not duplicate
      .mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    expect(deps.runService.start).toHaveBeenCalledWith(28, {});
  });

  it("persists the merged queue via queueStore.write when pending issues are added", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([99])
      .mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    const writtenQueues = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(writtenQueues.some((q) => q.issues.includes(99))).toBe(true);
  });
});

function queueWithSchedulerIssues(input: {
  maxConcurrentRuns: number;
  budgets?: { maxElapsedMinutes: number | null; maxStartedRuns: number | null; maxFailedRuns: number | null };
  issues: Array<{ issueNumber: number; scope: string }>;
}) {
  const policy = {
    maxConcurrentRuns: input.maxConcurrentRuns,
    idleTimeoutMinutes: 0,
    budgets: input.budgets ?? { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
  };
  return {
    repository: { owner: "acme", repo: "widgets" },
    issues: input.issues.map((issue) => issue.issueNumber),
    currentIndex: 0,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: input.issues.map((issue) => ({
        issueNumber: issue.issueNumber,
        dependencies: [],
        workspaceScope: { kind: "paths", patterns: [issue.scope], source: "issue-contract" },
        initialState: "PENDING",
        reason: "ready",
      })),
    }),
  };
}

describe("DaemonRunner scheduler queue", () => {
  it("starts disjoint pending scheduler issues up to maxConcurrentRuns", async () => {
    const deps = makeDeps();
    let resolveRun1!: (value: any) => void;
    const run1 = new Promise((resolve) => { resolveRun1 = resolve; });
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(run1)
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" },
      issues: [1, 2],
      currentIndex: 0,
      startedAt: "2026-08-24T00:00:00.000Z",
      completedRuns: [],
      scheduler: createInitialSchedulerState({
        policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
        startedAt: "2026-08-24T00:00:00.000Z",
        issues: [
          { issueNumber: 1, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/a/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" },
          { issueNumber: 2, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/b/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" },
        ],
      }),
    });

    const runPromise = new DaemonRunner(deps).run();
    await Promise.resolve();
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
    resolveRun1({ runId: "run-1", stage: "PR_OPEN", issueNumber: 1, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });
    await runPromise;

    const finalWrite = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(finalWrite.scheduler.issues.every((issue: { state: string }) => issue.state === "COMPLETED")).toBe(true);
  });

  it("does not run conflicting scheduler issues concurrently", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithSchedulerIssues({
      maxConcurrentRuns: 2,
      issues: [
        { issueNumber: 1, scope: "src/daemon/**" },
        { issueNumber: 2, scope: "src/daemon/daemon-runner.ts" },
      ],
    }));
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 1, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenNthCalledWith(1, 1, {});
    expect(deps.runService.start).toHaveBeenNthCalledWith(2, 2, {});
  });

  it("stops starting scheduler issues when maxStartedRuns is reached", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithSchedulerIssues({
      maxConcurrentRuns: 2,
      budgets: { maxElapsedMinutes: null, maxStartedRuns: 1, maxFailedRuns: null },
      issues: [{ issueNumber: 1, scope: "src/a/**" }, { issueNumber: 2, scope: "src/b/**" }],
    }));
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 1, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    const finalWrite = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(finalWrite.scheduler.budgets.stopReason).toBe("max started runs reached (1/1)");
  });

  it("records FAILED when scheduler executor throws", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithSchedulerIssues({
      maxConcurrentRuns: 1,
      issues: [{ issueNumber: 1, scope: "src/a/**" }],
    }));
    (deps.runService.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    await new DaemonRunner(deps).run();

    const writes = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(writes.at(-1).completedRuns[0].outcome).toBe("FAILED");
  });
});

function queueWithBlockedDependency() {
  return {
    repository: { owner: "acme", repo: "widgets" },
    issues: [2],
    currentIndex: 0,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy: { maxConcurrentRuns: 1, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [{
        issueNumber: 2,
        dependencies: [{ issueNumber: 1, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" }],
        workspaceScope: { kind: "paths", patterns: ["src/b/**"], source: "issue-contract" },
        initialState: "DEFERRED_DEPENDENCY",
        reason: "waiting for #1",
      }],
    }),
  };
}

describe("DaemonRunner blocked dependency refresh and idle", () => {
  it("refreshes dependencies once when scheduler is blocked with no active runs", async () => {
    const deps = makeDeps({
      schedulerRefresh: {
        refreshDependencies: vi.fn(async (queue) => {
          const scheduler = queue.scheduler!;
          return {
            ...queue,
            scheduler: {
              ...scheduler,
              issues: scheduler.issues.map((issue) => issue.issueNumber === 2
                ? { ...issue, state: "PENDING", dependencies: issue.dependencies.map((dep) => ({ ...dep, satisfied: true, source: "github-closed", checkedAt: "2026-08-24T00:02:00.000Z" })), reason: "ready" }
                : issue),
              lastBlockedRefreshAt: "2026-08-24T00:02:00.000Z",
            },
          };
        }),
      },
    } as Partial<DaemonRunnerDeps>);
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithBlockedDependency());
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.schedulerRefresh!.refreshDependencies).toHaveBeenCalledTimes(1);
    expect(deps.runService.start).toHaveBeenCalledWith(2, {});
  });

  it("exits immediately by default when scheduler remains blocked", async () => {
    const deps = makeDeps({
      schedulerRefresh: { refreshDependencies: vi.fn(async (queue) => queue) },
    } as Partial<DaemonRunnerDeps>);
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithBlockedDependency());

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).not.toHaveBeenCalled();
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("drains pending queue while idling", async () => {
    const deps = makeDeps({
      now: vi.fn()
        .mockReturnValueOnce("2026-08-24T00:00:00.000Z")
        .mockReturnValueOnce("2026-08-24T00:00:30.000Z")
        .mockReturnValue("2026-08-24T00:01:01.000Z"),
      sleep: vi.fn(async () => undefined),
      schedulerRefresh: { refreshDependencies: vi.fn(async (queue) => queue) },
    } as Partial<DaemonRunnerDeps>);
    const queue = queueWithBlockedDependency();
    queue.scheduler.policy.idleTimeoutMinutes = 1;
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queue);
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([99])
      .mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-99", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledWith(99, {});
  });

  it("refreshes blocked dependencies while idling before timing out", async () => {
    const deps = makeDeps({
      now: vi.fn()
        .mockReturnValueOnce("2026-08-24T00:00:00.000Z")
        .mockReturnValueOnce("2026-08-24T00:00:30.000Z")
        .mockReturnValue("2026-08-24T00:01:01.000Z"),
      sleep: vi.fn(async () => undefined),
      schedulerRefresh: {
        refreshDependencies: vi.fn(async (queue) => {
          if ((deps.schedulerRefresh!.refreshDependencies as ReturnType<typeof vi.fn>).mock.calls.length === 1) return queue;
          const scheduler = queue.scheduler!;
          return {
            ...queue,
            scheduler: {
              ...scheduler,
              issues: scheduler.issues.map((issue) => issue.issueNumber === 2
                ? { ...issue, state: "PENDING", dependencies: issue.dependencies.map((dep) => ({ ...dep, satisfied: true, source: "github-closed", checkedAt: "2026-08-24T00:00:30.000Z" })), reason: "ready" }
                : issue),
            },
          };
        }),
      },
    } as Partial<DaemonRunnerDeps>);
    const queue = queueWithBlockedDependency();
    queue.scheduler.policy.idleTimeoutMinutes = 1;
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queue);
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.schedulerRefresh!.refreshDependencies).toHaveBeenCalledTimes(2);
    expect(deps.runService.start).toHaveBeenCalledWith(2, {});
  });

  it("normalizes pending issues added to a scheduler queue via schedulerPending.normalize", async () => {
    const deps = makeDeps({
      schedulerPending: {
        normalize: vi.fn(async (issueNumbers) => issueNumbers.map((issueNumber) => ({
          issueNumber,
          dependencies: [],
          workspaceScope: { kind: "paths" as const, patterns: ["src/c/**"], source: "issue-contract" as const },
          initialState: "PENDING" as const,
          reason: "ready",
        }))),
      },
    } as Partial<DaemonRunnerDeps>);
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
      scheduler: createInitialSchedulerState({
        policy: { maxConcurrentRuns: 1, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
        startedAt: "2026-08-24T00:00:00.000Z",
        issues: [{ issueNumber: 28, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/a/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" }],
      }),
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([99])
      .mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.schedulerPending!.normalize).toHaveBeenCalledWith([99], expect.any(Object), expect.any(String));
    const writes = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const withNinetyNine = writes.find((q) => q.scheduler?.issues.some((issue: { issueNumber: number }) => issue.issueNumber === 99));
    expect(withNinetyNine.scheduler.issues.find((issue: { issueNumber: number }) => issue.issueNumber === 99).workspaceScope).toEqual({ kind: "paths", patterns: ["src/c/**"], source: "issue-contract" });
  });
});
