import { describe, it, expect, vi, beforeEach } from "vitest";
import { DaemonRunner } from "../../../src/daemon/daemon-runner.js";
import type { DaemonRunnerDeps } from "../../../src/daemon/daemon-runner.js";

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
