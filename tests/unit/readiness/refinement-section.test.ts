import { describe, expect, it } from "vitest";
import type { TaskDraft } from "../../../src/domain/contracts.js";
import {
  REFINEMENT_END,
  REFINEMENT_START,
  RefinementSectionError,
  renderRefinementSection,
  renderUnifiedDiff,
  upsertRefinementSection,
} from "../../../src/readiness/refinement-section.js";

const SECTION_HEADINGS = [
  "Goal",
  "Context",
  "Expected behavior",
  "Acceptance criteria",
  "Constraints",
  "Non-goals",
  "Validation",
  "Dependencies",
  "References",
] as const;

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "widgets" },
    issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
    objective: "Implement token refresh validation",
    context: "The auth module owns session refresh.",
    expectedBehavior: ["Expired refresh tokens are rejected"],
    acceptanceCriteria: [
      { id: "ac1", text: "A refresh with an expired token returns 401" },
    ],
    constraints: ["Do not alter the session model"],
    nonGoals: ["Password reset flows"],
    validation: ["npm test"],
    dependencies: [
      { issue: 41, satisfied: true },
      { issue: 40, satisfied: false },
    ],
    canonicalReferences: ["docs/auth/refresh.md"],
    sourceBodyHash: "abc",
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

describe("upsertRefinementSection", () => {
  it("appends a managed section when the body has no markers", () => {
    const body = "Original issue body";
    const updated = upsertRefinementSection(body, draft());

    expect(updated).toContain("Original issue body");
    expect(countOccurrences(updated, REFINEMENT_START)).toBe(1);
    expect(countOccurrences(updated, REFINEMENT_END)).toBe(1);
    expect(updated.indexOf(REFINEMENT_START)).toBeGreaterThan(body.length);
  });

  it("replaces the single existing managed section", () => {
    const once = upsertRefinementSection("Original context", draft());
    const changed = draft({ objective: "New objective" });
    const twice = upsertRefinementSection(once, changed);

    expect(twice).toContain("Original context");
    expect(countOccurrences(twice, REFINEMENT_START)).toBe(1);
    expect(twice).not.toContain("Implement token refresh validation");
    expect(twice).toContain("New objective");
  });

  it("preserves original content and newlines around the managed section", () => {
    const body = "Intro line\n\n- bullet one\n- bullet two";
    const updated = upsertRefinementSection(body, draft());

    expect(updated).toContain("Intro line\n\n- bullet one\n- bullet two");
    expect(updated.indexOf(REFINEMENT_START)).toBeGreaterThan(
      body.indexOf("bullet two"),
    );
  });

  it("rejects duplicate start markers instead of guessing", () => {
    const body = `${REFINEMENT_START}\nold\n${REFINEMENT_START}\nolder`;
    expect(() => upsertRefinementSection(body, draft())).toThrow(
      RefinementSectionError,
    );
  });

  it("rejects duplicate end markers instead of guessing", () => {
    const body = `${REFINEMENT_END}\n${REFINEMENT_END}`;
    expect(() => upsertRefinementSection(body, draft())).toThrow(
      RefinementSectionError,
    );
  });

  it("rejects an end marker without a matching start marker", () => {
    const body = `${REFINEMENT_END}`;
    expect(() => upsertRefinementSection(body, draft())).toThrow(
      RefinementSectionError,
    );
  });

  it("rejects an unbalanced start marker without a matching end marker", () => {
    const body = `text ${REFINEMENT_START} more text`;
    expect(() => upsertRefinementSection(body, draft())).toThrow(
      RefinementSectionError,
    );
  });

  it("rejects an end marker that appears before the start marker", () => {
    // Equal marker counts (1 each), but the end marker precedes the start,
    // so the search for a later end marker fails: exercises the reversed-
    // marker branch (endIndex === -1) rather than the balance branch.
    const body = `${REFINEMENT_END}\n${REFINEMENT_START}`;
    expect(() => upsertRefinementSection(body, draft())).toThrow(
      RefinementSectionError,
    );
  });

  it("is stable: re-running with the same draft yields the same body", () => {
    const once = upsertRefinementSection("Original", draft());
    const twice = upsertRefinementSection(once, draft());
    expect(twice).toBe(once);
  });

  it("handles an empty body", () => {
    const updated = upsertRefinementSection("", draft());
    expect(updated).toContain(REFINEMENT_START);
    expect(updated).toContain("Implement token refresh validation");
  });
});

describe("renderRefinementSection", () => {
  it("renders sections in the fixed required order", () => {
    const rendered = renderRefinementSection(draft());
    const indexes = SECTION_HEADINGS.map((heading) =>
      rendered.indexOf(`### ${heading}`),
    );
    for (const index of indexes) expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < indexes.length; i += 1) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });

  it("renders acceptance criteria with ids and checkboxes", () => {
    const rendered = renderRefinementSection(draft());
    expect(rendered).toContain("- [ ] **ac1** A refresh with an expired token returns 401");
  });

  it("renders dependencies with satisfied status", () => {
    const rendered = renderRefinementSection(draft());
    expect(rendered).toContain("- #41 (satisfied)");
    expect(rendered).toContain("- #40 (unsatisfied)");
  });

  it("renders explicit None. for empty collections", () => {
    const rendered = renderRefinementSection(
      draft({
        expectedBehavior: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        dependencies: [],
        canonicalReferences: [],
      }),
    );
    expect(countOccurrences(rendered, "None.")).toBe(6);
  });

  it("renders an explicit None. for an empty objective", () => {
    const rendered = renderRefinementSection(draft({ objective: "" }));
    expect(rendered).toContain("None.");
  });
});

describe("renderUnifiedDiff", () => {
  it("produces a unified diff with headers and +/- lines", () => {
    const diff = renderUnifiedDiff("line one\nline two", "line one\nline two\nline three");

    expect(diff).toContain("--- original");
    expect(diff).toContain("+++ proposed");
    expect(diff).toContain("+line three");
    expect(diff).toContain("-");
  });

  it("reports no changes when the texts are identical", () => {
    const diff = renderUnifiedDiff("same", "same");
    expect(diff).toContain("(no changes)");
  });

  it("prefixes every line in a replacement diff", () => {
    const diff = renderUnifiedDiff("old line", "new line");
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  it("uses a canonical hunk range when the first change is not on line 1", () => {
    const diff = renderUnifiedDiff(
      "keep one\nkeep two\nold line",
      "keep one\nkeep two\nnew line",
    );
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain(" keep one");
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });
});
