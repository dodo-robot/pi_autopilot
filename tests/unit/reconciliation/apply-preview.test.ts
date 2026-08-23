import { describe, expect, it } from "vitest";
import { renderReconciliationSection } from "../../../src/reconciliation/managed-section.js";
import {
  confirmMenu,
  renderEnrichPreview,
  renderDependencyPreview,
  renderCreatePreview,
} from "../../../src/reconciliation/apply-preview.js";

describe("confirmMenu", () => {
  it("maps y to apply, n to skip, a to all, q to abort", async () => {
    const inputs = ["y", "n", "a", "q", "n"];
    const readIndex = { value: 0 };
    const read = (): Promise<string> => {
      const input = inputs[readIndex.value];
      readIndex.value++;
      return Promise.resolve(input ?? "");
    };
    const abort: string[] = [];
    const write = (s: string): void => { abort.push(s); };
    expect(await confirmMenu("apply #15? ", write, read)).toBe("apply");
    expect(await confirmMenu("apply #16? ", write, read)).toBe("skip");
    expect(await confirmMenu("apply #17? ", write, read)).toBe("all");
    expect(await confirmMenu("apply #18? ", write, read)).toBe("abort");
    expect(abort).toHaveLength(4);
  });

  it("treats blank/empty input as skip", async () => {
    const read = (): Promise<string> => Promise.resolve("");
    expect(await confirmMenu("x? ", () => {}, read)).toBe("skip");
  });

  it("is case-insensitive and accepts the word forms", async () => {
    const read = (): Promise<string> => Promise.resolve("APPLY");
    expect(await confirmMenu("x? ", () => {}, read)).toBe("apply");
  });

  it("loops until a valid answer", async () => {
    const inputs = ["zz", "Y"];
    const readIndex = { value: 0 };
    const read = (): Promise<string> => {
      const input = inputs[readIndex.value];
      readIndex.value++;
      return Promise.resolve(input ?? "");
    };
    const writes: string[] = [];
    expect(await confirmMenu("? ", (s) => { writes.push(s); }, read)).toBe("apply");
    // wrote the invalid-input retry prompt at least once
    expect(writes.some((s) => s.includes("apply") || s.includes("skip"))).toBe(true);
  });

  describe("renderEnrichPreview", () => {
    it("renders the diff between current body and proposed section", () => {
      const enrichment = {
        goal: "Implement new feature",
        sourceRequirements: ["Requirement 1"],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      };
      const patch = {
        type: "ENRICH_ISSUE",
        issue: 15,
        patch: enrichment,
        reason: "Adding new feature",
      } as any;
      const currentBody = "Existing content";
      const result = renderEnrichPreview(currentBody, patch);
      expect(result).toContain("---");
      expect(result).toContain("+++");
      expect(result).toContain("### Goal");
      expect(result).toContain("Implement new feature");
      expect(result).toContain("- Requirement 1");
    });

    it("includes current body when present in diff", () => {
      const enrichment = {
        goal: "New goal",
        sourceRequirements: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      };
      const patch = {
        type: "ENRICH_ISSUE",
        issue: 16,
        patch: enrichment,
        reason: "Updating goal",
      } as any;
      const currentBody = "Old goal was here";
      const result = renderEnrichPreview(currentBody, patch);
      expect(result).toContain("Old goal was here");
    });

    it("handles empty current body", () => {
      const enrichment = {
        goal: "New goal",
        sourceRequirements: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      };
      const patch = {
        type: "ENRICH_ISSUE",
        issue: 17,
        patch: enrichment,
        reason: "Adding goal",
      } as any;
      const result = renderEnrichPreview("", patch);
      expect(result).toContain("### Goal");
      expect(result).toContain("New goal");
    });
  });

  describe("renderDependencyPreview", () => {
    it("returns the dependency line for a given line number", () => {
      const result = renderDependencyPreview("", 42);
      expect(result).toBe(`- #42 (unsatisfied)`);
    });

    it("accepts currentBody parameter without using it (interface compliance)", () => {
      const result = renderDependencyPreview("some current body text", 100);
      expect(result).toBe(`- #100 (unsatisfied)`);
    });
  });

  describe("renderCreatePreview", () => {
    it("returns title and goal for a CREATE_ISSUE patch", () => {
      const patch = {
        type: "CREATE_ISSUE",
        spec: {
          title: "Test Issue",
          enrichment: { goal: "Implement feature X" },
        },
      } as any;
      const result = renderCreatePreview(patch);
      expect(result).toBe("title: Test Issue\nImplement feature X");
    });

    it("shows '(no goal)' when goal is empty", () => {
      const patch = {
        type: "CREATE_ISSUE",
        spec: {
          title: "Test Issue",
          enrichment: { goal: "" },
        },
      } as any;
      const result = renderCreatePreview(patch);
      expect(result).toBe("title: Test Issue\n(no goal)");
    });
  });
});
