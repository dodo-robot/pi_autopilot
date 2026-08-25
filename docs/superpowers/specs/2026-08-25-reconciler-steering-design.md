# Reconciler Steering from Apply Results — Design

Status: Proposed (brainstormed; ready for review)

Date: 2026-08-25

## 1. Purpose

`autopilot reconcile <epic>` proposes a backlog patch plan; `reconcile-apply`
applies the safe subset. When a human **declines** a proposed patch during
`reconcile-apply` (or answers `n` in interactive mode), that outcome is
recorded in the durable `reconciliation-apply.json` artifact (an `ApplyEntry`
with `outcome.status === "skipped"` and `skippedBy: "user"`, optionally with a
`declineReason`). Today those declines are recorded but never read again — the
next `reconcile` run re-proposes the same rejected patches, and the human has
to decline them again.

This spec adds Tier 1 steering: the next `reconcile <epic>` run loads the
relevant apply declines and feeds them into the reconciler prompt, so the
model stops re-proposing a patch a human already declined (or re-justifies it
explicitly if circumstances changed). It is the "suggested first slice"
named by the apply-safe design spec (§14): *"feed recorded decline reasons to
the next `reconcile` run's reconciler prompt (Tier 1 steering)"*.

## 2. Scope

**In scope:**

- A durable **per-epic apply index** so a `reconcile <epic>` run can discover
  the apply report(s) for that epic without scanning the runs directory.
- Loading declines (`skippedBy: "user"`) from the latest apply report for an
  epic and passing them to the reconciler prompt as a structured
  "Apply steering context" section.
- A prompt rule telling the reconciler not to re-propose a declined patch
  unchanged.
- A pure, unit-tested `extractDeclines` helper and a `DeclinedPatch` domain
  type.

**Out of scope (deferred):**

- **Tier 2 steering** — structured Q&A convergence from `NEEDS_HUMAN`
  answers. The (now idempotent) `NEEDS_HUMAN_ANSWER_MARKER` comment is a
  clean read-back signal a future Tier-2 design can use, but Tier 1 does not
  consume comments at all.
- Feeding `skippedBy: "requires-approval"` or `failed` outcomes as steering
  (see §3).
- Auto-deciding what the reconciler *does* with a decline — it can re-propose,
  `KEEP`, or alternate, but the choice stays with the model, bounded only by
  the prompt rule.
- A general apply-artifact search / discovery CLI beyond the per-epic index.
- Daemon/queue integration.

## 3. The steering signal

`ApplyEntry.outcome` carries several distinguishable outcomes. Only one is a
human rejection:

| Outcome | Steering value | Why |
|---|---|---|
| `skipped / skippedBy: "user"` | **Yes — a decline** | The human explicitly rejected the patch (optionally with `declineReason`). |
| `skipped / skippedBy: "requires-approval"` | No | A gate, not a judgment; the human never saw or decided on the patch. |
| `skipped / skippedBy: "idempotent"` | No | Already satisfied by live state. |
| `skipped / skippedBy: "failed-to-fetch"` | No | A transient fetch problem, not a rejection. |
| `failed` | No | The write errored; the patch is still wanted. |
| `applied` | No | The patch landed; nothing to steer. |

`extractDeclines` filters to the first row and trims each decline to a
steering directive: `{ patchType, targetIssue, reason? }`. Entries whose
`targetIssue` is `null` are dropped defensively — a user-skip entry has no
issue to anchor the instruction to, and Tier 1 only steers on concrete
issue-level patches.

## 4. Discovery — the per-epic apply index

A `reconcile <epic>` run generates a fresh `analysisId`
(`reconcile-<ts>-<epic>`), so it cannot derive the relevant apply report from
its own id. To discover declines for epic `N`, `reconcile` must find apply
reports whose source report was for epic `N`.

**Approach (Option 3 chosen):** a stable per-epic pointer, replaced on every
apply, mirroring the existing `runs/_latest/<owner>/<repo>/<n>.json`
readiness-pointer mechanism (`issuePointerPath` / `writeLatestReadiness`).
Each apply writes one more artifact alongside `reconciliation-apply.json`:
`runs/_latest/<owner>/<repo>/apply-epic-<epic>.json` (or an equivalently
namespaced row under `_latest`), containing:

```ts
interface LatestApply {
  analysisId: string;     // analysisId of the reconcile report this apply consumed
  epicRef: number;
  repository: { owner: string; repo: string };
  appliedAt: string;
}
```

- `ApplyService.apply()` already has `report.epicRef` in hand at artifact-write
  time (`apply` loads the report at the top), so the index write piggybacks on
  the existing tail of `apply()`, next to the `writeJson(APPLY_ARTIFACT, …)`
  call.
- `ArtifactStore` gains `writeLatestApply(owner, repo, epicNumber, data)` and
  `readLatestApply(owner, repo, epicNumber)`, following the exact tmp+rename
  atomic-write and tolerant-read-null pattern of `writeLatestReadiness` /
  `readLatestReadiness`. The pointer points at the **most recent** apply for
  the epic (replace, not append).

No directory scan. `ReconciliationService.reconcile()` reads the pointer (one
`readLatestApply`), and only when present loads that one
`reconciliation-apply.json` via the existing `readJson`.

## 5. Type & extraction

New pure pieces in the `reconciliation` domain:

```ts
// src/domain/reconciliation.ts (or apply.ts — see §9)
interface DeclinedPatch {
  patchType: BacklogPatchType;
  targetIssue: number;
  reason?: string;   // the human's declineReason when provided
}
```

```ts
// src/reconciliation/steering.ts (pure helper)
function extractDeclines(applyReport: ApplyReport): DeclinedPatch[];
```

`extractDeclines` maps every `entries` item with
`outcome.status === "skipped" && outcome.skippedBy === "user"` and
`targetIssue !== null` into a `DeclinedPatch`, copying `outcome-adjacent`
`declineReason` into `reason` when set. It never touches GitHub and never
reads beyond the in-memory `ApplyReport`.

## 6. Prompt contract

`ReconcilerPromptInput` gains an optional field:

```ts
export interface ReconcilerPromptInput {
  repository: RepositoryRef;
  epic: GitHubIssue;
  issues: GitHubIssue[];
  requirementDocs: RequirementDoc[];
  priorReport?: { coverage: Array<{ requirementId: string; description: string }> };
  /** Declined patches from a prior reconcile-apply of this epic. */
  applySteering?: DeclinedPatch[];
}
```

`buildReconcilerPrompt` renders an **Apply steering context** section when
`applySteering` is non-empty, as its own block immediately after the
"Epic issues" list, styled exactly like the existing `priorReport` section:

```
Apply steering context
-----------------------
A prior reconcile-apply of this epic proposed patches that a human declined during apply. Do not re-propose a declined patch as-is; either KEEP the issue, propose a different patch, or — only if something has genuinely changed — propose the same patch again AND justify in its "reason" why the earlier decline no longer applies.
- ENRICH_ISSUE #7: "waiting on product decision"
- ADD_DEPENDENCY #8 -> #3: "not a hard ordering constraint"
```

And a new line is appended to the prompt's **Rules** block stating the same
behavior concisely (declined patches must not be re-proposed unchanged unless
re-justified). This is a prompt-only guideline — the model's output is still
validated by `ReconcilerResultSchema`; steering does not loosen or tighten the
schema.

`applySteering` is purely additive to the prompt. A missing/empty value renders
no section and changes nothing about a first-run reconcile.

## 7. Wiring

### 7.1 `ApplyService` — write the index

In `apply()`, after the existing `writeJson(analysisId, APPLY_ARTIFACT, result)`,
add:

```ts
await this.deps.artifacts.writeLatestApply(
  report.repository.owner,
  report.repository.repo,
  report.epicRef,
  { analysisId, epicRef: report.epicRef, repository: report.repository, appliedAt: this.now() },
);
```

`report.epicRef` and `report.repository` are already fields of the loaded
`ReconciliationReport`. The apply service needs no new dependency.

### 7.2 `ReconciliationService` — load steering

In `reconcile()`, before `buildReconcilerPrompt`, add (read-only):

```ts
const latestApply = await this.deps.artifacts.readLatestApply(owner, repo, epicRef);
let applySteering: DeclinedPatch[] | undefined;
if (latestApply !== null) {
  const applyReport = await this.deps.artifacts.readJson<ApplyReport>(
    latestApply.analysisId,
    APPLY_ARTIFACT,
  );
  applySteering = extractDeclines(applyReport);
}
```

`reconcile` is already strictly read-only against GitHub; these two reads add
only local artifact reads. A missing pointer or a present-but-empty decline set
both yield `applySteering === undefined` (or `[]`), and the prompt is built
without a steering section. The apply-report artifact name is the existing
`APPLY_ARTIFACT` export from `apply-service.ts` (which `reconciliation-service`
imports) — not another locally-duplicated string constant.

## 8. Testing

Mirrors the repo's unit conventions and the fake-GitHub/fake-store harness.
The `ExtractDeclines` and index plumbing are pure/`ArtifactStore`-bound, so no
LLM is involved in the tests.

- **`extractDeclines` (pure)** — includes every `skippedBy: "user"` entry with
  a target; copies `declineReason` into `reason`; excludes
  `requires-approval`, `idempotent`, `failed-to-fetch`, `failed`, and `applied`;
  drops `targetIssue: null`.
- **`artifact-store`** — `writeLatestApply`/`readLatestApply` round-trip;
  replaces the prior pointer for the same epic; tolerant read returns `null`
  on missing/corrupt.
- **`apply-service`** — asserting the index is written on every apply, with
  the correct `epicRef`, using a fake `ArtifactStore` that records
  `writeLatestApply` calls.
- **`reconciliation-service`** — with a fake store, steering is loaded and
  passed to the prompt when a pointer + declining apply report exist; the
  prompt is built without steering when the pointer is absent or the apply has
  no user-skips.
- **`prompt`** — rendering of the steering section (present when
  `applySteering` non-empty, absent otherwise) and the new Rules line.
- **`reconcile-apply` → reconcile CLI e2e** — after a scripted interactive
  apply that declines a patch, a subsequent `reconcile` run's prompt (via the
  fake-Pi harness capturing the prompt) contains the decline context.

## 9. Module layout

- `src/domain/apply.ts` — add `DeclinedPatch` (or extend
  `src/domain/reconciliation.ts`; `apply.ts` is the closer fit since it owns
  the `ApplyReport` shape the helper reads from).
- `src/reconciliation/steering.ts` — `extractDeclines` (new, pure).
- `src/persistence/artifact-store.ts` — `writeLatestApply` / `readLatestApply`
  (mirror the readiness pointer methods).
- `src/reconciliation/prompt.ts` — `applySteering` input + section + rule.
- `src/reconciliation/apply-service.ts` — one index write in `apply()`.
- `src/reconciliation/reconciliation-service.ts` — load steering before
  building the prompt.

No new `GitHubPort` methods: steering reads only local artifacts and never
calls GitHub.

## 10. Error handling

| Scenario | Behavior |
|---|---|
| Pointing apply report missing/empty after a pointer is present | Steering skipped; reconcile proceeds without it (best-effort, never blocks reconcile) |
| Corrupt `reconciliation-apply.json` for the pointed analysisId | `readJson` throws → reconcile fails with the underlying parse error (a corrupt artifact is a hard error, consistent with other artifact reads) |
| No pointer / no user-skips | No steering; prompt built exactly as today |
| `extractDeclines` sees an unexpected shape | Pure function; a defensive filter keeps only well-formed user-skip entries |

## 11. Acceptance criteria

Tier 1 steering is complete when:

1. Every `reconcile-apply` writes the per-epic apply index (one pointer per
   epic, replaced on each apply) without a directory scan.
2. A `reconcile <epic>` run loads declines (`skippedBy: "user"`) from the
   latest apply for that epic and includes them in the reconciler prompt as an
   "Apply steering context" section.
3. The prompt's Rules block states that declined patches must not be
   re-proposed unchanged unless re-justified.
4. `extractDeclines` returns exactly the user-decline set (excluding all other
   outcomes) and is pure (no GitHub, no I/O).
5. None of `requires-approval` skips, `failed` entries, or `NEEDS_HUMAN`
   answers steer the reconciler (deferred to Tier 2 / not steering).
6. First runs and runs with no declines produce a prompt identical to today
   (no steering section).
7. The full suite stays green (`npm run typecheck`, `npm test`,
   `npm run build`); the new modules are covered per §8.

## 12. Out of scope (deferred work list)

- Tier 2: `NEEDS_HUMAN` Q&A convergence / comment read-back (the idempotent
  `NEEDS_HUMAN_ANSWER_MARKER` comment is ready to serve it later).
- Steering on `requires-approval` gates or `failed` writes.
- Auto-resolution of a decline (the choice stays with the reconciler model).
- A general apply-artifact search/discovery CLI.
