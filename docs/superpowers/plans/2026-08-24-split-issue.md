# `SPLIT_ISSUE` Reconciliation Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `SPLIT_ISSUE` as a fully-wired reconciliation patch type — the
reconciler can propose breaking an oversized issue into smaller child
issues, and `reconcile-apply` can create those children, link them to the
parent's epic, mark the parent as a tracking checklist via a new `split`
label, and exclude split parents from `discover`'s `agent:ready`
reconciliation.

**Architecture:** Extends the existing reconciliation pipeline
(`BacklogPatchSchema` → prompt → `patch-policy` → `idempotency` →
`ApplyService`) with one new discriminated-union variant, composing two
already-proven code paths: `CREATE_ISSUE`'s issue-creation +
epic-linking, and `REMOVE_DEPENDENCY`'s `requires-approval`-but-offerable
apply pattern. A new managed body section ("Split into") tracks children
on the parent issue, and a new `split` label — checked by
`reconcileReadyLabel` — permanently excludes the parent from
`agent:ready` label writes.

**Tech Stack:** TypeScript, Zod schemas, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-split-issue-design.md`

## Global Constraints

- `SPLIT_ISSUE.children` must have at least 2 entries (a split into fewer
  than 2 children isn't a split) — spec §4.
- `SPLIT_ISSUE` is classified `requires-approval` — never added to
  `patch-policy.ts`'s `AUTO_SAFE` set — spec §3.4.
- `SPLIT_ISSUE` is added to `ApplyService`'s `OFFERABLE_REQUIRES_APPROVAL`
  set so it is offerable via interactive confirmation but never
  auto-applied under `--yes` or a prior "all" answer — spec §3.4, §3.9.
- The parent issue is never closed, and existing dependents of the parent
  are never rewritten — both explicitly out of scope (spec §3.2, §6).
- The parent's own line in its epic's checklist is never removed or
  modified — children are strictly additive (spec §3.3).
- The "Split into" managed section uses its own distinct HTML comment
  markers (`<!-- autopilot-split:start -->` / `<!-- autopilot-split:end -->`)
  so it never collides with the reconciliation-enrichment or M1
  execution-contract sections (spec §3.8).
- `split` label value is exactly `"split"` (spec §3.5).

---

### Task 1: `SPLIT_ISSUE` schema variant

**Files:**
- Modify: `src/domain/reconciliation.ts`
- Test: `tests/unit/domain/reconciliation.test.ts`

**Interfaces:**
- Consumes: existing `IssueSpecSchema` (already defined in this file —
  `{ title: string, enrichment: IssueEnrichmentSchema }`).
- Produces: `BacklogPatchSchema` accepts a new discriminated-union member
  with `type: "SPLIT_ISSUE"`, `issue: number`, `children: IssueSpec[]`
  (min 2), `reason: string`. `BacklogPatch`/`BacklogPatchType` (both
  inferred from the schema) pick up the new variant automatically —
  every downstream task in this plan imports these two types.

- [ ] **Step 1: Write the failing schema tests**

Add to `tests/unit/domain/reconciliation.test.ts`, inside the
`describe("BacklogPatchSchema", ...)` block (place these new tests right
after the existing `"rejects a REMOVE_DEPENDENCY patch with a non-positive
dependsOn"` test, before `"accepts a MARK_STALE patch"`):

```ts
  it("accepts a SPLIT_ISSUE patch with two children", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "spans two independent behavioral outcomes",
      children: [
        {
          title: "Reject revoked sessions during authentication",
          enrichment: {
            goal: "A revoked session is rejected at the next authentication check",
            sourceRequirements: ["REQ-AUTH-012"],
            acceptanceCriteria: ["A revoked session's token is rejected with 401"],
            constraints: [],
            nonGoals: [],
            validation: ["npm test -- auth"],
            relevantAreas: ["src/auth/"],
          },
        },
        {
          title: "Rate-limit failed logins",
          enrichment: {
            goal: "Repeated failed logins from one account are throttled",
            sourceRequirements: ["REQ-AUTH-013"],
            acceptanceCriteria: ["The 6th failed login within a minute is rejected"],
            constraints: [],
            nonGoals: [],
            validation: ["npm test -- auth"],
            relevantAreas: ["src/auth/"],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a SPLIT_ISSUE patch with fewer than two children", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "too large",
      children: [
        {
          title: "Only one child",
          enrichment: {
            goal: "x",
            sourceRequirements: [],
            acceptanceCriteria: [],
            constraints: [],
            nonGoals: [],
            validation: [],
            relevantAreas: [],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a SPLIT_ISSUE patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "",
      children: [
        { title: "A", enrichment: { goal: "x", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } },
        { title: "B", enrichment: { goal: "x", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } },
      ],
    });
    expect(result.success).toBe(false);
  });
```

Also replace the existing `"rejects an unknown patch type"` test (it
currently asserts `SPLIT_ISSUE` without `children` is unknown — that stops
being true once this schema variant exists) with a genuinely-unknown type
so the test keeps testing what it means to test:

```ts
  it("rejects an unknown patch type", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "BOGUS_TYPE",
      issue: 17,
      reason: "too large",
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: the three new tests fail (`SPLIT_ISSUE` not a recognized
literal in the union yet); the modified "rejects an unknown patch type"
test passes already (no change needed there, `BOGUS_TYPE` is unknown
regardless).

- [ ] **Step 3: Add the schema variant**

In `src/domain/reconciliation.ts`, add one member to
`BacklogPatchSchema`'s discriminated union, immediately after the
`REMOVE_DEPENDENCY` object and before `MARK_STALE`:

```ts
  z.object({
    type: z.literal("SPLIT_ISSUE"),
    issue: z.number().int().positive(),
    children: z.array(IssueSpecSchema).min(2),
    reason: z.string().min(1),
  }),
```

Update the doc comment above `BacklogPatchSchema` (currently reads
`SPLIT_ISSUE/MERGE_DUPLICATE are documented as a future extension of this
same discriminated union`) to:

```ts
/**
 * Structured reconciliation patch. This milestone implements the subset
 * documented in the design spec (KEEP/ENRICH_ISSUE/CREATE_ISSUE/
 * ADD_DEPENDENCY/REMOVE_DEPENDENCY/SPLIT_ISSUE/MARK_STALE/NEEDS_HUMAN);
 * MERGE_DUPLICATE is documented as a future extension of this same
 * discriminated union. MARK_READY is deliberately excluded — see
 * docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md §6.
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/domain/reconciliation.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/reconciliation.ts tests/unit/domain/reconciliation.test.ts
git commit -m "feat: add SPLIT_ISSUE schema variant to BacklogPatchSchema"
```

---

### Task 2: `split` label + `reconcileReadyLabel` guard

**Files:**
- Modify: `src/analysis/label-reconciliation.ts`
- Test: `tests/unit/analysis/label-reconciliation.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const SPLIT_LABEL = "split"`. `LabelAction` gains
  `"skipped-split"`. `reconcileReadyLabel` accepts a new required input
  field `hasSplitLabel: boolean`. Task 6 (`discover.ts` wiring) consumes
  both the new input field and the new label constant.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/analysis/label-reconciliation.test.ts`, as new `it`
blocks inside the existing `describe("reconcileReadyLabel", ...)`:

```ts
  it("skips when the split label is present, regardless of readiness or agent:ready state", () => {
    expect(
      reconcileReadyLabel({
        isReady: true,
        hasReadyLabel: false,
        hasInProgressLabel: false,
        hasSplitLabel: true,
      }),
    ).toBe("skipped-split");
    expect(
      reconcileReadyLabel({
        isReady: false,
        hasReadyLabel: true,
        hasInProgressLabel: false,
        hasSplitLabel: true,
      }),
    ).toBe("skipped-split");
  });

  it("prioritizes skipped-split over skipped-in-progress when both labels are present", () => {
    expect(
      reconcileReadyLabel({
        isReady: true,
        hasReadyLabel: false,
        hasInProgressLabel: true,
        hasSplitLabel: true,
      }),
    ).toBe("skipped-split");
  });
```

Every existing call to `reconcileReadyLabel` in this file must also gain
`hasSplitLabel: false` (TypeScript will otherwise flag missing
properties once the input type is widened in Step 3) — update all five
existing call sites (`skips when agent:in-progress...` ×2 args,
`labels a ready issue...`, `unlabels a non-ready issue...`, `leaves a
ready issue...`, `leaves a non-ready issue...`) to add `hasSplitLabel:
false` alongside their existing fields.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/analysis/label-reconciliation.test.ts`
Expected: FAIL — `hasSplitLabel` doesn't exist on the input type /
`"skipped-split"` is never returned.

- [ ] **Step 3: Implement the guard**

Replace the full contents of `src/analysis/label-reconciliation.ts`:

```ts
export const AGENT_READY_LABEL = "agent:ready";
export const AGENT_IN_PROGRESS_LABEL = "agent:in-progress";
export const SPLIT_LABEL = "split";

export type LabelAction = "labeled" | "unlabeled" | "unchanged" | "skipped-in-progress" | "skipped-split";

/**
 * Decide what `discover` should do to an issue's `agent:ready` label given
 * its computed readiness and current label state. Never considers writing
 * `agent:in-progress` — that label is owned exclusively by the daemon's
 * just-in-time claim/release lifecycle (see `daemon-runner.ts`). An issue
 * already carrying `agent:in-progress` is always left alone: it is either
 * genuinely being worked right now, or stuck there from a past BLOCKED/
 * FAILED run — in both cases not `discover`'s to touch. An issue carrying
 * the `split` label is a SPLIT_ISSUE tracking checklist, not a task — it
 * is always skipped ahead of every other check, since it can never be a
 * real "ready to run" candidate regardless of its content.
 */
export function reconcileReadyLabel(input: {
  isReady: boolean;
  hasReadyLabel: boolean;
  hasInProgressLabel: boolean;
  hasSplitLabel: boolean;
}): LabelAction {
  if (input.hasSplitLabel) return "skipped-split";
  if (input.hasInProgressLabel) return "skipped-in-progress";
  if (input.isReady && !input.hasReadyLabel) return "labeled";
  if (!input.isReady && input.hasReadyLabel) return "unlabeled";
  return "unchanged";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/analysis/label-reconciliation.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/label-reconciliation.ts tests/unit/analysis/label-reconciliation.test.ts
git commit -m "feat: add split label guard to reconcileReadyLabel"
```

---

### Task 3: Wire the `split` label guard into `discover`

**Files:**
- Modify: `src/commands/discover.ts`
- Test: `tests/unit/commands/discover.test.ts`

**Interfaces:**
- Consumes: `SPLIT_LABEL` and the widened `reconcileReadyLabel` from Task 2.
- Produces: nothing new consumed by later tasks — this is a leaf wiring
  task.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/commands/discover.test.ts`, inside
`describe("discover command", ...)`, right after the existing `"never
touches labels on an issue with agent:in-progress"` test:

```ts
  it("never touches labels on an issue with the split label, even when classified READY", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => ["split"],
      addLabel,
      removeLabel,
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["discover", "42"], { from: "user" });
    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/commands/discover.test.ts`
Expected: FAIL — a READY issue with `listLabels` returning `["split"]`
still gets `addLabel(42, "agent:ready")` called today, since `discover.ts`
doesn't check for the `split` label yet.

- [ ] **Step 3: Wire the guard**

In `src/commands/discover.ts`, update the import from
`../analysis/label-reconciliation.js` to also bring in `SPLIT_LABEL`:

```ts
import {
  reconcileReadyLabel,
  AGENT_READY_LABEL,
  AGENT_IN_PROGRESS_LABEL,
  SPLIT_LABEL,
  type LabelAction,
} from "../analysis/label-reconciliation.js";
```

Then update the `reconcileReadyLabel` call inside the `for (const issue of
report.issues)` loop to pass the new field:

```ts
          const action = reconcileReadyLabel({
            isReady: issue.classification === "READY",
            hasReadyLabel: labels.includes(AGENT_READY_LABEL),
            hasInProgressLabel: labels.includes(AGENT_IN_PROGRESS_LABEL),
            hasSplitLabel: labels.includes(SPLIT_LABEL),
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/commands/discover.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/discover.ts tests/unit/commands/discover.test.ts
git commit -m "feat: exclude split-labeled issues from discover's agent:ready reconciliation"
```

---

### Task 4: `patch-policy` classification

**Files:**
- Modify: `src/reconciliation/patch-policy.ts` (no code change — see
  below — but the doc comment needs an update)
- Test: `tests/unit/reconciliation/patch-policy.test.ts`

**Interfaces:**
- Consumes: `BacklogPatch` (Task 1), specifically the `SPLIT_ISSUE`
  variant.
- Produces: nothing new — `classifyPatch(patch)` already returns
  `"requires-approval"` for any type not in `AUTO_SAFE`, so `SPLIT_ISSUE`
  is `requires-approval` with zero code changes. This task exists to add
  the explicit regression test per spec §5's testing list and to update
  the doc comment.

- [ ] **Step 1: Write the failing test**

Add to the `cases` array in `tests/unit/reconciliation/patch-policy.test.ts`,
after the `REMOVE_DEPENDENCY` case and before the `MARK_STALE` case:

```ts
  {
    patch: {
      type: "SPLIT_ISSUE",
      issue: 1,
      reason: "spans two independent behavioral outcomes",
      children: [
        { title: "A", enrichment: { goal: "x", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } },
        { title: "B", enrichment: { goal: "x", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } },
      ],
    },
    policy: "requires-approval",
  },
```

- [ ] **Step 2: Run the test to confirm the expected pass-without-changes behavior**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: PASS immediately, with zero production-code changes —
`classifyPatch` already returns `"requires-approval"` for any type not
listed in `AUTO_SAFE`, and `SPLIT_ISSUE` was never added to that set.
This run is the evidence backing that claim; if it unexpectedly fails,
stop and re-check `AUTO_SAFE` before proceeding to Step 3.

- [ ] **Step 3: Update the doc comment only**

`AUTO_SAFE` in `src/reconciliation/patch-policy.ts` already excludes
`SPLIT_ISSUE` by omission (it's not in the `Set`), so `classifyPatch`
already returns `"requires-approval"`. Update only the doc comment above
`classifyPatch` to mention the new type explicitly:

```ts
/**
 * Deterministic apply-safety classification for one patch, informational
 * only in this milestone (nothing is applied yet) — the seam the future
 * `apply-safe` mode reads directly. `KEEP` is a no-op, not a write, but is
 * still classified `requires-approval` here since it carries no automatic
 * action to gate; `MARK_STALE`, `NEEDS_HUMAN`, and `SPLIT_ISSUE` are
 * always `requires-approval`; every additive patch type is `auto-safe`.
 * Never assigned by the LLM.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/patch-policy.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/patch-policy.ts tests/unit/reconciliation/patch-policy.test.ts
git commit -m "test: pin SPLIT_ISSUE as a requires-approval patch"
```

---

### Task 5: Managed "Split into" section

**Files:**
- Create: `src/reconciliation/managed-split-section.ts`
- Create: `tests/unit/reconciliation/managed-split-section.test.ts`

**Interfaces:**
- Consumes: `upsertManagedSection(body, startMarker, endMarker, rendered):
  string` from `src/readiness/refinement-section.ts` (existing).
- Produces:
  - `export const SPLIT_START = "<!-- autopilot-split:start -->"`
  - `export const SPLIT_END = "<!-- autopilot-split:end -->"`
  - `export function renderSplitSection(children: Array<{ number: number; title: string }>): string`
  - `export function upsertSplitSection(body: string, children: Array<{ number: number; title: string }>): string`
  - `export function splitAlreadyApplied(body: string, children: ReadonlyArray<{ title: string }>): boolean`
    — the single shared detector for "does this body's Split into section
    already list every one of these child titles", mirroring how
    `bodyAlreadyDependsOn` in `apply-dependency.ts` is shared between
    `idempotency.ts` and `apply-service.ts` for `ADD_DEPENDENCY`/
    `REMOVE_DEPENDENCY` today. Task 6 (idempotency) and Task 10
    (`ApplyService` wiring) both import `splitAlreadyApplied` from this
    module instead of each defining their own copy. Task 10 also imports
    `upsertSplitSection` from here.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/reconciliation/managed-split-section.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RefinementSectionError } from "../../../src/readiness/refinement-section.js";
import {
  SPLIT_END,
  SPLIT_START,
  renderSplitSection,
  splitAlreadyApplied,
  upsertSplitSection,
} from "../../../src/reconciliation/managed-split-section.js";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("renderSplitSection", () => {
  it("renders a checklist of children by number and title", () => {
    const rendered = renderSplitSection([
      { number: 124, title: "Reject revoked sessions during authentication" },
      { number: 125, title: "Rate-limit failed logins" },
    ]);
    expect(rendered).toContain(SPLIT_START);
    expect(rendered).toContain(SPLIT_END);
    expect(rendered).toContain("## Split into");
    expect(rendered).toContain("- [ ] #124 Reject revoked sessions during authentication");
    expect(rendered).toContain("- [ ] #125 Rate-limit failed logins");
  });
});

describe("upsertSplitSection", () => {
  it("appends a managed section when the body has no markers", () => {
    const body = "Original human-authored issue body";
    const updated = upsertSplitSection(body, [{ number: 124, title: "Child A" }]);
    expect(updated).toContain("Original human-authored issue body");
    expect(countOccurrences(updated, SPLIT_START)).toBe(1);
    expect(countOccurrences(updated, SPLIT_END)).toBe(1);
    expect(updated).toContain("- [ ] #124 Child A");
  });

  it("replaces the single existing split section without touching other content", () => {
    const once = upsertSplitSection("Original context", [{ number: 124, title: "Child A" }]);
    const twice = upsertSplitSection(once, [
      { number: 124, title: "Child A" },
      { number: 125, title: "Child B" },
    ]);
    expect(twice).toContain("Original context");
    expect(countOccurrences(twice, SPLIT_START)).toBe(1);
    expect(twice).toContain("- [ ] #124 Child A");
    expect(twice).toContain("- [ ] #125 Child B");
  });

  it("coexists with a separate reconciliation-enrichment section", () => {
    const withEnrichment =
      "Body\n\n<!-- autopilot-reconciliation:start -->\nenrichment content\n<!-- autopilot-reconciliation:end -->\n";
    const updated = upsertSplitSection(withEnrichment, [{ number: 124, title: "Child A" }]);
    expect(updated).toContain("enrichment content");
    expect(updated).toContain(SPLIT_START);
  });

  it("rejects duplicate start markers instead of guessing", () => {
    const body = `${SPLIT_START}\nold\n${SPLIT_START}\nolder`;
    expect(() => upsertSplitSection(body, [{ number: 124, title: "Child A" }])).toThrow(
      RefinementSectionError,
    );
  });

  it("is stable: re-running with the same children yields the same body", () => {
    const once = upsertSplitSection("Original", [{ number: 124, title: "Child A" }]);
    const twice = upsertSplitSection(once, [{ number: 124, title: "Child A" }]);
    expect(twice).toBe(once);
  });
});

describe("splitAlreadyApplied", () => {
  it("is true when every child title appears as a checklist line in the body", () => {
    const body = upsertSplitSection("Original", [
      { number: 124, title: "Child A" },
      { number: 125, title: "Child B" },
    ]);
    expect(splitAlreadyApplied(body, [{ title: "Child A" }, { title: "Child B" }])).toBe(true);
  });

  it("is false when one child title is missing from the body", () => {
    const body = upsertSplitSection("Original", [{ number: 124, title: "Child A" }]);
    expect(splitAlreadyApplied(body, [{ title: "Child A" }, { title: "Child B" }])).toBe(false);
  });

  it("is false when the body has no split section at all", () => {
    expect(splitAlreadyApplied("Original body, no section yet", [{ title: "Child A" }])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/managed-split-section.test.ts`
Expected: FAIL with a module-not-found error (`managed-split-section.js`
doesn't exist yet).

- [ ] **Step 3: Implement the module**

Create `src/reconciliation/managed-split-section.ts`:

```ts
import { upsertManagedSection } from "../readiness/refinement-section.js";

/** Managed issue-body section owned by SPLIT_ISSUE apply, distinct from
 * the reconciliation-enrichment section (managed-section.ts) and the M1
 * execution-contract section (readiness/refinement-section.ts) so all
 * three proposals never collide inside one issue body. */
export const SPLIT_START = "<!-- autopilot-split:start -->";
export const SPLIT_END = "<!-- autopilot-split:end -->";

const SECTION_HEADING = "## Split into";

/** Render the managed "Split into" section listing every child issue by
 * number and title. Deterministic: fixed order (as given), one checklist
 * line per child. */
export function renderSplitSection(
  children: Array<{ number: number; title: string }>,
): string {
  const lines: string[] = [
    SPLIT_START,
    "",
    SECTION_HEADING,
    "",
    ...children.map((child) => `- [ ] #${child.number} ${child.title}`),
    "",
    SPLIT_END,
  ];
  return lines.join("\n");
}

/** Insert or replace the single managed "Split into" section in an issue
 * body. Original content — including any separate reconciliation or M1
 * refinement section — is always preserved. */
export function upsertSplitSection(
  body: string,
  children: Array<{ number: number; title: string }>,
): string {
  return upsertManagedSection(body, SPLIT_START, SPLIT_END, renderSplitSection(children));
}

/** True when `body`'s "Split into" section already lists a checklist line
 * for every given child title, regardless of that child's current issue
 * number. Shared by the idempotency pass (before a report is persisted)
 * and ApplyService (re-checked against live state right before a write) —
 * mirrors how `bodyAlreadyDependsOn` in apply-dependency.ts is shared
 * between the same two call sites for ADD_DEPENDENCY/REMOVE_DEPENDENCY. */
export function splitAlreadyApplied(
  body: string,
  children: ReadonlyArray<{ title: string }>,
): boolean {
  return children.every((child) => {
    const escaped = child.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linePattern = new RegExp(`- \\[ \\] #\\d+ ${escaped}(\\n|$)`);
    return linePattern.test(body);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/managed-split-section.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/managed-split-section.ts tests/unit/reconciliation/managed-split-section.test.ts
git commit -m "feat: add managed Split into section for SPLIT_ISSUE apply"
```

---

### Task 6: `idempotency` downgrade for `SPLIT_ISSUE`

**Files:**
- Modify: `src/reconciliation/idempotency.ts`
- Test: `tests/unit/reconciliation/idempotency.test.ts`

**Interfaces:**
- Consumes: `splitAlreadyApplied(body: string, children: ReadonlyArray<{ title: string }>): boolean`
  from `./managed-split-section.js` (Task 5).
- Produces: nothing new consumed elsewhere — `applyIdempotencyDowngrades`
  is already the single deterministic gate `ReconciliationService` calls
  before persisting a report (see its existing call site — no change
  needed to that call site).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/idempotency.test.ts`, after the
`REMOVE_DEPENDENCY`-related tests and before the `CREATE_ISSUE` tests:

```ts
  it("downgrades a SPLIT_ISSUE patch to KEEP when the parent body already lists all proposed children", () => {
    const patches: BacklogPatch[] = [
      {
        type: "SPLIT_ISSUE",
        issue: 20,
        reason: "spans two independent behavioral outcomes",
        children: [
          { title: "Reject revoked sessions during authentication", enrichment: enrichment() },
          { title: "Rate-limit failed logins", enrichment: enrichment() },
        ],
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      {
        number: 20,
        title: "Auth hardening",
        body:
          "<!-- autopilot-split:start -->\n## Split into\n\n" +
          "- [ ] #124 Reject revoked sessions during authentication\n" +
          "- [ ] #125 Rate-limit failed logins\n" +
          "<!-- autopilot-split:end -->",
      },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 20 });
  });

  it("leaves a SPLIT_ISSUE patch unchanged when the parent body is missing one of the proposed children", () => {
    const patches: BacklogPatch[] = [
      {
        type: "SPLIT_ISSUE",
        issue: 20,
        reason: "spans two independent behavioral outcomes",
        children: [
          { title: "Reject revoked sessions during authentication", enrichment: enrichment() },
          { title: "Rate-limit failed logins", enrichment: enrichment() },
        ],
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      {
        number: 20,
        title: "Auth hardening",
        body:
          "<!-- autopilot-split:start -->\n## Split into\n\n" +
          "- [ ] #124 Reject revoked sessions during authentication\n" +
          "<!-- autopilot-split:end -->",
      },
    ]);
    expect(result.type).toBe("SPLIT_ISSUE");
  });

  it("leaves a SPLIT_ISSUE patch unchanged when the parent body has no split section at all", () => {
    const patches: BacklogPatch[] = [
      {
        type: "SPLIT_ISSUE",
        issue: 20,
        reason: "spans two independent behavioral outcomes",
        children: [
          { title: "Reject revoked sessions during authentication", enrichment: enrichment() },
          { title: "Rate-limit failed logins", enrichment: enrichment() },
        ],
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 20, title: "Auth hardening", body: "Original body, no section yet" },
    ]);
    expect(result.type).toBe("SPLIT_ISSUE");
  });
```

Also extend the existing `"passes KEEP, MARK_STALE, and NEEDS_HUMAN
patches through unchanged"` test's title and body are unaffected by
`SPLIT_ISSUE` — no change needed there since `SPLIT_ISSUE` is handled by
new logic, not the pass-through fallback.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: FAIL — the first new test expects a `KEEP` downgrade that
doesn't happen yet (current code returns the patch unchanged for every
type not explicitly handled).

- [ ] **Step 3: Implement the downgrade**

First add the import at the top of `src/reconciliation/idempotency.ts`,
alongside the existing `managed-section.js` import:

```ts
import { splitAlreadyApplied } from "./managed-split-section.js";
```

Then add a new branch inside the
`patches.map((patch): BacklogPatch => { ... })` callback, after the
`if (patch.type === "CREATE_ISSUE") { ... }` block and before the final
`return patch;`:

```ts
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

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/idempotency.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/idempotency.ts tests/unit/reconciliation/idempotency.test.ts
git commit -m "feat: downgrade SPLIT_ISSUE to KEEP when already split"
```

---

### Task 7: Prompt contract update

**Files:**
- Modify: `src/reconciliation/prompt.ts`
- Test: `tests/unit/reconciliation/prompt.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new consumed by later tasks — this task only changes
  prompt text and its own tests.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/reconciliation/prompt.test.ts`, replace the existing test:

```ts
  it("instructs the model to flag oversized issues as NEEDS_HUMAN instead of splitting or silently keeping them", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("oversized");
    expect(prompt).toContain("NEEDS_HUMAN");
  });
```

with:

```ts
  it("instructs the model to propose SPLIT_ISSUE for an oversized issue with a mechanical split, and NEEDS_HUMAN when the split itself is a product call", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("oversized");
    expect(prompt).toContain("SPLIT_ISSUE");
    expect(prompt).toContain("NEEDS_HUMAN");
    expect(prompt).toContain("product");
  });
```

Add a new test after the existing `"instructs the reconciler never to
propose REMOVE_DEPENDENCY against a free-text dependency line"` test:

```ts
  it("includes the SPLIT_ISSUE patch shape with children in the output contract", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain('"type": "SPLIT_ISSUE"');
    expect(prompt).toContain('"children"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: FAIL — the current prompt text says "this milestone cannot
propose SPLIT_ISSUE" and the `submit_result` example doesn't include a
`SPLIT_ISSUE` entry.

- [ ] **Step 3: Update the prompt**

In `src/reconciliation/prompt.ts`, inside the `submit_result` JSON example
in the returned template literal, add a `SPLIT_ISSUE` entry to the
`"patches"` array, right after the `REMOVE_DEPENDENCY` line:

```ts
    { "type": "REMOVE_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." },
    { "type": "SPLIT_ISSUE", "issue": 123, "reason": "...", "children": [ { "title": "...", "enrichment": { "goal": "...", "sourceRequirements": [], "acceptanceCriteria": [], "constraints": [], "nonGoals": [], "validation": [], "relevantAreas": [] } } ] },
```

Then, in the `Rules` section, replace the existing line:

```
- An issue is the right size when it has one primary outcome, fits one isolated agent session, and its acceptance criteria are independently testable. If an issue's scope spans multiple independent behavioral outcomes (not just multiple implementation steps toward one outcome), it is oversized: this milestone cannot propose SPLIT_ISSUE, so raise a NEEDS_HUMAN patch (ambiguityType "ENGINEERING" if the split itself is mechanical, "PRODUCT" if which slice ships first is a product call) naming the outcomes you would split it into, rather than silently keeping or enriching it as one issue.
```

with:

```
- An issue is the right size when it has one primary outcome, fits one isolated agent session, and its acceptance criteria are independently testable. If an issue's scope spans multiple independent behavioral outcomes (not just multiple implementation steps toward one outcome), it is oversized. When the split itself is mechanical — the outcomes are clear and their relative order/priority is not a product call — propose SPLIT_ISSUE with one full IssueSpec (title + complete enrichment) per outcome. When which slice ships first, or how to divide the scope, requires a product decision, raise a NEEDS_HUMAN patch (ambiguityType "PRODUCT") naming the outcomes instead of proposing a split yourself.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/prompt.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/prompt.ts tests/unit/reconciliation/prompt.test.ts
git commit -m "feat: instruct reconciler to propose SPLIT_ISSUE for mechanical oversized splits"
```

---

### Task 8: Preview rendering

**Files:**
- Modify: `src/reconciliation/apply-preview.ts`
- Test: `tests/unit/reconciliation/apply-preview.test.ts`

**Interfaces:**
- Consumes: `ReconciledPatch` type (existing import in this file).
- Produces: `export function renderSplitPreview(patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>): string`.
  Task 9 (`ApplyService` wiring) imports and calls this.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/apply-preview.test.ts`, a new
`describe` block after `describe("renderCreatePreview", ...)`:

```ts
  describe("renderSplitPreview", () => {
    it("renders the parent issue and every child title with its goal", () => {
      const patch = {
        type: "SPLIT_ISSUE",
        issue: 123,
        reason: "spans two outcomes",
        children: [
          { title: "Reject revoked sessions", enrichment: { goal: "Revoked sessions are rejected" } },
          { title: "Rate-limit failed logins", enrichment: { goal: "Failed logins are throttled" } },
        ],
      } as any;
      const result = renderSplitPreview(patch);
      expect(result).toContain("split #123 into 2 issues:");
      expect(result).toContain("- Reject revoked sessions: Revoked sessions are rejected");
      expect(result).toContain("- Rate-limit failed logins: Failed logins are throttled");
    });

    it("shows '(no goal)' for a child with an empty goal", () => {
      const patch = {
        type: "SPLIT_ISSUE",
        issue: 123,
        reason: "spans two outcomes",
        children: [
          { title: "Child A", enrichment: { goal: "" } },
          { title: "Child B", enrichment: { goal: "Has a goal" } },
        ],
      } as any;
      const result = renderSplitPreview(patch);
      expect(result).toContain("- Child A: (no goal)");
      expect(result).toContain("- Child B: Has a goal");
    });
  });
```

Add `renderSplitPreview` to the import list at the top of the file:

```ts
import {
  confirmMenu,
  renderEnrichPreview,
  renderDependencyPreview,
  renderRemoveDependencyPreview,
  renderCreatePreview,
  renderSplitPreview,
} from "../../../src/reconciliation/apply-preview.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: FAIL — `renderSplitPreview` is not exported yet.

- [ ] **Step 3: Implement `renderSplitPreview`**

In `src/reconciliation/apply-preview.ts`, add after `renderCreatePreview`:

```ts
/** Render a compact human summary for a SPLIT_ISSUE: the parent issue and
 * every child's title + goal. */
export function renderSplitPreview(
  patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
): string {
  const lines = [`split #${patch.issue} into ${patch.children.length} issues:`];
  for (const child of patch.children) {
    const goal = child.enrichment.goal.trim();
    lines.push(`- ${child.title}: ${goal === "" ? "(no goal)" : goal}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/apply-preview.ts tests/unit/reconciliation/apply-preview.test.ts
git commit -m "feat: add renderSplitPreview for SPLIT_ISSUE apply preview"
```

---

### Task 9: `ApplyEntry` plural applied-issue field

**Files:**
- Modify: `src/domain/apply.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ApplyEntrySchema`/`ApplyEntry` gain an optional
  `appliedIssueNumbers: number[]`. Task 10 (`ApplyService` wiring) sets
  this field for `SPLIT_ISSUE` entries.

No dedicated test file exists for `src/domain/apply.ts` today (it's a
pure Zod schema module exercised transitively by `apply-service.test.ts`
and `apply.test.ts` if present) — verify with `find tests -iname
"apply.test.ts"` before starting; if one exists, add a schema round-trip
test there following its existing conventions. If none exists, this
field is exercised end-to-end by Task 10's `apply-service.test.ts`
assertions, so no separate test is required for this task alone.

- [ ] **Step 1: Check for an existing domain apply test file**

Run: `find tests -iname "apply.test.ts"`

If a file exists at e.g. `tests/unit/domain/apply.test.ts`, read it and
add a test asserting `ApplyEntrySchema.safeParse({...base fields...,
appliedIssueNumbers: [124, 125]}).success === true` and that omitting the
field still succeeds, following that file's existing fixture style. If no
such file exists, skip directly to Step 2 (this task's change is only
verified transitively via Task 10).

- [ ] **Step 2: Add the field**

In `src/domain/apply.ts`, in `ApplyEntrySchema`, add one line after the
existing `appliedIssueNumber` field:

```ts
export const ApplyEntrySchema = z.object({
  patchType: z.custom<BacklogPatchType>(),
  targetIssue: z.number().int().positive().nullable(),
  policy: z.custom<PatchPolicy>(),
  outcome: ApplyOutcomeSchema,
  detail: z.string(),
  appliedIssueNumber: z.number().int().positive().optional(),
  appliedIssueNumbers: z.array(z.number().int().positive()).optional(),
  declineReason: z.string().optional(),
});
```

- [ ] **Step 3: Run the full domain test suite to verify nothing broke**

Run: `npx vitest run tests/unit/domain/`
Expected: all existing tests PASS (an additive optional field never
breaks an existing `safeParse` call).

- [ ] **Step 4: Commit**

```bash
git add src/domain/apply.ts
git commit -m "feat: add plural appliedIssueNumbers field for multi-issue apply outcomes"
```

---

### Task 10: `ApplyService` — `SPLIT_ISSUE` wiring

**Files:**
- Modify: `src/reconciliation/apply-service.ts`
- Test: `tests/unit/reconciliation/apply-service.test.ts`

**Interfaces:**
- Consumes:
  - `upsertSplitSection` and `splitAlreadyApplied` from
    `../reconciliation/managed-split-section.js` (Task 5)
  - `renderSplitPreview` from `./apply-preview.js` (Task 8)
  - `appliedIssueNumbers` field on `ApplyEntry` (Task 9)
  - Existing `findExistingIssueWithTitle(epicNumber: number | null, title: string): Promise<ExistingIssueMatch | null>`
  - Existing `linkIssueToEpic(epicNumber: number, issue: Pick<GitHubIssue, "number" | "title">): Promise<void>`
  - Existing `GitHubPort.listLabels(number): Promise<string[]>`,
    `addLabel(number, name): Promise<void>`, `removeLabel(number, name): Promise<void>`
  - `SPLIT_LABEL` from `../analysis/label-reconciliation.js` (Task 2)
  - `AGENT_READY_LABEL` from `../analysis/label-reconciliation.js` (already imported by `discover.ts`; not currently imported by `apply-service.ts` — this task adds the import)
- Produces: nothing new consumed by later tasks in this plan — this is
  the last functional-code task; Task 11 only updates documentation.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/reconciliation/apply-service.test.ts`. First, extend
`FakeGitHub` with the three label methods it's currently missing (needed
because `SPLIT_ISSUE` apply calls `listLabels`/`addLabel`/`removeLabel`).
Replace the existing `async ensureLabel(): Promise<void> {}` line in the
`FakeGitHub` class with:

```ts
  async ensureLabel(): Promise<void> {}

  labelsByIssue = new Map<number, Set<string>>();

  async listLabels(number: number): Promise<string[]> {
    return [...(this.labelsByIssue.get(number) ?? new Set())];
  }

  async addLabel(number: number, name: string): Promise<void> {
    const set = this.labelsByIssue.get(number) ?? new Set();
    set.add(name);
    this.labelsByIssue.set(number, set);
  }

  async removeLabel(number: number, name: string): Promise<void> {
    this.labelsByIssue.get(number)?.delete(name);
  }
```

Then add these tests after the existing `"sorts REMOVE_DEPENDENCY after
ADD_DEPENDENCY when both are offerable in one run"` test and before
`"enforces the report staleness guard unless force is set"`:

```ts
  it("offers SPLIT_ISSUE interactively, creates children, links them to the epic, and marks the parent split", async () => {
    github.issues.set(12, epic());
    github.issues.set(20, makeIssue(20, "Auth hardening", "Handles too much at once"));
    github.labelsByIssue.set(20, new Set(["agent:ready"]));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Reject revoked sessions", enrichment: enrichment("Revoked sessions are rejected") },
            { title: "Rate-limit failed logins", enrichment: enrichment("Failed logins are throttled") },
          ],
          policy: "requires-approval",
        },
      ]),
    );
    const previews: string[] = [];
    let prompts = 0;

    const result = await service({
      onPreview: (text) => previews.push(text),
      confirmMenu: async () => {
        prompts += 1;
        return "apply";
      },
    }).apply(analysisId, { yes: false });

    expect(prompts).toBe(1);
    expect(previews[0]).toContain("split #20 into 2 issues:");
    expect(github.created.map((c) => c.title)).toEqual(["Reject revoked sessions", "Rate-limit failed logins"]);
    expect(github.created.every((c) => c.labels.includes("task"))).toBe(true);

    const epicBody = github.issues.get(12)?.body ?? "";
    expect(epicBody).toContain("#20 OAuth");
    expect(epicBody).toMatch(/- \[ \] #\d+ Reject revoked sessions/);
    expect(epicBody).toMatch(/- \[ \] #\d+ Rate-limit failed logins/);

    const parentBody = github.issues.get(20)?.body ?? "";
    expect(parentBody).toContain("Handles too much at once");
    expect(parentBody).toContain("## Split into");
    expect(parentBody).toMatch(/- \[ \] #\d+ Reject revoked sessions/);
    expect(parentBody).toMatch(/- \[ \] #\d+ Rate-limit failed logins/);

    expect(await github.listLabels(20)).toContain("split");
    expect(await github.listLabels(20)).not.toContain("agent:ready");

    expect(result.summary.applied).toBe(1);
    expect(result.entries[0]).toMatchObject({
      outcome: { status: "applied" },
    });
    expect(result.entries[0]?.appliedIssueNumbers).toHaveLength(2);
  });

  it("never auto-applies SPLIT_ISSUE under --yes, recording it as requires-approval", async () => {
    github.issues.set(12, epic());
    github.issues.set(20, makeIssue(20, "Auth hardening", "Handles too much at once"));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Child A", enrichment: enrichment("Goal A") },
            { title: "Child B", enrichment: enrichment("Goal B") },
          ],
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service().apply(analysisId, opts);

    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "requires-approval" });
    expect(github.created).toHaveLength(0);
  });

  it("does not fast-forward SPLIT_ISSUE when an earlier patch answered all", async () => {
    github.issues.set(12, epic());
    github.issues.set(15, makeIssue(15, "OAuth", "Handles OAuth"));
    github.issues.set(20, makeIssue(20, "Auth hardening", "Handles too much at once"));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: enrichment("Add OAuth refresh"),
          reason: "missing criteria",
          policy: "auto-safe",
        },
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Child A", enrichment: enrichment("Goal A") },
            { title: "Child B", enrichment: enrichment("Goal B") },
          ],
          policy: "requires-approval",
        },
      ]),
    );
    const answers: string[] = ["all"];
    let prompts = 0;

    const result = await service({
      confirmMenu: async () => {
        prompts += 1;
        return (answers.shift() as "all") ?? "apply";
      },
    }).apply(analysisId, { yes: false });

    expect(prompts).toBe(2);
    expect(result.entries.map((e) => e.patchType)).toEqual(["ENRICH_ISSUE", "SPLIT_ISSUE"]);
    expect(result.entries[1]?.outcome).toEqual({ status: "applied" });
  });

  it("skips SPLIT_ISSUE idempotently when the parent already lists all proposed children", async () => {
    github.issues.set(12, epic());
    github.issues.set(
      20,
      makeIssue(
        20,
        "Auth hardening",
        "Handles too much\n\n<!-- autopilot-split:start -->\n## Split into\n\n" +
          "- [ ] #124 Child A\n- [ ] #125 Child B\n<!-- autopilot-split:end -->",
      ),
    );
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Child A", enrichment: enrichment("Goal A") },
            { title: "Child B", enrichment: enrichment("Goal B") },
          ],
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ confirmMenu: async () => "apply" }).apply(analysisId, { yes: false });

    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "idempotent" });
    expect(github.created).toHaveLength(0);
  });

  it("resumes a partially-applied SPLIT_ISSUE by only creating the missing child", async () => {
    github.issues.set(12, epic());
    github.issues.set(20, makeIssue(20, "Auth hardening", "Handles too much at once"));
    github.issues.set(30, makeIssue(30, "Child A", "already created by a prior partial run"));

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Child A", enrichment: enrichment("Goal A") },
            { title: "Child B", enrichment: enrichment("Goal B") },
          ],
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ confirmMenu: async () => "apply" }).apply(analysisId, { yes: false });

    expect(github.created.map((c) => c.title)).toEqual(["Child B"]);
    expect(result.entries[0]?.outcome).toEqual({ status: "applied" });
    expect(result.entries[0]?.appliedIssueNumbers).toEqual(expect.arrayContaining([30]));

    const epicBody = github.issues.get(12)?.body ?? "";
    expect(epicBody).toContain("- [ ] #30 Child A");
  });

  it("previews SPLIT_ISSUE without mutation when previewOnly is set", async () => {
    github.issues.set(12, epic());
    github.issues.set(20, makeIssue(20, "Auth hardening", "Handles too much at once"));
    const previews: string[] = [];
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Child A", enrichment: enrichment("Goal A") },
            { title: "Child B", enrichment: enrichment("Goal B") },
          ],
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
    expect(previews[0]).toContain("split #20 into 2 issues:");
    expect(github.created).toHaveLength(0);
  });

  it("fails SPLIT_ISSUE cleanly when a child creation call throws, without losing the report entry", async () => {
    class FakeGitHubFailingCreate extends FakeGitHub {
      override async createIssue(input: { title: string; body: string; labels: string[] }): Promise<GitHubIssue> {
        if (input.title === "Child B") throw new Error("github 500");
        return super.createIssue(input);
      }
    }
    const failingGithub = new FakeGitHubFailingCreate();
    github = failingGithub;
    github.issues.set(12, epic());
    github.issues.set(20, makeIssue(20, "Auth hardening", "Handles too much at once"));

    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "SPLIT_ISSUE",
          issue: 20,
          reason: "spans two independent behavioral outcomes",
          children: [
            { title: "Child A", enrichment: enrichment("Goal A") },
            { title: "Child B", enrichment: enrichment("Goal B") },
          ],
          policy: "requires-approval",
        },
      ]),
    );

    const result = await service({ github, confirmMenu: async () => "apply" }).apply(analysisId, { yes: false });

    expect(result.summary.failed).toBe(1);
    expect(result.entries[0]?.outcome.status).toBe("failed");
    expect(github.created.map((c) => c.title)).toEqual(["Child A"]);
    const parentBody = github.issues.get(20)?.body ?? "";
    expect(parentBody).not.toContain("## Split into");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts`
Expected: FAIL — `SPLIT_ISSUE` currently falls into the `prepare()`
switch's unhandled case (TypeScript exhaustiveness would actually catch
this at compile time once Task 1's schema change lands — confirm by
running `npx tsc --noEmit` too, which should show a missing-case error
in `apply-service.ts`'s `prepare()` switch until Step 3 is done).

- [ ] **Step 3: Implement `SPLIT_ISSUE` wiring**

In `src/reconciliation/apply-service.ts`:

Update the import block at the top to add the two new imports:

```ts
import {
  appendDependencyToBody,
  bodyAlreadyDependsOn,
  removeManagedDependencyFromBody,
} from "./apply-dependency.js";
import {
  confirmMenu,
  renderCreatePreview,
  renderDependencyPreview,
  renderEnrichPreview,
  renderRemoveDependencyPreview,
  renderSplitPreview,
  type MenuAnswer,
} from "./apply-preview.js";
import { renderReconciliationSection, upsertReconciliationSection } from "./managed-section.js";
import { splitAlreadyApplied, upsertSplitSection } from "./managed-split-section.js";
import { AGENT_READY_LABEL, SPLIT_LABEL } from "../analysis/label-reconciliation.js";
```

Add `"SPLIT_ISSUE"` to `OFFERABLE_REQUIRES_APPROVAL`:

```ts
const OFFERABLE_REQUIRES_APPROVAL: ReadonlySet<BacklogPatchType> = new Set([
  "REMOVE_DEPENDENCY",
  "SPLIT_ISSUE",
]);
```

Update the `prepare()` switch to add a case, and pass `report.epicRef`
through. First find the `apply()` method's main loop — the `prepare()`
call currently reads `prepared = await this.prepare(patch);`. Change
`prepare` to also take the report's `epicRef`:

```ts
      let prepared: Prepared;
      try {
        prepared = await this.prepare(patch, report.epicRef);
      } catch (error) {
        recordEntry(entries, summary, failedEntry(patch, error));
        continue;
      }
```

Update the `prepare` method signature and switch:

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
      case "KEEP":
      case "MARK_STALE":
      case "NEEDS_HUMAN":
        return { kind: "skip", entry: skipEntry(patch, "requires-approval") };
    }
  }
```

Add `prepareSplit` and `applySplitFresh` methods, placed after
`prepareRemoveDependency` and before `getIssueOrSkipped`:

```ts
  private async prepareSplit(
    patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
    epicRef: number,
  ): Promise<Prepared> {
    let current: GitHubIssue;
    try {
      current = await this.deps.github.getIssue(patch.issue);
    } catch (error) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "failed-to-fetch", error instanceof Error ? error.message : String(error)),
      };
    }

    if (splitAlreadyApplied(current.body, patch.children)) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", "already split into the proposed children"),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `split #${patch.issue} into ${patch.children.length} issues`),
      previewText: renderSplitPreview(patch),
      applyFresh: () => this.applySplitFresh(patch, epicRef),
    };
  }

  private async applySplitFresh(
    patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
    epicRef: number,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.issue);
    if (splitAlreadyApplied(current.body, patch.children)) {
      return skipEntry(patch, "idempotent", "already split into the proposed children");
    }

    const childRefs: Array<{ number: number; title: string }> = [];
    for (const child of patch.children) {
      const existing = await this.deps.github.findIssueByTitle(child.title);
      const issue =
        existing ??
        (await this.deps.github.createIssue({
          title: child.title,
          body: renderReconciliationSection(child.enrichment),
          labels: ["task"],
        }));
      await this.linkIssueToEpic(epicRef, issue);
      childRefs.push({ number: issue.number, title: issue.title });
    }

    await this.deps.github.updateIssueBody(
      patch.issue,
      upsertSplitSection(current.body, childRefs),
    );

    try {
      await this.deps.github.addLabel(patch.issue, SPLIT_LABEL);
      const labels = await this.deps.github.listLabels(patch.issue);
      if (labels.includes(AGENT_READY_LABEL)) {
        await this.deps.github.removeLabel(patch.issue, AGENT_READY_LABEL);
      }
    } catch {
      // best-effort: label-write failures never fail an otherwise-successful split
    }

    return {
      ...entryBase(patch, `split #${patch.issue} into ${childRefs.length} issues`),
      outcome: { status: "applied" },
      appliedIssueNumbers: childRefs.map((ref) => ref.number),
    };
  }
```

No local `splitAlreadyApplied` helper is defined in this file — it is
imported from `./managed-split-section.js` (added to the import block in
the earlier step), the same shared function Task 6 uses in
`idempotency.ts`.

Update `sortPatches`'s rank map to place `SPLIT_ISSUE` after
`REMOVE_DEPENDENCY`:

```ts
function sortPatches(patches: ReconciledPatch[]): ReconciledPatch[] {
  const rank: Partial<Record<BacklogPatchType, number>> = {
    CREATE_ISSUE: 0,
    ENRICH_ISSUE: 1,
    ADD_DEPENDENCY: 2,
    REMOVE_DEPENDENCY: 3,
    SPLIT_ISSUE: 4,
  };
  return [...patches].sort((a, b) => (rank[a.type] ?? 10) - (rank[b.type] ?? 10));
}
```

Also update the `previewOnly` render call inside `apply()`'s main loop —
it already calls `this.onPreview(prepared.previewText)` generically via
the `Prepared` union's `previewText` field, so **no change is needed
there**; `prepareSplit`'s `previewText: renderSplitPreview(patch)` is
picked up automatically by the existing generic preview path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run the full test suite and type check**

Run: `npx vitest run`
Expected: all tests PASS (260+ existing plus the new ones from this
plan).

Run: `npx tsc --noEmit`
Expected: no errors. This is pi_autopilot's production-code type gate
(there is no Next.js build step in this repo, unlike revalbis-app).

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/apply-service.ts tests/unit/reconciliation/apply-service.test.ts
git commit -m "feat: wire SPLIT_ISSUE into ApplyService (create children, link epic, mark parent split)"
```

---

### Task 11: Update `docs/MILESTONES.md`

**Files:**
- Modify: `docs/MILESTONES.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the backlog entry**

In `docs/MILESTONES.md`, under "### Reconciliation apply-safe
follow-ups 🔲", find the bullet:

```
- **Remaining patch types:** `SPLIT_ISSUE`, `MERGE_DUPLICATE` —
  documented in `src/domain/reconciliation.ts` as a future extension of
  the `BacklogPatch` union. (extend_requirements.md §"Structured patch model")
  `REMOVE_DEPENDENCY` is fully implemented, including `ApplyService`
  wiring (see the 2026-08-24 milestone entry above). `MARK_READY` is
  deliberately excluded; see
  `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md` §6.
```

Replace it with:

```
- **Remaining patch type:** `MERGE_DUPLICATE` — documented in
  `src/domain/reconciliation.ts` as a future extension of the
  `BacklogPatch` union. (extend_requirements.md §"Structured patch model")
  `REMOVE_DEPENDENCY` and `SPLIT_ISSUE` are both fully implemented,
  including `ApplyService` wiring (see the 2026-08-24 milestone entries).
  `MARK_READY` is deliberately excluded; see
  `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md` §6.
```

Also find the bullet:

```
- **Oversized-task detection driving `SPLIT_ISSUE` proposals.**
  (extend_requirements.md §"Task size and splitting")
```

Remove it entirely (implemented by this plan — the prompt now proposes
`SPLIT_ISSUE` directly for mechanical splits per Task 7).

Add a new milestone entry section. Insert it directly after the existing
"## 2026-08-24 — `REMOVE_DEPENDENCY` wired into `ApplyService` ✅"
section (before "## 2026-08-23 — Continuous backlog intake ✅"):

```markdown
---

## 2026-08-24 — `SPLIT_ISSUE` reconciliation patch ✅

**Scope:** The reconciler can propose breaking an oversized issue into
smaller child issues, and `reconcile-apply` creates them end to end.

- New `SPLIT_ISSUE` `BacklogPatch` variant: a parent issue number plus 2+
  child `IssueSpec`s (title + full execution-contract enrichment each).
- Reconciler prompt rule split in two: a mechanical, engineering-only
  oversized split is proposed directly as `SPLIT_ISSUE`; a split whose
  slicing is itself a product call still raises `NEEDS_HUMAN`
  (ambiguityType `PRODUCT`).
- Classified `requires-approval` and added to `ApplyService`'s
  `OFFERABLE_REQUIRES_APPROVAL` set (offerable via interactive
  confirmation; never auto-applied under `--yes` or a prior `"all"`
  answer), joining `REMOVE_DEPENDENCY`.
- Apply creates each missing child (matched by title for idempotent
  partial-run resume), links every child into the parent's epic
  (append-only — the parent's own epic checklist line is never touched
  or removed), and upserts a new managed "Split into" checklist section
  onto the parent issue body.
- New `split` label marks the parent as a tracking checklist, not a
  task; apply also best-effort removes `agent:ready` from the parent if
  present. `reconcileReadyLabel` (and `discover`) now always skip
  `agent:ready` label writes on any issue carrying the `split` label,
  ahead of every other readiness check.
- Idempotency: a second reconciliation run downgrades `SPLIT_ISSUE` to
  `KEEP` once the parent's body already lists every proposed child.
- Deliberately out of scope: rewriting other issues' existing
  dependencies on the split parent, and removing the parent's own line
  from the epic checklist — both left for a human or a future
  reconciliation pass.

Design spec: `docs/superpowers/specs/2026-08-24-split-issue-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-24-split-issue.md`
```

- [ ] **Step 2: Commit**

```bash
git add docs/MILESTONES.md
git commit -m "docs: record SPLIT_ISSUE milestone and close out backlog entries"
```
