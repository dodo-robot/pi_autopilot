import type { GitHubIssue } from "../github/github-adapter.js";
import type { ScreenDecision } from "../domain/backlog.js";

export const REFINEMENT_START = "<!-- autopilot-refinement:start -->";
export const REFINEMENT_END = "<!-- autopilot-refinement:end -->";

/** A referenced issue whose satisfaction the screen checks (resolved by the analyst). */
export interface ScreenDependency {
  issue: number;
  satisfied: boolean;
}

/** Pure screen input. The analyst resolves dependency states before calling. */
export interface ScreenInput {
  issue: GitHubIssue;
  dependencies: ScreenDependency[];
}

/** Unresolved-decision phrases that mark a body as AMBIGUOUS (case-insensitive). */
const AMBIGUOUS_PHRASES = [
  "which behavior",
  "either ... or",
  "not sure whether",
  "choose one",
  "tbd:",
  "open question",
] as const;

/** Determines whether any explicit dependency marker in the body references a
 * number present in `dependencies` with `satisfied === false`. */
function hasUnsatisfiedDependencyMarker(
  body: string,
  dependencies: ScreenDependency[],
): boolean {
  const unsatisfiedNumbers = new Set(
    dependencies
      .filter((dep) => dep.satisfied === false)
      .map((dep) => dep.issue),
  );
  if (unsatisfiedNumbers.size === 0) return false;

  // Managed refinement-section rendering: `- #<n> (unsatisfied)`
  const managedPattern = /- #(\d+) \(unsatisfied\)/g;
  for (const match of body.matchAll(managedPattern)) {
    const num = Number(match[1]);
    if (unsatisfiedNumbers.has(num)) return true;
  }

  // Explicit dependency line at line start:
  // `depends on: #12`, `depend on #12`, `dependency: 12`, `dependency 12`.
  const linePattern = /^[ \t]*(?:depends?\s+on\b|dependency)\b\s*:?\s*#?\s*(\d+)/gim;
  for (const match of body.matchAll(linePattern)) {
    const num = Number(match[1]);
    if (unsatisfiedNumbers.has(num)) return true;
  }

  return false;
}

/** True if the line matches an objective-ish heading like `## Goal`,
 * `### Objective`, or `Summary` (optionally `#`-prefixed). */
function isObjectiveHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return /^(?:#+\s*)?(?:goal|objective|summary)\b/i.test(trimmed);
}

/** Rule 5 objective-ish statement: a non-empty line under a heading matching
 * the objective pattern, OR the first 200 chars contain at least one word and
 * a literal `##`. */
function hasObjective(body: string): boolean {
  const headingMatch = body
    .split(/\r?\n/)
    .some((line) => isObjectiveHeadingLine(line));
  if (headingMatch) return true;

  const first200 = body.slice(0, 200);
  const hasWord = /\w/.test(first200);
  const hasDoubleHash = first200.includes("##");
  return hasWord && hasDoubleHash;
}

/** True if the body contains at least one `- [ ]` acceptance-criteria marker. */
function hasAcceptanceCriteria(body: string): boolean {
  return body.includes("- [ ]");
}

/**
 * Deterministic heuristic classification of one issue body as a
 * fast, no-Pi pre-filter. The result is advisory for the analyst's refiner
 * banding; the deterministic readiness gate remains authoritative for any
 * issue a refiner actually creates a contract for.
 */
export function screenIssue(input: ScreenInput): ScreenDecision {
  const { issue, dependencies } = input;
  const body = issue.body ?? "";

  // Rule 1: SKIPPED — empty body and no title.
  if (body.trim().length === 0 && issue.title.trim().length === 0) {
    return { classification: "SKIPPED", reasons: ["unresolvable issue"] };
  }

  // Rule 2: BLOCKED — an unsatisfied dependency with an explicit marker.
  if (hasUnsatisfiedDependencyMarker(body, dependencies)) {
    return { classification: "BLOCKED", reasons: ["blocked by unsatisfied dependency"] };
  }

  const lowerBody = body.toLowerCase();

  // Rule 3: AMBIGUOUS — unresolved-decision phrase.
  const ambiguityPhrase = AMBIGUOUS_PHRASES.find((phrase) =>
    lowerBody.includes(phrase),
  );
  if (ambiguityPhrase !== undefined) {
    return {
      classification: "AMBIGUOUS",
      reasons: ["product ambiguity signal detected"],
    };
  }

  // Rule 4: READY — full managed execution contract.
  if (body.includes(REFINEMENT_START) && body.includes(REFINEMENT_END)) {
    return { classification: "READY", reasons: ["has managed execution contract"] };
  }

  // Rule 5: CANDIDATE — some spec signal but no full contract.
  if (hasAcceptanceCriteria(body) && hasObjective(body)) {
    return {
      classification: "CANDIDATE",
      reasons: ["partially specified — candidate for refiner"],
    };
  }

  // Rule 6: NEEDS_REFINEMENT — otherwise.
  return {
    classification: "NEEDS_REFINEMENT",
    reasons: ["lacks objective and acceptance criteria"],
  };
}
