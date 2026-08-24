import { describe, expect, it } from "vitest";
import {
  UNKNOWN_WORKSPACE_SCOPE,
  createInitialSchedulerState,
  ensureSchedulerState,
} from "../../../src/scheduler/state.js";
import type { DaemonQueue } from "../../../src/daemon/queue-store.js";

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
});
