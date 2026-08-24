import { upsertManagedSection } from "../readiness/refinement-section.js";

/** Managed issue-body section owned by SPLIT_ISSUE apply, distinct from
 * the reconciliation-enrichment section (managed-section.ts) and the M1
 * execution-contract section (readiness/refinement-section.ts) so all
 * three proposals never collide inside one issue body. */
export const SPLIT_START = "<!-- autopilot-split:start -->";
export const SPLIT_END = "<!-- autopilot-split:end -->";

const SECTION_HEADING = "## Split into";

/** Render the managed "Split into" section listing every child issue by
 * number and title. Deterministic: fixed order (as given), one checklist
 * line per child. */
export function renderSplitSection(
  children: Array<{ number: number; title: string }>,
): string {
  const lines: string[] = [
    SPLIT_START,
    "",
    SECTION_HEADING,
    "",
    ...children.map((child) => `- [ ] #${child.number} ${child.title}`),
    "",
    SPLIT_END,
  ];
  return lines.join("\n");
}

/** Insert or replace the single managed "Split into" section in an issue
 * body. Original content — including any separate reconciliation or M1
 * refinement section — is always preserved. */
export function upsertSplitSection(
  body: string,
  children: Array<{ number: number; title: string }>,
): string {
  return upsertManagedSection(body, SPLIT_START, SPLIT_END, renderSplitSection(children));
}

/** True when `body`'s "Split into" section already lists a checklist line
 * for every given child title, regardless of that child's current issue
 * number. Shared by the idempotency pass (before a report is persisted)
 * and ApplyService (re-checked against live state right before a write) —
 * mirrors how `bodyAlreadyDependsOn` in apply-dependency.ts is shared
 * between the same two call sites for ADD_DEPENDENCY/REMOVE_DEPENDENCY. */
export function splitAlreadyApplied(
  body: string,
  children: ReadonlyArray<{ title: string }>,
): boolean {
  return children.every((child) => {
    const escaped = child.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linePattern = new RegExp(`- \\[ \\] #\\d+ ${escaped}(\\n|$)`);
    return linePattern.test(body);
  });
}
