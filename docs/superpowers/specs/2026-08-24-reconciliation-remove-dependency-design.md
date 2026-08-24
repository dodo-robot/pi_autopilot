# `REMOVE_DEPENDENCY` reconciliation patch — design

## 1. Scope

Add `REMOVE_DEPENDENCY` as a new `BacklogPatch` variant: the reconciler
proposes retracting a previously-recorded, no-longer-real ordering
constraint between two issues. This is the first of three remaining
patch types deferred by the original backlog-reconciliation and
apply-safe milestones (`SPLIT_ISSUE` and `MERGE_DUPLICATE` are each
their own, separate design). `MARK_READY` — also on that deferred list —
is intentionally excluded from all three efforts; see §6.

This spec covers schema, deterministic guards, patch-policy
classification, apply-service writes, prompt contract, and testing.
Implementation plan follows in a separate document once this spec is
approved.

## 2. Precedent: how `ADD_DEPENDENCY` works today

`ADD_DEPENDENCY` is the direct mirror this design extends symmetrically:

- **Grammar** (`src/analysis/dependency-markers.ts`): two dependency-line
  patterns are recognized when *detecting* a dependency —
  `MANAGED_DEPENDENCY_PATTERN` (`- #N (unsatisfied)`, the form the system
  itself writes) and `LINE_DEPENDENCY_PATTERN` (free-text human prose like
  `depends on: #12`). Both feed the deterministic BLOCKED screen and the
  analyst's readiness check.
- **Write asymmetry**: `appendDependencyToBody` (`src/reconciliation/apply-dependency.ts`)
  only ever *writes* the managed form, appended as a loose `Depends on:`
  block outside any managed section. It never touches free-text lines.
  `bodyAlreadyDependsOn` still *detects* both forms for idempotency.
- **Idempotency** (`src/reconciliation/idempotency.ts`): a second
  reconciliation run downgrades `ADD_DEPENDENCY` to `KEEP` if the
  dependency is already present in either form.
- **Policy** (`src/reconciliation/patch-policy.ts`): `ADD_DEPENDENCY` is
  `auto-safe` — purely additive, no correctness risk to the autonomous
  daemon.
- **Apply** (`src/reconciliation/apply-service.ts`): `prepareDependency`
  re-fetches the issue fresh, re-checks idempotency against current state
  (guards against edits made between report generation and apply),
  previews the diff, and `applyDependencyFresh` writes via
  `updateIssueBody`.

`REMOVE_DEPENDENCY` reuses this exact pipeline shape end to end. The only
new primitive is the body-edit itself; everything else is a parallel
code path already proven by `ADD_DEPENDENCY`.

## 3. Design decisions

### 3.1 Managed-form-only removal

`REMOVE_DEPENDENCY` removes **only** a dependency recorded in the
managed `- #N (unsatisfied)` form — the exact line `appendDependencyToBody`
itself would have written. It never edits a free-text
(`LINE_DEPENDENCY_PATTERN`) human-authored dependency line.

Rationale: surgically deleting a line from unstructured human prose
risks corrupting surrounding content the reconciler doesn't fully
understand. Restricting removal to a form the *system* generates keeps
the operation deterministic and safe — symmetric with `ADD_DEPENDENCY`'s
own write asymmetry (it only ever writes the managed form too).

Removing a free-text human-authored dependency line is explicitly out of
scope (§6), guarded deterministically rather than silently attempted.

### 3.2 Two-layer guard against removing a free-text dependency

Because the reconciler is an LLM and this codebase's standing principle
is that safety-relevant decisions are never left to the LLM alone
(`patch-policy.ts`, `idempotency.ts` are both deterministic, prompt-independent
gates), the free-text exclusion is enforced twice:

1. **Prompt rule** (§3.5): instructs the reconciler to propose
   `REMOVE_DEPENDENCY` only against a dependency it can see rendered in
   the managed bullet form, never a free-text line.
2. **Deterministic downstream guard** (§3.4): `applyIdempotencyDowngrades`
   checks the target issue's *current* body directly; if the managed-form
   line for the given `dependsOn` is absent — whether because it was
   never there, already removed, or only ever present as free text — the
   patch downgrades to `KEEP` before it can reach `ApplyService`.

A prompt slip-up (proposing removal against a free-text line) is caught
by the deterministic guard and never produces a write.

### 3.3 Patch policy: `requires-approval`

Unlike every currently `auto-safe` patch type (`ENRICH_ISSUE`,
`ADD_DEPENDENCY`, `CREATE_ISSUE` — all purely additive), `REMOVE_DEPENDENCY`
loosens a constraint that gates automatic execution readiness. An
incorrect removal could make an issue appear ready to run while a real
ordering dependency still exists, which is a correctness risk for the
autonomous daemon (M3), not merely cosmetic. `REMOVE_DEPENDENCY` is
therefore classified `requires-approval` and left out of
`patch-policy.ts`'s `AUTO_SAFE` set.

### 3.4 Idempotency

Added to `applyIdempotencyDowngrades` (`src/reconciliation/idempotency.ts`):
for a `REMOVE_DEPENDENCY` patch, look up the target issue's current body.
If the managed-form dependency line for `dependsOn` is **not** present,
downgrade to:

```ts
{ type: "KEEP", issue: patch.issue, reason: "dependency #<dependsOn> is not recorded in managed form; nothing to remove" }
```

Otherwise the patch passes through unchanged. This mirrors
`ADD_DEPENDENCY`'s existing downgrade shape exactly (inverse condition).

### 3.5 Prompt contract

Add to the `submit_result` output-contract example in
`buildReconcilerPrompt` (`src/reconciliation/prompt.ts`):

```json
{ "type": "REMOVE_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." }
```

Add a rule alongside the existing `ADD_DEPENDENCY` rule:

> Propose `REMOVE_DEPENDENCY` only when a currently-recorded **managed-form**
> dependency (the `- #N (unsatisfied)` bullet, not free-text prose like
> "depends on #12") no longer reflects a real ordering constraint — for
> example, the dependency was satisfied by a rearchitecting that removed
> the need for it, or was recorded in error. Never propose it against a
> dependency you only see written as free-text human prose.

### 3.6 Apply-service writes

New body-edit primitive in `src/reconciliation/apply-dependency.ts`:

```ts
function removeManagedDependencyFromBody(body: string, dependsOn: number): string
```

Behavior:
- Removes the exact `- #<dependsOn> (unsatisfied)` line.
- If that was the only bullet under its `Depends on:` header, also
  removes the now-empty header (and the blank-line separator
  `appendDependencyToBody` inserts before it) — repeated add/remove
  cycles never accumulate empty `Depends on:` headers.
- If other dependency bullets remain under the same header, only the
  matching line is removed; the header and other bullets are untouched.
- No-op (returns `body` unchanged) if the managed-form line is absent —
  this should never actually run in practice, since the idempotency
  guard (§3.4) downgrades that case to `KEEP` before `ApplyService` is
  reached, but the function stays total/safe on its own.

New `ApplyService` methods, structurally identical to
`prepareDependency`/`applyDependencyFresh`:

- `prepareRemoveDependency`: fetches the issue fresh, re-checks the
  managed-form line is still present against *current* state (protects
  against a concurrent edit between report generation and apply — same
  pattern every other patch type already follows), skips idempotently if
  already gone, otherwise stages a write with a rendered preview.
- `applyRemoveDependencyFresh`: re-fetches once more immediately before
  writing (matching `applyDependencyFresh`'s own fresh-fetch), re-checks,
  writes via `updateIssueBody(issue, removeManagedDependencyFromBody(body, dependsOn))`.

Both added to the `switch` in `ApplyService.prepare()`.

### 3.7 Preview rendering

New function in `src/reconciliation/apply-preview.ts`:

```ts
function renderRemoveDependencyPreview(currentBody: string, dependsOn: number): string
```

Mirrors `renderDependencyPreview`; shows the exact line being removed.

## 4. Schema change

`src/domain/reconciliation.ts` — add one variant to `BacklogPatchSchema`'s
discriminated union:

```ts
z.object({
  type: z.literal("REMOVE_DEPENDENCY"),
  issue: z.number().int().positive(),
  dependsOn: z.number().int().positive(),
  reason: z.string().min(1),
}),
```

Update the doc comment listing which variants this union currently
implements vs. defers (currently references `SPLIT_ISSUE`/`MERGE_DUPLICATE`/
`REMOVE_DEPENDENCY`/`MARK_READY` as all-future; `REMOVE_DEPENDENCY` moves
out of that deferred list once implemented).

## 5. Testing

Mirrors existing `ADD_DEPENDENCY` coverage 1:1:

- **`apply-dependency.test.ts`**: `removeManagedDependencyFromBody` —
  removes the line; cleans up an emptied `Depends on:` header; leaves
  other bullets under the same header untouched; no-op when the line is
  absent.
- **`idempotency.test.ts`**: `REMOVE_DEPENDENCY` downgrades to `KEEP`
  when the managed-form line is absent; passes through unchanged when
  present.
- **`patch-policy.test.ts`**: `REMOVE_DEPENDENCY` classifies as
  `requires-approval`.
- **`apply-service.test.ts`**: prepare/apply happy path (removes the
  line via a real `updateIssueBody` call); idempotent skip; concurrent-edit
  re-check (dependency already removed by the time apply runs).
- **Schema test**: round-trips the new discriminated-union variant
  through `BacklogPatchSchema`.

## 6. Out of scope

- **Free-text (`LINE_DEPENDENCY_PATTERN`) dependency-line removal.**
  Deliberately excluded (§3.1); guarded deterministically, not silently
  dropped. A future extension could add a distinct, more careful patch
  type for this if it proves necessary.
- **`MARK_READY`.** Excluded from this effort (and from the sibling
  `SPLIT_ISSUE`/`MERGE_DUPLICATE` efforts) entirely: readiness is already
  computed deterministically by `discover`'s `agent:ready` label
  reconciliation (per the "Continuous backlog intake" milestone), and a
  reconciler-proposed `MARK_READY` would be a second, competing,
  LLM-opinion source of truth for the same label with no defined
  precedence rule against the deterministic gate. Any case that looks
  like "this issue should now be ready" is actually a content problem
  (fixed via `ENRICH_ISSUE`/`KEEP`), which `discover`'s deterministic
  check then picks up on its own without a new patch type.
- **`SPLIT_ISSUE`, `MERGE_DUPLICATE`.** Each is its own design +
  implementation-plan cycle, sequenced after this one.
