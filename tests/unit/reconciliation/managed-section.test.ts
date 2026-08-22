import { describe, expect, it } from "vitest";
import type { IssueEnrichment } from "../../../src/domain/reconciliation.js";
import { RefinementSectionError } from "../../../src/readiness/refinement-section.js";
import {
  RECONCILIATION_END,
  RECONCILIATION_START,
  renderReconciliationSection,
  upsertReconciliationSection,
} from "../../../src/reconciliation/managed-section.js";

function enrichment(overrides: Partial<IssueEnrichment> = {}): IssueEnrichment {
  return {
    goal: "Create a user record from a verified GitHub identity",
    sourceRequirements: ["REQ-AUTH-004"],
    acceptanceCriteria: ["A first-time GitHub login creates exactly one user row"],
    constraints: [],
    nonGoals: [],
    validation: ["npm test -- auth"],
    relevantAreas: ["src/auth/"],
    ...overrides,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("renderReconciliationSection", () => {
  it("renders the goal, source requirements, and every field", () => {
    const rendered = renderReconciliationSection(enrichment());
    expect(rendered).toContain("Create a user record from a verified GitHub identity");
    expect(rendered).toContain("REQ-AUTH-004");
    expect(rendered).toContain("A first-time GitHub login creates exactly one user row");
    expect(rendered).toContain("npm test -- auth");
    expect(rendered).toContain("src/auth/");
  });

  it("renders None. for empty list fields", () => {
    const rendered = renderReconciliationSection(enrichment({ constraints: [], nonGoals: [] }));
    expect(rendered).toContain("None.");
  });
});

describe("upsertReconciliationSection", () => {
  it("appends a managed section when the body has no markers", () => {
    const body = "Original human-authored issue body";
    const updated = upsertReconciliationSection(body, enrichment());
    expect(updated).toContain("Original human-authored issue body");
    expect(countOccurrences(updated, RECONCILIATION_START)).toBe(1);
    expect(countOccurrences(updated, RECONCILIATION_END)).toBe(1);
  });

  it("replaces the single existing reconciliation section without touching other content", () => {
    const once = upsertReconciliationSection("Original context", enrichment());
    const twice = upsertReconciliationSection(once, enrichment({ goal: "New goal" }));
    expect(twice).toContain("Original context");
    expect(countOccurrences(twice, RECONCILIATION_START)).toBe(1);
    expect(twice).not.toContain("Create a user record from a verified GitHub identity");
    expect(twice).toContain("New goal");
  });

  it("coexists with a separate M1 refinement section", () => {
    const withRefinement =
      "Body\n\n<!-- autopilot-refinement:start -->\nrefinement content\n<!-- autopilot-refinement:end -->\n";
    const updated = upsertReconciliationSection(withRefinement, enrichment());
    expect(updated).toContain("refinement content");
    expect(updated).toContain(RECONCILIATION_START);
  });

  it("rejects duplicate start markers instead of guessing", () => {
    const body = `${RECONCILIATION_START}\nold\n${RECONCILIATION_START}\nolder`;
    expect(() => upsertReconciliationSection(body, enrichment())).toThrow(
      RefinementSectionError,
    );
  });

  it("is stable: re-running with the same enrichment yields the same body", () => {
    const once = upsertReconciliationSection("Original", enrichment());
    const twice = upsertReconciliationSection(once, enrichment());
    expect(twice).toBe(once);
  });
});
