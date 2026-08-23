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

    expect(() =>
      AutopilotConfigSchema.parse({
        ...base,
        reconciliation: { reportStaleAfterHours: "ten" },
      }),
    ).toThrow();
  });
});
