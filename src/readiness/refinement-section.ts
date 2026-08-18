import type { TaskDraft } from "../domain/contracts.js";

/** Managed issue-body section delimiters owned by autopilot. */
export const REFINEMENT_START = "<!-- autopilot-refinement:start -->";
export const REFINEMENT_END = "<!-- autopilot-refinement:end -->";

/**
 * Raised when an issue body contains ambiguous refinement markers.
 * Autopilot must never guess which section to replace.
 */
export class RefinementSectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinementSectionError";
  }
}

/** Fixed rendering order required by the design. */
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

const CONTRACT_HEADING = "## Autonomous execution contract";

/**
 * Render the managed execution-contract section for a task draft. The
 * render is fully deterministic: fixed section order, stable formatting,
 * and explicit `None.` for empty collections.
 */
export function renderRefinementSection(draft: TaskDraft): string {
  const lines: string[] = [
    REFINEMENT_START,
    "",
    CONTRACT_HEADING,
    "",
    "### Goal",
    "",
    draft.objective.trim() === "" ? "None." : draft.objective.trim(),
    "",
    "### Context",
    "",
    draft.context.trim() === "" ? "None." : draft.context.trim(),
    "",
    "### Expected behavior",
    "",
    ...bulletOrNone(draft.expectedBehavior),
    "",
    "### Acceptance criteria",
    "",
    ...(draft.acceptanceCriteria.length === 0
      ? ["None."]
      : draft.acceptanceCriteria.map(
          (criterion) => `- [ ] **${criterion.id}** ${criterion.text}`,
        )),
    "",
    "### Constraints",
    "",
    ...bulletOrNone(draft.constraints),
    "",
    "### Non-goals",
    "",
    ...bulletOrNone(draft.nonGoals),
    "",
    "### Validation",
    "",
    ...bulletOrNone(draft.validation),
    "",
    "### Dependencies",
    "",
    ...(draft.dependencies.length === 0
      ? ["None."]
      : draft.dependencies.map(
          (dependency) =>
            `- #${dependency.issue} (${dependency.satisfied ? "satisfied" : "unsatisfied"})`,
        )),
    "",
    "### References",
    "",
    ...bulletOrNone(draft.canonicalReferences),
    "",
    REFINEMENT_END,
  ];
  return lines.join("\n");
}

/**
 * Insert or replace the single managed refinement section in an issue body.
 * Original content is always preserved. Ambiguous marker layouts (duplicate
 * or unbalanced markers) raise {@link RefinementSectionError} instead of
 * guessing. Accepts either a {@link TaskDraft} or the strict
 * {@link TaskSnapshot} subtype.
 */
export function upsertRefinementSection(
  body: string,
  draft: TaskDraft,
): string {
  const rendered = renderRefinementSection(draft);
  const startCount = countOccurrences(body, REFINEMENT_START);
  const endCount = countOccurrences(body, REFINEMENT_END);

  if (startCount > 1 || endCount > 1) {
    throw new RefinementSectionError(
      "issue body contains multiple autopilot-refinement markers; refusing to guess which section to replace",
    );
  }
  if (startCount !== endCount) {
    throw new RefinementSectionError(
      "issue body contains unbalanced autopilot-refinement markers; refusing to guess",
    );
  }
  if (startCount === 0) {
    const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n\n";
    return `${body}${separator}${rendered}`;
  }

  const startIndex = body.indexOf(REFINEMENT_START);
  const endIndex = body.indexOf(
    REFINEMENT_END,
    startIndex + REFINEMENT_START.length,
  );
  if (endIndex === -1) {
    throw new RefinementSectionError(
      "autopilot-refinement end marker appears before the start marker; refusing to guess",
    );
  }
  const before = body.slice(0, startIndex);
  const after = body.slice(endIndex + REFINEMENT_END.length);
  return `${before}${rendered}${after}`;
}

/** A single line of an LCS-derived diff. */
export interface DiffLine {
  type: "equal" | "remove" | "add";
  text: string;
}

/**
 * Line-oriented diff via longest-common-subsequence on lines. Issue bodies
 * are small, so the quadratic dynamic program is fine.
 */
export function diffLines(original: string, updated: string): DiffLine[] {
  const a = original.split("\n");
  const b = updated.split("\n");
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const rowBelow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (rowBelow[j + 1] ?? 0) + 1
          : Math.max(rowBelow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const lineA = a[i] ?? "";
    const lineB = b[j] ?? "";
    if (lineA === lineB) {
      ops.push({ type: "equal", text: lineA });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ type: "remove", text: lineA });
      i += 1;
    } else {
      ops.push({ type: "add", text: lineB });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", text: a[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j] ?? "" });
    j += 1;
  }
  return ops;
}

/**
 * Render a unified diff between the original and proposed issue bodies.
 * Emits a single hunk with canonical `---`/`+++` headers and `@@` range.
 */
export function renderUnifiedDiff(original: string, updated: string): string {
  const ops = diffLines(original, updated);
  const lines: string[] = ["--- original", "+++ proposed"];

  const changeCount = ops.filter((op) => op.type !== "equal").length;
  if (changeCount === 0) {
    lines.push("(no changes)");
    return lines.join("\n");
  }

  const firstChange = ops.findIndex((op) => op.type !== "equal");
  const originalCount = ops.filter((op) => op.type !== "add").length;
  const updatedCount = ops.filter((op) => op.type !== "remove").length;
  lines.push(`@@ -${firstChange + 1},${originalCount} +${firstChange + 1},${updatedCount} @@`);
  for (const op of ops) {
    if (op.type === "equal") lines.push(` ${op.text}`);
    else if (op.type === "remove") lines.push(`-${op.text}`);
    else lines.push(`+${op.text}`);
  }
  return lines.join("\n");
}

function bulletOrNone(entries: string[]): string[] {
  if (entries.length === 0) return ["None."];
  return entries.map((entry) => `- ${entry}`);
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
