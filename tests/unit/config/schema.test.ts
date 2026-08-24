import { describe, expect, it } from "vitest";
import { AutopilotConfigSchema } from "../../../src/config/schema.js";

describe("AutopilotConfigSchema", () => {
  it("has the correct default values", () => {
    const base = {
      version: 1,
      workspace: { baseBranch: "main", requireCleanCheckout: true },
      commands: { verify: ["npm test"] },
      reconciliation: {},
    };
    const cfg = AutopilotConfigSchema.parse(base);
    expect(cfg.reconciliation.requirementsPaths).toBeUndefined();
    expect(cfg.budgets.reconciler.timeoutMinutes).toBe(10);
  });

  it("defaults reportStaleAfterHours to 168, and classifies invalid values", () => {
    const base = {
      version: 1,
      workspace: { baseBranch: "main", requireCleanCheckout: true },
      commands: { verify: ["npm test"] },
      reconciliation: {},
    };
    const cfg = AutopilotConfigSchema.parse(base);
    expect(cfg.reconciliation.reportStaleAfterHours).toBe(168);

    const negative = AutopilotConfigSchema.parse({
      ...base,
      reconciliation: { reportStaleAfterHours: -1 },
    });
    expect(negative.reconciliation.reportStaleAfterHours).toBe(-1);

    const disabled = AutopilotConfigSchema.parse({
      ...base,
      reconciliation: { reportStaleAfterHours: null },
    });
    expect(disabled.reconciliation.reportStaleAfterHours).toBeNull();

    expect(() =>
      AutopilotConfigSchema.parse({
        ...base,
        reconciliation: { reportStaleAfterHours: "ten" },
      }),
    ).toThrow();
  });
});

describe("scheduler config", () => {
  const baseConfig = {
    version: 1,
    commands: { verify: ["npm test"] },
  };

  it("defaults to sequential scheduling", () => {
    const parsed = AutopilotConfigSchema.parse(baseConfig);
    expect(parsed.scheduler).toEqual({
      maxConcurrentRuns: 1,
      idleTimeoutMinutes: 0,
      budgets: {
        maxElapsedMinutes: null,
        maxStartedRuns: null,
        maxFailedRuns: null,
      },
    });
  });

  it("accepts explicit scheduler policy", () => {
    const parsed = AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: {
        maxConcurrentRuns: 3,
        idleTimeoutMinutes: 5,
        budgets: {
          maxElapsedMinutes: 120,
          maxStartedRuns: 10,
          maxFailedRuns: 2,
        },
      },
    });
    expect(parsed.scheduler.maxConcurrentRuns).toBe(3);
    expect(parsed.scheduler.idleTimeoutMinutes).toBe(5);
    expect(parsed.scheduler.budgets.maxElapsedMinutes).toBe(120);
    expect(parsed.scheduler.budgets.maxStartedRuns).toBe(10);
    expect(parsed.scheduler.budgets.maxFailedRuns).toBe(2);
  });

  it("rejects invalid scheduler numbers", () => {
    expect(() => AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: { maxConcurrentRuns: 0 },
    })).toThrow();
    expect(() => AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: { idleTimeoutMinutes: -1 },
    })).toThrow();
    expect(() => AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: { budgets: { maxFailedRuns: -1 } },
    })).toThrow();
  });
});
