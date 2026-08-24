import { describe, expect, it } from "vitest";
import {
  completeIssue,
  findStartableIssue,
  isStartBudgetExhausted,
  markIssueRunning,
  mergePendingIssues,
  refreshConflictStates,
  updateBudgetUsage,
} from "../../../src/scheduler/scheduler.js";
import {
  UNKNOWN_WORKSPACE_SCOPE,
  createInitialSchedulerState,
  ensureSchedulerState,
} from "../../../src/scheduler/state.js";
import type { DaemonQueue } from "../../../src/daemon/queue-store.js";

const pathScope = (pattern: string) => ({ kind: "paths" as const, patterns: [pattern], source: "issue-contract" as const });

const policy = {
  maxConcurrentRuns: 1,
  idleTimeoutMinutes: 0,
  budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
};

describe("scheduler state", () => {
  it("creates initial scheduler state from normalized issues", () => {
    const state = createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        {
          issueNumber: 42,
          dependencies: [],
          workspaceScope: { kind: "paths", patterns: ["src/daemon/**"], source: "issue-contract" },
          initialState: "PENDING",
          reason: "ready",
        },
      ],
    });

    expect(state.version).toBe(1);
    expect(state.policy).toEqual(policy);
    expect(state.activeRuns).toEqual([]);
    expect(state.budgets).toEqual({ startedRuns: 0, failedRuns: 0, elapsedMinutes: 0, stopReason: null });
    expect(state.issues[0]).toMatchObject({ issueNumber: 42, state: "PENDING", reason: "ready" });
  });

  it("initializes absent scheduler state from an old queue", () => {
    const queue: DaemonQueue = {
      repository: { owner: "acme", repo: "widgets" },
      issues: [42],
      currentIndex: 0,
      startedAt: "2026-08-24T00:00:00.000Z",
      completedRuns: [],
    };

    const state = ensureSchedulerState(queue, policy, () => "2026-08-24T00:01:00.000Z");

    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({
      issueNumber: 42,
      state: "PENDING",
      workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
      dependencies: [],
    });
  });

  it("starts first pending issue with satisfied dependencies and no active conflict", () => {
    const state = createInitialSchedulerState({
      policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        { issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" },
        { issueNumber: 2, dependencies: [], workspaceScope: pathScope("src/b/**"), initialState: "PENDING", reason: "ready" },
      ],
    });

    expect(findStartableIssue(state, "2026-08-24T00:01:00.000Z")?.issueNumber).toBe(1);
  });

  it("does not start dependency-blocked issues", () => {
    const state = createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [{
        issueNumber: 2,
        dependencies: [{ issueNumber: 1, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" }],
        workspaceScope: pathScope("src/b/**"),
        initialState: "DEFERRED_DEPENDENCY",
        reason: "waiting for #1",
      }],
    });

    expect(findStartableIssue(state, "2026-08-24T00:01:00.000Z")).toBeNull();
  });

  it("does not start an issue whose workspace scope conflicts with an active run", () => {
    let state = createInitialSchedulerState({
      policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        { issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/daemon/**"), initialState: "PENDING", reason: "ready" },
        { issueNumber: 2, dependencies: [], workspaceScope: pathScope("src/daemon/daemon-runner.ts"), initialState: "PENDING", reason: "ready" },
      ],
    });
    state = markIssueRunning(state, 1, "run-1", "2026-08-24T00:01:00.000Z");
    state = refreshConflictStates(state);

    expect(findStartableIssue(state, "2026-08-24T00:02:00.000Z")).toBeNull();
    expect(state.issues.find((issue) => issue.issueNumber === 2)?.state).toBe("DEFERRED_CONFLICT");
  });

  it("marks completed PR_OPEN and unblocks dependents locally", () => {
    let state = createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        { issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" },
        { issueNumber: 2, dependencies: [{ issueNumber: 1, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" }], workspaceScope: pathScope("src/b/**"), initialState: "DEFERRED_DEPENDENCY", reason: "waiting for #1" },
      ],
    });
    state = markIssueRunning(state, 1, "run-1", "2026-08-24T00:01:00.000Z");
    state = completeIssue(state, {
      runId: "run-1",
      stage: "PR_OPEN",
      repository: { owner: "acme", repo: "widgets" },
      issueNumber: 1,
      publication: null,
      reason: null,
    }, "2026-08-24T00:02:00.000Z");

    expect(state.activeRuns).toEqual([]);
    expect(state.issues.find((issue) => issue.issueNumber === 1)?.state).toBe("COMPLETED");
    expect(state.issues.find((issue) => issue.issueNumber === 2)?.state).toBe("PENDING");
  });

  it("reports budget stop reasons without cancelling active runs", () => {
    const state = updateBudgetUsage(createInitialSchedulerState({
      policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: 10, maxStartedRuns: 1, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [{ issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" }],
    }), "2026-08-24T00:11:00.000Z");

    expect(isStartBudgetExhausted(state)).toMatch(/elapsed/);
  });

  it("merges pending issue inputs onto scheduler state", () => {
    const state = createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [{ issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" }],
    });

    const updated = mergePendingIssues(state, [{
      issueNumber: 2,
      dependencies: [],
      workspaceScope: pathScope("src/b/**"),
      initialState: "PENDING",
      reason: "pending queue entry",
    }], "2026-08-24T00:03:00.000Z");

    expect(updated.issues.map((issue) => issue.issueNumber)).toEqual([1, 2]);
    expect(updated.lastUpdatedAt).toBe("2026-08-24T00:03:00.000Z");
  });
});
