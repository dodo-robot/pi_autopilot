# REMOVE_DEPENDENCY Reconciliation Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `REMOVE_DEPENDENCY` as a new, fully report-only `BacklogPatch`
type — the reconciler can propose retracting a managed-form dependency
marker that no longer reflects a real ordering constraint. The patch is
schema-validated, deterministically idempotency-guarded, always classified
`requires-approval`, and rendered in reconciliation reports — but not yet
wired into `ApplyService` (that's a separate follow-up; see Task 6 note).

**Architecture:** Mirrors the existing `ADD_DEPENDENCY` code path exactly,
in the opposite direction: a new body-edit primitive
(`removeManagedDependencyFromBody`) alongside the existing
`appendDependencyToBody` in `apply-dependency.ts`, a new discriminated-union
schema variant, a policy classification, an idempotency downgrade rule, a
preview renderer, and a prompt-contract addition. No new files — every
change lands in an existing module that already has an `ADD_DEPENDENCY`
counterpart to pattern-match against.

**Tech Stack:** TypeScript, Zod (schema), Vitest (tests). No new
dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md`

## Global Constraints

- `REMOVE_DEPENDENCY` removes only the managed-form dependency line
  (`- #N (unsatisfied)`) — never a free-text (`depends on: #12`) line.
- `REMOVE_DEPENDENCY` is always classified `requires-approval` (never
  added to `patch-policy.ts`'s `AUTO_SAFE` set).
- No `ApplyService` changes in this plan. `removeManagedDependencyFromBody`
  and the preview renderer are built and unit-tested as free functions,
  not wired into `ApplyService.prepare()`'s switch.
- Every new test lives in the existing test file for the module it tests —
  no new test files.

---

### Task 1: Schema — add the `REMOVE_DEPENDENCY` discriminated-union variant

**Files:**
- Modify: `src/domain/reconciliation.ts:68-112`
- Test: `tests/unit/domain/reconciliation.test.ts`

**Interfaces:**
- Produces: `BacklogPatch` (via `z.infer<typeof BacklogPatchSchema>`) gains
  a new variant `{ type: "REMOVE_DEPENDENCY"; issue: number; dependsOn: number; reason: string }`,
  consumed by Tasks 2, 3, 4, 5.

- [ ] **Step 1: Write the failing schema tests**

Add to `tests/unit/domain/reconciliation.test.ts`, inside the existing
`describe("BacklogPatchSchema", ...)` block (find the block by searching
for `describe("BacklogPatchSchema"`; add these `it` blocks alongside the
existing `ADD_DEPENDENCY` cases in that same describe):

```ts
  it("accepts a REMOVE_DEPENDENCY patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "REMOVE_DEPENDENCY",
      issue: 15,
      dependsOn: 12,
      reason: "dependency was satisfied by a rearchitecting",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a REMOVE_DEPENDENCY patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "REMOVE_DEPENDENCY",
      issue: 15,
      dependsOn: 12,
      reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a REMOVE_DEPENDENCY patch with a non-positive dependsOn", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "REMOVE_DEPENDENCY",
      issue: 15,
      dependsOn: 0,
      reason: "invalid",
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: 3 new FAIL (schema doesn't recognize `REMOVE_DEPENDENCY` as a
valid `type` literal yet — Zod's discriminated union rejects it).

- [ ] **Step 3: Add the schema variant**

In `src/domain/reconciliation.ts`, replace the doc comment and add a new
variant to the union:

```ts
/**
 * Structured reconciliation patch. This milestone implements the subset
 * documented in the design spec (KEEP/ENRICH_ISSUE/CREATE_ISSUE/
 * ADD_DEPENDENCY/REMOVE_DEPENDENCY/MARK_STALE/NEEDS_HUMAN);
 * SPLIT_ISSUE/MERGE_DUPLICATE are documented as a future extension of this
 * same discriminated union. MARK_READY is deliberately excluded — see
 * docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md §6.
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
    type: z.literal("REMOVE_DEPENDENCY"),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (This will surface every place a `switch`/`if`
over `BacklogPatch`/`BacklogPatchType` needs a new case — none should
exist yet at this point since nothing consumes the new variant.)

- [ ] **Step 6: Commit**

```bash
git add src/domain/reconciliation.ts tests/unit/domain/reconciliation.test.ts
git commit -m "feat(reconciliation): add REMOVE_DEPENDENCY patch schema"
```

---

### Task 2: Body-edit primitive — `removeManagedDependencyFromBody`

**Files:**
- Modify: `src/reconciliation/apply-dependency.ts`
- Test: `tests/unit/reconciliation/apply-dependency.test.ts`

**Interfaces:**
- Consumes: `MANAGED_DEPENDENCY_PATTERN` from
  `src/analysis/dependency-markers.js` (already imported in
  `apply-dependency.ts`).
- Produces: `removeManagedDependencyFromBody(body: string, dependsOn: number): string`,
  consumed by Task 5 (preview renderer) and by the future `ApplyService`
  follow-up (not this plan).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/apply-dependency.test.ts`. First update
the import line to include the new function:

```ts
import {
  appendDependencyToBody,
  bodyAlreadyDependsOn,
  removeManagedDependencyFromBody,
  renderDependencyLine,
} from "../../../src/reconciliation/apply-dependency.js";
```

Then add a new `describe` block at the end of the file:

```ts
describe("removeManagedDependencyFromBody", () => {
  it("removes the dependency line and its now-empty header", () => {
    const body = "Do the oauth thing.\n\nDepends on:\n- #16 (unsatisfied)";
    expect(removeManagedDependencyFromBody(body, 16)).toBe("Do the oauth thing.");
  });

  it("removes only the matching line, keeping other bullets under the same header", () => {
    const body =
      "Body here.\n\nDepends on:\n- #7 (unsatisfied)\n- #9 (unsatisfied)";
    expect(removeManagedDependencyFromBody(body, 7)).toBe(
      "Body here.\n\nDepends on:\n- #9 (unsatisfied)",
    );
  });

  it("is a no-op when the managed-form line is absent", () => {
    const body = "Body here.\n\nDepends on:\n- #7 (unsatisfied)";
    expect(removeManagedDependencyFromBody(body, 99)).toBe(body);
  });

  it("does not touch a free-text dependency line", () => {
    const body = "depends on: #12\nmore content";
    expect(removeManagedDependencyFromBody(body, 12)).toBe(body);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/apply-dependency.test.ts`
Expected: FAIL with "removeManagedDependencyFromBody is not a function" or
similar (import error) — the function doesn't exist yet.

- [ ] **Step 3: Implement the function**

In `src/reconciliation/apply-dependency.ts`, add after `appendDependencyToBody`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/apply-dependency.test.ts`
Expected: PASS (all tests in the file, including the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/apply-dependency.ts tests/unit/reconciliation/apply-dependency.test.ts
git commit -m "feat(reconciliation): add removeManagedDependencyFromBody"
```

---

### Task 3: Patch policy — classify `REMOVE_DEPENDENCY` as `requires-approval`

**Files:**
- Modify: `src/reconciliation/patch-policy.ts`
- Test: `tests/unit/reconciliation/patch-policy.test.ts`

**Interfaces:**
- Consumes: `BacklogPatch` (Task 1's new variant).
- Produces: `classifyPatch` returns `"requires-approval"` for
  `REMOVE_DEPENDENCY`, consumed by `ReconciliationService`/report generation
  (unmodified in this plan — it already calls `classifyPatch` generically
  over every patch type).

- [ ] **Step 1: Write the failing test**

Add a new case to the `cases` array in
`tests/unit/reconciliation/patch-policy.test.ts` (insert after the
existing `ADD_DEPENDENCY` case):

```ts
  {
    patch: { type: "REMOVE_DEPENDENCY", issue: 1, dependsOn: 2, reason: "no longer needed" },
    policy: "requires-approval",
  },
```

- [ ] **Step 2: Run the test to confirm it passes with no code change**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: PASS immediately, with zero changes to
`src/reconciliation/patch-policy.ts`. Verified ahead of time: `classifyPatch`
is `AUTO_SAFE.has(patch.type) ? "auto-safe" : "requires-approval"`, and
`AUTO_SAFE` is exactly `new Set(["ENRICH_ISSUE", "ADD_DEPENDENCY", "CREATE_ISSUE"])`.
`REMOVE_DEPENDENCY` is not a member, so the fallback branch already
returns `"requires-approval"` correctly — this task only adds test
coverage of that existing, correct behavior. If the test somehow fails,
stop and report rather than guessing why; that would mean `AUTO_SAFE`
no longer matches what's described here.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/reconciliation/patch-policy.test.ts
git commit -m "test(reconciliation): cover REMOVE_DEPENDENCY as requires-approval"
```

---

### Task 4: Idempotency downgrade for `REMOVE_DEPENDENCY`

**Files:**
- Modify: `src/reconciliation/idempotency.ts`
- Test: `tests/unit/reconciliation/idempotency.test.ts`

**Interfaces:**
- Consumes: `BacklogPatch` (Task 1's variant), `MANAGED_DEPENDENCY_PATTERN`
  from `../analysis/dependency-markers.js` (already imported in this file).
- Produces: `applyIdempotencyDowngrades` downgrades a `REMOVE_DEPENDENCY`
  patch to `KEEP` when the managed-form line is already absent from the
  target issue's current body.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/idempotency.test.ts`, near the existing
`ADD_DEPENDENCY` cases:

```ts
  it("downgrades a REMOVE_DEPENDENCY patch to KEEP when the managed marker is already absent", () => {
    const patches: BacklogPatch[] = [
      { type: "REMOVE_DEPENDENCY", issue: 17, dependsOn: 15, reason: "no longer needed" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "no dependency markers here" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 17 });
  });

  it("leaves a REMOVE_DEPENDENCY patch unchanged when the managed marker is still present", () => {
    const patches: BacklogPatch[] = [
      { type: "REMOVE_DEPENDENCY", issue: 17, dependsOn: 15, reason: "no longer needed" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "Depends on:\n- #15 (unsatisfied)" },
    ]);
    expect(result.type).toBe("REMOVE_DEPENDENCY");
  });

  it("downgrades a REMOVE_DEPENDENCY patch to KEEP when the dependency is only present as free text", () => {
    const patches: BacklogPatch[] = [
      { type: "REMOVE_DEPENDENCY", issue: 17, dependsOn: 15, reason: "no longer needed" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "depends on: #15\n" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 17 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: FAIL — `applyIdempotencyDowngrades` currently has no
`REMOVE_DEPENDENCY` branch, so it falls through to `return patch;`
unchanged in all three cases, meaning the first and third tests (expecting
a `KEEP` downgrade) fail while the second (expecting no change) already
passes incidentally.

- [ ] **Step 3: Implement the downgrade branch**

In `src/reconciliation/idempotency.ts`, this file already imports
`MANAGED_DEPENDENCY_PATTERN` and `dependencyNumberFromMatch` from
`../analysis/dependency-markers.js`. Add a new branch inside the `.map()`
callback in `applyIdempotencyDowngrades`, after the existing
`if (patch.type === "ADD_DEPENDENCY") { ... }` block and before the
`if (patch.type === "CREATE_ISSUE") { ... }` block:

```ts
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
```

Note: this checks `MANAGED_DEPENDENCY_PATTERN` only (not
`LINE_DEPENDENCY_PATTERN`) — a free-text-only dependency correctly
downgrades to `KEEP` here, matching the spec's two-layer guard (§3.2/§3.4).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/idempotency.ts tests/unit/reconciliation/idempotency.test.ts
git commit -m "feat(reconciliation): downgrade REMOVE_DEPENDENCY to KEEP when marker is absent"
```

---

### Task 5: Preview renderer — `renderRemoveDependencyPreview`

**Files:**
- Modify: `src/reconciliation/apply-preview.ts`
- Test: `tests/unit/reconciliation/apply-preview.test.ts`

**Interfaces:**
- Consumes: none new (pure string formatting).
- Produces: `renderRemoveDependencyPreview(currentBody: string, dependsOn: number): string`,
  available for the future `ApplyService` follow-up (not wired in by this
  plan).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/apply-preview.test.ts`. Update the
import line to include the new function:

```ts
import {
  confirmMenu,
  renderEnrichPreview,
  renderDependencyPreview,
  renderRemoveDependencyPreview,
  renderCreatePreview,
} from "../../../src/reconciliation/apply-preview.js";
```

Add a new `describe` block after `describe("renderDependencyPreview", ...)`:

```ts
  describe("renderRemoveDependencyPreview", () => {
    it("returns the dependency line being removed", () => {
      const result = renderRemoveDependencyPreview("some current body", 42);
      expect(result).toBe("remove: - #42 (unsatisfied)");
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: FAIL — `renderRemoveDependencyPreview` doesn't exist (import
error).

- [ ] **Step 3: Implement the function**

In `src/reconciliation/apply-preview.ts`, add after
`renderDependencyPreview`:

```ts
/** Render the one dependency line a REMOVE_DEPENDENCY will delete. */
export function renderRemoveDependencyPreview(
  currentBody: string,
  dependsOn: number,
): string {
  return `remove: ${renderDependencyLine(dependsOn)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/apply-preview.ts tests/unit/reconciliation/apply-preview.test.ts
git commit -m "feat(reconciliation): add renderRemoveDependencyPreview"
```

---

### Task 6: Prompt contract — reconciler output shape and rule

**Files:**
- Modify: `src/reconciliation/prompt.ts`
- Test: `tests/unit/reconciliation/prompt.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `buildReconcilerPrompt`'s returned string includes a
  `REMOVE_DEPENDENCY` example in the `submit_result` contract and an
  instructive rule — read by the reconciler Pi role at runtime (not
  type-checked, verified only by string-content tests).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/prompt.test.ts` (append new `it` blocks
inside the existing `describe("buildReconcilerPrompt", ...)` block):

```ts
  it("includes the REMOVE_DEPENDENCY patch shape in the output contract", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain('"type": "REMOVE_DEPENDENCY"');
    expect(prompt).toContain('"dependsOn"');
  });

  it("instructs the reconciler never to propose REMOVE_DEPENDENCY against a free-text dependency line", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("REMOVE_DEPENDENCY");
    expect(prompt).toContain("free-text");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: FAIL — neither string currently appears in the prompt output.

- [ ] **Step 3: Update the prompt**

In `src/reconciliation/prompt.ts`, inside the `submit_result` JSON example
in the returned template literal, add a line after the existing
`ADD_DEPENDENCY` example line:

```
    { "type": "ADD_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." },
    { "type": "REMOVE_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." },
```

And in the `Rules` section, add a new bullet after the existing
`ADD_DEPENDENCY` rule ("Propose ADD_DEPENDENCY when one issue's work
genuinely cannot start before another completes..."):

```
- Propose REMOVE_DEPENDENCY only when a currently-recorded managed-form dependency (the "- #N (unsatisfied)" bullet, not free-text prose like "depends on #12") no longer reflects a real ordering constraint — for example, the dependency was satisfied by a rearchitecting that removed the need for it, or was recorded in error. Never propose it against a dependency you only see written as free-text human prose.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/prompt.ts tests/unit/reconciliation/prompt.test.ts
git commit -m "feat(reconciliation): add REMOVE_DEPENDENCY to reconciler prompt contract"
```

---

### Task 7: Full-suite verification and milestone doc update

**Files:**
- Modify: `docs/MILESTONES.md`

**Interfaces:**
- Consumes: nothing new — this task is verification plus a documentation
  update, no source changes.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all test files pass (was 71 files / 680 tests before this plan;
expect 71 files still, with a higher passing test count reflecting the
~13 new tests added across Tasks 1-6).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build` (runs `tsc -p tsconfig.json`)
Expected: build succeeds with no errors.

- [ ] **Step 4: Update `docs/MILESTONES.md`**

Find the `### Reconciliation apply-safe follow-ups 🔲` section (under
`## Backlog — missing features`). Replace the bullet:

```
- **Remaining patch types:** `SPLIT_ISSUE`, `MERGE_DUPLICATE`,
  `REMOVE_DEPENDENCY`, `MARK_READY` — documented in
  `src/domain/reconciliation.ts` as a future extension of the
  `BacklogPatch` union. (extend_requirements.md §"Structured patch model")
```

with:

```
- **Remaining patch types:** `SPLIT_ISSUE`, `MERGE_DUPLICATE` —
  documented in `src/domain/reconciliation.ts` as a future extension of
  the `BacklogPatch` union. (extend_requirements.md §"Structured patch model")
  `REMOVE_DEPENDENCY` is implemented (schema, policy, idempotency, prompt)
  but report-only — see the next bullet. `MARK_READY` is deliberately
  excluded; see `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md` §6.
- **`REMOVE_DEPENDENCY` → `ApplyService` wiring.** `ApplyService.apply()`
  unconditionally skips every `requires-approval` patch before `prepare()`
  runs, so `REMOVE_DEPENDENCY` (always `requires-approval`) cannot yet be
  applied through `reconcile-apply` even though its body-edit primitive
  (`removeManagedDependencyFromBody`) and preview renderer
  (`renderRemoveDependencyPreview`) already exist and are tested. Fixing
  requires first deciding how `ApplyService` should distinguish
  "requires-approval but still offerable via interactive confirmation"
  (`REMOVE_DEPENDENCY`) from "requires-approval and never offered"
  (`MARK_STALE`, `NEEDS_HUMAN`) — a cross-cutting change to code every
  patch type depends on.
```

- [ ] **Step 5: Commit**

```bash
git add docs/MILESTONES.md
git commit -m "docs: mark REMOVE_DEPENDENCY implemented (report-only) in MILESTONES.md"
```

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Plan self-review notes

- **Spec coverage:** §3.1 (managed-form-only) → Task 2. §3.2 (two-layer
  guard) → Task 4 (deterministic) + Task 6 (prompt). §3.3 (policy) → Task
  3. §3.4 (idempotency) → Task 4. §3.5 (prompt) → Task 6. §3.6 (apply-side
  primitives built but not wired) → Task 2 + Task 5, explicitly not wired
  in any task. §3.7 (preview) → Task 5. §4 (schema) → Task 1. §5
  (testing) → covered per-task. §6 (out of scope) → nothing in this plan
  contradicts it; Task 7 documents the deferred `ApplyService` wiring
  explicitly rather than leaving it implicit.
- **Type consistency:** `removeManagedDependencyFromBody(body: string, dependsOn: number): string`
  (Task 2) and `renderRemoveDependencyPreview(currentBody: string, dependsOn: number): string`
  (Task 5) match the exact signatures given in the spec §3.6/§3.7.
- **No `ApplyService.test.ts` changes anywhere in this plan** — matches
  spec §5's explicit statement that `ApplyService`'s existing tests are
  unaffected.
