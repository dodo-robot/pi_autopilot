import { describe, expect, it } from "vitest";
import {
  RefinerResultSchema,
  ReviewerResultSchema,
  TaskDraftSchema,
  VerifierResultSchema,
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

describe("ReviewerResultSchema", () => {
  it("accepts an APPROVED result without criteriaResults", () => {
    const result = ReviewerResultSchema.safeParse({
      outcome: "APPROVED",
      findings: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a finding with no criterionId", () => {
    const result = ReviewerResultSchema.safeParse({
      outcome: "CHANGES_REQUESTED",
      findings: [
        {
          severity: "minor",
          path: "src/example.ts",
          line: 1,
          evidence: "unused import",
          requestedChange: "remove the unused import",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("silently strips a stray criteriaResults field from an APPROVED result (moved to the verifier)", () => {
    const result = ReviewerResultSchema.safeParse({
      outcome: "APPROVED",
      criteriaResults: [{ criterionId: "ac1", passed: true, notes: "n/a" }],
      findings: [],
    });
    // criteriaResults is now an unrecognized key; zod object schemas strip
    // unknown keys by default rather than rejecting them, so parsing still
    // succeeds but the field is gone from the parsed output.
    expect(result.success).toBe(true);
    expect(result.success && "criteriaResults" in result.data).toBe(false);
  });
});

describe("VerifierResultSchema", () => {
  it("accepts a VERIFIED result", () => {
    const result = VerifierResultSchema.safeParse({
      outcome: "VERIFIED",
      criteriaResults: [{ criterionId: "ac1", passed: true, notes: "confirmed by test output" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a NOT_VERIFIED result with findings", () => {
    const result = VerifierResultSchema.safeParse({
      outcome: "NOT_VERIFIED",
      criteriaResults: [{ criterionId: "ac1", passed: false, notes: "no evidence in diff" }],
      findings: [
        {
          criterionId: "ac1",
          evidence: "no test exercises the 401 path",
          notes: "acceptance criterion is unverified",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts PRODUCT_AMBIGUITY and FAILED outcomes", () => {
    expect(
      VerifierResultSchema.safeParse({ outcome: "PRODUCT_AMBIGUITY", reason: "ambiguous" })
        .success,
    ).toBe(true);
    expect(
      VerifierResultSchema.safeParse({ outcome: "FAILED", reason: "could not verify" }).success,
    ).toBe(true);
  });

  it("rejects VERIFIED without criteriaResults", () => {
    const result = VerifierResultSchema.safeParse({ outcome: "VERIFIED" });
    expect(result.success).toBe(false);
  });
});
