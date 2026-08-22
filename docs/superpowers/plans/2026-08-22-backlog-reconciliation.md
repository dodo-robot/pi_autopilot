# Backlog Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `autopilot reconcile <epic>` — a read-only command that compares an epic's existing issues against requirement/architecture docs and the repository, and produces a structured, human-reviewable patch plan (coverage map + typed patches) via one bounded `reconciler` Pi session. Always dry-run; no GitHub mutation in this milestone.

**Architecture:** A new `src/domain/reconciliation.ts` holds the zod-validated patch/coverage contracts. A new `reconciler` Pi role reuses the exact `PiRunner`/`ROLE_SCHEMAS` gate every other role already goes through (malformed output throws `PiRunError`, same as `check`/`analyze`/`prepare`). A new `src/reconciliation/` module (prompt, managed-section, patch-policy, idempotency, service) composes existing M1/M2 pieces — `GitHubPort`, `collectEpicIssueRefs`/`resolveIssueSet`, `ArtifactStore`, the generalized managed-section upsert extracted from `refinement-section.ts` — rather than introducing parallel infrastructure. A new `commands/reconcile.ts` mirrors `analyze.ts`'s CLI wiring.

**Tech Stack:** TypeScript, Node.js, commander, zod, Octokit (`@octokit/rest`), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-backlog-reconciliation-design.md`

## Global Constraints

- `reconcile` is **read-only against GitHub** in this milestone: it must never call `updateIssueBody`, `createIssueComment`, `createPullRequest`, or `findIssueCommentByMarker` for a write purpose. Tests assert zero mutation calls (same pattern as M2's `analyze`).
- `PiRunner` already validates every role's raw output against its schema and throws `PiRunError` on anything invalid, timing out, or crashing (see `src/pi/pi-runner.ts:207-222`). Reconciliation adds **no** separate malformed-output recovery path — a `PiRunError` from the reconciler session propagates unchanged to the CLI's existing top-level catch (exit 1), exactly like `check`/`analyze`/`prepare`.
- Epic discovery reuses the existing epic-checklist mechanism (`collectEpicIssueRefs`/`resolveIssueSet` in `src/analysis/issue-set.ts`) unchanged. No GitHub Projects v2 or label-based discovery.
- A second run over an unchanged epic must downgrade previously-proposed `ENRICH_ISSUE`/`ADD_DEPENDENCY`/`CREATE_ISSUE` patches to `KEEP` (idempotency) — enforced deterministically, never left to the model.
- Reuse the existing managed-section marker-upsert logic (`upsertRefinementSection`'s ambiguous/unbalanced-marker rules) rather than duplicating it; generalize it in place.
- Keep the full M1–M3 suite green; `npm run typecheck`, `npm test`, and `npm run build` must pass after every task.
- Working branch: create and check out `feature/backlog-reconciliation` before Task 1 (`git checkout -b feature/backlog-reconciliation`). The design spec is already committed on `main`.
- `package.json.bak-untracked`, `package-lock.json.bak-untracked`, `requirements.md`, `extend_requirements.md`, and the loose `*.md` files in the repo root (`SUCCESS_SUMMARY.md`, `TESTING_NOTES.md`, etc.) are untracked scratch files — never add or modify them.

---

### Task 1: Reconciliation domain contracts

**Files:**
- Create: `src/domain/reconciliation.ts`
- Test: `tests/unit/domain/reconciliation.test.ts`

**Interfaces:**
- Consumes: nothing new (zod only).
- Produces (every later task relies on these exact names):
  - `ReconciliationAmbiguityTypeSchema` / `ReconciliationAmbiguityType` — `"ENGINEERING" | "PRODUCT" | "MISSING_CONTEXT" | "CONFLICTING_REQUIREMENTS"`.
  - `CoverageStatusSchema` / `CoverageStatus` — `"covered" | "partial" | "missing" | "implemented"`.
  - `CoverageEntrySchema` / `CoverageEntry` — `{ requirementId, description, epic, issues, status, evidence }`.
  - `IssueEnrichmentSchema` / `IssueEnrichment` — `{ goal, sourceRequirements, acceptanceCriteria, constraints, nonGoals, validation, relevantAreas }` (all arrays `string[]` except `goal: string`).
  - `IssueSpecSchema` / `IssueSpec` — `{ title, enrichment }`.
  - `PatchPolicySchema` / `PatchPolicy` — `"auto-safe" | "requires-approval"`.
  - `BacklogPatchSchema` / `BacklogPatch` — discriminated union on `type`: `KEEP`, `ENRICH_ISSUE`, `CREATE_ISSUE`, `ADD_DEPENDENCY`, `MARK_STALE`, `NEEDS_HUMAN`.
  - `BacklogPatchType` — `BacklogPatch["type"]`.
  - `ReconciledPatch` — `BacklogPatch & { policy: PatchPolicy }` (plain type, not a schema — policy is assigned deterministically after validation, never parsed from LLM output).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/domain/reconciliation.test.ts
import { describe, expect, it } from "vitest";
import {
  BacklogPatchSchema,
  CoverageEntrySchema,
} from "../../../src/domain/reconciliation.js";

const validCoverageEntry = {
  requirementId: "REQ-AUTH-001",
  description: "Users can reset a forgotten password",
  epic: 12,
  issues: [15, 16],
  status: "covered" as const,
  evidence: "issue #15 implements the reset flow",
};

describe("CoverageEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(CoverageEntrySchema.safeParse(validCoverageEntry).success).toBe(true);
  });

  it("accepts a null epic and an empty issues list for a missing requirement", () => {
    const result = CoverageEntrySchema.safeParse({
      ...validCoverageEntry,
      epic: null,
      issues: [],
      status: "missing",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status", () => {
    const result = CoverageEntrySchema.safeParse({
      ...validCoverageEntry,
      status: "done",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty requirementId", () => {
    const result = CoverageEntrySchema.safeParse({
      ...validCoverageEntry,
      requirementId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("BacklogPatchSchema", () => {
  it("accepts a KEEP patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "KEEP",
      issue: 15,
      reason: "correct and complete as-is",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an ENRICH_ISSUE patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "ENRICH_ISSUE",
      issue: 16,
      reason: "missing a testable acceptance criterion",
      patch: {
        goal: "Create a user record from a verified GitHub identity",
        sourceRequirements: ["REQ-AUTH-004"],
        acceptanceCriteria: ["A first-time GitHub login creates exactly one user row"],
        constraints: [],
        nonGoals: [],
        validation: ["npm test -- auth"],
        relevantAreas: ["src/auth/"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an ENRICH_ISSUE patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "ENRICH_ISSUE",
      issue: 16,
      reason: "",
      patch: {
        goal: "x",
        sourceRequirements: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a CREATE_ISSUE patch with a null epic", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "CREATE_ISSUE",
      epic: null,
      reason: "no existing issue covers session revocation",
      spec: {
        title: "Admin session revocation endpoint",
        enrichment: {
          goal: "An admin can revoke a user's active sessions",
          sourceRequirements: ["REQ-AUTH-009"],
          acceptanceCriteria: ["Revoking a session invalidates its refresh token"],
          constraints: [],
          nonGoals: [],
          validation: ["npm test -- sessions"],
          relevantAreas: ["src/auth/sessions.ts"],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an ADD_DEPENDENCY patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "ADD_DEPENDENCY",
      issue: 17,
      dependsOn: 15,
      reason: "session validation needs the OAuth callback in place first",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a MARK_STALE patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MARK_STALE",
      issue: 21,
      reason: "browser-stored OAuth tokens were replaced by httpOnly cookies in #40",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a NEEDS_HUMAN patch with a null issue and rejects an empty questions list", () => {
    const withQuestion = BacklogPatchSchema.safeParse({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "CONFLICTING_REQUIREMENTS",
      reason: "REQ-AUTH-002 and REQ-AUTH-011 disagree on session length",
      questions: ["Should sessions expire after 24h (REQ-AUTH-002) or 7d (REQ-AUTH-011)?"],
    });
    expect(withQuestion.success).toBe(true);

    const withoutQuestions = BacklogPatchSchema.safeParse({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "CONFLICTING_REQUIREMENTS",
      reason: "REQ-AUTH-002 and REQ-AUTH-011 disagree on session length",
      questions: [],
    });
    expect(withoutQuestions.success).toBe(false);
  });

  it("rejects an unknown patch type", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "too large",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/reconciliation.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/domain/reconciliation.ts
import { z } from "zod";

/**
 * Ambiguity classification for reconciliation NEEDS_HUMAN patches. Distinct
 * from the refiner's two-value AmbiguitySchema in contracts.ts —
 * reconciliation reasons about backlog- and requirement-level ambiguity
 * (missing context, conflicting requirement documents), not just per-issue
 * engineering/product ambiguity.
 */
export const ReconciliationAmbiguityTypeSchema = z.enum([
  "ENGINEERING",
  "PRODUCT",
  "MISSING_CONTEXT",
  "CONFLICTING_REQUIREMENTS",
]);
export type ReconciliationAmbiguityType = z.infer<
  typeof ReconciliationAmbiguityTypeSchema
>;

export const CoverageStatusSchema = z.enum([
  "covered",
  "partial",
  "missing",
  "implemented",
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/** One requirement's traceability row: requirement -> epic -> issues. */
export const CoverageEntrySchema = z.object({
  requirementId: z.string().min(1),
  description: z.string().min(1),
  epic: z.number().int().positive().nullable(),
  issues: z.array(z.number().int().positive()),
  status: CoverageStatusSchema,
  evidence: z.string(),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

/**
 * Machine-owned execution-contract content for an ENRICH_ISSUE/CREATE_ISSUE
 * patch. Rendered into the reconciliation managed section
 * (src/reconciliation/managed-section.ts); never replaces human-authored
 * issue content.
 */
export const IssueEnrichmentSchema = z.object({
  goal: z.string().min(1),
  sourceRequirements: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  validation: z.array(z.string()),
  relevantAreas: z.array(z.string()),
});
export type IssueEnrichment = z.infer<typeof IssueEnrichmentSchema>;

export const IssueSpecSchema = z.object({
  title: z.string().min(1),
  enrichment: IssueEnrichmentSchema,
});
export type IssueSpec = z.infer<typeof IssueSpecSchema>;

/** Deterministic apply-safety classification, assigned by
 * src/reconciliation/patch-policy.ts — never by the LLM. */
export const PatchPolicySchema = z.enum(["auto-safe", "requires-approval"]);
export type PatchPolicy = z.infer<typeof PatchPolicySchema>;

/**
 * Structured reconciliation patch. This milestone implements the subset
 * documented in the design spec (KEEP/ENRICH_ISSUE/CREATE_ISSUE/
 * ADD_DEPENDENCY/MARK_STALE/NEEDS_HUMAN); SPLIT_ISSUE/MERGE_DUPLICATE/
 * REMOVE_DEPENDENCY/MARK_READY are documented as a future extension of this
 * same discriminated union.
 */
export const BacklogPatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("KEEP"),
    issue: z.number().int().positive(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("ENRICH_ISSUE"),
    issue: z.number().int().positive(),
    patch: IssueEnrichmentSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("CREATE_ISSUE"),
    epic: z.number().int().positive().nullable(),
    spec: IssueSpecSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("ADD_DEPENDENCY"),
    issue: z.number().int().positive(),
    dependsOn: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("MARK_STALE"),
    issue: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("NEEDS_HUMAN"),
    issue: z.number().int().positive().nullable(),
    ambiguityType: ReconciliationAmbiguityTypeSchema,
    reason: z.string().min(1),
    questions: z.array(z.string()).min(1),
  }),
]);
export type BacklogPatch = z.infer<typeof BacklogPatchSchema>;
export type BacklogPatchType = BacklogPatch["type"];

/** A patch annotated with its deterministic apply-safety classification —
 * the shape persisted in a ReconciliationReport's `patches` array. */
export type ReconciledPatch = BacklogPatch & { policy: PatchPolicy };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/reconciliation.ts tests/unit/domain/reconciliation.test.ts
git commit -m "feat(domain): add reconciliation patch and coverage contracts"
```

---

### Task 2: Config schema — requirement doc paths and reconciler role budgets

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/unit/config/load-config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 9 relies on these exact paths):
  - `AutopilotConfig["reconciliation"]["requirementsPaths"]` — `string[] | undefined`. `undefined` when the repository's `.pi/autopilot.yaml` omits the whole `reconciliation:` section or omits `requirementsPaths` inside it — the CLI (Task 9) treats `undefined` as "no explicit configuration, fall back to `requirements.md` if present." An explicit empty array (`requirementsPaths: []`) is a real, explicit "no requirement docs" and must be preserved as `[]`, not defaulted away.
  - `AutopilotConfig["agents"]["reconciler"]` — optional `RoleModelEntry`, same shape as `agents.refiner`/`agents.implementer`/etc.
  - `AutopilotConfig["budgets"]["reconciler"]["timeoutMinutes"]` — `number`, default `10`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/config/load-config.test.ts`, inside the existing `describe("loadRepositoryConfig", ...)` block (after the last existing `it(...)`):

```typescript
  it("defaults reconciliation.requirementsPaths to undefined when the section is omitted", async () => {
    const config = await loadMinimalFixture();
    expect(config.reconciliation.requirementsPaths).toBeUndefined();
    expect(config.budgets.reconciler.timeoutMinutes).toBe(10);
  });

  it("loads an explicit reconciliation.requirementsPaths list, including an explicit empty list", async () => {
    const withPaths = await loadRepositoryConfig(
      tempConfigRoot(
        `version: 1\ncommands:\n  verify:\n    - npm test\nreconciliation:\n  requirementsPaths:\n    - requirements.md\n    - docs/architecture\n`,
      ),
    );
    expect(withPaths.reconciliation.requirementsPaths).toEqual([
      "requirements.md",
      "docs/architecture",
    ]);

    const withEmptyPaths = await loadRepositoryConfig(
      tempConfigRoot(
        `version: 1\ncommands:\n  verify:\n    - npm test\nreconciliation:\n  requirementsPaths: []\n`,
      ),
    );
    expect(withEmptyPaths.reconciliation.requirementsPaths).toEqual([]);
  });

  it("loads an agents.reconciler model entry", async () => {
    const config = await loadRepositoryConfig(
      tempConfigRoot(
        `version: 1\ncommands:\n  verify:\n    - npm test\nagents:\n  reconciler:\n    model: anthropic/claude-opus-4\n    thinking: high\n`,
      ),
    );
    expect(config.agents.reconciler).toEqual({
      model: "anthropic/claude-opus-4",
      thinking: "high",
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/config/load-config.test.ts`
Expected: FAIL — `config.reconciliation` is `undefined` (property does not exist on the parsed config), and `config.budgets.reconciler`/`config.agents.reconciler` are likewise undefined/rejected.

- [ ] **Step 3: Write the implementation**

In `src/config/schema.ts`, add `reconciler` to `RoleAgentsConfigSchema`:

```typescript
export const RoleAgentsConfigSchema = z
  .object({
    refiner: RoleModelEntrySchema.optional(),
    implementer: RoleModelEntrySchema.optional(),
    reviewer: RoleModelEntrySchema.optional(),
    brainstormer: RoleModelEntrySchema.optional(),
    reconciler: RoleModelEntrySchema.optional(),
  })
  .prefault({});
```

Add a `reconciler` budget alongside `refiner` inside the existing `budgets` object:

```typescript
  budgets: z
    .object({
      refiner: z
        .object({
          timeoutMinutes: z.number().int().positive().default(5),
        })
        .prefault({}),
      reconciler: z
        .object({
          timeoutMinutes: z.number().int().positive().default(10),
        })
        .prefault({}),
      implementation: z
        .object({
          timeoutMinutes: z.number().int().positive().default(60),
          maxAttempts: z.number().int().positive().default(3),
        })
        .prefault({}),
      review: z
        .object({
          timeoutMinutes: z.number().int().positive().default(20),
          maxCorrectionCycles: z.number().int().nonnegative().default(2),
        })
        .prefault({}),
    })
    .prefault({}),
```

Add a new top-level `reconciliation` section, after `publication` and before the closing `});` of `AutopilotConfigSchema`:

```typescript
  reconciliation: z
    .object({
      requirementsPaths: z.array(z.string()).optional(),
    })
    .prefault({}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/config/load-config.test.ts`
Expected: PASS (all cases, including the pre-existing ones — this is an additive schema change).

- [ ] **Step 5: Typecheck and full config suite**

Run: `npm run typecheck && npx vitest run tests/unit/config/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/unit/config/load-config.test.ts
git commit -m "feat(config): add reconciliation.requirementsPaths, agents.reconciler, budgets.reconciler"
```

---

### Task 3: Reconciler Pi role — contracts, PiRunner wiring, fixture scenario

**Files:**
- Modify: `src/domain/contracts.ts`
- Modify: `src/pi/pi-runner.ts`
- Modify: `tests/fixtures/pi/fake-pi.mjs`
- Create: `tests/unit/domain/reconciler-contracts.test.ts`
- Modify: `tests/integration/pi/pi-runner.test.ts`

**Interfaces:**
- Consumes: `CoverageEntrySchema`, `BacklogPatchSchema` from `src/domain/reconciliation.js` (Task 1).
- Produces (Task 8 relies on these exact names):
  - `Role` now includes `"reconciler"`.
  - `ReconcilerResultSchema` / `ReconcilerResult` — `{ coverage: CoverageEntry[]; patches: BacklogPatch[] }`.
  - `RoleResultSchema` union includes `ReconcilerResultSchema`.
  - `PiRunner.run({ role: "reconciler", ... })` validates against `ReconcilerResultSchema` and grants the same `READ_ONLY_TOOLS` (`read`, `grep`, `find`, `ls`, `submit_result`) the refiner/reviewer/brainstormer roles already get — no `bash`/`edit`/`write`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/domain/reconciler-contracts.test.ts
import { describe, expect, it } from "vitest";
import { ReconcilerResultSchema, RoleSchema } from "../../../src/domain/contracts.js";

describe("RoleSchema", () => {
  it("accepts reconciler as a valid role", () => {
    expect(RoleSchema.safeParse("reconciler").success).toBe(true);
  });
});

describe("ReconcilerResultSchema", () => {
  it("accepts an empty coverage/patches result", () => {
    const result = ReconcilerResultSchema.safeParse({ coverage: [], patches: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a populated result", () => {
    const result = ReconcilerResultSchema.safeParse({
      coverage: [
        {
          requirementId: "REQ-AUTH-001",
          description: "Users can log in via GitHub",
          epic: 12,
          issues: [15],
          status: "covered",
          evidence: "issue #15",
        },
      ],
      patches: [{ type: "KEEP", issue: 15, reason: "correct as-is" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a result missing the patches field", () => {
    const result = ReconcilerResultSchema.safeParse({ coverage: [] });
    expect(result.success).toBe(false);
  });
});
```

Add one case to `tests/integration/pi/pi-runner.test.ts`, alongside the existing `it("accepts a valid refiner result", ...)` block:

```typescript
  it("accepts a valid reconciler result", async () => {
    const request = makeRequest({
      role: "reconciler",
      prompt: "Reconcile the epic. SCENARIO:valid-reconciler",
    });
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ coverage: [], patches: [] });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/domain/reconciler-contracts.test.ts tests/integration/pi/pi-runner.test.ts`
Expected: FAIL — `ReconcilerResultSchema` does not exist; `RoleSchema.safeParse("reconciler")` fails; the reconciler `pi-runner.test.ts` case fails with `fake pi: unknown scenario 'valid-reconciler'`.

- [ ] **Step 3: Write the implementation**

In `src/domain/contracts.ts`:

```typescript
import {
  BacklogPatchSchema,
  CoverageEntrySchema,
} from "./reconciliation.js";
```

(add this import near the top, alongside the existing `import { z } from "zod";`)

```typescript
export const RoleSchema = z.enum([
  "refiner",
  "implementer",
  "reviewer",
  "brainstormer",
  "reconciler",
]);
```

Add after `BrainstormerResultSchema`:

```typescript
export const ReconcilerResultSchema = z.object({
  coverage: z.array(CoverageEntrySchema),
  patches: z.array(BacklogPatchSchema),
});
export type ReconcilerResult = z.infer<typeof ReconcilerResultSchema>;
```

Add `ReconcilerResultSchema` to the `RoleResultSchema` union:

```typescript
export const RoleResultSchema = z.union([
  RefinerResultSchema,
  ImplementerResultSchema,
  ReviewerResultSchema,
  BrainstormerResultSchema,
  ReconcilerResultSchema,
]);
```

In `src/pi/pi-runner.ts`, add `ReconcilerResultSchema` to the existing import from `../domain/contracts.js`, then extend the two role tables:

```typescript
const ROLE_SCHEMAS: Record<Role, z.ZodType> = {
  refiner: RefinerResultSchema,
  implementer: ImplementerResultSchema,
  reviewer: ReviewerResultSchema,
  brainstormer: BrainstormerResultSchema,
  reconciler: ReconcilerResultSchema,
};
```

```typescript
const ROLE_TOOLS: Record<Role, string[]> = {
  refiner: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
  brainstormer: READ_ONLY_TOOLS,
  reconciler: READ_ONLY_TOOLS,
};
```

In `tests/fixtures/pi/fake-pi.mjs`, add a `valid-reconciler` payload to `VALID_PAYLOADS`:

```javascript
  "valid-reconciler": JSON.stringify({
    coverage: [],
    patches: [],
  }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/domain/reconciler-contracts.test.ts tests/integration/pi/pi-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — `Record<Role, ...>` in `pi-runner.ts` would fail to typecheck if either table were left incomplete, so this step also proves both tables are exhaustive.

- [ ] **Step 6: Commit**

```bash
git add src/domain/contracts.ts src/pi/pi-runner.ts tests/fixtures/pi/fake-pi.mjs \
  tests/unit/domain/reconciler-contracts.test.ts tests/integration/pi/pi-runner.test.ts
git commit -m "feat(pi): add reconciler role to contracts and PiRunner"
```

---

### Task 4: Generalize managed-section upsert; add the reconciliation section

**Files:**
- Modify: `src/readiness/refinement-section.ts`
- Create: `src/reconciliation/managed-section.ts`
- Create: `tests/unit/reconciliation/managed-section.test.ts`

**Interfaces:**
- Consumes: `IssueEnrichment` from `src/domain/reconciliation.js` (Task 1).
- Produces (Task 6 and Task 8 rely on these exact names):
  - `upsertManagedSection(body: string, startMarker: string, endMarker: string, rendered: string): string` — exported from `src/readiness/refinement-section.ts`. Throws `RefinementSectionError` on ambiguous/unbalanced markers; inserts when absent; replaces the single existing section otherwise. `upsertRefinementSection` becomes a thin wrapper over it (behavior-unchanged; verified by the existing `refinement-section.test.ts` staying green untouched).
  - `RECONCILIATION_START` / `RECONCILIATION_END` — marker constants, distinct from `REFINEMENT_START`/`REFINEMENT_END` so an issue can carry both sections independently.
  - `renderReconciliationSection(enrichment: IssueEnrichment): string`.
  - `upsertReconciliationSection(body: string, enrichment: IssueEnrichment): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/reconciliation/managed-section.test.ts
import { describe, expect, it } from "vitest";
import type { IssueEnrichment } from "../../../src/domain/reconciliation.js";
import { RefinementSectionError } from "../../../src/readiness/refinement-section.js";
import {
  RECONCILIATION_END,
  RECONCILIATION_START,
  renderReconciliationSection,
  upsertReconciliationSection,
} from "../../../src/reconciliation/managed-section.js";

function enrichment(overrides: Partial<IssueEnrichment> = {}): IssueEnrichment {
  return {
    goal: "Create a user record from a verified GitHub identity",
    sourceRequirements: ["REQ-AUTH-004"],
    acceptanceCriteria: ["A first-time GitHub login creates exactly one user row"],
    constraints: [],
    nonGoals: [],
    validation: ["npm test -- auth"],
    relevantAreas: ["src/auth/"],
    ...overrides,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("renderReconciliationSection", () => {
  it("renders the goal, source requirements, and every field", () => {
    const rendered = renderReconciliationSection(enrichment());
    expect(rendered).toContain("Create a user record from a verified GitHub identity");
    expect(rendered).toContain("REQ-AUTH-004");
    expect(rendered).toContain("A first-time GitHub login creates exactly one user row");
    expect(rendered).toContain("npm test -- auth");
    expect(rendered).toContain("src/auth/");
  });

  it("renders None. for empty list fields", () => {
    const rendered = renderReconciliationSection(enrichment({ constraints: [], nonGoals: [] }));
    expect(rendered).toContain("None.");
  });
});

describe("upsertReconciliationSection", () => {
  it("appends a managed section when the body has no markers", () => {
    const body = "Original human-authored issue body";
    const updated = upsertReconciliationSection(body, enrichment());
    expect(updated).toContain("Original human-authored issue body");
    expect(countOccurrences(updated, RECONCILIATION_START)).toBe(1);
    expect(countOccurrences(updated, RECONCILIATION_END)).toBe(1);
  });

  it("replaces the single existing reconciliation section without touching other content", () => {
    const once = upsertReconciliationSection("Original context", enrichment());
    const twice = upsertReconciliationSection(once, enrichment({ goal: "New goal" }));
    expect(twice).toContain("Original context");
    expect(countOccurrences(twice, RECONCILIATION_START)).toBe(1);
    expect(twice).not.toContain("Create a user record from a verified GitHub identity");
    expect(twice).toContain("New goal");
  });

  it("coexists with a separate M1 refinement section", () => {
    const withRefinement =
      "Body\n\n<!-- autopilot-refinement:start -->\nrefinement content\n<!-- autopilot-refinement:end -->\n";
    const updated = upsertReconciliationSection(withRefinement, enrichment());
    expect(updated).toContain("refinement content");
    expect(updated).toContain(RECONCILIATION_START);
  });

  it("rejects duplicate start markers instead of guessing", () => {
    const body = `${RECONCILIATION_START}\nold\n${RECONCILIATION_START}\nolder`;
    expect(() => upsertReconciliationSection(body, enrichment())).toThrow(
      RefinementSectionError,
    );
  });

  it("is stable: re-running with the same enrichment yields the same body", () => {
    const once = upsertReconciliationSection("Original", enrichment());
    const twice = upsertReconciliationSection(once, enrichment());
    expect(twice).toBe(once);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/managed-section.test.ts`
Expected: FAIL — `Cannot find module '../../../src/reconciliation/managed-section.js'`.

- [ ] **Step 3: Write the implementation**

In `src/readiness/refinement-section.ts`, replace the body of `upsertRefinementSection` and add the new generic export just above it (keep every other export — `renderRefinementSection`, `REFINEMENT_START`/`REFINEMENT_END`, `RefinementSectionError`, `diffLines`, `renderUnifiedDiff`, `countOccurrences` — unchanged):

```typescript
/**
 * Generic managed-section upsert: insert or replace the single section
 * delimited by `startMarker`/`endMarker` in `body`, preserving all other
 * content. Ambiguous marker layouts (duplicate or unbalanced markers) raise
 * {@link RefinementSectionError} instead of guessing. Shared by every
 * autopilot-owned managed section — the M1 execution contract here, and the
 * reconciliation section in src/reconciliation/managed-section.ts — so the
 * "never guess" marker-scanning rules live exactly once.
 */
export function upsertManagedSection(
  body: string,
  startMarker: string,
  endMarker: string,
  rendered: string,
): string {
  const startCount = countOccurrences(body, startMarker);
  const endCount = countOccurrences(body, endMarker);

  if (startCount > 1 || endCount > 1) {
    throw new RefinementSectionError(
      "issue body contains multiple managed-section markers; refusing to guess which section to replace",
    );
  }
  if (startCount !== endCount) {
    throw new RefinementSectionError(
      "issue body contains unbalanced managed-section markers; refusing to guess",
    );
  }
  if (startCount === 0) {
    const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n\n";
    return `${body}${separator}${rendered}`;
  }

  const startIndex = body.indexOf(startMarker);
  const endIndex = body.indexOf(endMarker, startIndex + startMarker.length);
  if (endIndex === -1) {
    throw new RefinementSectionError(
      "managed-section end marker appears before the start marker; refusing to guess",
    );
  }
  const before = body.slice(0, startIndex);
  const after = body.slice(endIndex + endMarker.length);
  return `${before}${rendered}${after}`;
}

/**
 * Insert or replace the single managed refinement section in an issue body.
 * Original content is always preserved. Accepts either a {@link TaskDraft}
 * or the strict {@link TaskSnapshot} subtype.
 */
export function upsertRefinementSection(
  body: string,
  draft: TaskDraft,
): string {
  return upsertManagedSection(
    body,
    REFINEMENT_START,
    REFINEMENT_END,
    renderRefinementSection(draft),
  );
}
```

Delete the old `upsertRefinementSection` body (the marker-scanning logic that now lives in `upsertManagedSection`) — it is fully replaced by the two functions above.

```typescript
// src/reconciliation/managed-section.ts
import type { IssueEnrichment } from "../domain/reconciliation.js";
import { upsertManagedSection } from "../readiness/refinement-section.js";

/** Managed issue-body section owned by reconciliation, distinct from the M1
 * execution-contract section (readiness/refinement-section.ts) so the two
 * proposals never collide inside one issue body. */
export const RECONCILIATION_START = "<!-- autopilot-reconciliation:start -->";
export const RECONCILIATION_END = "<!-- autopilot-reconciliation:end -->";

const SECTION_HEADING = "## Backlog reconciliation";

function bulletOrNone(entries: string[]): string[] {
  if (entries.length === 0) return ["None."];
  return entries.map((entry) => `- ${entry}`);
}

/** Render the managed reconciliation section for a proposed issue
 * enrichment. Deterministic: fixed field order, `None.` for empty lists. */
export function renderReconciliationSection(enrichment: IssueEnrichment): string {
  const lines: string[] = [
    RECONCILIATION_START,
    "",
    SECTION_HEADING,
    "",
    "### Goal",
    "",
    enrichment.goal.trim() === "" ? "None." : enrichment.goal.trim(),
    "",
    "### Source requirements",
    "",
    ...bulletOrNone(enrichment.sourceRequirements),
    "",
    "### Acceptance criteria",
    "",
    ...bulletOrNone(enrichment.acceptanceCriteria),
    "",
    "### Constraints",
    "",
    ...bulletOrNone(enrichment.constraints),
    "",
    "### Non-goals",
    "",
    ...bulletOrNone(enrichment.nonGoals),
    "",
    "### Validation",
    "",
    ...bulletOrNone(enrichment.validation),
    "",
    "### Relevant areas",
    "",
    ...bulletOrNone(enrichment.relevantAreas),
    "",
    RECONCILIATION_END,
  ];
  return lines.join("\n");
}

/** Insert or replace the single managed reconciliation section in an issue
 * body. Original content — including any separate M1 refinement section —
 * is always preserved. */
export function upsertReconciliationSection(
  body: string,
  enrichment: IssueEnrichment,
): string {
  return upsertManagedSection(
    body,
    RECONCILIATION_START,
    RECONCILIATION_END,
    renderReconciliationSection(enrichment),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/managed-section.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the refactor is behavior-neutral**

Run: `npx vitest run tests/unit/readiness/refinement-section.test.ts`
Expected: PASS, unchanged — every existing assertion (insert, replace, preserve-surrounding-content, all five ambiguous-marker rejection cases, stability) still holds against the new `upsertManagedSection`-backed implementation.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/readiness/refinement-section.ts src/reconciliation/managed-section.ts \
  tests/unit/reconciliation/managed-section.test.ts
git commit -m "refactor(readiness): generalize managed-section upsert; add reconciliation section"
```

---

### Task 5: Patch-application policy classification

**Files:**
- Create: `src/reconciliation/patch-policy.ts`
- Test: `tests/unit/reconciliation/patch-policy.test.ts`

**Interfaces:**
- Consumes: `BacklogPatch`, `BacklogPatchType`, `PatchPolicy` from `src/domain/reconciliation.js` (Task 1).
- Produces (Task 8 relies on this exact name): `classifyPatch(patch: BacklogPatch): PatchPolicy`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/reconciliation/patch-policy.test.ts
import { describe, expect, it } from "vitest";
import type { BacklogPatch } from "../../../src/domain/reconciliation.js";
import { classifyPatch } from "../../../src/reconciliation/patch-policy.js";

const cases: Array<{ patch: BacklogPatch; policy: "auto-safe" | "requires-approval" }> = [
  { patch: { type: "KEEP", issue: 1, reason: "fine" }, policy: "requires-approval" },
  {
    patch: {
      type: "ENRICH_ISSUE",
      issue: 1,
      reason: "add contract",
      patch: {
        goal: "g",
        sourceRequirements: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      },
    },
    policy: "auto-safe",
  },
  {
    patch: {
      type: "CREATE_ISSUE",
      epic: 1,
      reason: "missing coverage",
      spec: {
        title: "New issue",
        enrichment: {
          goal: "g",
          sourceRequirements: [],
          acceptanceCriteria: [],
          constraints: [],
          nonGoals: [],
          validation: [],
          relevantAreas: [],
        },
      },
    },
    policy: "auto-safe",
  },
  {
    patch: { type: "ADD_DEPENDENCY", issue: 1, dependsOn: 2, reason: "ordering" },
    policy: "auto-safe",
  },
  { patch: { type: "MARK_STALE", issue: 1, reason: "superseded" }, policy: "requires-approval" },
  {
    patch: {
      type: "NEEDS_HUMAN",
      issue: 1,
      ambiguityType: "PRODUCT",
      reason: "unclear",
      questions: ["?"],
    },
    policy: "requires-approval",
  },
];

describe("classifyPatch", () => {
  it.each(cases)("classifies $patch.type as $policy", ({ patch, policy }) => {
    expect(classifyPatch(patch)).toBe(policy);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: FAIL — `Cannot find module '../../../src/reconciliation/patch-policy.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/reconciliation/patch-policy.ts
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
 * action to gate; `MARK_STALE` and `NEEDS_HUMAN` are always
 * `requires-approval`; every additive patch type is `auto-safe`. Never
 * assigned by the LLM.
 */
export function classifyPatch(patch: BacklogPatch): PatchPolicy {
  return AUTO_SAFE.has(patch.type) ? "auto-safe" : "requires-approval";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/patch-policy.ts tests/unit/reconciliation/patch-policy.test.ts
git commit -m "feat(reconciliation): add deterministic patch-application policy"
```

---

### Task 6: Idempotency downgrades

**Files:**
- Create: `src/reconciliation/idempotency.ts`
- Test: `tests/unit/reconciliation/idempotency.test.ts`

**Interfaces:**
- Consumes:
  - `BacklogPatch` from `src/domain/reconciliation.js` (Task 1).
  - `upsertReconciliationSection` from `src/reconciliation/managed-section.js` (Task 4).
  - `MANAGED_DEPENDENCY_PATTERN`, `LINE_DEPENDENCY_PATTERN`, `dependencyNumberFromMatch` from `src/analysis/dependency-markers.js` (existing, unmodified).
- Produces (Task 8 relies on this exact name): `applyIdempotencyDowngrades(patches: BacklogPatch[], issues: ReadonlyArray<{ number: number; title: string; body: string }>): BacklogPatch[]` — returns a new array, same order and length as `patches`, with `ENRICH_ISSUE`/`ADD_DEPENDENCY`/`CREATE_ISSUE` entries downgraded to `KEEP` where the current state already reflects the proposal; every other entry passes through unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/reconciliation/idempotency.test.ts
import { describe, expect, it } from "vitest";
import type { BacklogPatch, IssueEnrichment } from "../../../src/domain/reconciliation.js";
import { applyIdempotencyDowngrades } from "../../../src/reconciliation/idempotency.js";
import { upsertReconciliationSection } from "../../../src/reconciliation/managed-section.js";

function enrichment(overrides: Partial<IssueEnrichment> = {}): IssueEnrichment {
  return {
    goal: "Create a user record from a verified GitHub identity",
    sourceRequirements: ["REQ-AUTH-004"],
    acceptanceCriteria: ["A first-time GitHub login creates exactly one user row"],
    constraints: [],
    nonGoals: [],
    validation: ["npm test -- auth"],
    relevantAreas: ["src/auth/"],
    ...overrides,
  };
}

describe("applyIdempotencyDowngrades", () => {
  it("downgrades an ENRICH_ISSUE patch to KEEP when the issue already carries the identical proposed section", () => {
    const already = upsertReconciliationSection("Original body", enrichment());
    const patches: BacklogPatch[] = [
      { type: "ENRICH_ISSUE", issue: 16, reason: "add contract", patch: enrichment() },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 16, title: "Create user from GitHub identity", body: already },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 16 });
  });

  it("leaves an ENRICH_ISSUE patch unchanged when the issue's current section differs", () => {
    const patches: BacklogPatch[] = [
      { type: "ENRICH_ISSUE", issue: 16, reason: "add contract", patch: enrichment() },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 16, title: "Create user from GitHub identity", body: "Original body, no section yet" },
    ]);
    expect(result.type).toBe("ENRICH_ISSUE");
  });

  it("downgrades an ADD_DEPENDENCY patch to KEEP when the dependency marker is already present", () => {
    const patches: BacklogPatch[] = [
      { type: "ADD_DEPENDENCY", issue: 17, dependsOn: 15, reason: "ordering" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "depends on: #15\n" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 17 });
  });

  it("leaves an ADD_DEPENDENCY patch unchanged when no marker references it", () => {
    const patches: BacklogPatch[] = [
      { type: "ADD_DEPENDENCY", issue: 17, dependsOn: 15, reason: "ordering" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "no dependency markers here" },
    ]);
    expect(result.type).toBe("ADD_DEPENDENCY");
  });

  it("downgrades a CREATE_ISSUE patch to KEEP of the matching issue on an exact (case-insensitive) title match", () => {
    const patches: BacklogPatch[] = [
      {
        type: "CREATE_ISSUE",
        epic: 12,
        reason: "missing coverage",
        spec: { title: "  admin session revocation endpoint  ", enrichment: enrichment() },
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 30, title: "Admin session revocation endpoint", body: "already exists" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 30 });
  });

  it("leaves a CREATE_ISSUE patch unchanged when no existing issue matches its title", () => {
    const patches: BacklogPatch[] = [
      {
        type: "CREATE_ISSUE",
        epic: 12,
        reason: "missing coverage",
        spec: { title: "Admin session revocation endpoint", enrichment: enrichment() },
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 30, title: "Something unrelated", body: "" },
    ]);
    expect(result.type).toBe("CREATE_ISSUE");
  });

  it("passes KEEP, MARK_STALE, and NEEDS_HUMAN patches through unchanged", () => {
    const patches: BacklogPatch[] = [
      { type: "KEEP", issue: 1, reason: "fine" },
      { type: "MARK_STALE", issue: 2, reason: "superseded" },
      {
        type: "NEEDS_HUMAN",
        issue: null,
        ambiguityType: "PRODUCT",
        reason: "unclear",
        questions: ["?"],
      },
    ];
    const result = applyIdempotencyDowngrades(patches, []);
    expect(result).toEqual(patches);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: FAIL — `Cannot find module '../../../src/reconciliation/idempotency.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/reconciliation/idempotency.ts
import {
  dependencyNumberFromMatch,
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
} from "../analysis/dependency-markers.js";
import type { BacklogPatch } from "../domain/reconciliation.js";
import { upsertReconciliationSection } from "./managed-section.js";

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
      const proposed = upsertReconciliationSection(current.body, patch.patch);
      if (proposed === current.body) {
        return {
          type: "KEEP",
          issue: patch.issue,
          reason: "already reflects the proposed enrichment",
        };
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

    return patch;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/idempotency.ts tests/unit/reconciliation/idempotency.test.ts
git commit -m "feat(reconciliation): add deterministic idempotency downgrades"
```

---

### Task 7: Reconciler prompt builder

**Files:**
- Create: `src/reconciliation/prompt.ts`
- Test: `tests/unit/reconciliation/prompt.test.ts`

**Interfaces:**
- Consumes: `RepositoryRef` from `src/domain/contracts.js`; `GitHubIssue` from `src/github/github-adapter.js` (both existing).
- Produces (Task 8 and Task 9 rely on these exact names):
  - `RequirementDoc` — `{ path: string; content: string }`.
  - `ReconcilerPromptInput` — `{ repository: RepositoryRef; epic: GitHubIssue; issues: GitHubIssue[]; requirementDocs: RequirementDoc[]; priorReport?: { coverage: Array<{ requirementId: string; description: string }> } }`.
  - `buildReconcilerPrompt(input: ReconcilerPromptInput): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/reconciliation/prompt.test.ts
import { describe, expect, it } from "vitest";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import { buildReconcilerPrompt } from "../../../src/reconciliation/prompt.js";

function issue(number: number, title: string, body: string): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-18T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

const repository = { owner: "acme", repo: "widgets" };
const epic = issue(12, "Authentication overhaul", "- [ ] #15 OAuth callback");
const issues = [issue(15, "OAuth callback", "Handle the GitHub OAuth callback")];

describe("buildReconcilerPrompt", () => {
  it("includes the epic number and title", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("#12");
    expect(prompt).toContain("Authentication overhaul");
  });

  it("includes every issue's number, title, and body", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("#15");
    expect(prompt).toContain("OAuth callback");
    expect(prompt).toContain("Handle the GitHub OAuth callback");
  });

  it("includes every requirement document's path and content", () => {
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues,
      requirementDocs: [{ path: "requirements.md", content: "REQ-AUTH-001: users can log in" }],
    });
    expect(prompt).toContain("requirements.md");
    expect(prompt).toContain("REQ-AUTH-001: users can log in");
  });

  it("notes when no requirement documents are configured", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("no requirement documents configured");
  });

  it("notes when the epic has no checklist issues", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues: [], requirementDocs: [] });
    expect(prompt).toContain("epic has no checklist issues");
  });

  it("instructs the model to flag oversized issues as NEEDS_HUMAN instead of splitting or silently keeping them", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("oversized");
    expect(prompt).toContain("NEEDS_HUMAN");
  });

  it("includes prior requirement IDs when a prior report is given", () => {
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues,
      requirementDocs: [],
      priorReport: { coverage: [{ requirementId: "REQ-AUTH-004", description: "GitHub login" }] },
    });
    expect(prompt).toContain("REQ-AUTH-004");
    expect(prompt).toContain("Reuse these IDs");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: FAIL — `Cannot find module '../../../src/reconciliation/prompt.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/reconciliation/prompt.ts
import type { RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue } from "../github/github-adapter.js";

export interface RequirementDoc {
  path: string;
  content: string;
}

export interface ReconcilerPromptInput {
  repository: RepositoryRef;
  epic: GitHubIssue;
  issues: GitHubIssue[];
  requirementDocs: RequirementDoc[];
  /** A prior reconciliation report for this epic, if one exists, so the
   * model can reuse previously assigned requirement IDs instead of
   * re-deriving them from scratch. Omitted on a first run. */
  priorReport?: {
    coverage: Array<{ requirementId: string; description: string }>;
  };
}

/**
 * Build the prompt for a bounded reconciler session. The reconciler
 * inspects the repository checkout and produces a structured coverage map
 * plus a patch plan through the `submit_result` tool; it never gains write
 * access to GitHub.
 */
export function buildReconcilerPrompt(input: ReconcilerPromptInput): string {
  const { repository, epic, issues, requirementDocs } = input;

  const requirementsSection =
    requirementDocs.length > 0
      ? requirementDocs
          .map((doc) => `--- ${doc.path} ---\n${doc.content}`)
          .join("\n\n")
      : "(no requirement documents configured)";

  const issuesSection =
    issues.length > 0
      ? issues
          .map(
            (issue) =>
              `#${issue.number} — ${issue.title} (${issue.state})\n${
                issue.body.length > 0 ? issue.body : "(empty issue body)"
              }`,
          )
          .join("\n\n")
      : "(epic has no checklist issues)";

  const priorSection =
    input.priorReport !== undefined && input.priorReport.coverage.length > 0
      ? `\n\nRequirement IDs assigned in a prior reconciliation of this epic\n------------------------------------------------------------\n${input.priorReport.coverage
          .map((entry) => `- ${entry.requirementId}: ${entry.description}`)
          .join(
            "\n",
          )}\nReuse these IDs for the same requirements; only assign new IDs for requirements not listed here.`
      : "";

  return `You are the Reconciler role of an autonomous software development orchestrator.

You are operating inside a checkout of the target repository at the current working directory. Use the read, grep, find, and ls tools to inspect the repository — confirm whether work an issue describes already exists, is partially implemented, or was superseded, before proposing a patch about it.

Your job is to compare the requirement documents below against the epic's existing issues, and produce two things: a requirement coverage map, and a set of proposed patches to the backlog. You do not have write access to GitHub — every patch is a proposal for a human to review.

Output contract
---------------
When your analysis is complete, call the submit_result tool exactly once with a JSON string matching this shape:

{
  "coverage": [
    { "requirementId": "REQ-AUTH-001", "description": "...", "epic": ${epic.number}, "issues": [123], "status": "covered" | "partial" | "missing" | "implemented", "evidence": "..." }
  ],
  "patches": [
    { "type": "KEEP", "issue": 123, "reason": "..." },
    { "type": "ENRICH_ISSUE", "issue": 123, "reason": "...", "patch": { "goal": "...", "sourceRequirements": ["REQ-AUTH-001"], "acceptanceCriteria": ["..."], "constraints": [], "nonGoals": [], "validation": ["..."], "relevantAreas": ["src/auth/"] } },
    { "type": "CREATE_ISSUE", "epic": ${epic.number}, "reason": "...", "spec": { "title": "...", "enrichment": { "goal": "...", "sourceRequirements": [], "acceptanceCriteria": [], "constraints": [], "nonGoals": [], "validation": [], "relevantAreas": [] } } },
    { "type": "ADD_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." },
    { "type": "MARK_STALE", "issue": 123, "reason": "..." },
    { "type": "NEEDS_HUMAN", "issue": 123, "ambiguityType": "ENGINEERING" | "PRODUCT" | "MISSING_CONTEXT" | "CONFLICTING_REQUIREMENTS", "reason": "...", "questions": ["..."] }
  ]
}

Rules
-----
- Assign a stable REQ-<AREA>-<NNN> identifier to every requirement you find, unless a prior reconciliation (below) already assigned one — reuse those exactly.
- Every issue in the epic must be classified with exactly one patch: KEEP when it is correct and complete as-is, ENRICH_ISSUE when it needs the machine-owned execution-contract fields added, MARK_STALE when the repository already contains an equivalent implementation (name the evidence in "reason"), or NEEDS_HUMAN when you cannot decide without a product decision.
- Propose CREATE_ISSUE only for a requirement with no corresponding issue anywhere in the epic.
- Propose ADD_DEPENDENCY when one issue's work genuinely cannot start before another completes and no dependency is currently recorded.
- ENGINEERING ambiguity (which module owns a behavior, whether an abstraction already exists) does NOT require NEEDS_HUMAN: resolve it by inspecting the repository.
- PRODUCT ambiguity, MISSING_CONTEXT (a requirement you cannot locate enough information about), and CONFLICTING_REQUIREMENTS (two requirement documents disagree) MUST produce a NEEDS_HUMAN patch with specific questions.
- An issue is the right size when it has one primary outcome, fits one isolated agent session, and its acceptance criteria are independently testable. If an issue's scope spans multiple independent behavioral outcomes (not just multiple implementation steps toward one outcome), it is oversized: this milestone cannot propose SPLIT_ISSUE, so raise a NEEDS_HUMAN patch (ambiguityType "ENGINEERING" if the split itself is mechanical, "PRODUCT" if which slice ships first is a product call) naming the outcomes you would split it into, rather than silently keeping or enriching it as one issue.
- Never silently drop a requirement or an issue from your analysis.

Input
-----
Repository: ${repository.owner}/${repository.repo}
Epic: #${epic.number} — ${epic.title}

Requirement documents
----------------------
${requirementsSection}

Epic issues
-----------
${issuesSection}${priorSection}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/prompt.ts tests/unit/reconciliation/prompt.test.ts
git commit -m "feat(reconciliation): add reconciler prompt builder"
```

---

### Task 8: ReconciliationService

**Files:**
- Create: `src/reconciliation/reconciliation-service.ts`
- Test: `tests/unit/reconciliation/reconciliation-service.test.ts`

**Interfaces:**
- Consumes:
  - `isEpicBody`, `collectEpicIssueRefs`, `resolveIssueSet` from `src/analysis/issue-set.js` (existing, unmodified).
  - `classifyPatch` from `src/reconciliation/patch-policy.js` (Task 5).
  - `applyIdempotencyDowngrades` from `src/reconciliation/idempotency.js` (Task 6).
  - `buildReconcilerPrompt`, `RequirementDoc` from `src/reconciliation/prompt.js` (Task 7).
  - `BacklogPatch`, `CoverageEntry`, `ReconciledPatch` from `src/domain/reconciliation.js` (Task 1).
  - `ReconcilerResult` from `src/domain/contracts.js` (Task 3).
  - `PiRunError`, `PiExecution`, `PiRunRequest` from `src/pi/pi-runner.js` (existing/Task 3).
  - `GitHubError`, `GitHubIssue`, `GitHubPort` from `src/github/github-adapter.js`; `RepositoryContext`, `safeProcessEnv` from `src/github/repository-context.js`; `AutopilotConfig` from `src/config/schema.js`; `ResolvedRoleModel` from `src/config/load-config.js`; `ArtifactStore` from `src/persistence/artifact-store.js`; `AppPaths` from `src/platform/paths.js` (all existing).
- Produces (Task 9 relies on these exact names):
  - `ReconcilerRunner` — `{ run(request: PiRunRequest): Promise<PiExecution> }`.
  - `ReconciliationServiceDeps` — `{ repository: RepositoryContext; config: AutopilotConfig; github: GitHubPort; pi: ReconcilerRunner; artifacts: ArtifactStore; paths: AppPaths; reconcilerModel: ResolvedRoleModel; reconcilerTimeoutMs?: number; analysisId?: (epicRef: number) => string; now?: () => string }`.
  - `ReconciliationReport` — `{ repository: RepositoryRef; epicRef: number; requirementsPaths: string[]; generatedAt: string; analysisId: string; coverage: CoverageEntry[]; patches: ReconciledPatch[]; summary: { requirementsCovered: number; requirementsPartial: number; requirementsMissing: number; requirementsTotal: number; patchCounts: Record<string, number> } }`.
  - `ReconciliationService` class with `async reconcile(epicRef: number, requirementDocs: RequirementDoc[]): Promise<ReconciliationReport>`. A `PiRunError` (or any other error) from `deps.pi.run()` propagates unchanged — never caught.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/reconciliation/reconciliation-service.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import type { ReconcilerResult } from "../../../src/domain/contracts.js";
import { GitHubError } from "../../../src/github/github-adapter.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { PiRunError } from "../../../src/pi/pi-runner.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReconciliationService } from "../../../src/reconciliation/reconciliation-service.js";
import type { ReconcilerRunner } from "../../../src/reconciliation/reconciliation-service.js";

const repository: RepositoryContext = {
  root: "/tmp/fake-repo",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config: AutopilotConfig = {
  version: 1,
  workspace: {
    baseBranch: "main",
    branchPrefix: "autopilot/",
    requireCleanCheckout: true,
    retainBlockedWorktree: true,
  },
  commands: { setup: [], verify: ["npm test"] },
  agents: {},
  agentPolicy: { allowedCommands: [], protectedPaths: [], allowNetwork: false },
  budgets: {
    refiner: { timeoutMinutes: 5 },
    reconciler: { timeoutMinutes: 10 },
    implementation: { timeoutMinutes: 60, maxAttempts: 3 },
    review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
  },
  publication: { draftPr: false, issueComment: "concise", autoMerge: false },
  reconciliation: {},
};

const reconcilerModel: ResolvedRoleModel = {
  model: "anthropic/claude-haiku",
  thinking: "high",
  source: "repository",
};

function makeIssue(number: number, title: string, body: string): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-18T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

const EPIC = makeIssue(
  12,
  "Authentication overhaul",
  "- [ ] #15 OAuth callback\n- [ ] #16 Create user from GitHub identity",
);
const ISSUE_15 = makeIssue(15, "OAuth callback", "Handles the GitHub OAuth callback");
const ISSUE_16 = makeIssue(16, "Create user from GitHub identity", "Creates the user row");

class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];
  private readonly issues = new Map<number, GitHubIssue>([
    [12, EPIC],
    [15, ISSUE_15],
    [16, ISSUE_16],
  ]);

  async getIssue(number: number): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) {
      throw new GitHubError(`failed to fetch issue #${number}`, { cause: { status: 404 } });
    }
    return issue;
  }

  async updateIssueBody(): Promise<GitHubIssue> {
    this.mutationCalls.push("updateIssueBody");
    throw new Error("must not be called");
  }

  async createIssueComment(): Promise<void> {
    this.mutationCalls.push("createIssueComment");
    throw new Error("must not be called");
  }

  async findPullRequestByHead(): Promise<null> {
    return null;
  }

  async createPullRequest(): Promise<never> {
    this.mutationCalls.push("createPullRequest");
    throw new Error("must not be called");
  }

  async findIssueCommentByMarker(): Promise<null> {
    return null;
  }
}

function fakePi(result: ReconcilerResult): ReconcilerRunner {
  return {
    async run(): Promise<PiExecution> {
      return {
        result,
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        resultPath: "/tmp/result.json",
        sessionDir: "/tmp/session",
      };
    },
  };
}

const dirs: string[] = [];
function makeService(pi: ReconcilerRunner, github: GitHubPort = new FakeGitHub()) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "autopilot-reconcile-"));
  dirs.push(dataDir);
  const paths = appPaths(dataDir);
  return new ReconciliationService({
    repository,
    config,
    github,
    pi,
    artifacts: new ArtifactStore(paths),
    paths,
    reconcilerModel,
    analysisId: () => "reconcile-test",
    now: () => "2026-08-22T00:00:00Z",
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ReconciliationService.reconcile", () => {
  it("produces a coverage map and policy-classified patches from a valid reconciler result", async () => {
    const service = makeService(
      fakePi({
        coverage: [
          {
            requirementId: "REQ-AUTH-001",
            description: "Users can log in via GitHub",
            epic: 12,
            issues: [15],
            status: "covered",
            evidence: "issue #15",
          },
          {
            requirementId: "REQ-AUTH-009",
            description: "Admins can revoke sessions",
            epic: 12,
            issues: [],
            status: "missing",
            evidence: "no matching issue",
          },
        ],
        patches: [
          { type: "KEEP", issue: 15, reason: "correct as-is" },
          {
            type: "ENRICH_ISSUE",
            issue: 16,
            reason: "missing acceptance criteria",
            patch: {
              goal: "Create a user record from a verified GitHub identity",
              sourceRequirements: ["REQ-AUTH-004"],
              acceptanceCriteria: ["A first login creates exactly one user row"],
              constraints: [],
              nonGoals: [],
              validation: ["npm test -- auth"],
              relevantAreas: ["src/auth/"],
            },
          },
        ],
      }),
    );

    const report = await service.reconcile(12, []);

    expect(report.epicRef).toBe(12);
    expect(report.coverage).toHaveLength(2);
    expect(report.summary).toMatchObject({
      requirementsCovered: 1,
      requirementsMissing: 1,
      requirementsTotal: 2,
    });
    expect(report.patches).toContainEqual(
      expect.objectContaining({ type: "KEEP", issue: 15, policy: "requires-approval" }),
    );
    expect(report.patches).toContainEqual(
      expect.objectContaining({ type: "ENRICH_ISSUE", issue: 16, policy: "auto-safe" }),
    );
  });

  it("passes through a NEEDS_HUMAN patch the reconciler raised for an oversized issue, classified requires-approval", async () => {
    const service = makeService(
      fakePi({
        coverage: [],
        patches: [
          {
            type: "NEEDS_HUMAN",
            issue: 16,
            ambiguityType: "ENGINEERING",
            reason:
              "issue #16 bundles three independent outcomes (create user, link identity, send welcome email) into one issue",
            questions: [
              "Should this be split into three issues, or is bundling them intentional?",
            ],
          },
        ],
      }),
    );

    const report = await service.reconcile(12, []);

    expect(report.patches).toContainEqual(
      expect.objectContaining({
        type: "NEEDS_HUMAN",
        issue: 16,
        ambiguityType: "ENGINEERING",
        policy: "requires-approval",
      }),
    );
  });

  it("downgrades an ENRICH_ISSUE patch to KEEP when the issue already carries the identical section", async () => {
    const enrichment = {
      goal: "Create a user record from a verified GitHub identity",
      sourceRequirements: ["REQ-AUTH-004"],
      acceptanceCriteria: ["A first login creates exactly one user row"],
      constraints: [],
      nonGoals: [],
      validation: ["npm test -- auth"],
      relevantAreas: ["src/auth/"],
    };
    const { upsertReconciliationSection } = await import(
      "../../../src/reconciliation/managed-section.js"
    );
    const alreadyEnriched = new (class extends FakeGitHub {
      override async getIssue(number: number): Promise<GitHubIssue> {
        const issue = await super.getIssue(number);
        if (number === 16) {
          return { ...issue, body: upsertReconciliationSection(issue.body, enrichment) };
        }
        return issue;
      }
    })();

    const service = makeService(
      fakePi({
        coverage: [],
        patches: [
          { type: "ENRICH_ISSUE", issue: 16, reason: "missing acceptance criteria", patch: enrichment },
        ],
      }),
      alreadyEnriched,
    );

    const report = await service.reconcile(12, []);
    expect(report.patches).toContainEqual(
      expect.objectContaining({ type: "KEEP", issue: 16 }),
    );
  });

  it("produces a NEEDS_HUMAN patch for an epic checklist ref that cannot be fetched", async () => {
    const withMissingRef = new (class extends FakeGitHub {
      override async getIssue(number: number): Promise<GitHubIssue> {
        if (number === 12) {
          return makeIssue(12, "Authentication overhaul", "- [ ] #15 OAuth callback\n- [ ] #999 Gone");
        }
        return super.getIssue(number);
      }
    })();

    const service = makeService(fakePi({ coverage: [], patches: [] }), withMissingRef);
    const report = await service.reconcile(12, []);

    expect(report.patches).toContainEqual(
      expect.objectContaining({
        type: "NEEDS_HUMAN",
        issue: null,
        ambiguityType: "MISSING_CONTEXT",
      }),
    );
  });

  it("propagates a PiRunError from the reconciler session without swallowing it", async () => {
    const failing: ReconcilerRunner = {
      async run(): Promise<PiExecution> {
        throw new PiRunError("invalid reconciler result: patches: Required", "reconciler", {
          stdout: "",
          stderr: "",
          resultPath: "/tmp/result.json",
        });
      },
    };
    const service = makeService(failing);
    await expect(service.reconcile(12, [])).rejects.toThrow(PiRunError);
  });

  it("never calls a GitHub mutation method", async () => {
    const github = new FakeGitHub();
    const service = makeService(fakePi({ coverage: [], patches: [] }), github);
    await service.reconcile(12, []);
    expect(github.mutationCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/reconciliation-service.test.ts`
Expected: FAIL — `Cannot find module '../../../src/reconciliation/reconciliation-service.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/reconciliation/reconciliation-service.ts
import path from "node:path";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { ReconcilerResult } from "../domain/contracts.js";
import type {
  BacklogPatch,
  CoverageEntry,
  ReconciledPatch,
} from "../domain/reconciliation.js";
import { collectEpicIssueRefs, isEpicBody, resolveIssueSet } from "../analysis/issue-set.js";
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import type { AppPaths } from "../platform/paths.js";
import { applyIdempotencyDowngrades } from "./idempotency.js";
import { classifyPatch } from "./patch-policy.js";
import type { RequirementDoc } from "./prompt.js";
import { buildReconcilerPrompt } from "./prompt.js";

/** Structural Pi runner surface consumed by reconciliation (satisfied by
 * PiRunner). Injected via the constructor so tests can substitute a fake
 * without constructing the real service. */
export interface ReconcilerRunner {
  run(request: PiRunRequest): Promise<PiExecution>;
}

export interface ReconciliationServiceDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  github: GitHubPort;
  pi: ReconcilerRunner;
  artifacts: ArtifactStore;
  paths: AppPaths;
  reconcilerModel: ResolvedRoleModel;
  /** Reconciler session timeout in milliseconds. */
  reconcilerTimeoutMs?: number;
  /** Namespaces this analysis's artifacts and Pi session. */
  analysisId?: (epicRef: number) => string;
  /** Clock for report.generatedAt; injectable for deterministic tests. */
  now?: () => string;
}

export interface ReconciliationReport {
  repository: RepositoryRef;
  epicRef: number;
  requirementsPaths: string[];
  generatedAt: string;
  analysisId: string;
  coverage: CoverageEntry[];
  patches: ReconciledPatch[];
  summary: {
    requirementsCovered: number;
    requirementsPartial: number;
    requirementsMissing: number;
    requirementsTotal: number;
    patchCounts: Record<string, number>;
  };
}

const DEFAULT_RECONCILER_TIMEOUT_MS = 10 * 60_000;
const REPORT_ARTIFACT = "reconciliation-report.json";

/**
 * Runs one bounded reconciler session for an epic and produces a durable,
 * policy-annotated `ReconciliationReport`. Strictly read-only: never
 * mutates GitHub. A `PiRunError` from the reconciler session (malformed
 * output, timeout, or crash) is never caught here — it propagates to the
 * caller exactly like every other role session failure in this codebase.
 */
export class ReconciliationService {
  private readonly reconcilerTimeoutMs: number;
  private readonly analysisId: (epicRef: number) => string;
  private readonly now: () => string;

  constructor(private readonly deps: ReconciliationServiceDeps) {
    this.reconcilerTimeoutMs =
      deps.reconcilerTimeoutMs ?? DEFAULT_RECONCILER_TIMEOUT_MS;
    this.analysisId =
      deps.analysisId ?? ((epicRef) => `reconcile-${Date.now()}-${epicRef}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async reconcile(
    epicRef: number,
    requirementDocs: RequirementDoc[],
  ): Promise<ReconciliationReport> {
    const repository = this.deps.repository.repository;
    const analysisId = this.analysisId(epicRef);
    const analysisDir = this.deps.paths.runDir(analysisId);

    const epic = await this.deps.github.getIssue(epicRef);
    if (!isEpicBody(epic.body)) {
      throw new Error(
        `issue #${epicRef} does not look like an epic (no checklist of issue references found)`,
      );
    }

    const { issues: epicIssueRefs } = collectEpicIssueRefs(epic.body);
    const uniqueRefs = [...new Set(epicIssueRefs)];
    const { issues, missing } = await resolveIssueSet(
      uniqueRefs,
      epicRef,
      this.deps.github,
      repository,
    );

    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs });

    const execution = await this.deps.pi.run({
      role: "reconciler",
      model: this.deps.reconcilerModel,
      prompt,
      worktree: this.deps.repository.root,
      allowedCommands: [],
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(analysisDir, "session"),
      diagnosticsDir: path.join(analysisDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.reconcilerTimeoutMs,
    });

    const raw = execution.result as ReconcilerResult;

    const missingPatches: BacklogPatch[] = missing.map((ref) => ({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "MISSING_CONTEXT",
      reason: `epic #${epicRef} references issue #${ref}, which could not be fetched`,
      questions: [
        `Does issue #${ref} still exist? Update or remove it from epic #${epicRef}'s checklist.`,
      ],
    }));

    const issueLikes: Array<{ number: number; title: string; body: string }> =
      issues.map((issue: GitHubIssue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
      }));

    const downgraded = applyIdempotencyDowngrades(
      [...raw.patches, ...missingPatches],
      issueLikes,
    );

    const patches: ReconciledPatch[] = downgraded.map((patch) => ({
      ...patch,
      policy: classifyPatch(patch),
    }));

    const patchCounts: Record<string, number> = {};
    for (const patch of patches) {
      patchCounts[patch.type] = (patchCounts[patch.type] ?? 0) + 1;
    }

    const summary = {
      requirementsCovered: raw.coverage.filter(
        (entry) => entry.status === "covered" || entry.status === "implemented",
      ).length,
      requirementsPartial: raw.coverage.filter((entry) => entry.status === "partial").length,
      requirementsMissing: raw.coverage.filter((entry) => entry.status === "missing").length,
      requirementsTotal: raw.coverage.length,
      patchCounts,
    };

    const report: ReconciliationReport = {
      repository,
      epicRef,
      requirementsPaths: requirementDocs.map((doc) => doc.path),
      generatedAt: this.now(),
      analysisId,
      coverage: raw.coverage,
      patches,
      summary,
    };

    await this.deps.artifacts.writeJson(analysisId, REPORT_ARTIFACT, report);
    return report;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/reconciliation-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/reconciliation-service.ts \
  tests/unit/reconciliation/reconciliation-service.test.ts
git commit -m "feat(reconciliation): add ReconciliationService orchestration"
```

---

### Task 9: CLI command `autopilot reconcile`

**Files:**
- Create: `src/commands/reconcile.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/commands/reconcile.test.ts`

**Interfaces:**
- Consumes: `resolveIssueRef` from `src/commands/args.js`; `resolveRoleModel`, `DEFAULT_PI_MODEL`, `loadRepositoryConfig` from `src/config/load-config.js`; `ReconciliationService`, `ReconciliationServiceDeps`, `ReconciliationReport` from `src/reconciliation/reconciliation-service.js` (Task 8); `RequirementDoc` from `src/reconciliation/prompt.js` (Task 7); `GitHubAdapter` from `src/github/github-adapter.js`; `resolveRepositoryContext` from `src/github/repository-context.js`; `ArtifactStore`; `PiRunner`; `appPaths`; `createReporter`.
- Produces: `registerReconcileCommand(program: Command, deps: ReconcileCommandDeps): void`; `ReconcileCommandDeps` (exported, joins `CliDeps` in `src/cli.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/commands/reconcile.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import type { ReconcileCommandDeps } from "../../../src/commands/reconcile.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import type { ReconciliationReport } from "../../../src/reconciliation/reconciliation-service.js";
import type { RequirementDoc } from "../../../src/reconciliation/prompt.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - npm ci
  verify:
    - npm test
`;

function makeIssue(number: number, title: string, body: string): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-18T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

const EPIC = makeIssue(12, "Authentication overhaul", "- [ ] #15 OAuth callback");
const ISSUE_15 = makeIssue(15, "OAuth callback", "Handles the callback");

class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];
  private readonly issues = new Map<number, GitHubIssue>([[12, EPIC], [15, ISSUE_15]]);

  async getIssue(number: number): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`no such issue #${number}`);
    return issue;
  }
  async updateIssueBody(): Promise<GitHubIssue> {
    this.mutationCalls.push("updateIssueBody");
    throw new Error("must not be called");
  }
  async createIssueComment(): Promise<void> {
    this.mutationCalls.push("createIssueComment");
    throw new Error("must not be called");
  }
  async findPullRequestByHead(): Promise<null> {
    return null;
  }
  async createPullRequest(): Promise<never> {
    this.mutationCalls.push("createPullRequest");
    throw new Error("must not be called");
  }
  async findIssueCommentByMarker(): Promise<null> {
    return null;
  }
}

const FIXED_REPORT: ReconciliationReport = {
  repository: { owner: "acme", repo: "widgets" },
  epicRef: 12,
  requirementsPaths: [],
  generatedAt: "2026-08-22T00:00:00Z",
  analysisId: "reconcile-test",
  coverage: [
    {
      requirementId: "REQ-AUTH-001",
      description: "Users can log in via GitHub",
      epic: 12,
      issues: [15],
      status: "covered",
      evidence: "issue #15",
    },
  ],
  patches: [
    { type: "KEEP", issue: 15, reason: "correct as-is", policy: "requires-approval" },
  ],
  summary: {
    requirementsCovered: 1,
    requirementsPartial: 0,
    requirementsMissing: 0,
    requirementsTotal: 1,
    patchCounts: { KEEP: 1 },
  },
};

function baseDeps(overrides: Partial<ReconcileCommandDeps> = {}): ReconcileCommandDeps {
  const github = new FakeGitHub();
  return {
    cwd: tempRepoRoot(),
    createGitHub: async () => github,
    createReconciliation: () => ({
      reconcile: async () => FIXED_REPORT,
    }),
    ...overrides,
  };
}

const dirs: string[] = [];
function tempRepoRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "autopilot-reconcile-cli-"));
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), MINIMAL_YAML, "utf8");
  dirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("autopilot reconcile", () => {
  it("prints a human-readable report grouped by patch type, with coverage", async () => {
    const lines: string[] = [];
    const deps = baseDeps({ stdout: (line) => lines.push(line) });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);

    const output = lines.join("\n");
    expect(output).toContain("Epic #12");
    expect(output).toContain("KEEP");
    expect(output).toContain("#15");
    expect(output).toContain("COVERAGE");
    expect(output).toContain("1/1 requirements covered");
  });

  it("emits the full report as JSON with --json", async () => {
    const lines: string[] = [];
    const deps = baseDeps({ stdout: (line) => lines.push(line) });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12", "--json"]);

    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed).toEqual(FIXED_REPORT);
  });

  it("reads an explicit --requirements file and passes its content to the service", async () => {
    const root = tempRepoRoot();
    writeFileSync(path.join(root, "reqs.md"), "REQ-AUTH-001: users can log in", "utf8");
    let captured: RequirementDoc[] = [];
    const deps = baseDeps({
      cwd: root,
      stdout: () => {},
      createReconciliation: () => ({
        reconcile: async (_epicRef: number, docs: RequirementDoc[]) => {
          captured = docs;
          return FIXED_REPORT;
        },
      }),
    });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12", "--requirements", "reqs.md"]);

    expect(captured).toEqual([
      { path: "reqs.md", content: "REQ-AUTH-001: users can log in" },
    ]);
  });

  it("exits 1 with a clear error when an explicit --requirements path does not exist", async () => {
    let exitCode: number | undefined;
    let errorLine = "";
    const deps = baseDeps({
      stdout: () => {},
      stderr: (line) => (errorLine = line),
      setExitCode: (code) => (exitCode = code),
    });
    const program = buildProgram(deps);
    await program.parseAsync([
      "node",
      "autopilot",
      "reconcile",
      "12",
      "--requirements",
      "does-not-exist.md",
    ]);

    expect(exitCode).toBe(1);
    expect(errorLine).toContain("does-not-exist.md");
  });

  it("defaults to requirements.md when present and no explicit configuration is given", async () => {
    const root = tempRepoRoot();
    writeFileSync(path.join(root, "requirements.md"), "REQ-DEFAULT-001: default doc", "utf8");
    let captured: RequirementDoc[] = [];
    const deps = baseDeps({
      cwd: root,
      stdout: () => {},
      createReconciliation: () => ({
        reconcile: async (_epicRef: number, docs: RequirementDoc[]) => {
          captured = docs;
          return FIXED_REPORT;
        },
      }),
    });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);

    expect(captured).toEqual([
      { path: "requirements.md", content: "REQ-DEFAULT-001: default doc" },
    ]);
  });

  it("passes an empty requirement doc list when no requirements.md exists and none is configured", async () => {
    let captured: RequirementDoc[] | undefined;
    const deps = baseDeps({
      stdout: () => {},
      createReconciliation: () => ({
        reconcile: async (_epicRef: number, docs: RequirementDoc[]) => {
          captured = docs;
          return FIXED_REPORT;
        },
      }),
    });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);

    expect(captured).toEqual([]);
  });

  it("never calls a GitHub mutation method", async () => {
    const github = new FakeGitHub();
    const deps = baseDeps({ stdout: () => {}, createGitHub: async () => github });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);
    expect(github.mutationCalls).toEqual([]);
  });

  it("exits 0 on success", async () => {
    let exitCode: number | undefined;
    const deps = baseDeps({ stdout: () => {}, setExitCode: (code) => (exitCode = code) });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);
    expect(exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/commands/reconcile.test.ts`
Expected: FAIL — `Cannot find module '../../../src/commands/reconcile.js'`, and `buildProgram` does not register a `reconcile` command.

- [ ] **Step 3: Write the implementation**

```typescript
// src/commands/reconcile.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { DEFAULT_PI_MODEL, loadRepositoryConfig, resolveRoleModel } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry } from "../config/schema.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import type { ReconciliationReport } from "../reconciliation/reconciliation-service.js";
import { ReconciliationService as ReconciliationServiceImpl } from "../reconciliation/reconciliation-service.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";
import { resolveIssueRef } from "./args.js";

export interface ReconcileCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  createReconciliation?: (deps: {
    repository: RepositoryContext;
    config: AutopilotConfig;
    github: GitHubPort;
    reconcilerModel: ResolvedRoleModel;
    reconcilerTimeoutMs: number;
    analysisId: string;
    now: () => string;
  }) => Pick<ReconciliationServiceImpl, "reconcile">;
  analysisId?: string;
  now?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  isTTY?: boolean;
}

interface ReconcileOptions {
  json?: boolean;
  requirements?: string[];
}

const DEFAULT_REQUIREMENTS_FILE = "requirements.md";
const PATCH_ORDER = [
  "KEEP",
  "ENRICH_ISSUE",
  "CREATE_ISSUE",
  "ADD_DEPENDENCY",
  "MARK_STALE",
  "NEEDS_HUMAN",
] as const;

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * `autopilot reconcile <epic>` — compare an epic's existing issues against
 * requirement docs and the repository, and propose a patch plan. Strictly
 * read-only against GitHub; always dry-run in this milestone.
 */
export function registerReconcileCommand(
  program: Command,
  deps: ReconcileCommandDeps = {},
): void {
  program
    .command("reconcile")
    .description(
      "Reconcile an epic's backlog against requirement docs and the repository, proposing a patch plan (read-only, always dry-run)",
    )
    .argument("<epic>", "epic issue number, or owner/repo#number matching the local origin")
    .option(
      "--requirements <path>",
      "requirement/architecture doc or directory to include (repeatable)",
      collectPath,
      [] as string[],
    )
    .option("--json", "emit the reconciliation report as machine-readable JSON")
    .action(async (epicRef: string, opts: ReconcileOptions) => {
      const stdout =
        deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr =
        deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const reporter =
          opts.json === true ? null : createReporter(stdout, deps.isTTY);
        try {
          const report = await runReconcile(epicRef, opts, deps, reporter);
          if (opts.json === true) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            printHumanReport(report, stdout);
          }
          setExitCode(0);
        } finally {
          reporter?.close();
        }
      } catch (error) {
        stderr(
          `autopilot reconcile: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

async function runReconcile(
  epicRef: string,
  opts: ReconcileOptions,
  deps: ReconcileCommandDeps,
  reporter: Reporter | null,
): Promise<ReconciliationReport> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const { number } = resolveIssueRef(epicRef, ctx);

  const config = await loadRepositoryConfig(ctx.root);
  const github =
    deps.createGitHub !== undefined
      ? await deps.createGitHub(ctx, runner)
      : await GitHubAdapter.create(ctx.root, runner);

  const explicitPaths =
    opts.requirements !== undefined && opts.requirements.length > 0
      ? opts.requirements
      : config.reconciliation.requirementsPaths;
  const requirementDocs =
    explicitPaths !== undefined
      ? readRequirementDocs(ctx.root, explicitPaths)
      : readDefaultRequirementDocs(ctx.root);

  const paths: AppPaths = appPaths(deps.dataDir);
  const reconcilerModel = resolveRoleModel(
    "reconciler",
    null,
    config.agents,
    null,
    deps.piDefaultModel ?? DEFAULT_PI_MODEL,
  );
  const reconcilerTimeoutMs = config.budgets.reconciler.timeoutMinutes * 60_000;

  const analysisId = deps.analysisId ?? `reconcile-${Date.now()}-${number}`;
  const now = deps.now ?? (() => new Date().toISOString());

  const service =
    deps.createReconciliation !== undefined
      ? deps.createReconciliation({
          repository: ctx,
          config,
          github,
          reconcilerModel,
          reconcilerTimeoutMs,
          analysisId,
          now,
        })
      : new ReconciliationServiceImpl({
          repository: ctx,
          config,
          github,
          pi: new PiRunner(runner, deps.piCommand),
          artifacts: new ArtifactStore(paths),
          paths,
          reconcilerModel,
          reconcilerTimeoutMs,
          analysisId: () => analysisId,
          now,
        });

  const repoRef = `${ctx.repository.owner}/${ctx.repository.repo}`;
  reporter?.line(
    `→ reconciling epic #${number} against ${requirementDocs.length} requirement doc(s) (${repoRef})`,
  );
  reporter?.setSpinner(`reconciling epic #${number}`);
  try {
    const report = await service.reconcile(number, requirementDocs);
    reporter?.stopSpinner({
      commit: `reconciliation complete (${report.patches.length} patch${
        report.patches.length === 1 ? "" : "es"
      })`,
    });
    return report;
  } finally {
    reporter?.stopSpinner();
  }
}

/** Expand a configured/explicit requirements entry: a directory contributes
 * its top-level *.md files (sorted); a file contributes itself. Throws if
 * the path does not exist — explicit configuration is never silently
 * skipped. */
function expandDocPath(root: string, relativePath: string): string[] {
  const abs = path.resolve(root, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`requirements path not found: ${relativePath}`);
  }
  if (statSync(abs).isDirectory()) {
    return readdirSync(abs)
      .filter((entry) => entry.endsWith(".md"))
      .sort()
      .map((entry) => path.join(relativePath, entry));
  }
  return [relativePath];
}

function readRequirementDocs(root: string, requestedPaths: string[]): RequirementDoc[] {
  const docs: RequirementDoc[] = [];
  for (const requested of requestedPaths) {
    for (const relative of expandDocPath(root, requested)) {
      docs.push({ path: relative, content: readFileSync(path.resolve(root, relative), "utf8") });
    }
  }
  return docs;
}

/** No explicit `reconciliation.requirementsPaths` or `--requirements` was
 * given: fall back to `requirements.md` at the repository root if it
 * exists, otherwise no requirement documents at all (never an error). */
function readDefaultRequirementDocs(root: string): RequirementDoc[] {
  const abs = path.resolve(root, DEFAULT_REQUIREMENTS_FILE);
  if (!existsSync(abs)) return [];
  return [{ path: DEFAULT_REQUIREMENTS_FILE, content: readFileSync(abs, "utf8") }];
}

function printHumanReport(
  report: ReconciliationReport,
  stdout: (text: string) => void,
): void {
  stdout(`Repository: ${report.repository.owner}/${report.repository.repo}`);
  stdout(`Epic #${report.epicRef}`);

  for (const type of PATCH_ORDER) {
    const group = report.patches.filter((patch) => patch.type === type);
    if (group.length === 0) continue;
    stdout("");
    stdout(type);
    for (const patch of group) {
      stdout(`  ${describePatch(patch)} [${patch.policy}]`);
    }
  }

  stdout("");
  stdout("COVERAGE");
  const parts = [`${report.summary.requirementsCovered}/${report.summary.requirementsTotal} requirements covered`];
  if (report.summary.requirementsPartial > 0) parts.push(`${report.summary.requirementsPartial} partial`);
  if (report.summary.requirementsMissing > 0) parts.push(`${report.summary.requirementsMissing} missing`);
  stdout(`  ${parts.join(", ")}`);
  for (const entry of report.coverage.filter((e) => e.status === "missing")) {
    stdout(`  ${entry.requirementId} is currently uncovered`);
  }
  stdout(`Analysis ID: ${report.analysisId}`);
}

function describePatch(patch: ReconciliationReport["patches"][number]): string {
  switch (patch.type) {
    case "KEEP":
    case "ENRICH_ISSUE":
    case "MARK_STALE":
      return `#${patch.issue} — ${patch.reason}`;
    case "CREATE_ISSUE":
      return `${patch.spec.title} — ${patch.reason}`;
    case "ADD_DEPENDENCY":
      return `#${patch.issue} depends on #${patch.dependsOn} — ${patch.reason}`;
    case "NEEDS_HUMAN":
      return `${patch.issue !== null ? `#${patch.issue} — ` : ""}${patch.reason}`;
  }
}
```

Register the command in `src/cli.ts`:

```typescript
import type { ReconcileCommandDeps } from "./commands/reconcile.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
```

```typescript
export type CliDeps = CheckCommandDeps &
  PrepareCommandDeps &
  AnalyzeCommandDeps &
  RunCommandDeps &
  StatusCommandDeps &
  InspectCommandDeps &
  ResumeCommandDeps &
  RunsCommandDeps &
  AbandonCommandDeps &
  StartCommandDeps &
  StopCommandDeps &
  ReconcileCommandDeps;
```

```typescript
  registerAnalyzeCommand(program, deps);
  registerReconcileCommand(program, deps);
```

(insert the `registerReconcileCommand` call directly after `registerAnalyzeCommand` in `buildProgram`)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/commands/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — the full M1–M3 suite remains green alongside the new reconciliation tests.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: PASS, no compile errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/reconcile.ts src/cli.ts tests/integration/commands/reconcile.test.ts
git commit -m "feat(cli): add autopilot reconcile command"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished `autopilot reconcile` CLI surface (Task 9) and config fields (Task 2).
- Produces: nothing consumed by other tasks — this is the terminal documentation task.

- [ ] **Step 1: Add `reconcile` to the command list**

In the `## CLI commands and exit codes` section's fenced command block, add a line after `autopilot analyze <ref>`:

```text
autopilot reconcile <epic>         # propose a backlog patch plan against requirement docs (read-only, always dry-run)
```

Add a row to the exit-code table, after the `analyze` row:

```markdown
| `reconcile` | report generated | thrown error (invalid ref, missing `--requirements` path, etc.) | — |
```

- [ ] **Step 2: Document the workflow position and constraints**

Add a new subsection after `## Workflow: check → prepare → check → run`, before `## CLI commands and exit codes`:

```markdown
## Backlog reconciliation: `reconcile`

```text
requirement/architecture docs + existing epic + repository
    ↓
autopilot reconcile <epic>       # one reconciler session; always dry-run
    ↓
coverage map + typed patch plan (KEEP/ENRICH_ISSUE/CREATE_ISSUE/
ADD_DEPENDENCY/MARK_STALE/NEEDS_HUMAN)
```

`reconcile` answers a different question than `analyze`: not "is this issue
ready to run" but "does the epic's backlog, taken as a whole, actually
reflect the requirements and the repository — and if not, what should
change?" It never mutates GitHub in this milestone: every patch is a
proposal for a human to review, annotated with a deterministic
`auto-safe`/`requires-approval` classification that a future `apply-safe`
mode will act on. A second `reconcile` run over an unchanged epic downgrades
previously-proposed enrichments to `KEEP` rather than re-proposing them.

Requirement documents are resolved with the same precedence as model
overrides elsewhere: `--requirements <path>` (repeatable; a file or a
directory of top-level `*.md` files) overrides
`reconciliation.requirementsPaths` in `.pi/autopilot.yaml`; with neither
set, `requirements.md` at the repository root is used if present, otherwise
reconciliation proceeds with no requirement documents. An explicitly
configured or requested path that does not exist is a preflight error —
`reconcile` never silently reconciles with absent context it was told to
use.

See `docs/superpowers/specs/2026-08-22-backlog-reconciliation-design.md`
for the full design.
```

- [ ] **Step 3: Document the new config fields**

Add two rows to the `## Policy reference (.pi/autopilot.yaml)` table, in the `agents` and `budgets` sections respectively:

```markdown
| | `reconciler` | Same shape as `refiner`/`implementer`/`reviewer` — optional `{ model, thinking }` for the reconciler role. |
```

```markdown
| | `reconciler.timeoutMinutes` | Per-session timeout for a reconciler session (`reconcile`). Default 10 minutes. |
```

Add a new `reconciliation` section row after the `publication` rows:

```markdown
| `reconciliation` | `requirementsPaths` | Files or directories (repository-relative) to read as requirement/architecture context for `reconcile`. Omitted → `requirements.md` at the repository root if present, else none. An explicit empty list (`[]`) means "no requirement documents," and is preserved as such. |
```

- [ ] **Step 4: Verify the README renders sensibly**

Run: `grep -c "^|" README.md` (sanity check the table row count changed as expected) and read the three edited sections back to confirm no broken table alignment or fence mismatches.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document autopilot reconcile and its config"
```

---

## Post-plan verification

After Task 10:

```bash
npm run check   # typecheck && test && build, in that order
```

Expected: all green. This proves the milestone is complete per the design spec's §11 acceptance criteria (coverage classification, patch-type limits, idempotency, zero-mutation, error propagation, `--json`/human report shapes) and leaves `main` mergeable via the normal `finishing-a-development-branch` flow.
