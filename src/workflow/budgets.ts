import { createHash } from "node:crypto";
import type { RunStage } from "../domain/contracts.js";

/** A single failed attempt reported by a stage runner. */
export interface Failure {
  stage: RunStage;
  command: string;
  exitCode: number;
  findings: string[];
}

/** The configured ceilings this tracker enforces. */
export interface BudgetLimits {
  implementation: { timeoutMinutes: number; maxAttempts: number };
  review: { timeoutMinutes: number; maxCorrectionCycles: number };
}

/** Counters the caller currently holds in persisted attempt data. */
export interface BudgetCounters {
  implementationAttempts: number;
  correctionCycles: number;
}

export type BudgetDecision =
  | "CONTINUE"
  | "BLOCK_REPEATED_FAILURE"
  | "BLOCK_BUDGET_EXHAUSTED";

export interface BudgetResult {
  decision: BudgetDecision;
  reason: string;
}

/**
 * Normalize volatile content in a failure (paths' line/column numbers,
 * compound/simple durations, timestamps, and surrounding whitespace) so two
 * tool-identical failures hash to the same fingerprint while unrelated
 * failures remain distinct. Digit runs are collapsed to `<N>` only when they
 * sit in a recognized volatile context (a `path:line` / `path:line:col`
 * locator, or a duration unit suffix); substantive numeric literals
 * elsewhere in the text (counts, expected/actual values, etc.) are left
 * untouched so two findings that differ only by such a number still produce
 * distinct fingerprints. Findings are also order-independent: they are
 * individually normalized, then sorted before hashing.
 */
function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    // ISO-ish timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TS>")
    // durations, including compound forms like "3m12s": one or more
    // digit(+unit) segments in a row, e.g. "42ms", "8371 ms", "1.2s", "3m12s"
    .replace(/\b(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)){1,}\b/gi, "<DUR>")
    // path:line or path:line:col locators (e.g. "src/a.ts:12", "src/a.ts:12:4")
    .replace(/(:)\d+(?::\d+)?\b/g, "$1<N>");
}

/**
 * Produce a stable hex SHA-256 fingerprint for a failure. Two failures that
 * differ only in volatile noise (line numbers, timing, whitespace, ordering
 * of findings) normalize to the same fingerprint; failures that differ in
 * stage, command, exit code, or substantive finding text do not.
 */
export function fingerprintFailure(failure: Failure): string {
  const normalizedFindings = failure.findings
    .map(normalizeText)
    .sort((a, b) => a.localeCompare(b));

  const canonical = JSON.stringify({
    stage: failure.stage,
    command: normalizeText(failure.command),
    exitCode: failure.exitCode,
    findings: normalizedFindings,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

function stageLimits(stage: RunStage, limits: BudgetLimits): { timeoutMinutes: number } {
  if (stage === "IMPLEMENTATION") {
    return { timeoutMinutes: limits.implementation.timeoutMinutes };
  }
  return { timeoutMinutes: limits.review.timeoutMinutes };
}

/**
 * Pure, in-memory budget tracker. Constructed fresh from the counters
 * currently held in persisted attempt data; it never reads or writes
 * storage itself. Callers persist the returned decision (and any counter
 * increments they choose to apply) between calls — this tracker only
 * remembers fingerprints seen since it was constructed, so a repeated
 * failure is detected within a single construction's lifetime (e.g. one
 * orchestration loop holding a single tracker instance across attempts).
 */
export class BudgetTracker {
  private readonly seenFingerprints = new Set<string>();

  constructor(
    private readonly counters: BudgetCounters,
    private readonly limits: BudgetLimits,
  ) {}

  /**
   * Record a failure and decide whether the run may continue, must block
   * due to a repeated (normalized) fingerprint, or must block because the
   * relevant attempt/cycle budget is exhausted.
   */
  recordFailure(failure: Failure): BudgetResult {
    const fingerprint = fingerprintFailure(failure);
    if (this.seenFingerprints.has(fingerprint)) {
      return {
        decision: "BLOCK_REPEATED_FAILURE",
        reason: `identical failure fingerprint seen again for stage ${failure.stage}`,
      };
    }
    this.seenFingerprints.add(fingerprint);

    if (failure.stage === "IMPLEMENTATION") {
      if (this.counters.implementationAttempts >= this.limits.implementation.maxAttempts) {
        return {
          decision: "BLOCK_BUDGET_EXHAUSTED",
          reason: `implementation attempts exhausted (max ${this.limits.implementation.maxAttempts})`,
        };
      }
    }

    if (failure.stage === "CORRECTION" || failure.stage === "INDEPENDENT_REVIEW") {
      if (this.counters.correctionCycles >= this.limits.review.maxCorrectionCycles) {
        return {
          decision: "BLOCK_BUDGET_EXHAUSTED",
          reason: `correction cycles exhausted (max ${this.limits.review.maxCorrectionCycles})`,
        };
      }
    }

    return { decision: "CONTINUE", reason: "within budget" };
  }

  /** Check whether elapsed time in a stage exceeds its configured deadline. */
  checkDeadline(stage: RunStage, elapsedMs: number): BudgetResult {
    const { timeoutMinutes } = stageLimits(stage, this.limits);
    const timeoutMs = timeoutMinutes * 60_000;
    if (elapsedMs > timeoutMs) {
      return {
        decision: "BLOCK_BUDGET_EXHAUSTED",
        reason: `stage ${stage} exceeded its ${timeoutMinutes}-minute deadline`,
      };
    }
    return { decision: "CONTINUE", reason: "within deadline" };
  }
}
