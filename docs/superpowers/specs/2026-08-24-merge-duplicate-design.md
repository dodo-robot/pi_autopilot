# `MERGE_DUPLICATE` reconciliation patch — design

## 1. Scope

Add `MERGE_DUPLICATE` as a new `BacklogPatch` variant: the reconciler
proposes that two issues within the same epic describe the same actual
piece of work, and one of them (the duplicate) should be closed in favor
of the other (the survivor). This is the last of the two remaining patch
types deferred by the backlog-reconciliation and apply-safe milestones —
`REMOVE_DEPENDENCY` and `SPLIT_ISSUE` are both fully implemented (see the
2026-08-24 milestone entries and their design specs). Landing this closes
out the "Structured patch model" backlog item
(`docs/resources/extend_requirements.md` §"Structured patch model") in
full; `MARK_READY` remains permanently excluded — see
`docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md`
§6.

## 2. Precedent: how `SPLIT_ISSUE` and `REMOVE_DEPENDENCY` work today

`MERGE_DUPLICATE` reuses established patterns rather than inventing new
ones, with one exception (§2.1):

- **`requires-approval` offerable-but-gated apply**
  (`OFFERABLE_REQUIRES_APPROVAL`): a patch type can be applied via
  explicit interactive confirmation while never being auto-applied under
  `--yes` or a prior "all" answer. `MERGE_DUPLICATE` joins
  `REMOVE_DEPENDENCY` and `SPLIT_ISSUE` in this set.
- **Re-check current state before acting** (`prepare()` then
  `applyXFresh()` re-fetches and re-checks): every existing patch type
  re-verifies its precondition against a fresh `getIssue` call
  immediately before writing, not just at `prepare()` time, so a
  concurrent or resumed run can't double-apply. `MERGE_DUPLICATE` follows
  the same shape.
- **Deferred adjacent concerns**: `SPLIT_ISSUE` explicitly left rewriting
  the parent's existing dependents (§3.2 of its spec) and the epic
  checklist entry (§3.3) out of scope, for a human or a future
  reconciliation pass to resolve separately. `MERGE_DUPLICATE` makes the
  same deferral for the duplicate's dependents and epic checklist line
  (§3.4).

### 2.1 What's new: the first `closeIssue` primitive

No existing patch type closes a GitHub issue. `GitHubPort` currently has
no close capability at all — every existing mutation is additive
(`updateIssueBody`, `createIssue`, `addLabel`) or idempotent-safe
(`removeLabel`). `MERGE_DUPLICATE` is deliberately the first patch type
where closing is the intended, real effect of applying it — the whole
point is to stop the duplicate from being live work — so this spec adds
`closeIssue` to the port rather than working around its absence.

## 3. Design decisions

### 3.1 Applying closes the duplicate; does not touch the survivor

`keep` is never mutated by this patch. `duplicate` gets one comment
(§3.3) and is then closed. This is a deliberate, real state change (not a
"tracking checklist" deferral like `SPLIT_ISSUE`'s parent) — a genuine
duplicate is not live work, and closing it removes it from readiness
consideration without needing a new label or `discover` exclusion rule
(unlike `SPLIT_ISSUE`, which had to add the `split` label because its
parent stays open). A closed issue is already excluded from every
existing open-issue-scoped query (`collectEpicIssueRefs`,
`findIssueByTitle`, epic-checklist reconciliation) with no new code
required.

### 3.2 Patch shape: reconciler names both roles explicitly

```ts
{ type: "MERGE_DUPLICATE", keep: number, duplicate: number, reason: string }
```

The reconciler decides survivorship itself — mirroring how `SPLIT_ISSUE`
already makes the substantive judgment call (which children, what
titles) while code only enforces mechanical invariants. The prompt
instructs the model to prefer whichever issue has more complete/enriched
content as `keep`, with the lower issue number as a tie-break (§3.5).
`keep` and `duplicate` must differ; this is enforced by the prompt
instructions, not the schema (matching how `SPLIT_ISSUE`'s
`children.min(2)` is the only structural schema constraint — cross-field
inequality constraints aren't otherwise used in this union).

### 3.3 Duplicate gets exactly one plain-text comment, then is closed

Apply sequence for a fresh (not-yet-applied) patch:

1. `createIssueComment(duplicate, "Duplicate of #{keep}.")` — via the
   existing `createIssueComment` primitive, no new comment-formatting
   module needed (unlike `SPLIT_ISSUE`'s managed section, there is no
   structured content to upsert or later re-parse).
2. `closeIssue(duplicate)`.

No managed section, no body rewrite, no title change. The duplicate's
original human-authored content is untouched; the comment is the only
addition, purely for human readers who land on the closed issue later.

### 3.4 Out of scope: dependents and epic checklist

- **Existing dependents of `duplicate`.** If another issue has
  `ADD_DEPENDENCY on #duplicate`, that dependency is left pointing at the
  now-closed issue unchanged. Rewriting it to target `keep` is left for a
  human or a future reconciliation pass, via its own
  `ADD_DEPENDENCY`/`REMOVE_DEPENDENCY` proposals — identical deferral to
  `SPLIT_ISSUE` design §3.2.
- **Epic checklist entry for `duplicate`.** `duplicate`'s own line in the
  epic's checklist (`- [ ] #duplicate ...`) is not removed or struck
  through. Rewriting checklists isn't a solved primitive in this codebase
  yet (`linkIssueToEpic` is append-only); solving it is out of scope here,
  matching `SPLIT_ISSUE` design §3.3's equivalent deferral for the
  parent's own checklist line.

### 3.5 Prompt contract: same-epic-only, judgment-based detection

The reconciler is invoked per-epic (`buildReconcilerPrompt` receives one
epic's issue list), so cross-epic duplicate detection isn't data the
model has access to regardless — `MERGE_DUPLICATE` is implicitly
same-epic-only because nothing else is possible with the current prompt
shape. New rule text for `buildReconcilerPrompt`:

> Propose `MERGE_DUPLICATE` when two issues in this epic describe the
> same actual piece of work — not merely similar titles or overlapping
> keywords, but the same behavioral outcome such that implementing one
> would fully satisfy the other. Set `keep` to whichever issue has more
> complete or enriched content (fuller acceptance criteria, more
> validated context); if the two are equally complete, `keep` is the
> lower-numbered issue. Set `duplicate` to the other. Never propose
> `MERGE_DUPLICATE` for issues that merely depend on or relate to each
> other — only true duplicates.

Add to the `submit_result` output-contract example:

```json
{ "type": "MERGE_DUPLICATE", "keep": 120, "duplicate": 123, "reason": "..." }
```

### 3.6 Patch policy: `requires-approval`

Closing an issue is a real, irreversible-by-default (from the daemon's
perspective) action on human-authored content. `MERGE_DUPLICATE` is
classified `requires-approval` and added to `OFFERABLE_REQUIRES_APPROVAL`
in `apply-service.ts`, joining `REMOVE_DEPENDENCY` and `SPLIT_ISSUE`
(offerable via the interactive confirm menu; never auto-applied under
`--yes` or a prior "all" answer).

### 3.7 Idempotency: cheap state check, no content matching

Unlike every other requires-approval type, there is no managed section or
free-text pattern to re-parse — GitHub issue `state` (`"open"` |
`"closed"`, already present on `GitHubIssue`) is authoritative and free.

Added to `applyIdempotencyDowngrades` (`src/reconciliation/idempotency.ts`):
for a `MERGE_DUPLICATE` patch, look up `duplicate`'s current state (from
the same `issues` list already passed in). If it is `"closed"`, downgrade
to:

```ts
{ type: "KEEP", issue: patch.duplicate, reason: "already closed as a duplicate of #<keep>" }
```

Otherwise the patch passes through unchanged. `ApplyService.prepare`/
`applyFresh` re-run the identical check against a freshly fetched
`duplicate` immediately before writing, matching every other patch type's
"check twice" pattern (design decision, not duplicated logic — both call
sites are a one-line `state === "closed"` check, too small to warrant a
shared helper the way `bodyAlreadyDependsOn`/`splitAlreadyApplied` are
shared across their two call sites).

### 3.8 `ApplyService` wiring

- `OFFERABLE_REQUIRES_APPROVAL` gains `"MERGE_DUPLICATE"`.
- `prepare()`'s switch gains a `MERGE_DUPLICATE` case calling
  `prepareMergeDuplicate`.
- New `prepareMergeDuplicate(patch)` / `applyMergeDuplicateFresh(patch)`,
  parallel in shape to `prepareRemoveDependency`/
  `applyRemoveDependencyFresh` (single-issue re-fetch, single-issue
  write) rather than `prepareSplit`'s multi-issue shape:
  1. Re-fetch `duplicate` fresh via `getIssue`.
  2. If `state === "closed"`, skip idempotent
     (`"already closed as a duplicate of #<keep>"`).
  3. `createIssueComment(duplicate, "Duplicate of #{keep}.")`.
  4. `closeIssue(duplicate)`.
  5. Return one `ApplyEntry` with `outcome: { status: "applied" }` and
     `appliedIssueNumber: duplicate` (singular field — only one issue is
     mutated, unlike `SPLIT_ISSUE`'s plural `appliedIssueNumbers`).
- **Partial-failure recovery:** if `createIssueComment` succeeds but
  `closeIssue` throws, the write fails with `status: "failed"` and no
  `appliedIssueNumber` (matching the existing `write()` wrapper's
  catch-and-report shape) — re-running the patch later re-checks state
  (still open), so it retries both steps; a duplicate "Duplicate of #N"
  comment on retry is accepted as a harmless side effect of at-least-once
  semantics, same tolerance the codebase already accepts elsewhere for
  best-effort writes.
- `previewOnly` renders `renderMergeDuplicatePreview(patch)` (§3.9), same
  as every other offerable/auto-safe write.
- `sortPatches`: `MERGE_DUPLICATE` is appended to the rank map after
  `SPLIT_ISSUE` — closing an already-existing issue cannot conflict with
  anything else created or linked earlier in the same apply run.

### 3.9 Preview rendering

New function in `src/reconciliation/apply-preview.ts`:

```ts
export function renderMergeDuplicatePreview(
  patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
): string
```

Shows both issue numbers and states that `duplicate` will be commented on
and closed in favor of `keep`, mirroring `renderRemoveDependencyPreview`'s
compact shape.

### 3.10 `GitHubPort.closeIssue`

```ts
closeIssue(number: number): Promise<void>;
```

Added to the `GitHubPort` interface (`src/github/github-adapter.ts`) and
implemented on the Octokit adapter via
`octokit.rest.issues.update({ owner, repo, issue_number: number, state: "closed" })`,
matching `updateIssueBody`'s existing shape (parameters, `GitHubError`
wrapping on failure). Test doubles/fakes used by `apply-service.test.ts`
gain a `closeIssue` implementation alongside their existing
`createIssueComment`.

## 4. Schema change

`src/domain/reconciliation.ts` — add one variant to `BacklogPatchSchema`'s
discriminated union:

```ts
z.object({
  type: z.literal("MERGE_DUPLICATE"),
  keep: z.number().int().positive(),
  duplicate: z.number().int().positive(),
  reason: z.string().min(1),
}),
```

Update the doc comment: `MERGE_DUPLICATE` moves out of the "future
extension" list — the union now implements every patch type described in
`docs/resources/extend_requirements.md` §"Structured patch model" except
the permanently-excluded `MARK_READY`.

## 5. Testing

- **Schema test**: round-trips `MERGE_DUPLICATE` through
  `BacklogPatchSchema`.
- **`patch-policy.test.ts`**: `MERGE_DUPLICATE` classifies as
  `requires-approval`.
- **`idempotency.test.ts`**: `MERGE_DUPLICATE` downgrades to `KEEP` when
  `duplicate`'s current state is `"closed"`; passes through unchanged
  when open.
- **`prompt.test.ts`**: `buildReconcilerPrompt` output includes the
  `MERGE_DUPLICATE` example and the same-work-not-just-similar-titles rule
  text.
- **`apply-preview.test.ts`**: `renderMergeDuplicatePreview` output shape.
- **`apply-service.test.ts`**:
  - Applies: posts the "Duplicate of #N" comment, then closes
    `duplicate`; `keep` receives no calls at all.
  - Idempotent skip: `duplicate` already closed — patch is skipped, no
    comment or close call made.
  - Failure mid-step: `createIssueComment` succeeds but `closeIssue`
    throws — `ApplyEntry` is `failed`, no `appliedIssueNumber` reported.
  - `previewOnly` renders without any mutating GitHub call.
  - `sortPatches` places `MERGE_DUPLICATE` after `SPLIT_ISSUE`.
- **`github-adapter` test** (if an existing test file covers other port
  methods against a fake Octokit client): `closeIssue` calls
  `issues.update` with `state: "closed"` for the given number.

## 6. Out of scope

- **Rewriting existing dependents of `duplicate`.** (§3.4) Left for a
  human or a future reconciliation pass.
- **Removing or rewriting `duplicate`'s own line in the epic checklist.**
  (§3.4) Left for a future pass; `linkIssueToEpic` remains append-only.
- **`MARK_READY`.** Permanently excluded; see
  `docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md`
  §6.
- **Cross-epic duplicate detection.** Not possible with the current
  per-epic prompt shape; not addressed here.
- **Reopening a closed duplicate if a human disagrees.** Standard GitHub
  reopen via the web UI/CLI is sufficient; no autopilot command is added
  for this.
