import type { GitHubPort, GitHubIssue } from "../github/github-adapter.js";
import { GitHubError } from "../github/github-adapter.js";
import type { RepositoryRef } from "../domain/contracts.js";
import { AGENT_IN_PROGRESS_LABEL } from "./label-reconciliation.js";

/** Why a fetched issue was excluded from the analyzed set. */
export interface SkippedIssue {
  issue: number;
  reason: "closed";
}

export interface ResolvedIssueSet {
  /** Issues actually fetched and analyzed. */
  issues: GitHubIssue[];
  /** Input refs we could not fetch (e.g. requested number absent on origin). */
  missing: number[];
  /**
   * Refs that were fetched successfully but deliberately excluded from the
   * analyzed set. Reported rather than silently dropped so callers can explain
   * why a requested issue is absent from the resulting report.
   */
  skipped: SkippedIssue[];
  /** 1-based line numbers of checklist bullets that were prose-only (epic parse). */
  unresolvedProseLines: number[];
}

/** True when GitHub reports the issue as closed (state casing is not guaranteed). */
export function isClosedIssue(issue: GitHubIssue): boolean {
  return issue.state.toLowerCase() === "closed";
}

/**
 * Guard for commands that execute or mutate work on a single issue
 * (`start`, `prepare`). Such commands operate only on open, unclaimed
 * tickets: a closed issue is finished work, and an `agent:in-progress` issue
 * is already claimed by the daemon, so acting on it would duplicate a run.
 *
 * Throws with an actionable message; returns normally when the issue is
 * eligible. Label reads that fail are treated as "not claimed" so a label
 * outage cannot block all execution.
 */
export async function assertIssueActionable(
  issue: GitHubIssue,
  github: Pick<GitHubPort, "listLabels">,
): Promise<void> {
  if (isClosedIssue(issue)) {
    throw new Error(
      `issue #${String(issue.number)} is closed; autopilot only operates on open issues`,
    );
  }

  let labels: string[];
  try {
    labels = await github.listLabels(issue.number);
  } catch {
    return;
  }

  if (labels.includes(AGENT_IN_PROGRESS_LABEL)) {
    throw new Error(
      `issue #${String(issue.number)} is already claimed (${AGENT_IN_PROGRESS_LABEL}); ` +
        `wait for the active run to finish or remove the label if it is stuck`,
    );
  }
}

/** Markdown list-bullet prefix: `- ` or `* ` (with flexible leading space).
 * Covers `- [ ] / - [x]` checkboxes, `- [#174](url)` GitHub issue-link
 * bullets (the shape real Minerva epics use), and bare `- #n` bullets. */
const BULLET_PREFIX = /^\s*[-*]\s+/;

/** Qualified issue reference: `<owner>/<repo>#<number>`. */
const QUALIFIED_REF = /([^/\s]+)\/([^/\s]+)#(\d+)/g;

/** Bare issue reference: `#<number>` (also catches the trailing `#<n>` of `##<n>`). */
const BARE_REF = /#(\d+)\b/g;

/**
 * True iff the body is an epic: it contains Markdown list-bullet task items
 * (`- [ ] ...`, `- [#174](url) ...`, or `- #174 ...`) AND at least one bullet
 * references an issue (`#\d+` or `owner/repo#\d+`).
 */
export function isEpicBody(body: string): boolean {
  const lines = body.split(/\r?\n/);
  let hasChecklist = false;
  let hasIssueRef = false;
  for (const line of lines) {
    if (!BULLET_PREFIX.test(line)) continue;
    hasChecklist = true;
    const remainder = line.replace(BULLET_PREFIX, "");
    QUALIFIED_REF.lastIndex = 0;
    BARE_REF.lastIndex = 0;
    if (QUALIFIED_REF.test(remainder) || BARE_REF.test(remainder)) {
      hasIssueRef = true;
      break;
    }
  }
  return hasChecklist && hasIssueRef;
}

/**
 * Extract issue references from an epic body's Markdown list-bullet lines
 * (`- [ ] ...`, `- [#174](url) ...`, `- #174 ...`, or plain `- ...`).
 *
 * For each bullet line, run two ordered passes over the post-prefix text:
 *   1. Qualified refs (`owner/repo#n`) first.
 *   2. Bare refs (`#n`) on a copy with step-1 matches removed, so a
 *      qualified ref never double-counts. This also captures `##102` and the
 *      `#174` inside a `[#174](url)` GitHub issue link.
 *
 * Every reference is collected into `issues` (upstream de-dupes); a line
 * that yields at least one reference is "resolved". A bullet line with no
 * reference is prose-only and its 1-based line number is recorded in
 * `unresolvedProseLines`. Non-bullet lines (prose paragraphs, headings)
 * are ignored.
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
    if (!BULLET_PREFIX.test(line)) continue;

    const remainder = line.replace(BULLET_PREFIX, "");
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
 * True only for a genuine you-cannot-find-this-issue: a `GitHubError` whose
 * underlying Octokit error carries a numeric `status === 404`. Any other
 * failure — including `GitHubError`s with non-404 causes (rate-limit, auth,
 * network) and non-`GitHubError` throws — is treated as an infrastructure
 * failure and rethrown so the caller surfaces it (exit 1) rather than
 * silently recording the issue as "missing".
 */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof GitHubError)) return false;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return false;
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" && status === 404;
}

/**
 * Fetch each requested issue via `github.getIssue`. A genuinely missing issue
 * (404) is recorded in `missing` and skipped; an infrastructure failure is
 * rethrown so the command exits non-zero rather than masking the outage.
 *
 * Closed issues are excluded from `issues` and recorded in `skipped`: work is
 * only ever scoped to open tickets, and a closed issue reaching analysis can
 * otherwise be classified READY and executed.
 */
export async function resolveIssueSet(
  refs: number[],
  _epicRef: number | null,
  github: GitHubPort,
  _repository: RepositoryRef,
): Promise<ResolvedIssueSet> {
  const issues: GitHubIssue[] = [];
  const missing: number[] = [];
  const skipped: SkippedIssue[] = [];

  for (const ref of refs) {
    let issue: GitHubIssue;
    try {
      issue = await github.getIssue(ref);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      missing.push(ref);
      continue;
    }

    if (isClosedIssue(issue)) {
      skipped.push({ issue: ref, reason: "closed" });
      continue;
    }

    issues.push(issue);
  }

  return { issues, missing, skipped, unresolvedProseLines: [] };
}
