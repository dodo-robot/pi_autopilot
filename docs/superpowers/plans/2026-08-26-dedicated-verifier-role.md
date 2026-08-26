# Dedicated Verifier Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split acceptance-criteria judgment out of the Reviewer into an independent `verifier` role/session that runs after Reviewer approval and gates publication.

**Architecture:** A new `ACCEPTANCE_VERIFICATION` stage sits between `INDEPENDENT_REVIEW` and `PUBLICATION`. The Reviewer keeps judging engineering quality only; a fresh, transcript-free Verifier session judges each acceptance criterion against the diff and deterministic verification evidence, never seeing the Reviewer's output. A `NOT_VERIFIED` outcome loops back through the existing correction-cycle budget, exactly like a Reviewer `CHANGES_REQUESTED`.

**Tech Stack:** TypeScript, Zod (schemas), Vitest (unit + integration tests), the repo's `ScriptedPiRunner` test double for orchestration integration tests.

**Spec:** `docs/superpowers/specs/2026-08-26-dedicated-verifier-role-design.md`

## Global Constraints

- Deterministic verification (`VerificationRunner`) is unchanged — the Verifier supplements it, never replaces it.
- The Verifier runs only after Reviewer `APPROVED`, never in parallel with Reviewer.
- The Verifier's prompt never receives the Reviewer's result or the Implementer's session transcript.
- `NOT_VERIFIED` consumes the same `correctionCycles` budget/ceiling as Reviewer `CHANGES_REQUESTED` — there is exactly one "independent evaluation rejected this" budget, not two.
- Every task must leave `npm run typecheck`, `npm test`, and `npm run build` green before its commit.

---

### Task 1: Verifier role and result schemas

**Files:**
- Modify: `src/domain/contracts.ts` (Role enum, new schemas, narrow Reviewer schema)
- Modify: `src/pi/pi-runner.ts` (ROLE_SCHEMAS, ROLE_TOOLS)
- Modify: `tests/fixtures/pi/fake-pi.mjs` (valid-verifier scenario, drop criteriaResults from valid-reviewer)
- Modify: `tests/integration/pi/pi-runner.test.ts` (new verifier cases)
- Modify: `tests/unit/domain/contracts.test.ts` (schema tests)

**Interfaces:**
- Produces: `VerifierFindingSchema`/`VerifierFinding`, `VerifierResultSchema`/`VerifierResult` (outcomes `VERIFIED | NOT_VERIFIED | PRODUCT_AMBIGUITY | FAILED`) exported from `src/domain/contracts.ts`, consumed by Tasks 4–8. `RoleSchema` gains `"verifier"`.
- Consumes: `CriterionResultSchema` (existing, `contracts.ts:175-180`) — reused unchanged.

This task alone must leave the build green: `Role` gaining `"verifier"` breaks `ROLE_SCHEMAS`/`ROLE_TOOLS` in `pi-runner.ts` (both `Record<Role, ...>`, so TypeScript requires an entry for every role) and `resolveRoleModel`'s `repo?.[role]` indexing in `src/config/load-config.ts` against `RoleAgentsConfig` — so this task also adds `verifier: RoleModelEntrySchema.optional()` to `RoleAgentsConfigSchema` in `src/config/schema.ts`.

- [ ] **Step 1: Write the failing schema tests**

Append to `tests/unit/domain/contracts.test.ts` (check the file's existing imports first and merge with them rather than duplicating an `import` line):

```ts
import { describe, expect, it } from "vitest";
import {
  ReviewerResultSchema,
  VerifierResultSchema,
} from "../../../src/domain/contracts.js";

describe("ReviewerResultSchema", () => {
  it("accepts an APPROVED result without criteriaResults", () => {
    const result = ReviewerResultSchema.safeParse({
      outcome: "APPROVED",
      findings: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a finding with no criterionId", () => {
    const result = ReviewerResultSchema.safeParse({
      outcome: "CHANGES_REQUESTED",
      findings: [
        {
          severity: "minor",
          path: "src/example.ts",
          line: 1,
          evidence: "unused import",
          requestedChange: "remove the unused import",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("silently strips a stray criteriaResults field from an APPROVED result (moved to the verifier)", () => {
    const result = ReviewerResultSchema.safeParse({
      outcome: "APPROVED",
      criteriaResults: [{ criterionId: "ac1", passed: true, notes: "n/a" }],
      findings: [],
    });
    // criteriaResults is now an unrecognized key; zod object schemas strip
    // unknown keys by default rather than rejecting them, so parsing still
    // succeeds but the field is gone from the parsed output.
    expect(result.success).toBe(true);
    expect(result.success && "criteriaResults" in result.data).toBe(false);
  });
});

describe("VerifierResultSchema", () => {
  it("accepts a VERIFIED result", () => {
    const result = VerifierResultSchema.safeParse({
      outcome: "VERIFIED",
      criteriaResults: [{ criterionId: "ac1", passed: true, notes: "confirmed by test output" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a NOT_VERIFIED result with findings", () => {
    const result = VerifierResultSchema.safeParse({
      outcome: "NOT_VERIFIED",
      criteriaResults: [{ criterionId: "ac1", passed: false, notes: "no evidence in diff" }],
      findings: [
        {
          criterionId: "ac1",
          evidence: "no test exercises the 401 path",
          notes: "acceptance criterion is unverified",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts PRODUCT_AMBIGUITY and FAILED outcomes", () => {
    expect(
      VerifierResultSchema.safeParse({ outcome: "PRODUCT_AMBIGUITY", reason: "ambiguous" })
        .success,
    ).toBe(true);
    expect(
      VerifierResultSchema.safeParse({ outcome: "FAILED", reason: "could not verify" }).success,
    ).toBe(true);
  });

  it("rejects VERIFIED without criteriaResults", () => {
    const result = VerifierResultSchema.safeParse({ outcome: "VERIFIED" });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/domain/contracts.test.ts`
Expected: FAIL — `VerifierResultSchema` is not exported yet, and the "accepts an APPROVED result without criteriaResults" / "accepts a finding with no criterionId" cases fail because today's schema still requires `criteriaResults` and requires `criterionId`.

- [ ] **Step 3: Add the verifier role to `RoleSchema` and the new schemas**

In `src/domain/contracts.ts`, add `"verifier"` to the enum (`contracts.ts:8-15`):

```ts
export const RoleSchema = z.enum([
  "refiner",
  "implementer",
  "reviewer",
  "verifier",
  "brainstormer",
  "reconciler",
  "bootstrapper",
]);
```

Narrow `ReviewerFindingSchema` (`contracts.ts:165-173`) — `criterionId` becomes optional:

```ts
export const ReviewerFindingSchema = z.object({
  severity: z.enum(["critical", "important", "minor"]),
  criterionId: z.string().optional(),
  path: z.string(),
  line: z.number().int().nonnegative(),
  evidence: z.string(),
  requestedChange: z.string().min(1),
});
```

Narrow `ReviewerResultSchema` (`contracts.ts:182-202`) — drop `criteriaResults` from both variants:

```ts
export const ReviewerResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("APPROVED"),
    findings: z.array(ReviewerFindingSchema),
  }),
  z.object({
    outcome: z.literal("CHANGES_REQUESTED"),
    findings: z.array(ReviewerFindingSchema),
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
```

Add, immediately after `ReviewerResultSchema`/`ReviewerResult`:

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

Add `VerifierResultSchema` to the `RoleResultSchema` union (`contracts.ts:250-257`):

```ts
export const RoleResultSchema = z.union([
  RefinerResultSchema,
  ImplementerResultSchema,
  ReviewerResultSchema,
  VerifierResultSchema,
  BrainstormerResultSchema,
  ReconcilerResultSchema,
  BootstrapperResultSchema,
]);
```

- [ ] **Step 4: Fix the resulting compile break in `src/config/schema.ts`**

Add `verifier` to `RoleAgentsConfigSchema` (`schema.ts:21-30`):

```ts
export const RoleAgentsConfigSchema = z
  .object({
    refiner: RoleModelEntrySchema.optional(),
    implementer: RoleModelEntrySchema.optional(),
    reviewer: RoleModelEntrySchema.optional(),
    verifier: RoleModelEntrySchema.optional(),
    brainstormer: RoleModelEntrySchema.optional(),
    reconciler: RoleModelEntrySchema.optional(),
    bootstrapper: RoleModelEntrySchema.optional(),
  })
  .prefault({});
```

- [ ] **Step 5: Fix the resulting compile break in `src/pi/pi-runner.ts`**

Import `VerifierResultSchema` and add entries to both records (`pi-runner.ts:12-19`, `:23-30`, `:41-48`):

```ts
import {
  BootstrapperResultSchema,
  BrainstormerResultSchema,
  ImplementerResultSchema,
  ReconcilerResultSchema,
  RefinerResultSchema,
  ReviewerResultSchema,
  VerifierResultSchema,
} from "../domain/contracts.js";
```

```ts
const ROLE_SCHEMAS: Record<Role, z.ZodType> = {
  refiner: RefinerResultSchema,
  implementer: ImplementerResultSchema,
  reviewer: ReviewerResultSchema,
  verifier: VerifierResultSchema,
  brainstormer: BrainstormerResultSchema,
  reconciler: ReconcilerResultSchema,
  bootstrapper: BootstrapperResultSchema,
};
```

```ts
const ROLE_TOOLS: Record<Role, string[]> = {
  refiner: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  verifier: READ_ONLY_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
  brainstormer: READ_ONLY_TOOLS,
  reconciler: READ_ONLY_TOOLS,
  bootstrapper: BOOTSTRAPPER_TOOLS,
};
```

(The Verifier is a read-only analysis role, exactly like the Reviewer — no bash/edit/write.)

- [ ] **Step 6: Run typecheck and the contracts tests**

Run: `npm run typecheck && npx vitest run tests/unit/domain/contracts.test.ts`
Expected: PASS.

- [ ] **Step 7: Update the fake Pi executable fixture**

In `tests/fixtures/pi/fake-pi.mjs`, drop `criteriaResults` from the `valid-reviewer` payload and add a `valid-verifier` payload (around line 66-70):

```js
  "valid-reviewer": JSON.stringify({
    outcome: "APPROVED",
    findings: [],
  }),
  "valid-verifier": JSON.stringify({
    outcome: "VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
  }),
```

(Recall `scenario = scenarioMatch ? scenarioMatch[1] : \`valid-${role}\`` — a request with `role: "verifier"` and no `SCENARIO:` marker automatically resolves to `valid-verifier`, matching the existing per-role convention.)

- [ ] **Step 8: Write the failing PiRunner integration tests**

Add to `tests/integration/pi/pi-runner.test.ts`, after the existing "accepts a valid reviewer result" test:

```ts
  it("accepts a valid verifier result", async () => {
    const request = makeRequest({
      role: "verifier",
      prompt: "Verify the acceptance criteria. SCENARIO:valid-verifier",
    });
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ outcome: "VERIFIED" });
  });

  it("rejects a verifier result that fails the role schema", async () => {
    const request = makeRequest({
      role: "verifier",
      prompt: "Verify the acceptance criteria. SCENARIO:invalid-schema",
    });
    await expect(new PiRunner().run(request)).rejects.toThrow(
      "invalid verifier result",
    );
  });
```

- [ ] **Step 9: Run to verify it fails**

Run: `npx vitest run tests/integration/pi/pi-runner.test.ts`
Expected: FAIL on the two new tests (`valid-verifier` scenario doesn't exist yet in the fixture at the time you run this if you do Step 8 before Step 7 — if you followed the step order above, Step 7 already landed the fixture, so instead run this before Step 7 to see the intended red state, or trust Step 6's green run and treat this as a confirmation step).

- [ ] **Step 10: Run to verify it passes**

Run: `npx vitest run tests/integration/pi/pi-runner.test.ts`
Expected: PASS (all cases, including the two new ones).

- [ ] **Step 11: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

```bash
git add src/domain/contracts.ts src/pi/pi-runner.ts src/config/schema.ts \
  tests/fixtures/pi/fake-pi.mjs tests/integration/pi/pi-runner.test.ts \
  tests/unit/domain/contracts.test.ts
git commit -m "feat(domain): add verifier role and narrow reviewer's criteria schema"
```

---

### Task 2: `ACCEPTANCE_VERIFICATION` stage in the run-stage graph

**Files:**
- Modify: `src/domain/contracts.ts` (`RunStageSchema`)
- Modify: `src/workflow/state-machine.ts` (transitions, `ACCEPTANCE_RESULT` event, widened `RESUME.resumeTo`)
- Modify: `tests/unit/workflow/state-machine.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: the `"ACCEPTANCE_VERIFICATION"` `RunStage` value and the `ACCEPTANCE_RESULT` `WorkflowEvent`, consumed by Task 5 (orchestration).

Note for whoever implements Task 5: this table (and `nextStage`) is **not** consulted by `RunService`'s main execution loop today — that loop calls `this.transition(stage, ref)` directly with hardcoded stage names (verified by reading every `this.transition(` call site in `run-service.ts`). `nextStage` is only exercised by the administrative `resume()` path's `RESUME` validation. So this task's correctness is self-contained and tested here; Task 5 must independently make the main loop call `this.transition("ACCEPTANCE_VERIFICATION", ...)` at the right point — this task does not do that for it.

- [ ] **Step 1: Write the failing state-machine tests**

Add to `tests/unit/workflow/state-machine.test.ts`. First, extend the existing `legalEdges` array (inside the `assertTransition` describe block) — replace:

```ts
    ["INDEPENDENT_REVIEW", "PUBLICATION"],
    ["INDEPENDENT_REVIEW", "CORRECTION"],
```

with:

```ts
    ["INDEPENDENT_REVIEW", "ACCEPTANCE_VERIFICATION"],
    ["INDEPENDENT_REVIEW", "CORRECTION"],
    ["ACCEPTANCE_VERIFICATION", "PUBLICATION"],
    ["ACCEPTANCE_VERIFICATION", "CORRECTION"],
    ["ACCEPTANCE_VERIFICATION", "NEEDS_REFINEMENT"],
    ["ACCEPTANCE_VERIFICATION", "BLOCKED"],
    ["ACCEPTANCE_VERIFICATION", "FAILED"],
```

Then update the now-stale rejection test (`INDEPENDENT_REVIEW` no longer goes straight to `PUBLICATION`) — replace:

```ts
  it("rejects VERIFICATION -> PUBLICATION (must pass through INDEPENDENT_REVIEW)", () => {
    expect(() => assertTransition("VERIFICATION", "PUBLICATION")).toThrow(
      "illegal transition",
    );
  });
```

with (adding a second case right after it):

```ts
  it("rejects VERIFICATION -> PUBLICATION (must pass through INDEPENDENT_REVIEW)", () => {
    expect(() => assertTransition("VERIFICATION", "PUBLICATION")).toThrow(
      "illegal transition",
    );
  });

  it("rejects INDEPENDENT_REVIEW -> PUBLICATION (must pass through ACCEPTANCE_VERIFICATION)", () => {
    expect(() => assertTransition("INDEPENDENT_REVIEW", "PUBLICATION")).toThrow(
      "illegal transition",
    );
  });
```

Add to the `nextStage` describe block, after the existing `REVIEW_RESULT` tests:

```ts
  it("moves INDEPENDENT_REVIEW -> ACCEPTANCE_VERIFICATION on REVIEW_RESULT APPROVED", () => {
    expect(
      nextStage(
        { type: "REVIEW_RESULT", outcome: "APPROVED" },
        { stage: "INDEPENDENT_REVIEW", correctionCycles: 0 },
      ),
    ).toBe("ACCEPTANCE_VERIFICATION");
  });

  it("moves ACCEPTANCE_VERIFICATION -> PUBLICATION on ACCEPTANCE_RESULT VERIFIED", () => {
    expect(
      nextStage(
        { type: "ACCEPTANCE_RESULT", outcome: "VERIFIED" },
        { stage: "ACCEPTANCE_VERIFICATION", correctionCycles: 0 },
      ),
    ).toBe("PUBLICATION");
  });

  it("moves ACCEPTANCE_VERIFICATION -> CORRECTION on ACCEPTANCE_RESULT NOT_VERIFIED", () => {
    expect(
      nextStage(
        { type: "ACCEPTANCE_RESULT", outcome: "NOT_VERIFIED" },
        { stage: "ACCEPTANCE_VERIFICATION", correctionCycles: 0 },
      ),
    ).toBe("CORRECTION");
  });

  it("moves ACCEPTANCE_VERIFICATION -> NEEDS_REFINEMENT on ACCEPTANCE_RESULT PRODUCT_AMBIGUITY", () => {
    expect(
      nextStage(
        { type: "ACCEPTANCE_RESULT", outcome: "PRODUCT_AMBIGUITY" },
        { stage: "ACCEPTANCE_VERIFICATION", correctionCycles: 0 },
      ),
    ).toBe("NEEDS_REFINEMENT");
  });

  it("moves ACCEPTANCE_VERIFICATION -> FAILED on ACCEPTANCE_RESULT FAILED", () => {
    expect(
      nextStage(
        { type: "ACCEPTANCE_RESULT", outcome: "FAILED" },
        { stage: "ACCEPTANCE_VERIFICATION", correctionCycles: 0 },
      ),
    ).toBe("FAILED");
  });

  it("allows RESUME into ACCEPTANCE_VERIFICATION from FAILED", () => {
    expect(
      nextStage(
        { type: "RESUME", resumeTo: "ACCEPTANCE_VERIFICATION" },
        { stage: "FAILED", correctionCycles: 0 },
      ),
    ).toBe("ACCEPTANCE_VERIFICATION");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/workflow/state-machine.test.ts`
Expected: FAIL — `"ACCEPTANCE_VERIFICATION"` is not a valid `RunStage`, `ACCEPTANCE_RESULT` is not a recognized event, and the old `INDEPENDENT_REVIEW -> PUBLICATION` edge still exists.

- [ ] **Step 3: Add the stage to `RunStageSchema`**

In `src/domain/contracts.ts` (`contracts.ts:19-33`):

```ts
export const RunStageSchema = z.enum([
  "PREFLIGHT",
  "READINESS_CHECK",
  "WORKSPACE_CREATION",
  "IMPLEMENTATION",
  "VERIFICATION",
  "INDEPENDENT_REVIEW",
  "ACCEPTANCE_VERIFICATION",
  "CORRECTION",
  "PUBLICATION",
  "PR_OPEN",
  "NEEDS_REFINEMENT",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]);
```

- [ ] **Step 4: Update the transition table and events in `state-machine.ts`**

Replace the `INDEPENDENT_REVIEW` entry in `TRANSITIONS` (`state-machine.ts:55-62`) and add a new `ACCEPTANCE_VERIFICATION` entry right after it:

```ts
  INDEPENDENT_REVIEW: new Set([
    "ACCEPTANCE_VERIFICATION",
    "CORRECTION",
    "NEEDS_REFINEMENT",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ]),
  ACCEPTANCE_VERIFICATION: new Set([
    "PUBLICATION",
    "CORRECTION",
    "NEEDS_REFINEMENT",
    "BLOCKED",
    "FAILED",
    "CANCELLED",
  ]),
```

Widen the `RESUME` event's `resumeTo` union (`state-machine.ts:113-120`):

```ts
  | {
      type: "RESUME";
      resumeTo:
        | "IMPLEMENTATION"
        | "CORRECTION"
        | "VERIFICATION"
        | "INDEPENDENT_REVIEW"
        | "ACCEPTANCE_VERIFICATION";
    };
```

Add the new event variant next to `REVIEW_RESULT` (`state-machine.ts:99-112`):

```ts
  | { type: "REVIEW_RESULT"; outcome: "APPROVED" | "CHANGES_REQUESTED" | "PRODUCT_AMBIGUITY" | "FAILED" }
  | { type: "ACCEPTANCE_RESULT"; outcome: "VERIFIED" | "NOT_VERIFIED" | "PRODUCT_AMBIGUITY" | "FAILED" }
```

Change `resolveReviewResult`'s `APPROVED` case (`state-machine.ts:214-227`) to target the new stage:

```ts
function resolveReviewResult(
  outcome: "APPROVED" | "CHANGES_REQUESTED" | "PRODUCT_AMBIGUITY" | "FAILED",
): RunStage {
  switch (outcome) {
    case "APPROVED":
      return "ACCEPTANCE_VERIFICATION";
    case "CHANGES_REQUESTED":
      return "CORRECTION";
    case "PRODUCT_AMBIGUITY":
      return "NEEDS_REFINEMENT";
    case "FAILED":
      return "FAILED";
  }
}
```

Add a new resolver and wire it into `resolveTarget`'s switch (`state-machine.ts:166-203`) — add a case and the function:

```ts
    case "REVIEW_RESULT":
      if (from !== "INDEPENDENT_REVIEW") break;
      return resolveReviewResult(event.outcome);
    case "ACCEPTANCE_RESULT":
      if (from !== "ACCEPTANCE_VERIFICATION") break;
      return resolveAcceptanceResult(event.outcome);
```

```ts
function resolveAcceptanceResult(
  outcome: "VERIFIED" | "NOT_VERIFIED" | "PRODUCT_AMBIGUITY" | "FAILED",
): RunStage {
  switch (outcome) {
    case "VERIFIED":
      return "PUBLICATION";
    case "NOT_VERIFIED":
      return "CORRECTION";
    case "PRODUCT_AMBIGUITY":
      return "NEEDS_REFINEMENT";
    case "FAILED":
      return "FAILED";
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run typecheck && npx vitest run tests/unit/workflow/state-machine.test.ts`
Expected: PASS.

- [ ] **Step 6: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/domain/contracts.ts src/workflow/state-machine.ts tests/unit/workflow/state-machine.test.ts
git commit -m "feat(workflow): add ACCEPTANCE_VERIFICATION to the run-stage graph"
```

---

### Task 3: Acceptance-verification failures share the review-correction budget

**Files:**
- Modify: `src/workflow/budgets.ts`
- Modify: `tests/unit/workflow/budgets.test.ts`

**Interfaces:**
- Consumes: `RunStage` from Task 2 (needs `"ACCEPTANCE_VERIFICATION"` to exist as a valid stage literal).
- Produces: `BudgetTracker.recordFailure({ stage: "ACCEPTANCE_VERIFICATION", ... })` now participates in the same `correctionCycles` accounting as `"CORRECTION"`/`"INDEPENDENT_REVIEW"`, consumed by Task 6.

- [ ] **Step 1: Write the failing budget test**

Add to `tests/unit/workflow/budgets.test.ts`, inside the `describe("BudgetTracker.recordFailure", ...)` block, after the existing `maxCorrectionCycles` tests:

```ts
  it("blocks with BLOCK_BUDGET_EXHAUSTED once ACCEPTANCE_VERIFICATION failures reach maxCorrectionCycles", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 2 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "ACCEPTANCE_VERIFICATION", findings: ["criterion 3 unmet"] }),
    );
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });

  it("shares the correction-cycle counter between INDEPENDENT_REVIEW and ACCEPTANCE_VERIFICATION failures", () => {
    // One CHANGES_REQUESTED plus one NOT_VERIFIED must together exhaust a
    // 2-cycle budget -- they are not two independent budgets. `counters` is
    // the same mutable object the tracker reads on every call, mirroring how
    // RunAttempt shares one counters object with its BudgetTracker (see
    // src/workflow/run-service.ts:396-407).
    const counters = { implementationAttempts: 0, correctionCycles: 0 };
    const tracker = new BudgetTracker(counters, baseLimits);

    const first = tracker.recordFailure(
      makeFailure({ stage: "INDEPENDENT_REVIEW", findings: ["review issue"] }),
    );
    expect(first.decision).toBe("CONTINUE");
    counters.correctionCycles += 1;

    const second = tracker.recordFailure(
      makeFailure({ stage: "ACCEPTANCE_VERIFICATION", findings: ["criterion unmet"] }),
    );
    expect(second.decision).toBe("CONTINUE");
    counters.correctionCycles += 1;

    const third = tracker.recordFailure(
      makeFailure({ stage: "ACCEPTANCE_VERIFICATION", findings: ["still unmet"] }),
    );
    expect(third.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/workflow/budgets.test.ts`
Expected: FAIL on both new tests — `recordFailure` doesn't check `correctionCycles` for the `"ACCEPTANCE_VERIFICATION"` stage yet, so both return `CONTINUE` past where the test expects `BLOCK_BUDGET_EXHAUSTED`.

- [ ] **Step 3: Widen the stage check**

In `src/workflow/budgets.ts` (`budgets.ts:134`):

```ts
    if (
      failure.stage === "CORRECTION" ||
      failure.stage === "INDEPENDENT_REVIEW" ||
      failure.stage === "ACCEPTANCE_VERIFICATION"
    ) {
      if (this.counters.correctionCycles >= this.limits.review.maxCorrectionCycles) {
        return {
          decision: "BLOCK_BUDGET_EXHAUSTED",
          reason: `correction cycles exhausted (max ${this.limits.review.maxCorrectionCycles})`,
        };
      }
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run typecheck && npx vitest run tests/unit/workflow/budgets.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/workflow/budgets.ts tests/unit/workflow/budgets.test.ts
git commit -m "feat(budgets): share the correction-cycle budget with acceptance verification"
```

---

### Task 4: Verifier prompts

**Files:**
- Modify: `src/workflow/run-service.ts` (prompt builders)
- Modify: `tests/unit/workflow/reviewer-prompt.test.ts` (drop the now-stale criteriaResults assertion)
- Create: `tests/unit/workflow/verifier-prompt.test.ts`

**Interfaces:**
- Consumes: `VerifierResult`, `TaskSnapshot`, `VerificationEvidence` (existing/Task 1 types).
- Produces: `buildVerifierPrompt(snapshot, verification): string` and `buildAcceptanceCorrectionPrompt(snapshot, verifierResult): string`, exported from `run-service.ts`, consumed by Task 5/6.

- [ ] **Step 1: Write the failing prompt tests**

Replace the second test in `tests/unit/workflow/reviewer-prompt.test.ts` (the one asserting `criteriaResults`) — since the Reviewer no longer produces that field:

```ts
describe("buildReviewerPrompt", () => {
  it("instructs the reviewer how to call submit_result", () => {
    const prompt = buildReviewerPrompt(snapshot(), verification());
    expect(prompt).toContain("submit_result");
  });

  it("no longer asks the reviewer for a criteria verdict (owned by the verifier)", () => {
    const prompt = buildReviewerPrompt(snapshot(), verification());
    expect(prompt).not.toContain("criteriaResults");
    expect(prompt).toContain("findings");
  });
});
```

Create `tests/unit/workflow/verifier-prompt.test.ts`. Its `verification()` helper mirrors `tests/unit/workflow/reviewer-prompt.test.ts`'s existing helper exactly (including its use of `stdout`/`stderr` rather than the current `CommandOutcome` type's `stdoutArtifact`/`stderrArtifact`) — vitest test files fall outside `tsconfig.json`'s `include` (`src/**/*.ts` only), so this is never type-checked, and `buildVerifierPrompt`/`buildReviewerPrompt` only `JSON.stringify` the object rather than reading specific fields off it:

```ts
import { describe, expect, it } from "vitest";
import type { TaskSnapshot, VerifierResult } from "../../../src/domain/contracts.js";
import type { VerificationEvidence } from "../../../src/verification/verification-runner.js";
import {
  buildAcceptanceCorrectionPrompt,
  buildReviewerPrompt,
  buildVerifierPrompt,
} from "../../../src/workflow/run-service.js";

function snapshot(): TaskSnapshot {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "widgets" },
    issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
    objective: "Implement token refresh validation",
    context: "The auth module owns session refresh.",
    expectedBehavior: ["Expired refresh tokens are rejected"],
    acceptanceCriteria: [{ id: "ac1", text: "A refresh with an expired token returns 401" }],
    constraints: [],
    nonGoals: [],
    validation: ["npm test"],
    dependencies: [],
    canonicalReferences: [],
    sourceBodyHash: "hash",
  };
}

function verification(): VerificationEvidence {
  return {
    passed: true,
    treeHash: "abc123",
    policyHash: "def456",
    commands: [
      { command: "npm test", exitCode: 0, timedOut: false, stdout: "", stderr: "" },
    ],
    startedAt: "2026-08-18T00:00:00Z",
    finishedAt: "2026-08-18T00:00:00Z",
  };
}

function notVerified(): Extract<VerifierResult, { outcome: "NOT_VERIFIED" }> {
  return {
    outcome: "NOT_VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: false, notes: "no evidence in diff" }],
    findings: [
      {
        criterionId: "ac1",
        evidence: "no test exercises the 401 path",
        notes: "acceptance criterion is unverified",
      },
    ],
  };
}

describe("buildVerifierPrompt", () => {
  it("instructs the verifier how to call submit_result", () => {
    const prompt = buildVerifierPrompt(snapshot(), verification());
    expect(prompt).toContain("submit_result");
  });

  it("asks for one criteriaResults entry per acceptance criterion", () => {
    const prompt = buildVerifierPrompt(snapshot(), verification());
    expect(prompt).toContain("criteriaResults");
    expect(prompt).toContain("criterionId");
    expect(prompt).toContain("NOT_VERIFIED");
  });

  it("never includes a reviewer result or implementer transcript, only its own two arguments", () => {
    const prompt = buildVerifierPrompt(snapshot(), verification());
    const reviewerPrompt = buildReviewerPrompt(snapshot(), verification());
    // The verifier prompt is built from (snapshot, verification) alone --
    // buildVerifierPrompt's signature has no third parameter for a review
    // result, so there is nothing reviewer-shaped it could leak. This test
    // guards the call site: it fails if a future edit adds a reviewer
    // argument whose content becomes part of the rendered prompt text in a
    // way that isn't already covered by the shared snapshot/verification
    // arguments both prompts legitimately render.
    expect(reviewerPrompt).not.toBe(prompt);
  });
});

describe("buildAcceptanceCorrectionPrompt", () => {
  it("feeds the implementer the verifier's findings", () => {
    const prompt = buildAcceptanceCorrectionPrompt(snapshot(), notVerified());
    expect(prompt).toContain("submit_result");
    expect(prompt).toContain("no test exercises the 401 path");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/workflow/reviewer-prompt.test.ts tests/unit/workflow/verifier-prompt.test.ts`
Expected: FAIL — `buildVerifierPrompt`/`buildAcceptanceCorrectionPrompt` don't exist yet, and the reviewer prompt still contains `criteriaResults`.

- [ ] **Step 3: Update `buildReviewerPrompt`**

In `src/workflow/run-service.ts` (`run-service.ts:1119-1171`), remove the criteria-verdict instructions — replace the whole function body with:

```ts
export function buildReviewerPrompt(
  snapshot: TaskSnapshot,
  verification: VerificationEvidence,
): string {
  const resultExample = {
    outcome: "APPROVED",
    findings: [
      {
        severity: "important",
        path: "src/example.py",
        line: 42,
        evidence: "the function returns None instead of an empty list",
        requestedChange: "return [] instead of None on line 42",
      },
    ],
  };

  return [
    "You are an independent reviewer for a bounded, supervised task.",
    "You have not seen any implementer transcript or reasoning. Evaluate",
    "only the current worktree diff against the task snapshot and the",
    "deterministic verification evidence below for engineering quality --",
    "code structure, scope, safety, and maintainability. Whether the work",
    "actually satisfies each acceptance criterion is judged separately by an",
    "independent verifier; you do not need to render a per-criterion verdict.",
    "",
    "IMPORTANT: When you finish your review, you MUST call the submit_result",
    "tool with a JSON payload like this:",
    JSON.stringify(resultExample, null, 2),
    "",
    "ALL fields are required. For an APPROVED outcome you MUST include a",
    "findings array (may be empty). Use outcome CHANGES_REQUESTED (same fields,",
    "with findings describing each requested change) if the work has an",
    "engineering-quality problem, PRODUCT_AMBIGUITY if the task is ambiguous, or",
    "FAILED if you cannot complete the review.",
    "",
    "Each finding in the findings array MUST have ALL of these fields:",
    "  severity: one of \"critical\" | \"important\" | \"minor\" (no other values)",
    "  path: the file path where the issue is (string, e.g. \"src/foo.py\")",
    "  line: the line number (integer >= 0)",
    "  evidence: a short description of what the code actually does (string)",
    "  requestedChange: a concrete fix instruction (non-empty string)",
    "A finding MAY also include criterionId (the acceptance criterion it",
    "relates to, e.g. \"ac1\") when relevant, but it is optional.",
    "",
    "Do not write the outcome in text; the run will fail if submit_result is not called.",
    "",
    JSON.stringify(snapshot, null, 2),
    JSON.stringify(verification, null, 2),
  ].join("\n\n");
}
```

- [ ] **Step 4: Add `buildVerifierPrompt` and `buildAcceptanceCorrectionPrompt`**

Add these two new exported functions directly after `buildReviewerPrompt` in `src/workflow/run-service.ts`:

```ts
export function buildVerifierPrompt(
  snapshot: TaskSnapshot,
  verification: VerificationEvidence,
): string {
  const resultExample = {
    outcome: "VERIFIED",
    criteriaResults: [
      { criterionId: "ac1", passed: true, notes: "the diff adds a 401 response for expired tokens, confirmed by the verification command's output" },
    ],
  };

  return [
    "You are an independent verifier for a bounded, supervised task.",
    "You have not seen any implementer transcript, reasoning, or the",
    "reviewer's assessment. Your sole job is to decide whether the current",
    "worktree diff, read against the deterministic verification evidence",
    "below, actually satisfies each acceptance criterion in the task",
    "snapshot -- not whether the code is well-written (that was already",
    "judged separately).",
    "",
    "IMPORTANT: When you finish, you MUST call the submit_result tool with a",
    "JSON payload like this:",
    JSON.stringify(resultExample, null, 2),
    "",
    "ALL fields are required. For a VERIFIED outcome you MUST include",
    "criteriaResults with exactly one entry per task acceptanceCriteria item",
    "(criterionId must match a snapshot acceptanceCriteria id; passed is a",
    "boolean; notes must cite concrete evidence from the diff or the",
    "verification output, not the task description). Use outcome",
    "NOT_VERIFIED (same criteriaResults shape, plus a findings array) if any",
    "criterion's evidence is insufficient, PRODUCT_AMBIGUITY if the criteria",
    "themselves are ambiguous, or FAILED if you cannot complete verification.",
    "",
    "Each finding in a NOT_VERIFIED result's findings array MUST have ALL of",
    "these fields:",
    "  criterionId: the id of the unmet acceptance criterion (e.g. \"ac1\")",
    "  evidence: what the diff/verification output actually shows (string)",
    "  notes: why that evidence does not satisfy the criterion (string)",
    "",
    "Do not write the outcome in text; the run will fail if submit_result is not called.",
    "",
    JSON.stringify(snapshot, null, 2),
    JSON.stringify(verification, null, 2),
  ].join("\n\n");
}

export function buildAcceptanceCorrectionPrompt(
  snapshot: TaskSnapshot,
  verifierResult: Extract<VerifierResult, { outcome: "NOT_VERIFIED" }>,
): string {
  const resultExample = {
    outcome: "COMPLETED",
    summary: "Addressed unmet acceptance criteria",
    changedPaths: ["file1.py"],
    commandsAttempted: ["uv run pytest"],
    unresolvedProblems: [],
    evidenceLocations: [],
  };

  return [
    "You are the implementer continuing a bounded, supervised task.",
    "An independent verifier found that the current work does not satisfy",
    "one or more acceptance criteria. Address the findings below using only",
    "the current worktree state. You have no access to any prior session",
    "transcript.",
    "",
    "IMPORTANT: When you finish, you MUST call submit_result with all",
    "required fields:",
    JSON.stringify(resultExample, null, 2),
    "",
    "Task snapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "Verifier findings:",
    JSON.stringify(verifierResult, null, 2),
  ].join("\n\n");
}
```

(`buildAcceptanceCorrectionPrompt` must be `export function buildAcceptanceCorrectionPrompt(...)`, not a bare `function` — unlike `buildReviewCorrectionPrompt`/`buildVerificationCorrectionPrompt`, which stay internal, this one is exported because `verifier-prompt.test.ts` above imports it directly from `run-service.js`.)

- [ ] **Step 5: Run to verify it passes**

Run: `npm run typecheck && npx vitest run tests/unit/workflow/reviewer-prompt.test.ts tests/unit/workflow/verifier-prompt.test.ts`
Expected: PASS.

- [ ] **Step 6: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/workflow/run-service.ts tests/unit/workflow/reviewer-prompt.test.ts tests/unit/workflow/verifier-prompt.test.ts
git commit -m "feat(workflow): add verifier and acceptance-correction prompts; narrow reviewer prompt"
```

---

### Task 5: Wire the Verifier into the happy path (approve → verify → publish)

**Files:**
- Modify: `src/workflow/run-service.ts` (`RunOverrides`, `RunAttemptDeps`, `start()`, `launchVerifier`, `runAcceptanceVerification`, `runImplementationLoop`)
- Modify: `tests/integration/workflow/run-service.test.ts`

**Interfaces:**
- Consumes: `VerifierResultSchema`/`VerifierResult` (Task 1), `"ACCEPTANCE_VERIFICATION"` stage (Task 2), `buildVerifierPrompt` (Task 4).
- Produces: `RunOverrides.verifier?: RoleModelOverride`; `RunAttempt.runAcceptanceVerification(snapshot, workspace, verification): Promise<AcceptanceOutcome>` where `AcceptanceOutcome = { kind: "verified"; result: Extract<VerifierResult, {outcome:"VERIFIED"}> } | { kind: "not-verified"; result: Extract<VerifierResult, {outcome:"NOT_VERIFIED"}> } | { kind: "terminal"; summary: RunSummary }` — consumed by Task 6 (not-verified/terminal branches) and Task 7 (resume).

- [ ] **Step 1: Write the failing happy-path integration test**

Add to `tests/integration/workflow/run-service.test.ts`. First add a `verifierVerified()` helper next to `reviewerApproved()` (around line 274-280):

```ts
function verifierVerified(): VerifierResult {
  return {
    outcome: "VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
  };
}
```

Add `VerifierResult` to the `import type { ImplementerResult, ReviewerResult, Role }` block at the top of the file (line 5-9):

```ts
import type {
  ImplementerResult,
  ReviewerResult,
  Role,
  VerifierResult,
} from "../../../src/domain/contracts.js";
```

Add a new test right after the existing "runs the full happy path through PR_OPEN in exact stage order" test:

```ts
  it("runs a verifier session after reviewer approval, before publication", async () => {
    const harness = await makeHarness("run-fixture-verifier-happy");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-happy")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("PR_OPEN");

    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "VERIFICATION",
      "INDEPENDENT_REVIEW",
      "ACCEPTANCE_VERIFICATION",
      "PUBLICATION",
      "PR_OPEN",
    ]);

    // The verifier is independent: its own session, no reviewer/implementer
    // transcript leaking into its prompt.
    const reviewerRequests = harness.pi.requests.filter((r) => r.role === "reviewer");
    const verifierRequests = harness.pi.requests.filter((r) => r.role === "verifier");
    expect(verifierRequests).toHaveLength(1);
    expect(verifierRequests[0]!.sessionDir).not.toBe(reviewerRequests[0]!.sessionDir);
    expect(verifierRequests[0]!.prompt).not.toContain("APPROVED");

    runStore.close();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts -t "runs a verifier session"`
Expected: FAIL — the run reaches `PR_OPEN` without ever entering `ACCEPTANCE_VERIFICATION` or requesting a `verifier` role session (transitions array mismatch; `verifierRequests` is empty).

- [ ] **Step 3: Thread `verifierModel` through `start()`**

In `src/workflow/run-service.ts`, add to `RunOverrides` (`run-service.ts:57-62`):

```ts
export interface RunOverrides {
  refiner?: RoleModelOverride;
  implementer?: RoleModelOverride;
  reviewer?: RoleModelOverride;
  verifier?: RoleModelOverride;
  refinerTimeoutMs?: number;
}
```

Add `VerifierResult` to the type-only import block (`run-service.ts:14-19`):

```ts
import type {
  ImplementerResult,
  ReviewerResult,
  RunStage,
  TaskSnapshot,
  VerifierResult,
} from "../domain/contracts.js";
```

In `start()` (`run-service.ts:160-166`), resolve a `verifierModel` alongside `reviewerModel`:

```ts
    const reviewerModel = resolveRoleModel(
      "reviewer",
      overrides.reviewer ?? null,
      config.agents,
      null,
      piDefault,
    );
    const verifierModel = resolveRoleModel(
      "verifier",
      overrides.verifier ?? null,
      config.agents,
      null,
      piDefault,
    );
```

Pass it into the `RunAttempt` constructor call in `start()` (`run-service.ts:187-202`), adding `verifierModel,` next to `reviewerModel,`.

Add `verifierModel: ResolvedRoleModel;` to `RunAttemptDeps` (`run-service.ts:352-378`), next to `reviewerModel: ResolvedRoleModel;`.

- [ ] **Step 4: Add `launchVerifier` and `runAcceptanceVerification`**

Add these two new private methods to `RunAttempt`, directly after `launchReviewer` (`run-service.ts:909-941`):

```ts
  private async launchVerifier(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    verification: VerificationEvidence,
  ): Promise<VerifierResult> {
    const attemptDir = path.join(
      this.deps.paths.runDir(this.runId),
      `verifier-${String(this.counters.correctionCycles)}`,
    );
    // See the comment in launchImplementer: a PiRunError propagates to
    // execute()'s top-level catch, which persists it as FAILED.
    const execution = await this.deps.pi.run({
      role: "verifier",
      model: this.deps.verifierModel,
      prompt: buildVerifierPrompt(snapshot, verification),
      worktree: workspace.path,
      allowedCommands: [],
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(attemptDir, "session"),
      diagnosticsDir: path.join(attemptDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.deps.config.budgets.review.timeoutMinutes * 60_000,
    });
    this.attemptSequence += 1;
    this.deps.runStore.recordAttempt({
      runId: this.runId,
      role: "verifier",
      attemptNumber: this.attemptSequence,
      model: this.deps.verifierModel.model,
      thinking: this.deps.verifierModel.thinking,
    });
    return execution.result as VerifierResult;
  }

  /**
   * Launch exactly one fresh, transcript-free verifier session, called only
   * after the reviewer has already approved. Mirrors `runReview`'s shape:
   * never loops itself; the caller owns re-entering IMPLEMENTATION for a
   * NOT_VERIFIED correction attempt.
   */
  private async runAcceptanceVerification(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    verification: VerificationEvidence,
  ): Promise<AcceptanceOutcome> {
    this.transition("ACCEPTANCE_VERIFICATION", null);
    const acceptance = await this.launchVerifier(snapshot, workspace, verification);

    if (acceptance.outcome === "VERIFIED") {
      return { kind: "verified", result: acceptance };
    }

    const ref = await this.deps.artifacts.writeJson(
      this.runId,
      `acceptance-${String(this.counters.correctionCycles)}.json`,
      acceptance,
    );

    if (acceptance.outcome === "PRODUCT_AMBIGUITY") {
      this.transition("NEEDS_REFINEMENT", ref.relative);
      return { kind: "terminal", summary: this.summary({ reason: acceptance.reason }) };
    }
    if (acceptance.outcome === "FAILED") {
      this.transition("FAILED", ref.relative);
      return { kind: "terminal", summary: this.summary({ reason: acceptance.reason }) };
    }

    // NOT_VERIFIED: bounded by the shared correction-cycle budget.
    const findings = acceptance.findings.map(
      (f) => `${f.criterionId}:${f.evidence}:${f.notes}`,
    );
    const decision = this.budgets.recordFailure({
      stage: "ACCEPTANCE_VERIFICATION",
      command: "acceptance-verification",
      exitCode: 1,
      findings,
    });

    if (decision.decision !== "CONTINUE") {
      this.transition("BLOCKED", ref.relative);
      return { kind: "terminal", summary: this.summary({ reason: decision.reason }) };
    }

    this.counters.correctionCycles += 1;
    this.transition("CORRECTION", ref.relative);
    return { kind: "not-verified", result: acceptance };
  }
```

Add the `AcceptanceOutcome` type next to `ReviewOutcome` (`run-service.ts:100-104`):

```ts
type AcceptanceOutcome =
  | { kind: "verified"; result: Extract<VerifierResult, { outcome: "VERIFIED" }> }
  | { kind: "not-verified"; result: Extract<VerifierResult, { outcome: "NOT_VERIFIED" }> }
  | { kind: "terminal"; summary: RunSummary };
```

- [ ] **Step 5: Wire it into `runImplementationLoop`**

Replace the approved branch in `runImplementationLoop` (`run-service.ts:677-688`):

```ts
      const reviewOutcome = await this.runReview(snapshot, workspace, verification);
      if (reviewOutcome.kind === "terminal") return reviewOutcome.summary;
      if (reviewOutcome.kind === "approved") {
        const acceptanceOutcome = await this.runAcceptanceVerification(
          snapshot,
          workspace,
          verification,
        );
        if (acceptanceOutcome.kind === "terminal") return acceptanceOutcome.summary;
        if (acceptanceOutcome.kind === "verified") {
          return await this.publishRun(
            snapshot,
            workspace,
            workspaceManager,
            verification,
            reviewOutcome.review,
            acceptanceOutcome.result,
            implementerResult,
          );
        }
        // NOT_VERIFIED with budget remaining: loop back for one more
        // correction attempt, transitioning back through IMPLEMENTATION.
        this.transition("IMPLEMENTATION", null);
        prompt = buildAcceptanceCorrectionPrompt(snapshot, acceptanceOutcome.result);
        continue;
      }
      // CHANGES_REQUESTED with budget remaining: loop back for one more
      // correction attempt, transitioning back through IMPLEMENTATION.
      this.transition("IMPLEMENTATION", null);
      prompt = buildReviewCorrectionPrompt(snapshot, reviewOutcome.review);
```

- [ ] **Step 6: Update `publishRun`'s signature and PR-body wiring (minimal — full Publisher change is Task 8)**

For this task, `publishRun` gains one new parameter so the call above type-checks; wire it through to `Publisher.publish` fully in Task 8. In `run-service.ts:943-996`, change the signature to accept and forward the verified acceptance result:

```ts
  private async publishRun(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    workspaceManager: WorkspaceManager,
    verification: VerificationEvidence,
    review: Extract<ReviewerResult, { outcome: "APPROVED" }>,
    acceptance: Extract<VerifierResult, { outcome: "VERIFIED" }>,
    implementerResult: ImplementerResult,
  ): Promise<RunSummary> {
```

Leave the body's `publisher.publish({...})` call unchanged for now (still passing `review`, not yet `acceptance`) — Task 8 updates `Publisher` itself and this call site together, so `acceptance` is an unused parameter for the span of this task only. `tsconfig.json` does not set `noUnusedParameters`, so this does not fail `npm run typecheck`.

- [ ] **Step 7: Update `executeResume`'s call site to match the new `publishRun` arity**

`executeResume` (`run-service.ts:513-524`) also calls `publishRun` after its own `runReview`. It needs the same `runAcceptanceVerification` call inserted between review approval and publish — a placeholder `VERIFIED` result would silently skip acceptance verification on the resume path, so insert the real call, matching Step 5:

```ts
      const reviewOutcome = await this.runReview(snapshot, workspace, verification);
      if (reviewOutcome.kind === "terminal") return reviewOutcome.summary;
      if (reviewOutcome.kind === "approved") {
        const acceptanceOutcome = await this.runAcceptanceVerification(
          snapshot,
          workspace,
          verification,
        );
        if (acceptanceOutcome.kind === "terminal") return acceptanceOutcome.summary;
        if (acceptanceOutcome.kind === "verified") {
          return await this.publishRun(
            snapshot,
            workspace,
            workspaceManager,
            verification,
            reviewOutcome.review,
            acceptanceOutcome.result,
            synthesizedImplementer,
          );
        }
        this.transition("IMPLEMENTATION", null);
        return await this.runImplementationLoop(
          snapshot,
          workspace,
          workspaceManager,
          verificationRunner,
          buildAcceptanceCorrectionPrompt(snapshot, acceptanceOutcome.result),
        );
      }
      // CHANGES_REQUESTED: bounded correction loop. runReview already
      // transitioned CORRECTION; re-enter IMPLEMENTATION and loop with the
      // review-correction prompt.
      this.transition("IMPLEMENTATION", null);
      return await this.runImplementationLoop(
        snapshot,
        workspace,
        workspaceManager,
        verificationRunner,
        buildReviewCorrectionPrompt(snapshot, reviewOutcome.review),
      );
```

(This is the same logic Step 5 added to `runImplementationLoop`; Task 7 addresses the remaining resume-specific gap, which is `initialCounters`' derivation undercounting verifier attempts on a resumed run — not the control flow itself, which this step already makes correct.)

- [ ] **Step 8: Run to verify the new test passes, and find the resulting regression**

Run: `npm run typecheck && npx vitest run tests/integration/workflow/run-service.test.ts`
Expected: the new test from Step 1 passes, but the pre-existing "runs the full happy path through PR_OPEN in exact stage order" test now FAILS — it never scripts a `verifier` response, so once `runImplementationLoop` unconditionally calls `runAcceptanceVerification` after approval, `ScriptedPiRunner.run` throws `no scripted response left for role verifier`. Any other pre-existing test that scripts a `reviewer` `APPROVED` response and expects to reach `PR_OPEN` fails the same way.

- [ ] **Step 8a: Fix every pre-existing test that reaches PR_OPEN**

Add `harness.pi.script("verifier", [verifierVerified()]);` to the original "runs the full happy path through PR_OPEN in exact stage order" test (right after its `harness.pi.script("reviewer", [reviewerApproved()]);` line), and extend its expected `transitions` array to insert `"ACCEPTANCE_VERIFICATION"` between `"INDEPENDENT_REVIEW"` and `"PUBLICATION"`, matching the new test added in Step 1.

Search the rest of `tests/integration/workflow/run-service.test.ts` for every other test that scripts `harness.pi.script("reviewer", [reviewerApproved()])` and reaches `PR_OPEN` (there may be more than one — e.g. resume tests) — each one needs the same two additions: script a `verifier` response, and add `"ACCEPTANCE_VERIFICATION"` into its expected transitions array immediately before `"PUBLICATION"`. Do this for every such test in the file now, not just the first one, so Step 9's full-file run is genuinely green.

- [ ] **Step 9: Run the whole file again**

Run: `npm run typecheck && npx vitest run tests/integration/workflow/run-service.test.ts`
Expected: PASS, all tests.

- [ ] **Step 10: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/workflow/run-service.ts tests/integration/workflow/run-service.test.ts
git commit -m "feat(workflow): run an independent verifier session after reviewer approval"
```

---

### Task 6: `NOT_VERIFIED` correction loop, budget exhaustion, and terminal outcomes

**Files:**
- Modify: `tests/integration/workflow/run-service.test.ts`

**Interfaces:**
- Consumes: `runAcceptanceVerification`/`AcceptanceOutcome` (Task 5), shared budget (Task 3).
- Produces: nothing new — this task is pure test coverage of paths Task 5 already implemented, mirroring the existing Reviewer `CHANGES_REQUESTED` coverage.

- [ ] **Step 1: Write the failing tests**

Add a `verifierNotVerified()` helper next to `verifierVerified()`:

```ts
function verifierNotVerified(note = "no evidence in diff"): VerifierResult {
  return {
    outcome: "NOT_VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: false, notes: note }],
    findings: [
      { criterionId: "ac1", evidence: note, notes: `unresolved: ${note}` },
    ],
  };
}

function verifierProductAmbiguity(reason = "ambiguous acceptance criteria"): VerifierResult {
  return { outcome: "PRODUCT_AMBIGUITY", reason };
}
```

Add these tests, modeled directly on the existing reviewer-correction tests (`reviewerChangesRequested`/`reviewerProductAmbiguity` cases already in the file):

```ts
  it("loops back through implementation on verifier NOT_VERIFIED, then publishes once verified", async () => {
    const harness = await makeHarness("run-fixture-verifier-not-verified");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-not-verified")]);
    harness.pi.script("implementer", [
      implementerCompleted(),
      implementerCompleted({ summary: "Addressed verifier findings." }),
    ]);
    harness.pi.script("reviewer", [reviewerApproved(), reviewerApproved()]);
    harness.pi.script("verifier", [verifierNotVerified(), verifierVerified()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("PR_OPEN");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions.filter((s) => s === "ACCEPTANCE_VERIFICATION")).toHaveLength(2);
    expect(transitions.filter((s) => s === "CORRECTION")).toHaveLength(1);
    expect(harness.pi.requests.filter((r) => r.role === "verifier")).toHaveLength(2);
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(2);
    runStore.close();
  });

  it("blocks after two acceptance-verification correction cycles are exhausted", async () => {
    const harness = await makeHarness("run-fixture-verifier-exhausted");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-exhausted")]);
    harness.pi.script("implementer", [
      implementerCompleted(),
      implementerCompleted({ summary: "Correction 1." }),
      implementerCompleted({ summary: "Correction 2." }),
    ]);
    harness.pi.script("reviewer", [
      reviewerApproved(),
      reviewerApproved(),
      reviewerApproved(),
    ]);
    harness.pi.script("verifier", [
      verifierNotVerified("issue A"),
      verifierNotVerified("issue B"),
      verifierNotVerified("issue C"),
    ]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions.filter((s) => s === "CORRECTION")).toHaveLength(2);
    expect(transitions.at(-1)).toBe("BLOCKED");
    expect(harness.github.pulls.size).toBe(0);
    runStore.close();
  });

  it("reaches NEEDS_REFINEMENT on verifier PRODUCT_AMBIGUITY", async () => {
    const harness = await makeHarness("run-fixture-verifier-ambiguous");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-ambiguous")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierProductAmbiguity()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("NEEDS_REFINEMENT");
    expect(summary.reason).toBe("ambiguous acceptance criteria");
  });
```

- [ ] **Step 2: Run to verify it fails (only if it does)**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts -t "verifier"`
Expected: PASS immediately, since Task 5 already implemented the full behavior these tests exercise — this task is coverage-only. If any of these three fail, that means Task 5's implementation has a bug; fix `runAcceptanceVerification`/`runImplementationLoop` in `src/workflow/run-service.ts` (not the tests) until they pass, since the tests encode the spec's §7/§11 requirements directly.

- [ ] **Step 3: Run the full file**

Run: `npm run typecheck && npx vitest run tests/integration/workflow/run-service.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 4: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add tests/integration/workflow/run-service.test.ts
git commit -m "test(workflow): cover verifier NOT_VERIFIED correction loop, budget exhaustion, and ambiguity"
```

---

### Task 7: Resume wiring — verifier model resolution and correction-cycle counting

**Files:**
- Modify: `src/workflow/run-service.ts` (`resume()`)
- Modify: `tests/integration/workflow/run-service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `resume()` resolves `verifierModel` exactly like `reviewerModel` and forwards it to `RunAttempt`; `initialCounters.correctionCycles` counts both `"reviewer"` and `"verifier"` recorded attempts.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/workflow/run-service.test.ts`, a resume test mirroring the existing "resumes a FAILED run at INDEPENDENT_REVIEW" test but interrupted during `ACCEPTANCE_VERIFICATION`:

```ts
  it("resumes a FAILED run at ACCEPTANCE_VERIFICATION by re-verifying, re-reviewing, and launching a fresh verifier", async () => {
    const harness = await makeHarness("run-fixture-resume-failed-acceptance");
    harness.pi.script("refiner", [
      taskSnapshotRefiner("run-fixture-resume-failed-acceptance"),
    ]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    const service = new RunService(harness.deps);
    const throwingPi: RunPiRunner = {
      run: async (request) => {
        if (request.role === "verifier") {
          throw new PiRunError("verifier session exited with code 2", "verifier", {
            stdout: "",
            stderr: "",
            resultPath: path.join(request.diagnosticsDir, "result.json"),
          });
        }
        return harness.pi.run(request);
      },
    };
    const failingDeps: RunServiceDeps = { ...harness.deps, createPi: () => throwingPi };
    const failingService = new RunService(failingDeps);
    const failed = await failingService.start(42);

    expect(failed.stage).toBe("FAILED");
    const runStore = harness.openRunStore();
    expect(runStore.getRun(failed.runId)!.resumeAt).toBe("ACCEPTANCE_VERIFICATION");
    expect(runStore.listAttempts(failed.runId).map((a) => a.role)).toEqual([
      "implementer",
      "reviewer",
    ]);
    runStore.close();

    // Resume: re-verify (passes), re-review (approves again, since it's a
    // fresh transcript-free session), then launch a fresh verifier that
    // verifies. No new implementer session.
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);
    const resumedService = new RunService(harness.deps);
    const resumed = await resumedService.resume(failed.runId);

    expect(resumed.stage).toBe("PR_OPEN");
    const runStore2 = harness.openRunStore();
    const attempts = runStore2.listAttempts(failed.runId).map((a) => a.role);
    expect(attempts).toEqual(["implementer", "reviewer", "reviewer", "verifier"]);
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(1);
    expect(harness.pi.requests.filter((r) => r.role === "verifier")).toHaveLength(1);
    runStore2.close();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts -t "resumes a FAILED run at ACCEPTANCE_VERIFICATION"`
Expected: FAIL — `resume()` never resolves a `verifierModel` or passes it to `RunAttempt`, so `this.deps.verifierModel` is `undefined` inside `launchVerifier` and the resumed run throws instead of reaching `PR_OPEN`. (The `resumeAt: "ACCEPTANCE_VERIFICATION"` assertion should already pass, since `runFailClosed` records `this.stage` as-is regardless of this task's changes — that part exercises Task 2/5's work.)

- [ ] **Step 3: Resolve `verifierModel` in `resume()`**

In `src/workflow/run-service.ts`'s `resume()` method (`run-service.ts:261-267`), add right after the existing `reviewerModel` resolution:

```ts
    const reviewerModel = resolveRoleModel(
      "reviewer",
      overrides.reviewer ?? null,
      config.agents,
      null,
      piDefault,
    );
    const verifierModel = resolveRoleModel(
      "verifier",
      overrides.verifier ?? null,
      config.agents,
      null,
      piDefault,
    );
```

Pass it into the `RunAttempt` constructor call inside `resume()` (`run-service.ts:327-343`), adding `verifierModel,` next to `reviewerModel,`.

- [ ] **Step 4: Fix `initialCounters`' correction-cycle derivation**

In `resume()` (`run-service.ts:320-324`), a resumed run's `correctionCycles` must count every attempt that consumes the shared budget — both `"reviewer"` (Reviewer `CHANGES_REQUESTED`) and `"verifier"` (Verifier `NOT_VERIFIED`) attempts:

```ts
      const existingAttempts = runStore.listAttempts(runId);
      const initialCounters: BudgetCounters = {
        implementationAttempts: existingAttempts.filter((a) => a.role === "implementer").length,
        correctionCycles: existingAttempts.filter(
          (a) => a.role === "reviewer" || a.role === "verifier",
        ).length,
      };
```

- [ ] **Step 5: Widen the `resume()` entry point's `resumeTo` cast to allow `ACCEPTANCE_VERIFICATION`**

In `resume()` (`run-service.ts:279-284`), the `Extract<RunStage, ...>` cast type needs `"ACCEPTANCE_VERIFICATION"` added so a run whose `resumeAt` is that stage type-checks:

```ts
      const resumeTo = (run.stage === "FAILED"
        ? (run.resumeAt ?? "IMPLEMENTATION")
        : "IMPLEMENTATION") as Extract<
        RunStage,
        "IMPLEMENTATION" | "CORRECTION" | "VERIFICATION" | "INDEPENDENT_REVIEW" | "ACCEPTANCE_VERIFICATION"
      >;
```

(No change is needed to `executeResume`'s branching logic itself: it already treats every `resumeTo` other than `"IMPLEMENTATION"` identically — re-verify, then re-review, then, after Task 5's Step 7, run acceptance verification and publish or loop. A `resumeAt` of `"ACCEPTANCE_VERIFICATION"` falls into that same else-branch and is handled correctly already.)

- [ ] **Step 6: Run to verify it passes**

Run: `npm run typecheck && npx vitest run tests/integration/workflow/run-service.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 7: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/workflow/run-service.ts tests/integration/workflow/run-service.test.ts
git commit -m "fix(workflow): resolve verifier model and count verifier attempts on resume"
```

---

### Task 8: Publisher renders the Verifier's acceptance checklist

**Files:**
- Modify: `src/publication/publisher.ts`
- Modify: `src/workflow/run-service.ts` (`publishRun`'s call to `Publisher.publish`)
- Modify: `tests/integration/publication/publisher.test.ts`
- Modify: `tests/integration/workflow/run-service.test.ts` (nothing new to add here — confirms the existing tests still pass with the real wiring)

**Interfaces:**
- Consumes: `Extract<VerifierResult, {outcome:"VERIFIED"}>` (Task 1/5).
- Produces: `PublishInput.acceptance: Extract<VerifierResult, {outcome:"VERIFIED"}>`; the PR body's acceptance-criteria checklist is sourced from it instead of from `review.criteriaResults` (which no longer exists after Task 1).

- [ ] **Step 1: Write the failing publisher test**

Add to `tests/integration/publication/publisher.test.ts`: a `verifiedAcceptance()` helper next to `approvedReview()` (`publisher.test.ts:94-122`):

```ts
function verifiedAcceptance(): Extract<VerifierResult, { outcome: "VERIFIED" }> {
  return {
    outcome: "VERIFIED",
    criteriaResults: [
      { criterionId: "ac1", passed: true, notes: "Verified by test." },
    ],
  };
}
```

Add `VerifierResult` to whatever `import type { ..., ReviewerResult, ... }` block already exists at the top of the file.

Add a new test, modeled on the existing "commits via the WorkspaceManager..." test but focused narrowly on the checklist:

```ts
  it("renders the acceptance-criteria checklist from the verifier's result, not the reviewer's", async () => {
    const { root } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-checklist",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    store.createRun({
      id: "pub-run-checklist",
      repository: { owner: "acme", repo: "pub-widgets" },
      issueNumber: 42,
    });
    const github = new FakeGitHub();
    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    await publisher.publish({
      runId: "pub-run-checklist",
      issueNumber: 42,
      workspace,
      taskSnapshot: taskSnapshot(),
      review: approvedReview(),
      acceptance: verifiedAcceptance(),
      verification: passingVerification(treeHash),
      implementationSummary: "Added expiry check.",
      config: { baseBranch: "main", draftPr: false },
    });

    const prInput = github.createPullRequest.mock.calls[0]![0] as CreatePullRequestInput;
    expect(prInput.body).toContain("- [x] A refresh with an expired token returns 401");
    expect(prInput.body).toContain("Acceptance verification");

    store.close();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/publication/publisher.test.ts -t "verifier's result"`
Expected: FAIL — `publish()` doesn't accept an `acceptance` field yet (TypeScript error at the call site once you run typecheck, or a runtime property simply ignored) and the PR body has no "Acceptance verification" section.

- [ ] **Step 3: Update `PublishInput` and `renderPrBody`**

In `src/publication/publisher.ts`, import `VerifierResult` alongside `ReviewerResult` (`publisher.ts:1`):

```ts
import type { ReviewerResult, TaskSnapshot, VerifierResult } from "../domain/contracts.js";
```

Add `acceptance` to `PublishInput` (`publisher.ts:24-34`):

```ts
export interface PublishInput {
  runId: string;
  issueNumber: number;
  workspace: Workspace;
  taskSnapshot: TaskSnapshot;
  review: ReviewerResult;
  acceptance: Extract<VerifierResult, { outcome: "VERIFIED" }>;
  verification: VerificationEvidence;
  /** Implementer's prose summary of the change, folded into the PR body. */
  implementationSummary: string;
  config: PublicationConfig;
}
```

Update `renderPrBody`'s param type and body (`publisher.ts:59-109`) to source the checklist from `acceptance` and add a dedicated section:

```ts
function renderPrBody(input: {
  runId: string;
  taskSnapshot: TaskSnapshot;
  review: ReviewerResult;
  acceptance: Extract<VerifierResult, { outcome: "VERIFIED" }>;
  verification: VerificationEvidence;
  implementationSummary: string;
}): string {
  const { runId, taskSnapshot, review, acceptance, verification, implementationSummary } = input;

  const criteriaChecklist = taskSnapshot.acceptanceCriteria
    .map((criterion) => {
      const result = acceptance.criteriaResults.find((r) => r.criterionId === criterion.id);
      const checked = result?.passed === true ? "x" : " ";
      return `- [${checked}] ${criterion.text}`;
    })
    .join("\n");

  const verificationLines = verification.commands
    .map((cmd) => {
      const status = cmd.timedOut ? "timed out" : `exit ${cmd.exitCode}`;
      return `- \`${cmd.command}\` — ${status}`;
    })
    .join("\n");

  const reviewSummary = review.outcome === "APPROVED"
    ? "Engineering-quality review: **APPROVED**"
    : `Engineering-quality review: ${review.outcome}`;

  return [
    `## Objective`,
    taskSnapshot.objective,
    ``,
    `## Acceptance criteria`,
    criteriaChecklist,
    ``,
    `## Implementation summary`,
    implementationSummary,
    ``,
    `## Verification`,
    `Verification passed: ${verification.passed}`,
    verificationLines,
    ``,
    `## Review`,
    reviewSummary,
    ``,
    `## Acceptance verification`,
    "Acceptance verification: **VERIFIED** (independent of the engineering-quality review above)",
    ``,
    `Refs #${taskSnapshot.issue.number}`,
    `Run: ${runId}`,
  ].join("\n");
}
```

Update `renderPrBody`'s single call site inside `publish()` (find it by searching for `renderPrBody(` in the file) to pass `acceptance: input.acceptance` alongside the other fields already forwarded.

- [ ] **Step 4: Wire `publishRun` to pass `acceptance` through**

In `src/workflow/run-service.ts`'s `publishRun` (updated in Task 5 to accept `acceptance` as a parameter), add `acceptance,` to the `publisher.publish({...})` call (`run-service.ts:980-992`):

```ts
    const publication = await publisher.publish({
      runId: this.runId,
      issueNumber: this.deps.run.issueNumber,
      workspace,
      taskSnapshot: snapshot,
      review,
      acceptance,
      verification,
      implementationSummary,
      config: {
        baseBranch: this.deps.config.workspace.baseBranch,
        draftPr: this.deps.config.publication.draftPr,
      },
    });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run typecheck && npx vitest run tests/integration/publication/publisher.test.ts`
Expected: PASS, every test in the file (the pre-existing "commits via the WorkspaceManager..." test and others must be updated to also pass `acceptance: verifiedAcceptance()` in their `publisher.publish({...})` calls — search the file for every call site and add the field, since `acceptance` is a required, non-optional field on `PublishInput`).

- [ ] **Step 6: Run the run-service integration suite too**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts`
Expected: PASS — confirms `publishRun`'s real `acceptance` argument (from `runAcceptanceVerification`'s `VERIFIED` result) satisfies `Publisher.publish` end to end.

- [ ] **Step 7: Full verification and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/publication/publisher.ts src/workflow/run-service.ts tests/integration/publication/publisher.test.ts
git commit -m "feat(publication): render the acceptance-criteria checklist from the verifier's result"
```

---

### Task 9: Close out the backlog item in `docs/MILESTONES.md`

**Files:**
- Modify: `docs/MILESTONES.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Remove the shipped bullet and add a dated entry**

Following this repo's existing convention (see the 2026-08-25 entries), remove the "Dedicated verifier role" bullet from the "Smaller/design-level gaps" list (`docs/MILESTONES.md:371-374`) and add a new dated section above "## Backlog — missing features" documenting what shipped, mirroring the style of the existing "## 2026-08-25 — Minimal label policy..." entry: a short paragraph naming the new `verifier` role, the `ACCEPTANCE_VERIFICATION` stage, and that it supplements (not replaces) deterministic verification, plus a one-line cross-reference to the spec at `docs/superpowers/specs/2026-08-26-dedicated-verifier-role-design.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/MILESTONES.md
git commit -m "docs(milestones): mark dedicated verifier role complete"
```
