# MERGE_DUPLICATE Reconciliation Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `MERGE_DUPLICATE` as a new `BacklogPatch` variant, wired end-to-end (schema, patch policy, idempotency, prompt, preview, `ApplyService`, and a new `GitHubPort.closeIssue` primitive), so the reconciler can propose closing a duplicate issue in favor of a survivor and a human can approve applying it.

**Architecture:** Follows the exact wiring shape already established by `REMOVE_DEPENDENCY`/`SPLIT_ISSUE`: a discriminated-union schema variant classified `requires-approval` and added to `OFFERABLE_REQUIRES_APPROVAL`, a cheap state-based idempotency check (re-run once during report generation, re-run again immediately before the actual write), a preview renderer, and a `prepare`/`applyFresh` pair in `ApplyService`. The only genuinely new primitive is `GitHubPort.closeIssue` — no existing patch type closes an issue.

**Tech Stack:** TypeScript, Zod schemas, Vitest, Octokit REST client.

**Spec:** `docs/superpowers/specs/2026-08-24-merge-duplicate-design.md`

## Global Constraints

- `keep` and `duplicate` are both `z.number().int().positive()`; the schema does not enforce `keep !== duplicate` — that is a prompt-level instruction, not a structural constraint (spec §3.2).
- `MERGE_DUPLICATE` is classified `requires-approval` and joins `OFFERABLE_REQUIRES_APPROVAL` (spec §3.6) — it must never auto-apply under `--yes` or a prior "all" answer, exactly like `REMOVE_DEPENDENCY`/`SPLIT_ISSUE`.
- Idempotency check is always `duplicate.state === "closed"` — no comment-content matching (spec §3.7).
- `keep` is never mutated by apply. Only `duplicate` receives a comment and then a close call (spec §3.1, §3.3).
- Rewriting other issues' dependencies on `duplicate`, and rewriting the epic checklist line for `duplicate`, are explicitly out of scope (spec §3.4) — do not implement either.
- `sortPatches`' rank map gets `MERGE_DUPLICATE` appended after `SPLIT_ISSUE` (spec §3.8).

---

### Task 1: Schema — add `MERGE_DUPLICATE` to `BacklogPatchSchema`

**Files:**
- Modify: `src/domain/reconciliation.ts`
- Test: `tests/unit/domain/reconciliation.test.ts`

**Interfaces:**
- Produces: `BacklogPatchSchema` discriminated-union member `{ type: "MERGE_DUPLICATE", keep: number, duplicate: number, reason: string }`, and the corresponding `BacklogPatch` union member type (inferred automatically via `z.infer`).

- [ ] **Step 1: Write the failing schema tests**

Add to `tests/unit/domain/reconciliation.test.ts`, inside the existing `describe("BacklogPatchSchema", ...)` block (place after the last `SPLIT_ISSUE`-related test, before the `MARK_STALE` tests):

```ts
  it("accepts a MERGE_DUPLICATE patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MERGE_DUPLICATE",
      keep: 120,
      duplicate: 123,
      reason: "both issues describe the same OAuth callback rejection behavior",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a MERGE_DUPLICATE patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MERGE_DUPLICATE",
      keep: 120,
      duplicate: 123,
      reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a MERGE_DUPLICATE patch with a non-positive issue number", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MERGE_DUPLICATE",
      keep: 120,
      duplicate: 0,
      reason: "x",
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts -t "MERGE_DUPLICATE"`
Expected: FAIL — `MERGE_DUPLICATE` is not a recognized `type` literal, so `safeParse` returns `success: false` for the first test (which expects `true`).

- [ ] **Step 3: Add the schema variant**

In `src/domain/reconciliation.ts`, add a new member to `BacklogPatchSchema`'s discriminated union, immediately after the existing `SPLIT_ISSUE` object and before `MARK_STALE`:

```ts
  z.object({
    type: z.literal("MERGE_DUPLICATE"),
    keep: z.number().int().positive(),
    duplicate: z.number().int().positive(),
    reason: z.string().min(1),
  }),
```

Also update the doc comment directly above `BacklogPatchSchema` (currently reads `"MERGE_DUPLICATE is documented as a future extension of this same discriminated union"`) to:

```ts
/**
 * Structured reconciliation patch. This union implements every variant
 * documented in docs/resources/extend_requirements.md's "Structured patch
 * model" (KEEP/ENRICH_ISSUE/CREATE_ISSUE/ADD_DEPENDENCY/REMOVE_DEPENDENCY/
 * SPLIT_ISSUE/MERGE_DUPLICATE/MARK_STALE/NEEDS_HUMAN). MARK_READY is
 * deliberately excluded — see
 * docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md §6.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: PASS (all tests in the file, including the new ones)

- [ ] **Step 5: Commit**

```bash
git add src/domain/reconciliation.ts tests/unit/domain/reconciliation.test.ts
git commit -m "feat: add MERGE_DUPLICATE schema variant to BacklogPatchSchema"
```

---

### Task 2: Patch policy — classify `MERGE_DUPLICATE` as `requires-approval`

**Files:**
- Modify: `src/reconciliation/patch-policy.ts`
- Test: `tests/unit/reconciliation/patch-policy.test.ts`

**Interfaces:**
- Consumes: `BacklogPatch` from Task 1 (`MERGE_DUPLICATE` variant now parses).
- Produces: no new exports — `classifyPatch` already returns `"requires-approval"` for any type not in `AUTO_SAFE`; this task only needs a test confirming that's still true for the new type (no code change is required, since `AUTO_SAFE` is an explicit allow-list and `MERGE_DUPLICATE` is not in it — but write the test anyway so the classification is explicitly pinned in the suite, matching the existing pattern for `SPLIT_ISSUE`).

- [ ] **Step 1: Write the failing (well, immediately-passing-but-pin-it) test**

Check the existing `tests/unit/reconciliation/patch-policy.test.ts` around line 54 (the `SPLIT_ISSUE` case) to find the exact helper shape, then add a sibling case. Read the file first:

Run: `sed -n '1,90p' tests/unit/reconciliation/patch-policy.test.ts`

Add a test following the same shape as the existing `SPLIT_ISSUE` pin test, e.g.:

```ts
  it("classifies MERGE_DUPLICATE as requires-approval", () => {
    expect(
      classifyPatch({
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 123,
        reason: "same behavioral outcome",
      }),
    ).toBe("requires-approval");
  });
```

Place it inside the existing `describe("classifyPatch", ...)` block, after the `SPLIT_ISSUE` case.

- [ ] **Step 2: Run the test to verify it passes immediately**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: PASS — `classifyPatch` already returns `requires-approval` for any type not explicitly in `AUTO_SAFE`, and `MERGE_DUPLICATE` was never added there. This test exists to pin the behavior against future regression, not to drive new code.

- [ ] **Step 3: Update the `classifyPatch` doc comment for completeness**

In `src/reconciliation/patch-policy.ts`, update the doc comment on `classifyPatch` (currently lists `MARK_STALE`, `NEEDS_HUMAN`, and `SPLIT_ISSUE` as always `requires-approval`) to also name `MERGE_DUPLICATE`:

```ts
/**
 * Deterministic apply-safety classification for one patch, informational
 * only in this milestone (nothing is applied yet) — the seam the future
 * `apply-safe` mode reads directly. `KEEP` is a no-op, not a write, but is
 * still classified `requires-approval` here since it carries no automatic
 * action to gate; `MARK_STALE`, `NEEDS_HUMAN`, `SPLIT_ISSUE`, and
 * `MERGE_DUPLICATE` are always `requires-approval`; every additive patch
 * type is `auto-safe`. Never assigned by the LLM.
 */
```

- [ ] **Step 4: Run the full test file again to confirm no regression**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/patch-policy.ts tests/unit/reconciliation/patch-policy.test.ts
git commit -m "test: pin MERGE_DUPLICATE as a requires-approval patch"
```

---

### Task 3: `GitHubPort.closeIssue` — new primitive

**Files:**
- Modify: `src/github/github-adapter.ts`
- Test: `tests/unit/github/github-adapter.test.ts` (existing file; has a `describe("GitHubAdapter", ...)` block with a `makeAdapter`/`makeOctokit` fixture pair already used by the `updateIssueBody` test at line ~213)

**Interfaces:**
- Produces: `GitHubPort.closeIssue(number: number): Promise<void>`, implemented on `GitHubAdapter`.

- [ ] **Step 1: Write the failing test**

In `tests/unit/github/github-adapter.test.ts`, inside `describe("GitHubAdapter", ...)`, add a new test immediately after the existing `"updates the issue body and returns the updated issue"` test (around line 213-224), following its exact `makeOctokit`/`makeAdapter` fixture pattern:

```ts
  it("closes an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await github.closeIssue(42);
    expect(octokit.rest.issues.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      state: "closed",
    });
  });

  it("wraps a failure to close an issue in GitHubError", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.update.mockRejectedValueOnce(new Error("boom"));
    const { github } = await makeAdapter(octokit);
    await expect(github.closeIssue(42)).rejects.toThrow("failed to close issue #42");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/github/github-adapter.test.ts -t "closes an issue"`
Expected: FAIL — `GitHubAdapter` (and the `GitHubPort` interface it implements) has no `closeIssue` method yet, so this is a compile/type error surfaced as a test failure.

- [ ] **Step 3: Add `closeIssue` to the `GitHubPort` interface**

In `src/github/github-adapter.ts`, add to the `GitHubPort` interface, immediately after `updateIssueBody(number: number, body: string): Promise<GitHubIssue>;`:

```ts
  closeIssue(number: number): Promise<void>;
```

- [ ] **Step 4: Implement `closeIssue` on the adapter**

In `src/github/github-adapter.ts`, add a new method on the adapter class, immediately after the existing `updateIssueBody` implementation (which currently ends around line 313):

```ts
  async closeIssue(number: number): Promise<void> {
    try {
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        state: "closed",
      });
    } catch (error) {
      throw new GitHubError(`failed to close issue #${number}`, {
        cause: error,
      });
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/github/github-adapter.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 6: Run the TypeScript check across the whole project and enumerate every broken fake**

Run: `npx tsc --noEmit`

Expected: this repo has 17 files that each define their own class implementing `GitHubPort` for test purposes (confirmed via `grep -rln "implements GitHubPort" src tests`), and every one of them will now fail to compile because none of them has a `closeIssue` method. This is expected — Task 7 fixes every one of them in one pass, immediately before it adds the `MERGE_DUPLICATE`-specific tests, so the suite compiles again before any new test is written. Confirm `src/github/github-adapter.ts` itself has zero errors, and that the full list of broken files matches:

```
tests/unit/reconciliation/apply-service.test.ts
tests/unit/reconciliation/reconciliation-service.test.ts
tests/unit/analysis/backlog-analyst.test.ts
tests/unit/analysis/issue-set.test.ts
tests/unit/readiness/readiness-service.test.ts
tests/unit/commands/reconcile-apply.test.ts
tests/integration/publication/publisher.test.ts
tests/integration/workflow/recovery-service.test.ts
tests/integration/workflow/run-service.test.ts
tests/integration/commands/check.test.ts
tests/integration/commands/analyze.test.ts
tests/integration/commands/operator-commands.test.ts
tests/integration/commands/run.test.ts
tests/integration/commands/prepare.test.ts
tests/integration/commands/reconcile.test.ts
tests/integration/commands/prepare-reuse.test.ts
tests/e2e/helpers.ts
```

If `grep -rln "implements GitHubPort" src tests` finds any file not in this list (e.g. a new test added between this plan's writing and its execution), add it to the list Task 7 Step 1 works through.

- [ ] **Step 7: Commit**

```bash
git add src/github/github-adapter.ts
git commit -m "feat: add closeIssue to GitHubPort and the Octokit adapter"
```

---

### Task 4: Idempotency downgrade for `MERGE_DUPLICATE`

**Files:**
- Modify: `src/reconciliation/idempotency.ts`
- Test: `tests/unit/reconciliation/idempotency.test.ts`

**Interfaces:**
- Consumes: `BacklogPatch` (Task 1), the `IssueLike` interface already defined in `idempotency.ts` (currently `{ number, title, body }`; this task adds `state: string` to it).
- Produces: no new exports — extends `applyIdempotencyDowngrades`'s internal `.map()` branching with a new `if (patch.type === "MERGE_DUPLICATE")` case.

**Important — compile-order note:** `IssueLike` (the shape `applyIdempotencyDowngrades` receives as its `issues` parameter, via `ReadonlyArray<IssueLike>`) currently has fields `number`, `title`, `body` — no `state`. The idempotency check needs `duplicate`'s open/closed state, so this task adds `state: string` to `IssueLike` as a **required** field (not optional — an optional field would let the real caller silently keep omitting it, and the `MERGE_DUPLICATE` branch would then never fire against real data). Because TypeScript excess-property-checks object literals assigned directly to a typed array parameter, every existing call site must supply `state` in the *same* step the interface gains the field, or the file won't compile. The two affected call sites are:

- The real caller, `src/reconciliation/reconciliation-service.ts` (~line 108-113), builds `issueLikes: Array<{ number: number; title: string; body: string }>` from a `GitHubIssue[]` it already has in scope — it drops `state` today because nothing needed it, but the object it maps from already has it.
- Every existing literal in `tests/unit/reconciliation/idempotency.test.ts` (~13 call sites) constructs `IssueLike` objects inline as `{ number, title, body }`.

Step 1 below makes the interface change and fixes every one of those call sites in the same step, so the codebase compiles both before and after — only then does Step 2 add new tests that actually exercise `MERGE_DUPLICATE`.

- [ ] **Step 1: Add `state` to `IssueLike`, and update every existing call site to supply it**

In `src/reconciliation/idempotency.ts`, update the `IssueLike` interface:

```ts
interface IssueLike {
  number: number;
  title: string;
  body: string;
  state: string;
}
```

In `src/reconciliation/reconciliation-service.ts`, change:

```ts
    const issueLikes: Array<{ number: number; title: string; body: string }> =
      issues.map((issue: GitHubIssue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
      }));
```

to:

```ts
    const issueLikes: Array<{ number: number; title: string; body: string; state: string }> =
      issues.map((issue: GitHubIssue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));
```

In `tests/unit/reconciliation/idempotency.test.ts`: run `grep -n "applyIdempotencyDowngrades(patches" tests/unit/reconciliation/idempotency.test.ts` to list every existing call (there are ~13). For each inline issue-object literal passed as the second argument (e.g. `{ number: 16, title: "Create user from GitHub identity", body: already }`), add `, state: "open"` — every pre-existing test describes issues that are still open, none test a closed-issue scenario, so `"open"` is correct for all of them.

- [ ] **Step 1b: Run the full suite to confirm this pure refactor introduced no behavior change**

Run: `npx vitest run && npx tsc --noEmit`
Expected: both PASS — this step only added a field everywhere it's constructed and threaded one extra value through one caller; no test assertion should change.

- [ ] **Step 2: Write the failing tests for the new `MERGE_DUPLICATE` branch**

Add to `tests/unit/reconciliation/idempotency.test.ts`, inside `describe("applyIdempotencyDowngrades", ...)`, after the existing `SPLIT_ISSUE` tests (around line 145-161):

```ts
  it("downgrades a MERGE_DUPLICATE patch to KEEP when the duplicate issue is already closed", () => {
    const patches: BacklogPatch[] = [
      {
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 123,
        reason: "same behavioral outcome",
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 120, title: "OAuth callback", body: "", state: "open" },
      { number: 123, title: "OAuth callback (dup)", body: "", state: "closed" },
    ]);
    expect(result).toEqual({
      type: "KEEP",
      issue: 123,
      reason: "already closed as a duplicate of #120",
    });
  });

  it("leaves a MERGE_DUPLICATE patch unchanged when the duplicate issue is still open", () => {
    const patches: BacklogPatch[] = [
      {
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 123,
        reason: "same behavioral outcome",
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 120, title: "OAuth callback", body: "", state: "open" },
      { number: 123, title: "OAuth callback (dup)", body: "", state: "open" },
    ]);
    expect(result).toEqual(patches[0]);
  });

  it("leaves a MERGE_DUPLICATE patch unchanged when the duplicate issue is not in the provided issue list", () => {
    const patches: BacklogPatch[] = [
      {
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 999,
        reason: "same behavioral outcome",
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 120, title: "OAuth callback", body: "", state: "open" },
    ]);
    expect(result).toEqual(patches[0]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts -t "MERGE_DUPLICATE"`
Expected: FAIL — the file compiles (Step 1 already made `state` available everywhere it's needed), but `applyIdempotencyDowngrades` doesn't handle `MERGE_DUPLICATE` yet and returns the patch unchanged through the final `return patch;` fallthrough, so the first new test's assertion (expecting a `KEEP` patch) fails while the other two happen to already pass. Confirm the first test specifically fails.

- [ ] **Step 4: Add the `MERGE_DUPLICATE` branch**

In `src/reconciliation/idempotency.ts`, add a new branch inside the `.map()` callback in `applyIdempotencyDowngrades`, after the existing `if (patch.type === "SPLIT_ISSUE") { ... }` block and before the final `return patch;`:

```ts
    if (patch.type === "MERGE_DUPLICATE") {
      const duplicateIssue = byNumber.get(patch.duplicate);
      if (duplicateIssue !== undefined && duplicateIssue.state === "closed") {
        return {
          type: "KEEP",
          issue: patch.duplicate,
          reason: `already closed as a duplicate of #${patch.keep}`,
        };
      }
      return patch;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full test suite once more to confirm no regression**

Run: `npx vitest run && npx tsc --noEmit`
Expected: both PASS across the whole suite.

- [ ] **Step 7: Commit**

```bash
git add src/reconciliation/idempotency.ts tests/unit/reconciliation/idempotency.test.ts
git commit -m "feat: downgrade MERGE_DUPLICATE to KEEP when the duplicate is already closed"
```

---

### Task 5: Prompt contract — instruct the reconciler to propose `MERGE_DUPLICATE`

**Files:**
- Modify: `src/reconciliation/prompt.ts`
- Test: `tests/unit/reconciliation/prompt.test.ts`

**Interfaces:**
- Consumes: nothing new — `buildReconcilerPrompt`'s existing signature is unchanged.
- Produces: nothing new — only the string content `buildReconcilerPrompt` returns changes.

- [ ] **Step 1: Write the failing tests**

Read `tests/unit/reconciliation/prompt.test.ts` around lines 73-108 (the existing `SPLIT_ISSUE` tests) to confirm the exact `buildReconcilerPrompt` call shape used in that file's setup, then add two sibling tests immediately after them:

```ts
  it("instructs the model to propose MERGE_DUPLICATE only for true duplicates, not merely related issues", () => {
    const prompt = buildReconcilerPrompt(input);
    expect(prompt).toContain("MERGE_DUPLICATE");
    expect(prompt).toContain("same actual piece of work");
  });

  it("includes the MERGE_DUPLICATE patch shape with keep and duplicate fields in the output contract", () => {
    const prompt = buildReconcilerPrompt(input);
    expect(prompt).toContain('"type": "MERGE_DUPLICATE"');
    expect(prompt).toContain('"keep"');
    expect(prompt).toContain('"duplicate"');
  });
```

(Use whatever local variable name the file's existing tests use for the `ReconcilerPromptInput` fixture in place of `input` — match the file's own naming exactly.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts -t "MERGE_DUPLICATE"`
Expected: FAIL — the string `"MERGE_DUPLICATE"` does not yet appear anywhere in `buildReconcilerPrompt`'s output.

- [ ] **Step 3: Add the `MERGE_DUPLICATE` example to the output contract**

In `src/reconciliation/prompt.ts`, inside the `submit_result` output-contract template literal, add a new line to the `"patches"` array example, immediately after the existing `SPLIT_ISSUE` example line:

```ts
    { "type": "MERGE_DUPLICATE", "keep": 120, "duplicate": 123, "reason": "..." },
```

- [ ] **Step 4: Add the `MERGE_DUPLICATE` rule to the "Rules" section**

In the same file, in the `Rules\n-----` section, add a new bullet immediately after the existing `SPLIT_ISSUE` rule bullet (the one starting "An issue is the right size when..."):

```
- Propose MERGE_DUPLICATE when two issues in this epic describe the same actual piece of work — not merely similar titles or overlapping keywords, but the same behavioral outcome such that implementing one would fully satisfy the other. Set "keep" to whichever issue has more complete or enriched content (fuller acceptance criteria, more validated context); if the two are equally complete, "keep" is the lower-numbered issue. Set "duplicate" to the other. Never propose MERGE_DUPLICATE for issues that merely depend on or relate to each other — only true duplicates.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/prompt.ts tests/unit/reconciliation/prompt.test.ts
git commit -m "feat: instruct reconciler to propose MERGE_DUPLICATE for true duplicate issues"
```

---

### Task 6: `renderMergeDuplicatePreview`

**Files:**
- Modify: `src/reconciliation/apply-preview.ts`
- Test: `tests/unit/reconciliation/apply-preview.test.ts`

**Interfaces:**
- Consumes: `ReconciledPatch` (Task 1's `MERGE_DUPLICATE` variant plus the existing `policy` field).
- Produces: `renderMergeDuplicatePreview(patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>): string`.

- [ ] **Step 1: Write the failing test**

Read `tests/unit/reconciliation/apply-preview.test.ts` around lines 175-200 (the existing `describe("renderSplitPreview", ...)` block) to confirm the exact patch-literal shape used (it includes a `policy` field, since `ReconciledPatch = BacklogPatch & { policy: PatchPolicy }`), then add a sibling `describe` block after it:

```ts
  describe("renderMergeDuplicatePreview", () => {
    it("shows both issue numbers and which one closes", () => {
      const preview = renderMergeDuplicatePreview({
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 123,
        reason: "same behavioral outcome",
        policy: "requires-approval",
      });
      expect(preview).toContain("#120");
      expect(preview).toContain("#123");
      expect(preview).toContain("close");
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts -t "renderMergeDuplicatePreview"`
Expected: FAIL — `renderMergeDuplicatePreview` is not exported from `apply-preview.ts` yet (a TypeScript/import error, surfacing as a test-run failure).

- [ ] **Step 3: Implement `renderMergeDuplicatePreview`**

In `src/reconciliation/apply-preview.ts`, add a new function immediately after `renderSplitPreview`:

```ts
/** Render a compact human summary for a MERGE_DUPLICATE: which issue is
 * kept and which one will be commented on and closed. */
export function renderMergeDuplicatePreview(
  patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
): string {
  return `keep #${patch.keep}; close #${patch.duplicate} as a duplicate`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/apply-preview.ts tests/unit/reconciliation/apply-preview.test.ts
git commit -m "feat: add renderMergeDuplicatePreview for MERGE_DUPLICATE apply preview"
```

---

### Task 7: Wire `MERGE_DUPLICATE` into `ApplyService`

**Files:**
- Modify: `src/reconciliation/apply-service.ts`
- Test: `tests/unit/reconciliation/apply-service.test.ts`

**Interfaces:**
- Consumes: `GitHubPort.closeIssue` (Task 3), `renderMergeDuplicatePreview` (Task 6), `BacklogPatch`'s `MERGE_DUPLICATE` variant (Task 1).
- Produces: no new public exports — extends `OFFERABLE_REQUIRES_APPROVAL`, `prepare()`'s switch, `sortPatches`' rank map, and adds two new private methods `prepareMergeDuplicate` / `applyMergeDuplicateFresh`.

This task also fixes the `FakeGitHub` test double (and any other `GitHubPort` implementer in the test suite) to add `closeIssue`, since Task 3 added it to the interface and this is the first task that actually needs it to compile.

- [ ] **Step 1: Add `closeIssue` to `FakeGitHub` and track calls, and un-stub `createIssueComment` to track calls instead of throwing**

In `tests/unit/reconciliation/apply-service.test.ts`, modify the `FakeGitHub` class:

Replace:
```ts
  async createIssueComment(): Promise<void> {
    throw new Error("not called");
  }
```
with:
```ts
  readonly comments: Array<{ number: number; body: string }> = [];

  async createIssueComment(number: number, body: string): Promise<void> {
    this.comments.push({ number, body });
  }

  readonly closed: number[] = [];

  async closeIssue(number: number): Promise<void> {
    this.closed.push(number);
    const issue = this.issues.get(number);
    if (issue !== undefined) {
      this.issues.set(number, { ...issue, state: "closed" });
    }
  }
```

Run: `grep -n "class FakeGitHubWithFail\|class FakeGitHubFailingCreate" tests/unit/reconciliation/apply-service.test.ts` to confirm there are no other `GitHubPort` implementers in this file besides `FakeGitHub` and its two subclasses (which inherit `closeIssue`/`createIssueComment` automatically via `extends FakeGitHub` and only override specific methods) — both existing subclasses only override `updateIssueBody`/`createIssue` respectively, so they need no changes.

- [ ] **Step 1b: Add `closeIssue` to every other `GitHubPort` fake in the repo**

Task 3 Step 6 enumerated 17 files implementing `GitHubPort`; Step 1 above just fixed `tests/unit/reconciliation/apply-service.test.ts`. Fix the remaining 16 now, in one pass, so the whole suite compiles before any `MERGE_DUPLICATE`-specific test is added. Each file's fake already has an `updateIssueBody`/`createIssueComment` idiom — add `closeIssue` matching that same file's idiom: files whose fake logs a call and throws `"must not be called"` (asserting this code path never mutates GitHub) get a `closeIssue` that does the same; files whose fake actually records/applies the write get a `closeIssue` that mutates its in-memory issue map to `state: "closed"`.

For each file below, add the method immediately after that file's existing `createIssueComment` method (found by `grep -n "async createIssueComment" <file>`):

- **`tests/unit/reconciliation/reconciliation-service.test.ts`**, **`tests/unit/analysis/backlog-analyst.test.ts`**, **`tests/unit/readiness/readiness-service.test.ts`**, **`tests/integration/commands/check.test.ts`**, **`tests/integration/commands/analyze.test.ts`**, **`tests/integration/commands/reconcile.test.ts`** (top-level `FakeGitHub`, not the nested `MixedGitHub`) — each of these fakes' `createIssueComment` pushes `"createIssueComment"` onto a `this.mutationCalls` array and throws `"must not be called"`. Add:

  ```ts
  async closeIssue(): Promise<void> {
    this.mutationCalls.push("closeIssue");
    throw new Error("must not be called");
  }
  ```

- **`tests/integration/commands/prepare.test.ts`**, **`tests/integration/commands/prepare-reuse.test.ts`** — same throwing idiom, but the array is named `this.calls` in these two files. Add:

  ```ts
  async closeIssue(): Promise<void> {
    this.calls.push("closeIssue");
    throw new Error("must not be called");
  }
  ```

- **`tests/unit/analysis/issue-set.test.ts`** — its `createIssueComment` is a one-line `async createIssueComment(): Promise<void> { throw new Error("must not be called"); }` with no call-tracking array. Add, on its own line immediately after it:

  ```ts
  async closeIssue(): Promise<void> { throw new Error("must not be called"); }
  ```

- **`tests/integration/workflow/recovery-service.test.ts`**, **`tests/integration/workflow/run-service.test.ts`**, **`tests/integration/commands/operator-commands.test.ts`**, **`tests/integration/commands/run.test.ts`** — each of these fakes' `createIssueComment(_number, body)` actually records the comment (`this.comments.push(...)`) rather than throwing, because these test suites exercise real comment-posting flows. Add a `closeIssue` that similarly records rather than throws — check each file for how its issue map is named (`grep -n "private readonly issues\|this.issues" <file>` to confirm the field name before writing this) and mutate that map's entry to `state: "closed"`:

  ```ts
  async closeIssue(number: number): Promise<void> {
    const issue = this.issues.get(number);
    if (issue !== undefined) this.issues.set(number, { ...issue, state: "closed" });
  }
  ```

  If any of these four files' issue storage is not a `Map` named `this.issues` (verify with the grep above before writing), adapt the two lines inside the method to that file's actual storage shape while keeping the same externally observable effect (issue passed to `getIssue` afterward reports `state: "closed"`).

- **`tests/unit/commands/reconcile-apply.test.ts`** (`RecordingGitHub`) — its `createIssueComment` pushes `"createIssueComment"` onto `this.writes` and does not throw (a genuine recording fake, matching this file's `updateIssueBody` which also writes through). Add:

  ```ts
  async closeIssue(number: number): Promise<void> {
    const existing = await this.getIssue(number);
    this.issues.set(number, { ...existing, state: "closed" });
    this.writes.push(`closeIssue:#${number}`);
  }
  ```

- **`tests/integration/publication/publisher.test.ts`** — this fake uses arrow-function properties (`createIssueComment = vi.fn(...)`, `updateIssueBody = vi.fn(async (): Promise<never> => { throw new Error("issue body/closure calls are forbidden in M1"); })`), asserting the publication flow never touches issue body/closure at all. Add a sibling property, matching the existing forbidden-mutation message style:

  ```ts
  closeIssue = vi.fn(async (): Promise<never> => {
    throw new Error("issue body/closure calls are forbidden in M1");
  });
  ```

- **`tests/integration/commands/reconcile.test.ts`**'s nested `MixedGitHub` class (defined inside a test body, not at module scope — find it via `grep -n "class MixedGitHub"`) — its `createIssueComment` pushes onto `this.mutationCalls` and continues (does not throw, unlike the module-scope `FakeGitHub` in the same file — check the full method body before editing). Add `closeIssue` following that same continue-rather-than-throw pattern, pushing `"closeIssue"` onto `this.mutationCalls`.

- **`tests/e2e/helpers.ts`** (`FakeGitHubServer`) — its `createIssueComment(_number, body)` records into a comments structure (confirm exact shape via `grep -n "class FakeGitHubServer" -A 40 tests/e2e/helpers.ts` before writing, since this is the one file not yet inspected above). Add a `closeIssue` that mutates this file's issue-storage structure to `state: "closed"`, matching whatever pattern `updateIssueBody` in the same class already uses for issue mutation.

- [ ] **Step 2: Run the full suite to confirm the interface now compiles everywhere**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors across the whole project — every one of the 17 `GitHubPort` implementers listed in Task 3 Step 6 now has `closeIssue`.

- [ ] **Step 3: Write the failing apply/idempotent-skip/failure tests**

Add to `tests/unit/reconciliation/apply-service.test.ts`, inside `describe("ApplyService.apply", ...)`, after the last existing `SPLIT_ISSUE` test block (after the one ending around line 950+, the "fails SPLIT_ISSUE cleanly..." test):

```ts
  it("offers MERGE_DUPLICATE interactively, comments on and closes the duplicate, and never mutates the kept issue", async () => {
    github.issues.set(12, epic());
    github.issues.set(120, makeIssue(120, "OAuth callback", "Handles OAuth"));
    github.issues.set(123, makeIssue(123, "OAuth callback (dup)", "Also handles OAuth"));

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "MERGE_DUPLICATE",
          keep: 120,
          duplicate: 123,
          reason: "same behavioral outcome",
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ confirmMenu: async () => "apply" }).apply(analysisId, { yes: false });

    expect(github.comments).toEqual([{ number: 123, body: "Duplicate of #120." }]);
    expect(github.closed).toEqual([123]);
    expect(github.updated).toHaveLength(0);
    expect(result.entries[0]?.outcome).toEqual({ status: "applied" });
    expect(result.entries[0]?.appliedIssueNumber).toBe(123);
  });

  it("never auto-applies MERGE_DUPLICATE under --yes, recording it as requires-approval", async () => {
    github.issues.set(12, epic());
    github.issues.set(120, makeIssue(120, "OAuth callback", "Handles OAuth"));
    github.issues.set(123, makeIssue(123, "OAuth callback (dup)", "Also handles OAuth"));

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "MERGE_DUPLICATE",
          keep: 120,
          duplicate: 123,
          reason: "same behavioral outcome",
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service().apply(analysisId, { yes: true });

    expect(github.closed).toHaveLength(0);
    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "requires-approval" });
  });

  it("skips MERGE_DUPLICATE idempotently when the duplicate is already closed", async () => {
    github.issues.set(12, epic());
    github.issues.set(120, makeIssue(120, "OAuth callback", "Handles OAuth"));
    const closedDup = makeIssue(123, "OAuth callback (dup)", "Also handles OAuth");
    github.issues.set(123, { ...closedDup, state: "closed" });

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "MERGE_DUPLICATE",
          keep: 120,
          duplicate: 123,
          reason: "same behavioral outcome",
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ confirmMenu: async () => "apply" }).apply(analysisId, { yes: false });

    expect(github.comments).toHaveLength(0);
    expect(github.closed).toHaveLength(0);
    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "idempotent" });
  });

  it("previews MERGE_DUPLICATE without mutation when previewOnly is set", async () => {
    github.issues.set(12, epic());
    github.issues.set(120, makeIssue(120, "OAuth callback", "Handles OAuth"));
    github.issues.set(123, makeIssue(123, "OAuth callback (dup)", "Also handles OAuth"));
    const previews: string[] = [];

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "MERGE_DUPLICATE",
          keep: 120,
          duplicate: 123,
          reason: "same behavioral outcome",
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ onPreview: (text) => previews.push(text) }).apply(analysisId, {
      yes: true,
      previewOnly: true,
    });

    expect(result.summary.previewed).toBe(1);
    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "preview-only" });
    expect(previews[0]).toContain("keep #120");
    expect(previews[0]).toContain("close #123");
    expect(github.comments).toHaveLength(0);
    expect(github.closed).toHaveLength(0);
  });

  it("fails MERGE_DUPLICATE cleanly when closeIssue throws after the comment succeeds", async () => {
    class FakeGitHubFailingClose extends FakeGitHub {
      override async closeIssue(): Promise<void> {
        throw new Error("github 500");
      }
    }
    const failingGithub = new FakeGitHubFailingClose();
    github = failingGithub;
    github.issues.set(12, epic());
    github.issues.set(120, makeIssue(120, "OAuth callback", "Handles OAuth"));
    github.issues.set(123, makeIssue(123, "OAuth callback (dup)", "Also handles OAuth"));

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "MERGE_DUPLICATE",
          keep: 120,
          duplicate: 123,
          reason: "same behavioral outcome",
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ github, confirmMenu: async () => "apply" }).apply(analysisId, { yes: false });

    expect(github.comments).toEqual([{ number: 123, body: "Duplicate of #120." }]);
    expect(result.entries[0]?.outcome.status).toBe("failed");
    expect(result.entries[0]?.appliedIssueNumber).toBeUndefined();
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts -t "MERGE_DUPLICATE"`
Expected: FAIL — `prepare()`'s switch has no `MERGE_DUPLICATE` case, so it falls through to the `default`-style `KEEP`/`MARK_STALE`/`NEEDS_HUMAN` skip branch, meaning every one of these tests currently records a `skippedBy: "requires-approval"` outcome regardless of scenario (in particular, the first test expecting `"applied"` will fail).

- [ ] **Step 5: Add `MERGE_DUPLICATE` to `OFFERABLE_REQUIRES_APPROVAL`**

In `src/reconciliation/apply-service.ts`:

```ts
const OFFERABLE_REQUIRES_APPROVAL: ReadonlySet<BacklogPatchType> = new Set([
  "REMOVE_DEPENDENCY",
  "SPLIT_ISSUE",
  "MERGE_DUPLICATE",
]);
```

- [ ] **Step 6: Add the import for `renderMergeDuplicatePreview`**

In the existing import block from `"./apply-preview.js"`:

```ts
import {
  confirmMenu,
  renderCreatePreview,
  renderDependencyPreview,
  renderEnrichPreview,
  renderMergeDuplicatePreview,
  renderRemoveDependencyPreview,
  renderSplitPreview,
  type MenuAnswer,
} from "./apply-preview.js";
```

- [ ] **Step 7: Add the `MERGE_DUPLICATE` case to `prepare()`'s switch**

In `prepare()`:

```ts
  private async prepare(patch: ReconciledPatch, epicRef: number): Promise<Prepared> {
    switch (patch.type) {
      case "CREATE_ISSUE":
        return this.prepareCreate(patch);
      case "ENRICH_ISSUE":
        return this.prepareEnrich(patch);
      case "ADD_DEPENDENCY":
        return this.prepareDependency(patch);
      case "REMOVE_DEPENDENCY":
        return this.prepareRemoveDependency(patch);
      case "SPLIT_ISSUE":
        return this.prepareSplit(patch, epicRef);
      case "MERGE_DUPLICATE":
        return this.prepareMergeDuplicate(patch);
      case "KEEP":
      case "MARK_STALE":
      case "NEEDS_HUMAN":
        return { kind: "skip", entry: skipEntry(patch, "requires-approval") };
    }
  }
```

- [ ] **Step 8: Add `prepareMergeDuplicate` and `applyMergeDuplicateFresh`**

Add these two new private methods immediately after `prepareSplit`/`applySplitFresh` (after the `applySplitFresh` method's closing brace):

```ts
  private async prepareMergeDuplicate(
    patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
  ): Promise<Prepared> {
    let current: GitHubIssue;
    try {
      current = await this.deps.github.getIssue(patch.duplicate);
    } catch (error) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "failed-to-fetch", error instanceof Error ? error.message : String(error)),
      };
    }

    if (current.state === "closed") {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", `already closed as a duplicate of #${patch.keep}`),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `close #${patch.duplicate} as a duplicate of #${patch.keep}`),
      previewText: renderMergeDuplicatePreview(patch),
      applyFresh: () => this.applyMergeDuplicateFresh(patch),
    };
  }

  private async applyMergeDuplicateFresh(
    patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.duplicate);
    if (current.state === "closed") {
      return skipEntry(patch, "idempotent", `already closed as a duplicate of #${patch.keep}`);
    }

    await this.deps.github.createIssueComment(patch.duplicate, `Duplicate of #${patch.keep}.`);
    await this.deps.github.closeIssue(patch.duplicate);

    return {
      ...entryBase(patch, `closed #${patch.duplicate} as a duplicate of #${patch.keep}`),
      outcome: { status: "applied" },
      appliedIssueNumber: patch.duplicate,
    };
  }
```

- [ ] **Step 9: Add `MERGE_DUPLICATE` to `sortPatches`' rank map**

In `sortPatches`:

```ts
function sortPatches(patches: ReconciledPatch[]): ReconciledPatch[] {
  const rank: Partial<Record<BacklogPatchType, number>> = {
    CREATE_ISSUE: 0,
    ENRICH_ISSUE: 1,
    ADD_DEPENDENCY: 2,
    REMOVE_DEPENDENCY: 3,
    SPLIT_ISSUE: 4,
    MERGE_DUPLICATE: 5,
  };
  return [...patches].sort((a, b) => (rank[a.type] ?? 10) - (rank[b.type] ?? 10));
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones — confirm no regression in `SPLIT_ISSUE`/`REMOVE_DEPENDENCY`/etc. tests).

- [ ] **Step 11: Run the full suite and the TypeScript check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: both PASS.

- [ ] **Step 12: Commit**

```bash
git add src/reconciliation/apply-service.ts tests/unit/reconciliation/apply-service.test.ts
git commit -m "feat: wire MERGE_DUPLICATE into ApplyService (comment, close, never touch keep)"
```

---

### Task 8: Documentation — close out the backlog entry

**Files:**
- Modify: `docs/MILESTONES.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the "Remaining patch type" backlog bullet**

In `docs/MILESTONES.md`, find the bullet under "Reconciliation apply-safe follow-ups 🔲" that currently reads:

```
- **Remaining patch type:** `MERGE_DUPLICATE` — documented in
  `src/domain/reconciliation.ts` as a future extension of the
  `BacklogPatch` union. (extend_requirements.md §"Structured patch model")
  `REMOVE_DEPENDENCY` and `SPLIT_ISSUE` are both fully implemented,
  including `ApplyService` wiring (see the 2026-08-24 milestone entries).
  `MARK_READY` is deliberately excluded; see
  `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md` §6.
```

Replace it with a new dated milestone entry (following the file's existing convention of dated `##` headings with a ✅ suffix for completed work — check the heading style used for the `2026-08-24` SPLIT_ISSUE/REMOVE_DEPENDENCY entries above the "Backlog" section and match it exactly), and remove the bullet from the backlog section entirely since the "Structured patch model" backlog item is now fully closed (`MARK_READY` was always permanently excluded, not "remaining").

Read the file first to find the exact heading style:

Run: `grep -n "^## 2026-08-24" docs/MILESTONES.md`

Then add a new entry in the same style, e.g.:

```markdown
## 2026-08-24 — MERGE_DUPLICATE reconciliation patch ✅

**Scope:** Final patch type in the "Structured patch model" backlog item — the reconciler can now propose closing a duplicate issue in favor of a survivor.

- `MERGE_DUPLICATE` schema variant, patch policy (`requires-approval`, `OFFERABLE_REQUIRES_APPROVAL`), idempotency downgrade (closed-state check), prompt rule + example, preview renderer, and full `ApplyService` wiring (comment + close via the new `GitHubPort.closeIssue` primitive).
- Rewriting the duplicate's existing dependents and its epic checklist line are explicitly out of scope, deferred to a human or future reconciliation pass — matching `SPLIT_ISSUE`'s precedent.
- This closes the "Structured patch model" backlog item in full. `MARK_READY` remains permanently excluded (see the 2026-08-24 `REMOVE_DEPENDENCY` design spec §6).

Design spec: `docs/superpowers/specs/2026-08-24-merge-duplicate-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-24-merge-duplicate.md`
```

Place it directly above (more recent than) the existing `SPLIT_ISSUE`/`REMOVE_DEPENDENCY` `2026-08-24` entries if the file orders entries newest-first, or below them if oldest-first — match whichever ordering the file already uses (check by comparing the order of the existing `2026-08-23`/`2026-08-24` headings).

Remove the "Remaining patch type" bullet from the "Reconciliation apply-safe follow-ups 🔲" backlog list entirely.

- [ ] **Step 2: Verify the file reads correctly**

Run: `grep -n "MERGE_DUPLICATE" docs/MILESTONES.md`
Expected: shows the new milestone entry, and no leftover reference in the backlog section.

- [ ] **Step 3: Commit**

```bash
git add docs/MILESTONES.md
git commit -m "docs: record MERGE_DUPLICATE milestone and close out the Structured patch model backlog item"
```

---

## Final verification

- [ ] Run `npx vitest run` — full suite passes.
- [ ] Run `npx tsc --noEmit` — no type errors.
- [ ] Run `npm run build` (`tsc -p tsconfig.json`, per `package.json`'s `scripts` block) — production build compiles cleanly.
- [ ] Confirm `git log --oneline -10` shows one commit per task, in order.
