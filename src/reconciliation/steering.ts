import type { ApplyReport, DeclinedPatch } from "../domain/apply.js";

/**
 * Reduce a completed apply report to the steering signal for a future
 * reconcile: the human-declined patches (`skippedBy: "user"`). Excludes
 * every other outcome (gates, idempotent skips, failures, applies) and
 * drops user-skips with no target issue. Pure — never touches GitHub or I/O.
 */
export function extractDeclines(applyReport: ApplyReport): DeclinedPatch[] {
  const declines: DeclinedPatch[] = [];
  for (const entry of applyReport.entries) {
    if (entry.outcome.status !== "skipped" || entry.outcome.skippedBy !== "user") {
      continue;
    }
    if (entry.targetIssue === null) continue;
    declines.push({
      patchType: entry.patchType,
      targetIssue: entry.targetIssue,
      ...(entry.declineReason !== undefined ? { reason: entry.declineReason } : {}),
    });
  }
  return declines;
}
