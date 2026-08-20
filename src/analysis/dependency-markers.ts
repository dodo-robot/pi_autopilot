/**
 * Shared source of truth for the dependency-marker grammars used by the
 * deterministic screen (rule 2 / BLOCKED) and the backlog analyst's
 * `resolveScreenDependencies`. These two regexes encode a cross-module
 * contract: an issue referencing a dependency that satisfies one of these
 * grammars is classified BLOCKED when that dependency is still open, and the
 * analyst uses the SAME grammars to decide which referenced issues are
 * material dependencies worth resolving. Editing one copy independently
 * would silently break the BLOCKED classification, so the grammars live
 * here exactly once.
 */

/**
 * Matches the managed refinement-section rendering of an unsatisfied
 * dependency: `- #<n> (unsatisfied)`.
 */
export const MANAGED_DEPENDENCY_PATTERN = /- #(\d+) \(unsatisfied\)/g;

/**
 * Matches an explicit dependency line at line start:
 * `depends on: #12`, `depend on #12`, `dependency: 12`, `dependency 12`.
 */
export const LINE_DEPENDENCY_PATTERN =
  /^[ \t]*(?:depends?\s+on\b|dependency)\b\s*:?\s*#?\s*(\d+)/gim;

/**
 * Extract the referenced issue number from a regex match produced by one of
 * the patterns above. Guarded so that a `noUncheckedIndexedAccess` `undefined`
 * capture can never surface as `NaN`.
 */
export function dependencyNumberFromMatch(match: RegExpMatchArray): number {
  return Number(match[1]!);
}
