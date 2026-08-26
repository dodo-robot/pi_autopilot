# Dedicated Verifier Role — Design

Status: Proposed (brainstormed; ready for review)

Date: 2026-08-26

## 1. Purpose

`docs/MILESTONES.md` (Backlog — "Smaller/design-level gaps") flags that
verification today is deterministic (shell commands) rather than an
independent LLM verifier session distinct from the Reviewer, so
acceptance-criteria interpretation rides entirely on the Reviewer alone.
requirements.md §9 lists Verifier as a distinct possible role from Reviewer,
and §10 requires that completion not rest on a single authority's judgment.

Today the Reviewer (`src/workflow/run-service.ts:859-941`) does two jobs in
one LLM session: judging engineering quality (`findings`) and judging
whether each acceptance criterion passed (`criteriaResults`,
`ReviewerResultSchema` at `src/domain/contracts.ts:182-202`). This spec
separates the second job into its own role — `verifier` — run as a second,
independent, transcript-free LLM session, gated behind Reviewer approval.

This is a **spec-compliance / future-proofing** change, not a response to an
observed failure: no incident has been traced to the combined role. The
Verifier **supplements** deterministic verification (which stays exactly as
it is) rather than replacing it, and runs **only after the Reviewer has
already approved** the work on engineering-quality grounds — so the added
LLM session's cost is paid only on work that already cleared review.

## 2. Scope

**In scope:**

- A new `verifier` role: schema, prompt builder, session launcher, and its
  place in the run pipeline between Reviewer approval and publication.
- Narrowing `ReviewerResultSchema` so the Reviewer no longer renders a
  criteria-by-criteria verdict — that becomes the Verifier's exclusive
  output.
- A new `ACCEPTANCE_VERIFICATION` run stage, its transitions, and a budgeted
  correction loop for a `NOT_VERIFIED` outcome (reusing the existing
  review-correction budget).
- Updating `Publisher` to source the acceptance-criteria checklist in the PR
  body from the Verifier's result instead of the Reviewer's.

**Out of scope (deferred):**

- Any change to deterministic verification (`VerificationRunner`) itself —
  it keeps running before Reviewer, unchanged.
- A separate budget/timeout config surface for the Verifier stage; it shares
  the existing `budgets.review` limits (see §6).
- Risk-tiering (running the Verifier only for some tasks) — it runs for
  every task that reaches Reviewer approval, uniformly, matching how the
  Reviewer runs uniformly today.
- Any change to `NEEDS_REPLAN`/plan-evolution handling — unrelated backlog
  item, tracked separately.

## 3. Role split

| Question | Owner today | Owner after this change |
|---|---|---|
| Is the diff engineering-quality-acceptable (structure, scope, safety)? | Reviewer | Reviewer (unchanged) |
| Did each acceptance criterion actually get satisfied? | Reviewer (`criteriaResults`) | **Verifier** |

The Reviewer keeps `findings` (code-quality issues with severity/path/line)
but stops rendering a pass/fail verdict per criterion.
`ReviewerFinding.criterionId` (`contracts.ts:165-173`) is retained as a
cross-reference — a quality finding may still note which criterion area it
touches — but it is no longer authoritative for "did this criterion pass."
It becomes optional (`z.string().optional()`, see §4), since a quality
finding need not always map to one specific criterion.

The Verifier receives the task snapshot (objective, acceptance criteria),
the diff/commits, and the deterministic verification evidence — the same
class of inputs the Reviewer gets today. It deliberately does **not**
receive the Reviewer's `findings`/outcome or the Implementer's session
transcript, so its read of "did the behavior satisfy the criteria" is
independent rather than an agreement check on the Reviewer's opinion,
consistent with requirements.md §10 ("minimum context required to evaluate
the result independently").

## 4. Schema changes (`src/domain/contracts.ts`)

```ts
export const RoleSchema = z.enum([
  "refiner",
  "implementer",
  "reviewer",
  "verifier",       // new
  "brainstormer",
  "reconciler",
  "bootstrapper",
]);
```

`ReviewerResultSchema` drops `criteriaResults` from both `APPROVED` and
`CHANGES_REQUESTED` variants. `ReviewerFindingSchema.criterionId`
(`contracts.ts:165-173`) changes from `z.string()` to
`z.string().optional()` — a doc-comment update alongside it clarifies it's
an advisory cross-reference, not a verdict.

New `VerifierFindingSchema` — deliberately smaller than
`ReviewerFindingSchema`: a Verifier finding is "this criterion's evidence
doesn't support it," not "this line of code is wrong," so it carries no
`severity`/`path`/`line`:

```ts
export const VerifierFindingSchema = z.object({
  criterionId: z.string().min(1),
  evidence: z.string().min(1),
  notes: z.string().min(1),
});
export type VerifierFinding = z.infer<typeof VerifierFindingSchema>;

export const VerifierResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("VERIFIED"),
    criteriaResults: z.array(CriterionResultSchema),
  }),
  z.object({
    outcome: z.literal("NOT_VERIFIED"),
    criteriaResults: z.array(CriterionResultSchema),
    findings: z.array(VerifierFindingSchema),
  }),
  z.object({
    outcome: z.literal("PRODUCT_AMBIGUITY"),
    reason: z.string().min(1),
  }),
  z.object({
    outcome: z.literal("FAILED"),
    reason: z.string().min(1),
  }),
]);
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
```

`RoleResultSchema` gains `VerifierResultSchema` in its union
(`contracts.ts:250-257`). `CriterionResultSchema` (`contracts.ts:175-180`) is
reused as-is — it was already role-agnostic.

## 5. Stage graph (`src/workflow/state-machine.ts`)

A new stage, `ACCEPTANCE_VERIFICATION`, is inserted between
`INDEPENDENT_REVIEW` and `PUBLICATION`:

```ts
export const RunStageSchema = z.enum([
  ...
  "INDEPENDENT_REVIEW",
  "ACCEPTANCE_VERIFICATION",  // new
  "CORRECTION",
  "PUBLICATION",
  ...
]);
```

Transition table changes:

```ts
INDEPENDENT_REVIEW: new Set([
  "ACCEPTANCE_VERIFICATION",   // was "PUBLICATION"
  "CORRECTION",
  "NEEDS_REFINEMENT",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]),
ACCEPTANCE_VERIFICATION: new Set([   // new row
  "PUBLICATION",
  "CORRECTION",
  "NEEDS_REFINEMENT",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]),
```

A new `WorkflowEvent` variant, `ACCEPTANCE_RESULT`, mirrors `REVIEW_RESULT`:

```ts
| { type: "ACCEPTANCE_RESULT"; outcome: "VERIFIED" | "NOT_VERIFIED" | "PRODUCT_AMBIGUITY" | "FAILED" }
```

resolved by a `resolveAcceptanceResult` function analogous to
`resolveReviewResult`: `VERIFIED → PUBLICATION`, `NOT_VERIFIED → CORRECTION`,
`PRODUCT_AMBIGUITY → NEEDS_REFINEMENT`, `FAILED → FAILED`.

`REVIEW_RESULT`'s own `resolveReviewResult` changes so `APPROVED` now
resolves to `ACCEPTANCE_VERIFICATION` instead of `PUBLICATION`.

## 6. Orchestration (`src/workflow/run-service.ts`)

`runImplementationLoop` currently does: implement → verify (deterministic) →
`runReview` → on approval, `publishRun`. It changes to: implement → verify →
`runReview` → on approval, `runAcceptanceVerification` → on verified,
`publishRun`:

```ts
const reviewOutcome = await this.runReview(snapshot, workspace, verification);
if (reviewOutcome.kind === "terminal") return reviewOutcome.summary;
if (reviewOutcome.kind === "approved") {
  const acceptanceOutcome = await this.runAcceptanceVerification(
    snapshot, workspace, verification,
  );
  if (acceptanceOutcome.kind === "terminal") return acceptanceOutcome.summary;
  if (acceptanceOutcome.kind === "verified") {
    return await this.publishRun(
      snapshot, workspace, workspaceManager, verification,
      reviewOutcome.review, acceptanceOutcome.result, implementerResult,
    );
  }
  // NOT_VERIFIED with budget remaining: loop back for correction.
  this.transition("IMPLEMENTATION", null);
  prompt = buildAcceptanceCorrectionPrompt(snapshot, acceptanceOutcome.result);
  continue;
}
// CHANGES_REQUESTED, as today.
```

`runAcceptanceVerification` mirrors `runReview`
(`run-service.ts:859-907`) exactly in shape: transition to
`ACCEPTANCE_VERIFICATION`, launch the Verifier, branch on outcome, persist a
`verification-acceptance-<n>.json` artifact on any non-`VERIFIED` outcome,
and on `NOT_VERIFIED` run the same budget check as
`CHANGES_REQUESTED` does today, incrementing the shared correction-cycle
counter. `launchVerifier` mirrors `launchReviewer`
(`run-service.ts:909-941`): a fresh session, its own `verifier-<n>` attempt
directory, resolved via `resolveRoleModel("verifier", overrides.verifier ?? null, config.agents, null, piDefault)` — the same per-role
model-override plumbing already used for `reviewerModel`
(`run-service.ts:160-166`).

`RunOverrides` (wherever `overrides.reviewer` is typed) gains an optional
`verifier` field.

## 7. Budgets (`src/workflow/budgets.ts`)

`BudgetTracker.recordFailure`'s existing branch —

```ts
if (failure.stage === "CORRECTION" || failure.stage === "INDEPENDENT_REVIEW") {
```

— widens to include `"ACCEPTANCE_VERIFICATION"`:

```ts
if (
  failure.stage === "CORRECTION" ||
  failure.stage === "INDEPENDENT_REVIEW" ||
  failure.stage === "ACCEPTANCE_VERIFICATION"
) {
```

**Decision:** `NOT_VERIFIED` consumes the *same* `correctionCycles` counter
and the same `limits.review.maxCorrectionCycles` ceiling as a Reviewer
`CHANGES_REQUESTED` — there is one "how many times has independent
evaluation rejected this attempt" budget, not two independently-exhausting
ones. `stageLimits` needs no change: any non-`IMPLEMENTATION` stage already
falls through to `limits.review.timeoutMinutes`, which is the correct
deadline for the Verifier session too.

## 8. Publisher (`src/publication/publisher.ts`)

`PublishInput` and `renderPrBody`'s param object gain an `acceptance:
Extract<VerifierResult, { outcome: "VERIFIED" }>` field alongside the
existing `review`. `renderPrBody`'s criteria checklist
(`publisher.ts:68-76`) switches its lookup from
`review.criteriaResults.find(...)` to `acceptance.criteriaResults.find(...)`.
A new `## Acceptance verification` body section is added (verifier outcome,
mirroring the existing `## Review` section built from `reviewSummary`); the
existing `## Review` section's text no longer implies it covers criteria
(update its wording to "engineering-quality review").

## 9. Prompts

`buildReviewerPrompt` (`run-service.ts:1119-1171`) drops the instruction to
return `criteriaResults` and the schema excerpt describing it; it keeps
asking for `findings`.

New `buildVerifierPrompt(snapshot, verification)`: presents the task
snapshot's `objective` and `acceptanceCriteria`, the diff/commits, and the
verification evidence (test output, `treeHash`); instructs the model to
return one `CriterionResult` per acceptance criterion with `notes` citing
concrete evidence, and to use `NOT_VERIFIED` with `findings` when any
criterion's evidence is insufficient. Explicitly withholds the Reviewer's
output — the prompt builder never receives it as an argument.

New `buildAcceptanceCorrectionPrompt(snapshot, verifierResult)` mirrors
`buildReviewCorrectionPrompt`, feeding the implementer the `NOT_VERIFIED`
criteria and findings for its next correction attempt.

## 10. Testing

- **`state-machine`** — new stage/edges; `INDEPENDENT_REVIEW`'s `APPROVED`
  now resolves to `ACCEPTANCE_VERIFICATION`; `ACCEPTANCE_RESULT` resolves
  correctly for all four outcomes; illegal transitions into/out of the new
  stage still throw.
- **`contracts`** — `VerifierResultSchema` parses all four outcome shapes;
  `ReviewerResultSchema` no longer accepts/requires `criteriaResults`.
- **`budgets`** — a `NOT_VERIFIED`-shaped failure on
  `ACCEPTANCE_VERIFICATION` increments and exhausts the same
  `correctionCycles` budget a `CHANGES_REQUESTED` failure does; a
  fingerprint-repeat on this stage still blocks via
  `BLOCK_REPEATED_FAILURE`.
- **`run-service` (integration, fake Pi)** — Reviewer `APPROVED` → Verifier
  `VERIFIED` → publish; Reviewer `APPROVED` → Verifier `NOT_VERIFIED` →
  correction loop → eventual `VERIFIED` or budget-exhausted `BLOCKED`;
  Verifier `PRODUCT_AMBIGUITY`/`FAILED` reach the matching terminal stage.
- **prompt builders** — `buildVerifierPrompt`'s rendered text/args never
  include the Reviewer's result (regression guard for independence);
  `buildReviewerPrompt` no longer asks for criteria verdicts.
- **`publisher`** — PR body's acceptance-criteria checklist reflects the
  Verifier's `criteriaResults`, not the Reviewer's.

## 11. Error handling

| Scenario | Behavior |
|---|---|
| Verifier session errors/returns an invalid result | Propagates as `PiRunError` to `execute()`'s top-level catch → persisted `FAILED`, same as an Implementer/Reviewer session error today. |
| `NOT_VERIFIED`, budget remaining | Loop back to `IMPLEMENTATION` via `CORRECTION`, same shape as `CHANGES_REQUESTED`. |
| `NOT_VERIFIED`, budget exhausted | `BLOCKED`, via the shared `correctionCycles` ceiling. |
| `PRODUCT_AMBIGUITY` | `NEEDS_REFINEMENT`, terminal — identical handling to the Reviewer's own `PRODUCT_AMBIGUITY`. |
| Repeated identical `NOT_VERIFIED` fingerprint | `BLOCK_REPEATED_FAILURE`, same fingerprinting mechanism already used for other stages. |

## 12. Acceptance criteria

This change is complete when:

1. A `verifier` role exists with its own schema, prompt, and session
   launcher, run only after Reviewer `APPROVED`.
2. The Reviewer's schema/prompt no longer produce or ask for a per-criterion
   verdict; the Verifier's schema/prompt are the sole source of
   `criteriaResults`.
3. `ACCEPTANCE_VERIFICATION` is a legal stage with the transitions in §5,
   and a `NOT_VERIFIED` outcome consumes the same correction-cycle budget as
   a Reviewer `CHANGES_REQUESTED`.
4. The published PR body's acceptance-criteria checklist is sourced from the
   Verifier's result.
5. The Verifier's prompt never receives the Reviewer's result or the
   Implementer's session transcript as input.
6. The full suite stays green (`npm run typecheck`, `npm test`,
   `npm run build`), with new coverage per §10.

## 13. Out of scope (deferred work list)

- Risk-tiering which tasks get a Verifier pass.
- A distinct budget/timeout ceiling for `ACCEPTANCE_VERIFICATION` separate
  from the Reviewer's.
- Any interaction with `NEEDS_REPLAN` / plan-evolution detection (tracked as
  a separate backlog item — "Broader plan-evolution detection").
- Changing what deterministic verification checks or how it runs.
