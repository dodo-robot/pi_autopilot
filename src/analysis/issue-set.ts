import type { GitHubPort, GitHubIssue } from "../github/github-adapter.js";
import type { RepositoryRef } from "../domain/contracts.js";

export interface ResolvedIssueSet {
  /** Issues actually fetched and analyzed. */
  issues: GitHubIssue[];
  /** Input refs we could not fetch (e.g. requested number absent on origin). */
  missing: number[];
  /** 1-based line numbers of checklist bullets that were prose-only (epic parse). */
  unresolvedProseLines: number[];
}

/** Markdown checkbox prefix: `- [ ]`, `- [x]`, `- [X]`, with flexible spacing. */
const CHECKBOX_PREFIX = /^-\s*\[[ xX]\]\s+/;

/** Qualified issue reference: `<owner>/<repo>#<number>`. */
const QUALIFIED_REF = /([^/\s]+)\/([^/\s]+)#(\d+)/g;

/** Bare issue reference: `#<number>` (also catches the trailing `#<n>` of `##<n>`). */
const BARE_REF = /#(\d+)\b/g;

/**
 * True iff the body is an epic: it contains `- [ ]` checklist items AND at
 * least one item references an issue (`#\d+` or `owner/repo#\d+`).
 */
export function isEpicBody(body: string): boolean {
  const lines = body.split(/\r?\n/);
  let hasChecklist = false;
  let hasIssueRef = false;
  for (const line of lines) {
    if (!CHECKBOX_PREFIX.test(line)) continue;
    hasChecklist = true;
    const remainder = line.replace(CHECKBOX_PREFIX, "");
    if (QUALIFIED_REF.test(remainder) || BARE_REF.test(remainder)) {
      hasIssueRef = true;
      break;
    }
  }
  return hasChecklist && hasIssueRef;
}

/**
 * Extract issue references from an epic body's Markdown checklist lines.
 *
 * For each `- [ ]` line, run two ordered passes over the post-prefix text:
 *   1. Qualified refs (`owner/repo#n`) first.
 *   2. Bare refs (`#n`) on a copy with step-1 matches removed, so a
 *      qualified ref never double-counts. This also captures `##102`.
 *
 * Every reference is collected into `issues` (upstream de-dupes); a line
 * that yields at least one reference is "resolved". A checklist line with no
 * reference is prose-only and its 1-based line number is recorded in
 * `unresolvedProseLines`.
 */
export function collectEpicIssueRefs(body: string): {
  issues: number[];
  unresolvedProseLines: number[];
} {
  const issues: number[] = [];
  const unresolvedProseLines: number[] = [];

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!CHECKBOX_PREFIX.test(line)) continue;

    const remainder = line.replace(CHECKBOX_PREFIX, "");
    const lineIssues: number[] = [];

    // Pass 1: qualified refs, tracking their matched substrings for removal.
    const qualifiedMatches: RegExpExecArray[] = [];
    QUALIFIED_REF.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QUALIFIED_REF.exec(remainder)) !== null) {
      lineIssues.push(Number(m[3]));
      qualifiedMatches.push(m);
    }

    // Pass 2: bare refs on a copy where qualified matches are removed.
    let bareSource = remainder;
    for (const qm of qualifiedMatches) {
      bareSource = bareSource.replace(qm[0], "");
    }
    BARE_REF.lastIndex = 0;
    while ((m = BARE_REF.exec(bareSource)) !== null) {
      lineIssues.push(Number(m[1]));
    }

    if (lineIssues.length > 0) {
      issues.push(...lineIssues);
    } else {
      unresolvedProseLines.push(i + 1);
    }
  }

  return { issues, unresolvedProseLines };
}

/**
 * Fetch each requested issue via `github.getIssue`. A missing issue (the
 * port throws) is recorded in `missing` and skipped; one failure never aborts
 * the whole pass.
 */
export async function resolveIssueSet(
  refs: number[],
  _epicRef: number | null,
  github: GitHubPort,
  _repository: RepositoryRef,
): Promise<ResolvedIssueSet> {
  const issues: GitHubIssue[] = [];
  const missing: number[] = [];

  for (const ref of refs) {
    try {
      issues.push(await github.getIssue(ref));
    } catch {
      missing.push(ref);
    }
  }

  return { issues, missing, unresolvedProseLines: [] };
}
