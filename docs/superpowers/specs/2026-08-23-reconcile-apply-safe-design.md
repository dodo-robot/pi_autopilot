# Reconcile `apply-safe` — Design

Status: Proposed (brainstormed; ready for review)

Date: 2026-08-23

## 1. Purpose

`autopilot reconcile <epic>` currently proposes a backlog patch plan and
stops — it is strictly dry-run and never mutates GitHub. `apply-safe` is the
explicit next step named by the reconciliation design spec (§10): a command
that takes a *stored* reconciliation report and applies its deterministic,
low-risk (`auto-safe`) patches to GitHub, re-validating every patch against
the target's *current* state before writing.

This spec defines the `autopilot reconcile-apply <analysisId>` command: its
CLI contract, the apply pipeline, the interactive vs. unattended modes, the
staleness guard, the durable audit artifact, and the deterministic apply
ordering and idempotency guarantees.

## 2. Scope

**In scope:**

- A new `apply-safe` command that consumes a stored reconciliation report
  (`store-then-apply`), never re-running a reconciler session.
- Applying the three `auto-safe` patch types: `ENRICH_ISSUE`,
  `ADD_DEPENDENCY`, `CREATE_ISSUE` — with per-patch idempotent
  re-validation against the target's current GitHub state.
- `KEEP` / `MARK_STALE` / `NEEDS_HUMAN` remain proposal-only and are never
  auto-applied. In interactive mode a human may approve them one at a time.
- An interactive approval flow (per-patch preview + prompt) defaulting to
  on when a TTY is present, and an unattended `--yes` path that applies only
  the `auto-safe` set.
- A staleness guard so an outdated stored report is not blindly applied.
- A durable apply-artifact (append-only audit record) keyed to the same
  `analysisId` as the source report.
- Deterministic apply ordering and continue-on-error semantics.

**Out of scope (explicitly deferred):**

- **Reconciler steering.** Declines are recorded in the audit artifact but
  never fed back into a future `reconcile` run. Any design where a human's
  decline or `NEEDS_HUMAN` answers steer future proposals is a follow-on spec.
- **`apply-all`.** Unattended application of `requires-approval` patches.
- **`SPLIT_ISSUE`, `MERGE_DUPLICATE`, `REMOVE_DEPENDENCY`, `MARK_READY`**
  patch types. The `BacklogPatch` union is designed to extend cleanly but
  they are not implemented here.
- **GitHub Projects v2 / label-based discovery.**
- **Daemon/queue integration.**
- **Concurrent/parallel application** of independent patches — always
  sequential.
- **Label policy configuration** on `CREATE_ISSUE`.

## 3. Decisions (from brainstorming)

1. **Store-then-apply, not a flag on `reconcile`.** `reconcile` keeps
   producing a reviewable plan; a separate command consumes the stored
   report. This is the design spec §10 option (`reconcile-apply <analysisId>`),
   chosen so a human can review a dry-run before anything is written, and so
   re-running apply over an already-applied report is naturally idempotent.
2. **Apply consumes the stored report; never a fresh reconcile.** The report's
   patch set is frozen from generation time. Only the *application* is
   re-validated against live state. If the world has drifted
   meaningfully, the human re-runs `reconcile`.
3. **Apply is idempotent per-patch with no apply-state ledger.** The
   source of truth is the re-validation downgrade: an issue whose body
   already reflects a proposal (or a CREATE_ISSUE whose title already
   exists) is downgraded to a skip. Re-invoking apply over the same
   `analysisId` is safe and resumes cleanly. No separate `applied.json`
   dedup record is kept.
4. **Stable apply order: `CREATE_ISSUE` → `ENRICH_ISSUE` →
   `ADD_DEPENDENCY`.** Predictable semantics independent of the reconciler's
   array order. Today these types do not chain off each other, but the order
   is enforced so behavior never depends on report internals.
5. **Continue-on-error.** If a patch write fails (non-recoverable infra
   aside), the failure is recorded, the batch continues, and the run exits
   `2` (partial success). Re-running resumes. Recoverable errors never
   silently abort the whole batch.
6. **Interactive-only human gate for `requires-approval` patches.** An
   invariant: a `requires-approval` patch is written only when a human
   approves it explicitly, one at a time, in interactive mode. Neither
   `--yes` nor "apply-all-remaining" ever bulk-approves one.
7. **Declines recorded, not steered.** The audit artifact records every
   applied / skipped / declined / failed patch and the human reason where
   given. Feeding declines back into the reconciler is deferred (see §2).
8. **`auto-safe` classification stays deterministic.** `classifyPatch`
   already tags `ENRICH_ISSUE` / `ADD_DEPENDENCY` / `CREATE_ISSUE` as
   `auto-safe`; apply-safe honors that classification exactly. Never LLM-decided.

## 4. Command interface

```text
autopilot reconcile-apply <analysisId> [--yes] [--force] [--json]
```

- `<analysisId>` — identifies the stored report to apply. This is the same
  `analysisId` echoed in `autopilot reconcile --json` output
  (`reconcile-${timestamp}-${epic}` by default).
- `--yes` — unattended: auto-apply the `auto-safe` set, silently skip
  `requires-approval`. **Required** for any writes in a non-TTY. Without it,
  a non-TTY invocation prints the would-apply preview and writes nothing.
- `--force` — bypass the staleness guard (§6).
- `--json` — emit the structured `ApplyReport` instead of the human
  summary.
- No flag — **interactive default** when a TTY is present: per-patch
  preview + prompt (`apply / skip / apply-all-remaining / abort`).

### 4.1 Exit codes

| Code | Meaning |
|---|---|
| `0` | All intended `auto-safe` patches applied (or cleanly skipped by idempotent re-validation / `requires-approval` routing); no failures |
| `1` | Hard error — report not found, staleness guard tripped without `--force`, unrecoverable infrastructure failure |
| `2` | Partial outcome — at least one `auto-safe` patch ended in a non-`applied` state despite being eligible (fell short of clean completion): a write failed, the user declined (`n`) one or more, or the run was aborted (`q`). `0` requires every eligible auto-safe patch applied or cleanly skipped by idempotent re-validation / `requires-approval` routing. |

This matches the repo's existing `0/1/2` convention (e.g. `analyze` soft
failure is `2`).

## 5. New domain types

Defined in `src/domain/apply.ts` (new) or extended into
`src/domain/reconciliation.ts`:

```ts
type ApplyOutcome =
  | { status: "applied" }
  | { status: "skipped"; skippedBy: "requires-approval" | "idempotent" | "user" | "failed-to-fetch" }
  | { status: "failed"; error: string };

interface ApplyEntry {
  patchType: BacklogPatchType;
  targetIssue: number | null;      // null only for CREATE before resolution, or NEEDS_HUMAN
  policy: PatchPolicy;
  outcome: ApplyOutcome;
  detail: string;                  // human-readable preview/summary
  appliedIssueNumber?: number;     // set post-apply for CREATE_ISSUE
  declineReason?: string;          // human note when a patch is declined in interactive mode
}

interface ApplyReport {
  repository: RepositoryRef;
  analysisId: string;
  appliedAt: string;
  staleness: {
    staleAgeHours: number;
    guardApplied: boolean;
    overriddenByForce: boolean;
  };
  entries: ApplyEntry[];
  summary: {
    applied: number;
    skippedRequiresApproval: number;
    skippedIdempotent: number;
    skippedUser: number;
    failed: number;
    previewed: number;
  };
}
```

`ApplyReport` / `ApplyEntry` are zod-validated exactly like the other domain
models (`z.object` / `z.discriminatedUnion` on `outcome`).

## 6. The apply pipeline

`ApplyService.apply(analysisId, opts): Promise<ApplyReport>`:
`src/reconciliation/apply-service.ts`.

### Step 0 — Load & guard

Load the stored report by `analysisId` (the `reconciliation-report.json`
written by `reconcile` via `ArtifactStore`). Compute
`staleAgeHours = (now - report.generatedAt)`. If it exceeds the configured
window (§9) **and** `--force` was not passed → throw → CLI exits `1`. The
`staleness` record reflects whether the guard applied and whether `--force`
overrode it.

### Step 1 — Partition patches

Sort into the stable order `CREATE_ISSUE` → `ENRICH_ISSUE` →
`ADD_DEPENDENCY`, followed by the always-requires-approval set
`KEEP` / `MARK_STALE` / `NEEDS_HUMAN`. `KEEP` is never a write; it is not
offered in interactive mode (nothing to apply) and is skipped in `--yes`.
`MARK_STALE` / `NEEDS_HUMAN` are offered in interactive mode only.

### Step 2 — Re-fetch & re-validate each auto-safe patch against current state

For each patch in order, re-run the deterministic guards against freshly
fetched issue state (the same checks `applyIdempotencyDowngrades` performs
for the dry-run):

- `ENRICH_ISSUE` → fetch target; if the managed reconciliation section
  already reflects the proposed enrichment → **skip (idempotent)**; if the
  body has ambiguous/broken managed-section markers → **skip (idempotent)**
  (cannot be evaluated safely); else preview + apply.
- `ADD_DEPENDENCY` → fetch target; if `existingDependencyNumbers(body)`
  already contains `dependsOn` → **skip (idempotent)**; else preview +
  apply.
- `CREATE_ISSUE` → check for an existing issue with the same normalized
  title → if found, **skip (idempotent)**; else preview + apply.
- A fetch failure for a target → **skip (failed-to-fetch)**, recorded, batch
  continues.

### Step 3 — Per-patch apply (mode branch)

**Interactive (default when TTY):** before each write, render the preview
(§7) and prompt (§7.1). Applies or skips per the answer. `requires-approval`
patches are always offered individually and never bulk-approved.

**`--yes`:** auto-apply the three `auto-safe` types; skip `requires-approval`
with `skippedBy: "requires-approval"`. Non-TTY without `--yes` → preview-only,
no writes.

### Step 4 — Write & record

Apply order is `CREATE_ISSUE` → `ENRICH_ISSUE` → `ADD_DEPENDENCY`. Writes are
sequential and awaited.

- `ENRICH_ISSUE` → `updateIssueBody(target, upsertReconciliationSection(current.body, patch.patch))`. The applied body is computed from the freshly-fetched body — a concurrent human edit is layered on current state, never clobbered by the stored report's snapshot.
- `ADD_DEPENDENCY` → `updateIssueBody(target, renderDependencyLine(current.body, patch.dependsOn))`. A separate dependency renderer (not the enrichment-section upsert) that folds the dependency line into the body via the shared dependency-marker grammar (`- #<dep> (unsatisfied)`/`MANAGED_DEPENDENCY_PATTERN`), preserving everything else.
- `CREATE_ISSUE` → `createIssue({ title, body, labels })`, with `body`
  seeded from `IssueSpec.enrichment` rendered through
  `renderReconciliationSection`. **Linkback:** when `patch.epic` is set,
  append `- [ ] #<new>` to the epic's checklist via
  `updateIssueBody(epic, ...)`, idempotently (skip if already referenced).
  Labels: a sensible default set (e.g. `task`); explicit label policy is out
  of scope (§2).

### Step 5 — Continue-on-error

If a write throws (a non-recoverable infra failure aside), record
`outcome: failed`, continue the batch. A hard error classified before or
outside the per-patch loop (report not found, stale without `--force`,
auth/infrastructure failure) is a hard exit `1`. At the end, write the
durable apply-artifact and return the `ApplyReport`.

## 7. Preview rendering & interactive prompt

### 7.1 Per-patch preview

Printed once per patch before any prompt (interactive mode):

- `ENRICH_ISSUE` → the **unified diff** of the change to the issue body,
  reusing the existing `diffLines` / `renderUnifiedDiff` already used by the
  dry-run report and `prepare`.
- `ADD_DEPENDENCY` → the one dependency line to be inserted plus a small
  context diff against the current body.
- `CREATE_ISSUE` → title, a compact body summary (first lines of goal /
  acceptance-criteria count), and — when linkback applies — "will append to
  epic #N checklist".
- `MARK_STALE` / `NEEDS_HUMAN` (interactive only) → the reason, and for
  `NEEDS_HUMAN` the reconciler's `questions`, so the human can answer
  meaningfully.

All preview text passes through the existing redaction path.

### 7.2 Prompt menu

After each preview:

```text
[y] apply / [n] skip / [a] apply-all-remaining / [q] abort
```

- `y` — apply just this patch.
- `n` — skip this patch; move on. Recorded as `skippedBy: "user"` with the
  human's optional reason.
- `a` — apply-all-remaining: auto-apply the remaining **auto-safe** patches
  without further prompting; **skip** any remaining `requires-approval`
  patches (never bulk-approves them). `requires-approval` is only written by
  an explicit per-patch `y` in interactive mode.
- `q` — abort: stop the whole run. Already-applied patches stay applied
  (idempotent); nothing further is written. Re-invoking apply resumes only
  what is still pending. Abort is a partial outcome → exit `2`.
- Blank / Enter — treated as skip (a stray Enter never writes).

The menu helper `confirmMenu` (in `apply-preview.ts`) is injected and
testable, replacing bootstrap's simpler boolean `prompt`. Default answer is
skip so a non-response never mutates GitHub.

## 8. Non-interactive / `--yes` behavior

- `--yes` prints one committed reporter line per applied patch and applies
  the `auto-safe` set; skips `requires-approval` silently (with an entry in
  the artifact).
- Non-TTY without `--yes`: preview-only output — prints the would-apply
  plan and writes **nothing** (guarantee: a non-interactive invocation that
  did not opt in can never mutate GitHub). Preview-only with no writes is
  a clean run → exit `0`.

These two rules together preserve the repo invariant "no silent GitHub
mutation": a mutation happens only via explicit interactive `y` or an
explicit `--yes`.

## 9. Configuration

Extends the existing `reconciliation` section of `.pi/autopilot.yaml`
(which already carries `requirementsPaths`):

```yaml
reconciliation:
  requirementsPaths: [ ... ]   # existing
  reportStaleAfterHours: 168   # NEW; default 168 = 7 days; negative/null disables the guard
```

`reportStaleAfterHours` bounds how old a stored report may be before
`reconcile-apply` refuses without `--force`. Negative or null disables the
guard.

No new `budgets` entry is needed (this is not a timeout window) and no label
configuration is introduced this milestone.

## 10. Module layout

Approach 1 — a dedicated service, reusing `src/bootstrap/apply-service.ts`'s
established idempotent-apply pattern and the existing `GitHubPort` surface:

- `src/reconciliation/apply-service.ts` — `ApplyService`, the apply pipeline.
- `src/domain/apply.ts` — `ApplyReport` / `ApplyEntry` / `ApplyOutcome`
  zod schemas.
- `src/reconciliation/apply-dependency.ts` — `renderDependencyLine` (dep-line
  renderer, isolated and unit-tested; reused by preview and apply).
- `src/reconciliation/apply-preview.ts` — preview/diff rendering + the
  `confirmMenu` prompt helper (injected, testable).
- `src/commands/reconcile-apply.ts` — CLI command wiring the service, styled
  after `src/commands/reconcile.ts`.

No new `GitHubPort` methods: `createIssue`, `updateIssueBody`, and
`ensureLabel` already exist.

## 11. Error handling

| Scenario | Behavior |
|---|---|
| Report not found for `analysisId` | Hard error, exit `1` |
| Stale report without `--force` | Hard error, exit `1` (guard applied is e.g. > `reportStaleAfterHours`) |
| Patch write succeeds | `outcome: applied` |
| Patch write throws (recoverable) | `outcome: failed` with message; batch continues; exit `2` at end |
| Patch target fetch throws | `outcome: skipped (failed-to-fetch)`; batch continues |
| Auth / infrastructure failure | Hard error, exit `1` (outside the per-patch loop) |
| Non-TTY without `--yes` | Preview-only; no writes; exit `0` |

## 12. Testing

Mirrors the repo's existing `tests/unit/…` units plus a CLI e2e with fake Pi
+ fake GitHub (the same harness as M1/M2/reconcile).

- **Domain/schema** — `ApplyReport` / `ApplyEntry` zod parsing for every
  `outcome` variant.
- **Staleness guard** — report older than `reportStaleAfterHours` rejects
  (exit 1); `--force` and config override work; disabled-window case applies.
- **Idempotent re-validation** — stored ENRICH already reflected, ADD whose
  target already depends, CREATE whose title already exists → all downgrade
  to `skipped` with the correct `skippedBy`; no GitHub write occurs.
- **Apply writes** — fake GitHub asserts exact `updateIssueBody` bodies
  (enrichment upsert, dependency line, epic linkback) and `createIssue`
  calls, in stable order.
- **Continue-on-error** — a fake port that throws on the 3rd patch → patches
  1-2 applied, 3 failed, 4-8 still attempted; summary counts correct; exit
  `2`; re-run resumes correctly.
- **Interactive prompt** — injected menu answers exercise `y`/`n`/`a`/`q`;
  applies the approving set; `requires-approval` never bulk-approved under
  `a`; `q` stops mid-batch; blank defaults to skip.
- **`--yes` / non-interactive** — auto-safe applied; `requires-approval`
  skipped; preview-only (zero writes) when no `--yes` in non-TTY.
- **CLI e2e** — `reconcile-apply <analysisId>` against a stored report:
  human summary, `--json` `ApplyReport`, and the durable apply-artifact
  written; redaction holds.
- **Audit artifact** — declined / skipped / failed entries recorded;
  declines are not fed back into any future `reconcile` (out of scope).

## 13. Acceptance criteria

`apply-safe` is complete when:

1. `autopilot reconcile-apply <analysisId>` loads a stored report and applies
   exactly the `auto-safe` patch types (`ENRICH_ISSUE`, `ADD_DEPENDENCY`,
   `CREATE_ISSUE`) with per-patch idempotent re-validation.
2. Interactive mode previews and prompts per patch; `y`/`n`/`a`/`q` each
   behave as specified §7.2; `requires-approval` requires explicit per-patch
   human approval and is skipped by `--yes`.
3. `CREATE_ISSUE` creates the issue and links it back into the epic checklist
   (idempotent); `ADD_DEPENDENCY` and `ENRICH_ISSUE` edit current-state
   bodies without clobbering concurrent human edits.
4. All three auto-safe types are re-validated against live state; already
   reflected proposals are skipped; the staleness guard blocks stale reports
   unless `--force`.
5. Continue-on-error: partial failures are reported per patch with exit `2`,
   and re-running resumes; unrecoverable errors exit `1`.
6. A durable apply-artifact is written per apply, recording per-patch
   outcomes including declines; `--json` emits the structured `ApplyReport`.
7. Declines are recorded but never fed back into a future `reconcile` (the
   reconciler-steering feature is explicitly deferred).
8. The full suite stays green (`npm run typecheck`, `npm test`,
   `npm run build`); the new modules and CLI command are covered per §12.

## 14. Assumptions and open questions (for the follow-on)

- **Declines do not steer proposals.** Deciding how a human's decline or
  `NEEDS_HUMAN` answers revise a *future* plan is a follow-on spec building on
  the audit artifact. Suggested first slice: feed recorded decline reasons to
  the next `reconcile` run's reconciler prompt (Tier 1 steering); structured
  Q&A convergence (Tier 2) after that.
- **Label policy for `CREATE_ISSUE`** is a fixed default (`task`) this
  milestone; a `labels` field on `IssueSpec` / config knob is future work.
- **`ADD_DEPENDENCY` renderer** writes via the dependency-marker grammar so
  downstream `BLOCKED`/screen logic recognizes the dependency. Exact line
  placement is a plan-level detail; the spec only guarantees it reuses the
  shared grammar and preserves all other body content.
- **Epic linkback ordering**: `CREATE_ISSUE` for a task whose epic is itself
  created in the same batch is out of scope (reconcile's CREATE_ISSUE targets
  an existing epic by ref). `chained` creation is not addressed.

## 15. Out of scope (deferred work list)

Repeated from §2 for the milestone board:

- Reconciler steering (declines → future proposals).
- `apply-all` (unattended `requires-approval`).
- `SPLIT_ISSUE`, `MERGE_DUPLICATE`, `REMOVE_DEPENDENCY`, `MARK_READY`.
- Label policy on `CREATE_ISSUE`.
- Concurrent/parallel patch application.
