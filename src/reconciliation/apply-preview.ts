import type { ReconciledPatch } from "../domain/reconciliation.js";
import { renderDependencyLine } from "./apply-dependency.js";
import { renderUnifiedDiff } from "../readiness/refinement-section.js";

export type MenuAnswer = "apply" | "skip" | "all" | "abort";

/** Render the diff between an issue's current body and the exact proposed body. */
export function renderEnrichPreview(currentBody: string, proposedBody: string): string {
  return renderUnifiedDiff(currentBody, proposedBody);
}

/** Render the one dependency line an ADD_DEPENDENCY will insert. */
export function renderDependencyPreview(
  currentBody: string,
  dependsOn: number,
): string {
  return `${renderDependencyLine(dependsOn)}`;
}

/** Render the one dependency line a REMOVE_DEPENDENCY will delete. */
export function renderRemoveDependencyPreview(
  currentBody: string,
  dependsOn: number,
): string {
  return `remove: ${renderDependencyLine(dependsOn)}`;
}

/** Render a compact human summary for a CREATE_ISSUE. */
export function renderCreatePreview(
  patch: Extract<ReconciledPatch, { type: "CREATE_ISSUE" }>,
): string {
  const enrichment = patch.spec.enrichment;
  const goal = enrichment.goal.trim();
  return `title: ${patch.spec.title}\n${goal === "" ? "(no goal)" : goal}`;
}

/** Render a compact human summary for a SPLIT_ISSUE: the parent issue and
 * every child's title + goal. */
export function renderSplitPreview(
  patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
): string {
  const lines = [`split #${patch.issue} into ${patch.children.length} issues:`];
  for (const child of patch.children) {
    const goal = child.enrichment.goal.trim();
    lines.push(`- ${child.title}: ${goal === "" ? "(no goal)" : goal}`);
  }
  return lines.join("\n");
}

/** Render a compact human summary for a MERGE_DUPLICATE: which issue is
 * kept and which one will be commented on and closed. */
export function renderMergeDuplicatePreview(
  patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
): string {
  return `keep #${patch.keep}; close #${patch.duplicate} as a duplicate`;
}

/**
 * Prompt for one of apply / skip / all / abort. Injected write/read for
 * tests; default reads/writes from process stdio. Blank input always
 * defaults to "skip" (a stray Enter never applies).
 */
export async function confirmMenu(
  prompt: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  readLine: () => Promise<string> = () =>
    new Promise((resolve) => {
      process.stdin.once("data", (data) => resolve(data.toString()));
    }),
): Promise<MenuAnswer> {
  for (;;) {
    write(prompt);
    const raw = (await readLine()).trim().toLowerCase();
    
    // Check for valid answers (single letters and word forms)
    if (raw === "y" || raw === "yes" || raw === "apply") return "apply";
    if (raw === "n" || raw === "no" || raw === "skip") return "skip";
    if (raw === "a" || raw === "all") return "all";
    if (raw === "q" || raw === "quit" || raw === "abort") return "abort";
    
    // Blank input always returns skip (binding safety invariant)
    if (raw === "") return "skip";
    
    // Invalid answer: prompt to retry
    write(`invalid answer; [y] apply / [n] skip / [a] all / [q] abort\n`);
  }
}
