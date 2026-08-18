import { describe, expect, it } from "vitest";
import {
  RefinerResultSchema,
  TaskDraftSchema,
} from "../../../src/domain/contracts.js";

const minimalDraft = {
  schemaVersion: 1,
  repository: { owner: "acme", repo: "widgets" },
  issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
  objective: "",
  context: "",
  expectedBehavior: [],
  acceptanceCriteria: [],
  constraints: [],
  nonGoals: [],
  validation: [],
  dependencies: [],
  canonicalReferences: [],
  sourceBodyHash: "abc123",
};

describe("RefinerResultSchema", () => {
  it("accepts a FAILED outcome that still carries a taskDraft", () => {
    const result = RefinerResultSchema.parse({
      outcome: "FAILED",
      reason: "refiner crashed mid-analysis",
      taskDraft: minimalDraft,
    });
    expect(result.outcome).toBe("FAILED");
    expect(result.taskDraft).toEqual(minimalDraft);
  });

  it("still rejects a FAILED outcome without a taskDraft", () => {
    expect(() =>
      RefinerResultSchema.parse({ outcome: "FAILED", reason: "boom" }),
    ).toThrow();
  });

  it("round-trips a permissive draft through TaskDraftSchema", () => {
    const draft = TaskDraftSchema.parse(minimalDraft);
    expect(draft.objective).toBe("");
    expect(draft.acceptanceCriteria).toEqual([]);
  });
});
