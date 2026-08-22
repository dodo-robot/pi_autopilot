import { describe, expect, it } from "vitest";
import type { BacklogPatch } from "../../../src/domain/reconciliation.js";
import { classifyPatch } from "../../../src/reconciliation/patch-policy.js";

const cases: Array<{ patch: BacklogPatch; policy: "auto-safe" | "requires-approval" }> = [
  { patch: { type: "KEEP", issue: 1, reason: "fine" }, policy: "requires-approval" },
  {
    patch: {
      type: "ENRICH_ISSUE",
      issue: 1,
      reason: "add contract",
      patch: {
        goal: "g",
        sourceRequirements: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      },
    },
    policy: "auto-safe",
  },
  {
    patch: {
      type: "CREATE_ISSUE",
      epic: 1,
      reason: "missing coverage",
      spec: {
        title: "New issue",
        enrichment: {
          goal: "g",
          sourceRequirements: [],
          acceptanceCriteria: [],
          constraints: [],
          nonGoals: [],
          validation: [],
          relevantAreas: [],
        },
      },
    },
    policy: "auto-safe",
  },
  {
    patch: { type: "ADD_DEPENDENCY", issue: 1, dependsOn: 2, reason: "ordering" },
    policy: "auto-safe",
  },
  { patch: { type: "MARK_STALE", issue: 1, reason: "superseded" }, policy: "requires-approval" },
  {
    patch: {
      type: "NEEDS_HUMAN",
      issue: 1,
      ambiguityType: "PRODUCT",
      reason: "unclear",
      questions: ["?"],
    },
    policy: "requires-approval",
  },
];

describe("classifyPatch", () => {
  it.each(cases)("classifies $patch.type as $policy", ({ patch, policy }) => {
    expect(classifyPatch(patch)).toBe(policy);
  });
});
