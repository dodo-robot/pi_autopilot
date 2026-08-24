import { describe, expect, it } from "vitest";
import { RefinementSectionError } from "../../../src/readiness/refinement-section.js";
import {
  SPLIT_END,
  SPLIT_START,
  renderSplitSection,
  splitAlreadyApplied,
  upsertSplitSection,
} from "../../../src/reconciliation/managed-split-section.js";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("renderSplitSection", () => {
  it("renders a checklist of children by number and title", () => {
    const rendered = renderSplitSection([
      { number: 124, title: "Reject revoked sessions during authentication" },
      { number: 125, title: "Rate-limit failed logins" },
    ]);
    expect(rendered).toContain(SPLIT_START);
    expect(rendered).toContain(SPLIT_END);
    expect(rendered).toContain("## Split into");
    expect(rendered).toContain("- [ ] #124 Reject revoked sessions during authentication");
    expect(rendered).toContain("- [ ] #125 Rate-limit failed logins");
  });
});

describe("upsertSplitSection", () => {
  it("appends a managed section when the body has no markers", () => {
    const body = "Original human-authored issue body";
    const updated = upsertSplitSection(body, [{ number: 124, title: "Child A" }]);
    expect(updated).toContain("Original human-authored issue body");
    expect(countOccurrences(updated, SPLIT_START)).toBe(1);
    expect(countOccurrences(updated, SPLIT_END)).toBe(1);
    expect(updated).toContain("- [ ] #124 Child A");
  });

  it("replaces the single existing split section without touching other content", () => {
    const once = upsertSplitSection("Original context", [{ number: 124, title: "Child A" }]);
    const twice = upsertSplitSection(once, [
      { number: 124, title: "Child A" },
      { number: 125, title: "Child B" },
    ]);
    expect(twice).toContain("Original context");
    expect(countOccurrences(twice, SPLIT_START)).toBe(1);
    expect(twice).toContain("- [ ] #124 Child A");
    expect(twice).toContain("- [ ] #125 Child B");
  });

  it("coexists with a separate reconciliation-enrichment section", () => {
    const withEnrichment =
      "Body\n\n<!-- autopilot-reconciliation:start -->\nenrichment content\n<!-- autopilot-reconciliation:end -->\n";
    const updated = upsertSplitSection(withEnrichment, [{ number: 124, title: "Child A" }]);
    expect(updated).toContain("enrichment content");
    expect(updated).toContain(SPLIT_START);
  });

  it("rejects duplicate start markers instead of guessing", () => {
    const body = `${SPLIT_START}\nold\n${SPLIT_START}\nolder`;
    expect(() => upsertSplitSection(body, [{ number: 124, title: "Child A" }])).toThrow(
      RefinementSectionError,
    );
  });

  it("is stable: re-running with the same children yields the same body", () => {
    const once = upsertSplitSection("Original", [{ number: 124, title: "Child A" }]);
    const twice = upsertSplitSection(once, [{ number: 124, title: "Child A" }]);
    expect(twice).toBe(once);
  });
});

describe("splitAlreadyApplied", () => {
  it("is true when every child title appears as a checklist line in the body", () => {
    const body = upsertSplitSection("Original", [
      { number: 124, title: "Child A" },
      { number: 125, title: "Child B" },
    ]);
    expect(splitAlreadyApplied(body, [{ title: "Child A" }, { title: "Child B" }])).toBe(true);
  });

  it("is false when one child title is missing from the body", () => {
    const body = upsertSplitSection("Original", [{ number: 124, title: "Child A" }]);
    expect(splitAlreadyApplied(body, [{ title: "Child A" }, { title: "Child B" }])).toBe(false);
  });

  it("is false when the body has no split section at all", () => {
    expect(splitAlreadyApplied("Original body, no section yet", [{ title: "Child A" }])).toBe(false);
  });
});
