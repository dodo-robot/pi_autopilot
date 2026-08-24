import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULER_POLICY,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  resolveSchedulerPolicy,
} from "../../../src/scheduler/policy.js";
import type { AutopilotConfig } from "../../../src/config/schema.js";

function configWithScheduler(scheduler: AutopilotConfig["scheduler"]): AutopilotConfig {
  return {
    version: 1,
    workspace: { baseBranch: "main", branchPrefix: "autopilot/", requireCleanCheckout: true, retainBlockedWorktree: true },
    commands: { setup: [], verify: ["npm test"] },
    agents: {},
    agentPolicy: { allowedCommands: ["npm"], protectedPaths: [], allowNetwork: false },
    budgets: {
      refiner: { timeoutMinutes: 5 },
      reconciler: { timeoutMinutes: 10 },
      implementation: { timeoutMinutes: 60, maxAttempts: 3 },
      review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
    },
    publication: { draftPr: false, issueComment: "concise", autoMerge: false },
    reconciliation: { reportStaleAfterHours: 168 },
    bootstrap: { tokenThreshold: 80_000 },
    scheduler,
  };
}

describe("scheduler policy helpers", () => {
  it("exports sequential defaults", () => {
    expect(DEFAULT_SCHEDULER_POLICY).toEqual({
      maxConcurrentRuns: 1,
      idleTimeoutMinutes: 0,
      budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
    });
  });

  it("uses config values when no CLI override is present", () => {
    const policy = resolveSchedulerPolicy(configWithScheduler({
      maxConcurrentRuns: 2,
      idleTimeoutMinutes: 7,
      budgets: { maxElapsedMinutes: 90, maxStartedRuns: 8, maxFailedRuns: 1 },
    }), {});
    expect(policy.maxConcurrentRuns).toBe(2);
    expect(policy.idleTimeoutMinutes).toBe(7);
    expect(policy.budgets).toEqual({ maxElapsedMinutes: 90, maxStartedRuns: 8, maxFailedRuns: 1 });
  });

  it("lets CLI override config for one daemon start", () => {
    const policy = resolveSchedulerPolicy(configWithScheduler({
      maxConcurrentRuns: 2,
      idleTimeoutMinutes: 7,
      budgets: { maxElapsedMinutes: 90, maxStartedRuns: 8, maxFailedRuns: 1 },
    }), {
      maxConcurrentRuns: 4,
      idleTimeoutMinutes: 0,
      maxElapsedMinutes: 30,
      maxStartedRuns: 3,
      maxFailedRuns: 0,
    });
    expect(policy).toEqual({
      maxConcurrentRuns: 4,
      idleTimeoutMinutes: 0,
      budgets: { maxElapsedMinutes: 30, maxStartedRuns: 3, maxFailedRuns: 0 },
    });
  });

  it("parses positive and non-negative CLI integers", () => {
    expect(parseOptionalPositiveInt("2", "--max-concurrent")).toBe(2);
    expect(parseOptionalPositiveInt(undefined, "--max-concurrent")).toBeNull();
    expect(parseOptionalNonNegativeInt("0", "--idle-timeout")).toBe(0);
    expect(parseOptionalNonNegativeInt(undefined, "--idle-timeout")).toBeNull();
  });

  it("rejects invalid CLI integers with flag names", () => {
    expect(() => parseOptionalPositiveInt("0", "--max-concurrent")).toThrow(/--max-concurrent/);
    expect(() => parseOptionalPositiveInt("1.5", "--max-concurrent")).toThrow(/--max-concurrent/);
    expect(() => parseOptionalNonNegativeInt("-1", "--idle-timeout")).toThrow(/--idle-timeout/);
    expect(() => parseOptionalNonNegativeInt("abc", "--idle-timeout")).toThrow(/--idle-timeout/);
  });
});
