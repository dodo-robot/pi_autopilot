import {
  dependencyNumberFromMatch,
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
} from "../analysis/dependency-markers.js";
import type { BacklogPatch } from "../domain/reconciliation.js";
import { RefinementSectionError } from "../readiness/refinement-section.js";
import { upsertReconciliationSection } from "./managed-section.js";
import { splitAlreadyApplied } from "./managed-split-section.js";

interface IssueLike {
  number: number;
  title: string;
  body: string;
}

function existingDependencyNumbers(body: string): Set<number> {
  const found = new Set<number>();
  for (const pattern of [MANAGED_DEPENDENCY_PATTERN, LINE_DEPENDENCY_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      found.add(dependencyNumberFromMatch(match));
    }
  }
  return found;
}

/**
 * A second reconciliation run over an unchanged epic must not keep
 * re-proposing already-applied enrichment (design spec §7.1). Enforced
 * deterministically by diffing each proposal against the target issue's
 * CURRENT state — never left to the model to remember.
 */
export function applyIdempotencyDowngrades(
  patches: BacklogPatch[],
  issues: ReadonlyArray<IssueLike>,
): BacklogPatch[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));

  return patches.map((patch): BacklogPatch => {
    if (patch.type === "ENRICH_ISSUE") {
      const current = byNumber.get(patch.issue);
      if (current === undefined) return patch;
      try {
        const proposed = upsertReconciliationSection(current.body, patch.patch);
        if (proposed === current.body) {
          return {
            type: "KEEP",
            issue: patch.issue,
            reason: "already reflects the proposed enrichment",
          };
        }
      } catch (error) {
        if (error instanceof RefinementSectionError) {
          return {
            type: "NEEDS_HUMAN",
            issue: patch.issue,
            ambiguityType: "MISSING_CONTEXT",
            reason: `issue #${patch.issue}'s body has ambiguous managed-section markers, so the proposed enrichment cannot be safely evaluated: ${error.message}`,
            questions: [
              `Issue #${patch.issue}'s body has duplicate or unbalanced autopilot managed-section markers — please clean it up manually before this enrichment can be evaluated.`,
            ],
          };
        }
        throw error;
      }
      return patch;
    }

    if (patch.type === "ADD_DEPENDENCY") {
      const current = byNumber.get(patch.issue);
      if (current === undefined) return patch;
      if (existingDependencyNumbers(current.body).has(patch.dependsOn)) {
        return {
          type: "KEEP",
          issue: patch.issue,
          reason: `already depends on #${patch.dependsOn}`,
        };
      }
      return patch;
    }

    if (patch.type === "REMOVE_DEPENDENCY") {
      const current = byNumber.get(patch.issue);
      if (current === undefined) return patch;
      MANAGED_DEPENDENCY_PATTERN.lastIndex = 0;
      const stillPresent = [...current.body.matchAll(MANAGED_DEPENDENCY_PATTERN)].some(
        (match) => dependencyNumberFromMatch(match) === patch.dependsOn,
      );
      if (!stillPresent) {
        return {
          type: "KEEP",
          issue: patch.issue,
          reason: `dependency #${patch.dependsOn} is not recorded in managed form; nothing to remove`,
        };
      }
      return patch;
    }

    if (patch.type === "CREATE_ISSUE") {
      const normalizedTarget = patch.spec.title.trim().toLowerCase();
      const duplicate = issues.find(
        (issue) => issue.title.trim().toLowerCase() === normalizedTarget,
      );
      if (duplicate !== undefined) {
        return {
          type: "KEEP",
          issue: duplicate.number,
          reason: `an issue titled "${duplicate.title}" already exists (#${duplicate.number})`,
        };
      }
      return patch;
    }

    if (patch.type === "SPLIT_ISSUE") {
      const current = byNumber.get(patch.issue);
      if (current === undefined) return patch;
      if (splitAlreadyApplied(current.body, patch.children)) {
        return {
          type: "KEEP",
          issue: patch.issue,
          reason: "already split into the proposed children",
        };
      }
      return patch;
    }

    return patch;
  });
}
