# `SPLIT_ISSUE` reconciliation patch — design

## 1. Scope

Add `SPLIT_ISSUE` as a new `BacklogPatch` variant: the reconciler proposes
breaking an oversized issue into multiple smaller, independently
implementable child issues. This is the second of the two remaining patch
types deferred by the backlog-reconciliation and apply-safe milestones
(`MERGE_DUPLICATE` remains deferred; `MARK_READY` remains permanently
excluded — see
`docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md`
§6).

Unlike `REMOVE_DEPENDENCY`, this spec wires `SPLIT_ISSUE` all the way into
`ApplyService` in the same task — the `ApplyService` gate that deferred
`REMOVE_DEPENDENCY`'s apply wiring (unconditionally skipping every
`requires-approval` patch before `prepare()` ran) was already fixed by the
2026-08-24 `REMOVE_DEPENDENCY`-into-`ApplyService` milestone, so there is no
equivalent blocker here.

## 2. Precedent: how `CREATE_ISSUE` and `REMOVE_DEPENDENCY` work today

`SPLIT_ISSUE` composes two existing, already-proven code paths rather than
inventing new primitives:

- **Issue creation** (`ApplyService.applyCreateFresh`): creates a GitHub
  issue from an `IssueSpec` (title + `IssueEnrichment`), rendered via
  `renderReconciliationSection`, labeled `["task"]`, then linked into an
  epic's checklist via `linkIssueToEpic` — a pure, idempotent append
  (`collectEpicIssueRefs` first, so re-running never double-links).
- **Idempotent existing-issue matching** (`findExistingIssueWithTitle`):
  used by `CREATE_ISSUE` to detect a same-titled issue already created by a
  prior partial run. `SPLIT_ISSUE` reuses this per child.
- **`requires-approval` offerable-but-gated apply** (`REMOVE_DEPENDENCY`):
  `OFFERABLE_REQUIRES_APPROVAL` lets a patch type be applied via explicit
  interactive confirmation while never being auto-applied under `--yes` or
  a prior "all" answer. `SPLIT_ISSUE` joins this set.
- **Managed body sections** (`managed-section.ts` /
  `upsertManagedSection`): a machine-owned section delimited by HTML
  comment markers, upserted without disturbing human-authored content
  elsewhere in the body. `SPLIT_ISSUE` adds a second, distinctly-delimited
  managed section for the same pattern.

`SPLIT_ISSUE` is new only in that it creates *multiple* issues from one
patch and mutates the *parent* issue's body/labels instead of (or in
addition to) creating something new.

## 3. Design decisions

### 3.1 Parent issue becomes a tracking checklist, not a blocker

Once applied, the parent issue is not closed and does not become a
dependency of its children. It stays open, its original human-authored
content is untouched, and a new managed section is appended listing the
children as a checklist. The parent is now conceptually an index, not a
task — reflected by the `split` label (§3.5), not by closing it or
rewriting its title/description.

Rationale: closing the parent loses its history/comments/discussion
thread for no benefit; making children depend on it would incorrectly
block their execution behind an issue that no longer represents real work.

### 3.2 Existing dependents of the parent are out of scope

If another issue currently has `ADD_DEPENDENCY on #123` and #123 gets
split into `#124`/`#125`, that dependency is left pointing at `#123`
unchanged. Rewriting it to target the new children (and deciding which
ones) is a separate concern, left for a human or a future reconciliation
pass to resolve via its own `ADD_DEPENDENCY`/`REMOVE_DEPENDENCY`
proposals — mirroring how `REMOVE_DEPENDENCY`'s design deferred adjacent
concerns rather than solving everything transitively in one patch.

### 3.3 Children are linked to the parent's epic; the parent's own epic line is untouched

`SPLIT_ISSUE` apply links every child issue into the same epic the parent
belongs to (`report.epicRef`, already available in `ApplyService.apply()`
from the stored `ReconciliationReport`), via the existing `linkIssueToEpic`
append-only primitive. The parent's own line in the epic's checklist
(`- [ ] #123 ...`) is **not** removed or modified — children are strictly
additive to the epic checklist.

Rationale: an unlinked child would be invisible to
`collectEpicIssueRefs`-based epic-scoped issue discovery (`analyze`,
`discover`), so linking is required for children to be discoverable at
all — unlike the dependent-rewriting case in §3.2, this isn't optional
polish. Removing the parent's own checklist line would require parsing
and rewriting the checklist rather than a pure append, and the `split`
label already gives any future rollup a way to distinguish "this
checklist entry is a tracking issue, not a task" without deleting
history.

### 3.4 Patch policy: `requires-approval`

Splitting rewrites a human-authored issue into a tracking checklist and
creates new issues whose scope division is a nontrivial judgment call
(the prompt already routes genuinely product-flavored splits to
`NEEDS_HUMAN` instead — §3.6). Even an engineering-only split is a
structural, semi-destructive edit to existing content. `SPLIT_ISSUE` is
therefore classified `requires-approval`, joining `REMOVE_DEPENDENCY` in
`OFFERABLE_REQUIRES_APPROVAL` (offerable via the interactive confirm menu;
never auto-applied under `--yes` or a prior "all" answer).

### 3.5 New `split` label excludes the parent from `agent:ready` reconciliation

Once a parent issue is split, it is no longer a task — `discover`'s
readiness reconciliation must never write `agent:ready` onto it, no
matter what a readiness check would otherwise conclude about its content.

- New label constant `SPLIT_LABEL = "split"` in
  `src/analysis/label-reconciliation.ts`.
- `reconcileReadyLabel` gains a `hasSplitLabel: boolean` input, checked
  first (same early-return position as the existing `hasInProgressLabel`
  check): when true, always returns a new `LabelAction = "skipped-split"`
  regardless of every other input.
- `discover.ts`'s existing label-fetch-then-reconcile loop passes
  `labels.includes(SPLIT_LABEL)` through, exactly as it already does for
  `AGENT_IN_PROGRESS_LABEL`. No change needed to `BacklogAnalyst`/
  `ReadinessService` — the parent can still be classified normally by
  content; only the label *write* is suppressed.
- `SPLIT_ISSUE` apply adds the `split` label to the parent and
  best-effort removes `agent:ready` if present (the parent may have been
  marked ready before an oversized-scope problem was caught).

### 3.6 Prompt contract: ENGINEERING splits proposed directly, PRODUCT splits still `NEEDS_HUMAN`

The current prompt rule in `buildReconcilerPrompt`
(`src/reconciliation/prompt.ts`) blanket-defers every oversized issue to
`NEEDS_HUMAN` ("this milestone cannot propose SPLIT_ISSUE"). Replace it
with:

> An issue is the right size when it has one primary outcome, fits one
> isolated agent session, and its acceptance criteria are independently
> testable. If an issue's scope spans multiple independent behavioral
> outcomes, it is oversized. When the split itself is mechanical — the
> outcomes are clear and their relative order/priority is not a product
> call — propose `SPLIT_ISSUE` with one full `IssueSpec` (title +
> complete enrichment) per outcome. When which slice ships first, or how
> to divide the scope, requires a product decision, raise `NEEDS_HUMAN`
> (ambiguityType "PRODUCT") naming the outcomes instead of proposing a
> split yourself.

Add to the `submit_result` output-contract example:

```json
{ "type": "SPLIT_ISSUE", "issue": 123, "reason": "...", "children": [
  { "title": "Reject revoked sessions during authentication", "enrichment": { "goal": "...", "sourceRequirements": [], "acceptanceCriteria": [], "constraints": [], "nonGoals": [], "validation": [], "relevantAreas": [] } },
  { "title": "Rate-limit failed logins", "enrichment": { "goal": "...", "sourceRequirements": [], "acceptanceCriteria": [], "constraints": [], "nonGoals": [], "validation": [], "relevantAreas": [] } }
] }
```

### 3.7 Idempotency

Added to `applyIdempotencyDowngrades` (`src/reconciliation/idempotency.ts`):
for a `SPLIT_ISSUE` patch, look up the parent issue's current body. If it
already contains the "Split into" managed section (§3.8) whose child
titles match the proposed `children` titles exactly (case-insensitive,
order-independent set comparison), downgrade to:

```ts
{ type: "KEEP", issue: patch.issue, reason: "already split into the proposed children" }
```

Otherwise the patch passes through unchanged. Unlike `ADD_DEPENDENCY`/
`REMOVE_DEPENDENCY`, there is no free-text form to also detect — the
"Split into" section is entirely system-owned from its first write.

### 3.8 New managed section — `src/reconciliation/managed-split-section.ts`

Mirrors `managed-section.ts`'s upsert pattern with its own distinct HTML
comment markers, so it can never collide with the reconciliation
enrichment section or the M1 execution-contract section:

```ts
export const SPLIT_START = "<!-- autopilot-split:start -->";
export const SPLIT_END = "<!-- autopilot-split:end -->";

export function renderSplitSection(children: Array<{ number: number; title: string }>): string
export function upsertSplitSection(body: string, children: Array<{ number: number; title: string }>): string
```

Renders:

```
<!-- autopilot-split:start -->
## Split into

- [ ] #124 Reject revoked sessions during authentication
- [ ] #125 Rate-limit failed logins
<!-- autopilot-split:end -->
```

`upsertSplitSection` reuses the same `upsertManagedSection` primitive
`managed-section.ts` already builds on (`src/readiness/refinement-section.ts`),
parameterized with the new markers — no duplicated upsert logic.

### 3.9 `ApplyService` wiring

- `OFFERABLE_REQUIRES_APPROVAL` gains `"SPLIT_ISSUE"`.
- `prepare()`'s switch gains a `SPLIT_ISSUE` case calling `prepareSplit`.
- New `prepareSplit(patch)` / `applySplitFresh(patch)`, parallel in shape
  to `prepareCreate`/`applyCreateFresh`, both given `report.epicRef` from
  the enclosing `apply()` loop (already in scope alongside
  `report.repository`):
  1. Re-fetch parent issue fresh.
  2. Idempotency re-check against *current* parent body (mirrors every
     other `applyXFresh`): if the "Split into" section already lists all
     proposed children, skip as idempotent.
  3. For each child spec, call `findExistingIssueWithTitle` (already
     epic-scoped) to detect one already created by a prior partial run;
     create only the missing ones via `github.createIssue` (title +
     `renderReconciliationSection(child.enrichment)` body, label
     `["task"]`).
  4. Link every child (newly created or pre-existing-and-unlinked) into
     `epicRef` via `linkIssueToEpic` (pure append, already idempotent).
  5. Upsert the "Split into" section (§3.8) onto the parent's body with
     all children's final numbers + titles.
  6. Add `split` label to the parent; best-effort remove `agent:ready` if
     present (label-write failures do not fail the whole apply step,
     matching existing best-effort label-write conventions elsewhere).
  7. Return one `ApplyEntry` with the new `appliedIssueNumbers: number[]`
     field (§3.10) holding every child's issue number.
- **Partial-failure recovery:** every step re-checks current state before
  acting, so a re-run after a mid-way failure (e.g. `createIssue` throws
  on the second child) naturally resumes: already-created children are
  matched by title and not recreated, already-linked children are not
  re-linked, and the "Split into" section/label writes are last so they
  only happen once all children exist.
- `previewOnly` renders `renderSplitPreview(patch)` (§3.11), same as every
  other offerable/auto-safe write.
- `sortPatches`: `SPLIT_ISSUE` is appended to the rank map after the
  existing `ADD_DEPENDENCY`/`REMOVE_DEPENDENCY` entries — its children are
  brand new in this apply run, so nothing else in the same batch could
  reference them yet; placing it last avoids any theoretical ordering
  surprise at negligible cost.

### 3.10 `ApplyEntry` schema: plural applied-issue field

`ApplyEntrySchema` (`src/domain/apply.ts`) gains one new optional field:

```ts
appliedIssueNumbers: z.array(z.number().int().positive()).optional(),
```

alongside the existing singular `appliedIssueNumber`. Every other patch
type continues to use the singular field unchanged; `SPLIT_ISSUE` is the
only patch type that ever sets the plural one.

### 3.11 Preview rendering

New function in `src/reconciliation/apply-preview.ts`:

```ts
export function renderSplitPreview(
  patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
): string
```

Shows the parent issue number and the list of child titles about to be
created, mirroring `renderCreatePreview`'s compact shape (title + goal
per child).

## 4. Schema change

`src/domain/reconciliation.ts` — add one variant to `BacklogPatchSchema`'s
discriminated union:

```ts
z.object({
  type: z.literal("SPLIT_ISSUE"),
  issue: z.number().int().positive(),
  children: z.array(IssueSpecSchema).min(2),
  reason: z.string().min(1),
}),
```

Update the doc comment listing which variants this union currently
implements vs. defers: `SPLIT_ISSUE` moves out of the "future extension"
list; `MERGE_DUPLICATE` remains the sole deferred variant alongside the
permanently-excluded `MARK_READY`.

## 5. Testing

- **Schema test**: round-trips `SPLIT_ISSUE` through `BacklogPatchSchema`;
  rejects `children.length < 2`.
- **`patch-policy.test.ts`**: `SPLIT_ISSUE` classifies as
  `requires-approval`.
- **`idempotency.test.ts`**: `SPLIT_ISSUE` downgrades to `KEEP` when the
  parent's current body already has a matching "Split into" section
  (title-set match, case-insensitive, order-independent); passes through
  unchanged otherwise.
- **`prompt.test.ts`**: `buildReconcilerPrompt` output includes the
  `SPLIT_ISSUE` example and the updated ENGINEERING/PRODUCT split rule
  text.
- **`managed-split-section.test.ts`** (new): `renderSplitSection` output
  shape; `upsertSplitSection` inserts fresh, replaces an existing section
  in place, and leaves the rest of the body untouched.
- **`apply-preview.test.ts`**: `renderSplitPreview` output shape.
- **`apply-service.test.ts`**:
  - Creates all missing children, links each to `epicRef`, upserts the
    split section, adds the `split` label, and best-effort removes
    `agent:ready` when present.
  - Idempotent partial-run resume: some children already exist (matched
    by title) — they are not recreated, only linked/upserted as needed.
  - Idempotent full-skip: parent's body already has the matching split
    section — patch is skipped entirely, no GitHub calls beyond the
    initial fetch.
  - Failure mid-loop (one `createIssue` call throws) — `ApplyEntry` is
    `failed`, no partial `appliedIssueNumbers` are silently dropped or
    misreported.
  - `previewOnly` renders without any mutating GitHub call.
- **`label-reconciliation.test.ts`**: `hasSplitLabel: true` always yields
  `"skipped-split"`, regardless of every other input (mirrors the
  existing `hasInProgressLabel` precedence test).
- **`discover` command test**: an issue carrying the `split` label never
  receives `agent:ready`, even when otherwise classified `READY`.

## 6. Out of scope

- **Rewriting existing dependents of the split parent.** (§3.2) Left for
  a human or a future reconciliation pass.
- **Removing or rewriting the parent's own line in the epic checklist.**
  (§3.3) Children are strictly additive; the parent's checklist entry is
  untouched.
- **`MERGE_DUPLICATE`.** Its own separate design + implementation-plan
  cycle.
- **`MARK_READY`.** Permanently excluded; see
  `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md`
  §6.
- **Epic-tree progress rollups distinguishing tracking issues from
  tasks.** The `split` label makes this possible for a future
  observability feature (per `docs/MILESTONES.md`'s "Epic-tree progress
  view" backlog item), but no rollup view is built or changed here.
