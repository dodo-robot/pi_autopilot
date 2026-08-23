import type { RequirementDoc } from "../reconciliation/prompt.js";

export interface SizeOk {
  ok: true;
}

export interface SizeBatch {
  docs: string[];
  estimatedTokens: number;
}

export interface SizeFail {
  ok: false;
  totalTokens: number;
  threshold: number;
  batches: SizeBatch[];
}

export type SizeCheckResult = SizeOk | SizeFail;

export function estimateTokens(docs: RequirementDoc[]): number {
  return docs.reduce((sum, doc) => sum + Math.ceil(doc.content.length / 4), 0);
}

/** Greedy bin-pack: fill each batch up to threshold before opening a new one. */
function binPack(docs: RequirementDoc[], threshold: number): SizeBatch[] {
  const batches: SizeBatch[] = [];
  let current: SizeBatch = { docs: [], estimatedTokens: 0 };
  for (const doc of docs) {
    const tokens = Math.ceil(doc.content.length / 4);
    if (current.docs.length > 0 && current.estimatedTokens + tokens > threshold) {
      batches.push(current);
      current = { docs: [], estimatedTokens: 0 };
    }
    current.docs.push(doc.path);
    current.estimatedTokens += tokens;
  }
  if (current.docs.length > 0) batches.push(current);
  return batches;
}

export function checkSize(docs: RequirementDoc[], threshold: number): SizeCheckResult {
  const totalTokens = estimateTokens(docs);
  if (totalTokens <= threshold) return { ok: true };
  return { ok: false, totalTokens, threshold, batches: binPack(docs, threshold) };
}

export function formatSizeError(result: SizeFail): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const lines: string[] = [
    `✗ Input too large to process in one pass.`,
    `  Total estimated tokens: ~${fmt(result.totalTokens)} (threshold: ${fmt(result.threshold)})`,
    ``,
    `  Suggested batches:`,
  ];
  result.batches.forEach((b, i) => {
    lines.push(`    Batch ${i + 1} (~${fmt(b.estimatedTokens)} tokens): ${b.docs.join(", ")}`);
  });
  lines.push(``, `  Run each batch separately:`);
  result.batches.forEach((b) => {
    lines.push(`    autopilot bootstrap --plan --requirements ${b.docs.join(" ")}`);
  });
  lines.push(``, `  Then apply each plan in order:`);
  result.batches.forEach((_, i) => {
    lines.push(`    autopilot bootstrap --apply <plan-id-${i + 1}>`);
  });
  return lines.join("\n");
}
