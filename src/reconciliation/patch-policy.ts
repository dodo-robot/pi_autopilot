import type {
  BacklogPatch,
  BacklogPatchType,
  PatchPolicy,
} from "../domain/reconciliation.js";

const AUTO_SAFE: ReadonlySet<BacklogPatchType> = new Set([
  "ENRICH_ISSUE",
  "ADD_DEPENDENCY",
  "CREATE_ISSUE",
]);

/**
 * Deterministic apply-safety classification for one patch, informational
 * only in this milestone (nothing is applied yet) — the seam the future
 * `apply-safe` mode reads directly. `KEEP` is a no-op, not a write, but is
 * still classified `requires-approval` here since it carries no automatic
 * action to gate; `MARK_STALE`, `NEEDS_HUMAN`, `SPLIT_ISSUE`, and
 * `MERGE_DUPLICATE` are always `requires-approval`; every additive patch
 * type is `auto-safe`. Never assigned by the LLM.
 */
export function classifyPatch(patch: BacklogPatch): PatchPolicy {
  return AUTO_SAFE.has(patch.type) ? "auto-safe" : "requires-approval";
}
