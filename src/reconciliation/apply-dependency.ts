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

/**
 * Remove a managed-form dependency line (`- #N (unsatisfied)`) from an
 * issue body, and remove the enclosing `Depends on:` header too if that
 * was the last bullet under it. Never touches a free-text
 * (LINE_DEPENDENCY_PATTERN) dependency line — REMOVE_DEPENDENCY only ever
 * retracts what the system itself wrote via appendDependencyToBody. A
 * no-op when the managed-form line for `dependsOn` is absent.
 */
export function removeManagedDependencyFromBody(
  body: string,
  dependsOn: number,
): string {
  const line = renderDependencyLine(dependsOn);
  const lines = body.split("\n");
  const lineIndex = lines.findIndex((entry) => entry === line);
  if (lineIndex === -1) return body;

  lines.splice(lineIndex, 1);

  // If the preceding line is now an empty "Depends on:" header (no bullet
  // lines directly below it), remove the header and the blank-line
  // separator appendDependencyToBody inserts before it.
  const headerIndex = lineIndex - 1;
  const headerIsEmpty =
    headerIndex >= 0 &&
    lines[headerIndex] === "Depends on:" &&
    (lineIndex >= lines.length || !lines[lineIndex]?.startsWith("- #"));
  if (headerIsEmpty) {
    lines.splice(headerIndex, 1);
    // Remove the blank-line separator immediately before the header, if present.
    if (headerIndex > 0 && lines[headerIndex - 1] === "") {
      lines.splice(headerIndex - 1, 1);
    }
  }

  return lines.join("\n");
}
