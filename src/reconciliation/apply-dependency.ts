import {
  dependencyNumberFromMatch,
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
} from "../analysis/dependency-markers.js";

/** The dependency line grammar downstream `BLOCKED`/screen logic reads. */
export function renderDependencyLine(dependsOn: number): string {
  return `- #${dependsOn} (unsatisfied)`;
}

/** True when `body` already marks `dependsOn` per the shared grammar. */
export function bodyAlreadyDependsOn(body: string, dependsOn: number): boolean {
  for (const pattern of [MANAGED_DEPENDENCY_PATTERN, LINE_DEPENDENCY_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      if (dependencyNumberFromMatch(match) === dependsOn) return true;
    }
  }
  return false;
}

/**
 * Append an unsatisfied dependency to an issue body, preserving all other
 * content. The dependency is folded under a `Depends on:` block using the
 * managed dependency-marker grammar so the deterministic screen recognises
 * it and reconciliation's own idempotency pass (`bodyAlreadyDependsOn`)
 * sees it on a later run.
 */
export function appendDependencyToBody(
  body: string,
  dependsOn: number,
): string {
  const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n\n";
  const block = `Depends on:\n${renderDependencyLine(dependsOn)}`;
  return `${body}${separator}${block}`;
}
