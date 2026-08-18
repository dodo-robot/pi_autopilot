import { RunStageSchema, type RunStage } from "../domain/contracts.js";

/** Every stage a run can occupy, in declaration order. */
export const ALL_RUN_STAGES: readonly RunStage[] = RunStageSchema.options;

/** Terminal stages have no outgoing edges at all. */
export const TERMINAL_STAGES: ReadonlySet<RunStage> = new Set([
  "PR_OPEN",
  "NEEDS_REFINEMENT",
  "FAILED",
  "CANCELLED",
]);

/**
 * BLOCKED is quiescent: automatic orchestration can enter it but never
 * leaves it automatically. Only an explicit administrative `RESUME` event
 * (handled separately in {@link nextStage}) may move a run out of BLOCKED.
 */
const BLOCKED_STAGE: RunStage = "BLOCKED";

/**
 * Legal transition map: for each stage, the set of stages it is legal to
 * move to. This table is the single source of truth consulted by both
 * {@link assertTransition} (direct from/to check) and {@link nextStage}
 * (event-driven, resolves to a `to` stage and then re-uses this table).
 *
 * BLOCKED is the one stage where this table's entries are reachable only
 * through an explicit administrative RESUME event, never through automatic
 * event dispatch — see the inline comment on the BLOCKED entry below and
 * the RESUME handling in `nextStage`.
 */
const TRANSITIONS: Record<RunStage, ReadonlySet<RunStage>> = {
  PREFLIGHT: new Set(["READINESS_CHECK", "FAILED", "CANCELLED"]),
  READINESS_CHECK: new Set([
    "WORKSPACE_CREATION",
    "NEEDS_REFINEMENT",
    "FAILED",
    "CANCELLED",
  ]),
  WORKSPACE_CREATION: new Set(["IMPLEMENTATION", "FAILED", "CANCELLED"]),
  IMPLEMENTATION: new Set([
    "VERIFICATION",
    "BLOCKED",
    "NEEDS_REFINEMENT",
    "FAILED",
    "CANCELLED",
  ]),
  VERIFICATION: new Set([
    "INDEPENDENT_REVIEW",
    "IMPLEMENTATION",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ]),
  INDEPENDENT_REVIEW: new Set([
    "PUBLICATION",
    "CORRECTION",
    "NEEDS_REFINEMENT",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ]),
  CORRECTION: new Set(["IMPLEMENTATION", "BLOCKED", "FAILED", "CANCELLED"]),
  PUBLICATION: new Set(["PR_OPEN", "FAILED", "CANCELLED"]),
  PR_OPEN: new Set(),
  NEEDS_REFINEMENT: new Set(),
  // BLOCKED is quiescent for AUTOMATIC orchestration (see module doc): it has
  // no automatically-reachable outgoing edge. IMPLEMENTATION and CORRECTION
  // are still listed here (matching the brief's own `assertTransition`
  // examples for BLOCKED -> IMPLEMENTATION/CORRECTION) because they are the
  // only stages an explicit administrative RESUME event may resume into;
  // `nextStage` never reaches this table entry for BLOCKED except through
  // its dedicated RESUME branch, so no automatic event can exploit it.
  BLOCKED: new Set(["IMPLEMENTATION", "CORRECTION"]),
  FAILED: new Set(),
  CANCELLED: new Set(),
};

/**
 * Throw unless `from -> to` is a legal transition. Pure and synchronous;
 * consults only the static transition table (plus the CANCELLED escape
 * hatch, already encoded per-stage above).
 */
export function assertTransition(from: RunStage, to: RunStage): void {
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) {
    throw new Error(`illegal transition: ${from} -> ${to}`);
  }
}

/** Context supplied alongside every event fed into {@link nextStage}. */
export interface TransitionContext {
  /** The stage the run currently occupies. */
  stage?: RunStage;
  /** Number of correction cycles already consumed. */
  correctionCycles: number;
}

export type WorkflowEvent =
  | { type: "READY" }
  | { type: "READINESS_FAILED" }
  | { type: "WORKSPACE_READY" }
  | { type: "IMPLEMENTER_COMPLETED" }
  | { type: "IMPLEMENTER_BLOCKED" }
  | { type: "IMPLEMENTER_NEEDS_REFINEMENT" }
  | { type: "VERIFICATION_PASSED" }
  | { type: "VERIFICATION_FAILED" }
  | { type: "REVIEW_RESULT"; outcome: "APPROVED" | "CHANGES_REQUESTED" | "PRODUCT_AMBIGUITY" | "FAILED" }
  | { type: "CORRECTION_STARTED" }
  | { type: "PUBLISHED" }
  | { type: "FATAL_ERROR" }
  | { type: "CANCELLED" }
  | { type: "RESUME"; resumeTo: "IMPLEMENTATION" | "CORRECTION" };

/**
 * Resolve the next stage for an explicit event fired while a run occupies
 * `context.stage`. Never infers success from missing data: every advance
 * requires an explicit, recognized event for the current stage, and the
 * resulting edge is always re-validated against the same legal transition
 * table used by {@link assertTransition}.
 *
 * `context.stage` is optional only for the CHANGES_REQUESTED case shown in
 * the spec (`nextStage({ type: "REVIEW_RESULT", outcome: "CHANGES_REQUESTED" }, { correctionCycles: 0 })`);
 * when omitted, INDEPENDENT_REVIEW is assumed since REVIEW_RESULT is only
 * ever fired from that stage.
 */
export function nextStage(event: WorkflowEvent, context: TransitionContext): RunStage {
  const from = context.stage ?? "INDEPENDENT_REVIEW";

  if (event.type === "RESUME") {
    if (from !== BLOCKED_STAGE) {
      throw new Error(`illegal transition: ${from} -> ${event.resumeTo} (RESUME only applies from BLOCKED)`);
    }
    // RESUME is the sole legal exit from BLOCKED; validated directly rather
    // than through TRANSITIONS (which intentionally lists no BLOCKED edges).
    return event.resumeTo;
  }

  if (from === BLOCKED_STAGE) {
    throw new Error(`illegal transition: ${from} has no automatic outgoing edge for event ${event.type} (requires RESUME)`);
  }

  if (event.type === "CANCELLED") {
    assertTransition(from, "CANCELLED");
    return "CANCELLED";
  }

  if (event.type === "FATAL_ERROR") {
    assertTransition(from, "FAILED");
    return "FAILED";
  }

  const to = resolveTarget(event, from, context);
  assertTransition(from, to);
  return to;
}

function resolveTarget(event: WorkflowEvent, from: RunStage, context: TransitionContext): RunStage {
  switch (event.type) {
    case "READY":
      if (from !== "READINESS_CHECK") break;
      return "WORKSPACE_CREATION";
    case "READINESS_FAILED":
      if (from !== "READINESS_CHECK") break;
      return "NEEDS_REFINEMENT";
    case "WORKSPACE_READY":
      if (from !== "WORKSPACE_CREATION") break;
      return "IMPLEMENTATION";
    case "IMPLEMENTER_COMPLETED":
      if (from !== "IMPLEMENTATION") break;
      return "VERIFICATION";
    case "IMPLEMENTER_BLOCKED":
      if (from !== "IMPLEMENTATION") break;
      return "BLOCKED";
    case "IMPLEMENTER_NEEDS_REFINEMENT":
      if (from !== "IMPLEMENTATION") break;
      return "NEEDS_REFINEMENT";
    case "VERIFICATION_PASSED":
      if (from !== "VERIFICATION") break;
      return "INDEPENDENT_REVIEW";
    case "VERIFICATION_FAILED":
      if (from !== "VERIFICATION") break;
      return "IMPLEMENTATION";
    case "REVIEW_RESULT":
      if (from !== "INDEPENDENT_REVIEW") break;
      return resolveReviewResult(event.outcome);
    case "CORRECTION_STARTED":
      if (from !== "CORRECTION") break;
      return "IMPLEMENTATION";
    case "PUBLISHED":
      if (from !== "PUBLICATION") break;
      return "PR_OPEN";
  }
  throw new Error(`illegal transition: ${from} has no edge for event ${event.type}`);
}

/**
 * Map a reviewer outcome to its target stage. Whether a CHANGES_REQUESTED
 * outcome can actually afford another correction cycle is a budget
 * decision, not a transition-legality decision: {@link BudgetTracker} (see
 * `src/workflow/budgets.ts`) is responsible for deciding CONTINUE vs
 * BLOCK_BUDGET_EXHAUSTED before this event is ever raised. This function
 * always resolves CHANGES_REQUESTED to CORRECTION, matching the spec's
 * `nextStage({ type: "REVIEW_RESULT", outcome: "CHANGES_REQUESTED" }, { correctionCycles: 0 })` example.
 */
function resolveReviewResult(
  outcome: "APPROVED" | "CHANGES_REQUESTED" | "PRODUCT_AMBIGUITY" | "FAILED",
): RunStage {
  switch (outcome) {
    case "APPROVED":
      return "PUBLICATION";
    case "CHANGES_REQUESTED":
      return "CORRECTION";
    case "PRODUCT_AMBIGUITY":
      return "NEEDS_REFINEMENT";
    case "FAILED":
      return "FAILED";
  }
}
