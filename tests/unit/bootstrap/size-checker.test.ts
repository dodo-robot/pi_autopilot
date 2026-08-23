import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  checkSize,
  formatSizeError,
} from "../../../src/bootstrap/size-checker.js";
import type { RequirementDoc } from "../../../src/reconciliation/prompt.js";

function doc(path: string, chars: number): RequirementDoc {
  return { path, content: "a".repeat(chars) };
}

describe("estimateTokens", () => {
  it("returns 0 for empty docs", () => {
    expect(estimateTokens([])).toBe(0);
  });
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens([doc("a.md", 400)])).toBe(100);
    expect(estimateTokens([doc("a.md", 401)])).toBe(101); // ceil
  });
  it("sums across docs", () => {
    expect(estimateTokens([doc("a.md", 400), doc("b.md", 800)])).toBe(300);
  });
});

describe("checkSize", () => {
  it("returns ok:true when under threshold", () => {
    const result = checkSize([doc("a.md", 400)], 80_000);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with batches when over threshold", () => {
    // 3 docs of 120k chars each = 30k tokens each, threshold = 50k
    const docs = [
      doc("a.md", 120_000),
      doc("b.md", 120_000),
      doc("c.md", 120_000),
    ];
    const result = checkSize(docs, 50_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.totalTokens).toBe(90_000);
    expect(result.batches.length).toBeGreaterThan(1);
    // Every batch must be under threshold
    for (const batch of result.batches) {
      expect(batch.estimatedTokens).toBeLessThanOrEqual(50_000);
    }
    // Every doc must appear in exactly one batch
    const allDocs = result.batches.flatMap((b) => b.docs);
    expect(allDocs.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("formatSizeError", () => {
  it("includes total tokens, threshold, batch commands, and apply commands", () => {
    const docs = [doc("a.md", 120_000), doc("b.md", 120_000)];
    const result = checkSize(docs, 50_000);
    if (result.ok) throw new Error("unreachable");
    const msg = formatSizeError(result);
    expect(msg).toContain("Input too large");
    expect(msg).toContain("60,000");   // totalTokens
    expect(msg).toContain("50,000");   // threshold
    expect(msg).toContain("--requirements");
    expect(msg).toContain("--apply");
  });
});
