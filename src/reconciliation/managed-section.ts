import type { IssueEnrichment } from "../domain/reconciliation.js";
import { upsertManagedSection } from "../readiness/refinement-section.js";

/** Managed issue-body section owned by reconciliation, distinct from the M1
 * execution-contract section (readiness/refinement-section.ts) so the two
 * proposals never collide inside one issue body. */
export const RECONCILIATION_START = "<!-- autopilot-reconciliation:start -->";
export const RECONCILIATION_END = "<!-- autopilot-reconciliation:end -->";

const SECTION_HEADING = "## Backlog reconciliation";

function bulletOrNone(entries: string[]): string[] {
  if (entries.length === 0) return ["None."];
  return entries.map((entry) => `- ${entry}`);
}

/** Render the managed reconciliation section for a proposed issue
 * enrichment. Deterministic: fixed field order, `None.` for empty lists. */
export function renderReconciliationSection(enrichment: IssueEnrichment): string {
  const lines: string[] = [
    RECONCILIATION_START,
    "",
    SECTION_HEADING,
    "",
    "### Goal",
    "",
    enrichment.goal.trim() === "" ? "None." : enrichment.goal.trim(),
    "",
    "### Source requirements",
    "",
    ...bulletOrNone(enrichment.sourceRequirements),
    "",
    "### Acceptance criteria",
    "",
    ...bulletOrNone(enrichment.acceptanceCriteria),
    "",
    "### Constraints",
    "",
    ...bulletOrNone(enrichment.constraints),
    "",
    "### Non-goals",
    "",
    ...bulletOrNone(enrichment.nonGoals),
    "",
    "### Validation",
    "",
    ...bulletOrNone(enrichment.validation),
    "",
    "### Relevant areas",
    "",
    ...bulletOrNone(enrichment.relevantAreas),
    "",
    RECONCILIATION_END,
  ];
  return lines.join("\n");
}

/** Insert or replace the single managed reconciliation section in an issue
 * body. Original content — including any separate M1 refinement section —
 * is always preserved. */
export function upsertReconciliationSection(
  body: string,
  enrichment: IssueEnrichment,
): string {
  return upsertManagedSection(
    body,
    RECONCILIATION_START,
    RECONCILIATION_END,
    renderReconciliationSection(enrichment),
  );
}
