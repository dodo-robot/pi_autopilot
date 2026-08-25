# Pi Autopilot — Milestone Progress

Design specs and implementation plans live in
`docs/superpowers/specs/` and `docs/superpowers/plans/`.

---

## M1 — Supervised task runner ✅

**Scope:** Run one issue at a time, started explicitly by a developer.

- `autopilot check` / `prepare` / `run` / `resume` / `abandon`
- Isolated Git worktree per run
- Refiner → Implementer → Verification → Reviewer pipeline
- Deterministic verification (configurable `commands.verify`)
- Guard extension (allowed commands, protected paths)
- Independent reviewer with correction-cycle budget
- PR publication (draft support, concise issue comment)
- SQLite state store with redacted `inspect` output
- Acceptance suite (`npm run test:e2e`) with fake-Pi scenario runner

**Non-goals (deliberately excluded from M1):**
- Automatic issue selection — a human always names one
- PR auto-merge (`publication.autoMerge` reserved)
- Closing or labelling source issues beyond the `prepare` section and one comment
- Background daemon / concurrent runs
- Dynamic model fallback after a failure
- Automatic replan (`NEEDS_REPLAN` → `BLOCKED`, requires human `resume`)

Design spec: `docs/superpowers/specs/2026-08-18-pi-autopilot-m1-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-18-pi-autopilot-m1-implementation.md`

---

## M2 — Read-only backlog analyst ✅

**Scope:** `autopilot analyze <ref>` scans an epic or explicit issue set
and records which tasks are ready to execute, without mutating GitHub.

Design spec: `docs/superpowers/specs/2026-08-20-pi-autopilot-m2-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-20-pi-autopilot-m2-implementation.md`

---

## Brainstormer role ✅

**Scope:** A pre-refinement `brainstorm` phase wired into `autopilot prepare`
to surface product ambiguity before the refiner drafts the execution contract.

Design spec: `docs/superpowers/specs/2026-08-21-brainstormer-role-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-21-brainstormer-role.md`

---

## Resume FAILED runs + `run --fresh` ✅

**Scope:** `autopilot resume` can continue a `FAILED` run by re-verifying
the existing implementation and retrying the interrupted role.
`autopilot run <issue> --fresh` discards the prior run and starts clean.

Design spec: `docs/superpowers/specs/2026-08-21-resume-failed-run-and-fresh-restart-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-21-resume-failed-run-and-fresh-restart.md`

---

## M3 — Autonomous backlog executor ✅

**Scope:** Unattended loop over ready issues — auto-select, run, and
publish without human per-issue invocation.

Delivered: `autopilot start` launches a detached sequential daemon from an
explicit issue list or a repository-matching analyze report, `stop` requests
clean stage-boundary shutdown, `status` shows daemon progress and current run
stage, and crash startup auto-resumes interrupted runs before continuing the
queue. Queue outcomes are persisted in `queue.json`; role overrides and
refiner timeout are carried from `start` into daemon-run `RunService` calls.

Design spec: `docs/superpowers/specs/2026-08-21-pi-autopilot-m3-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-21-pi-autopilot-m3.md`

---

## Backlog reconciliation ✅

**Scope:** `autopilot reconcile <epic>` compares an epic's existing GitHub
issues against requirement/architecture docs and the repository, and
proposes a structured patch plan (`KEEP`/`ENRICH_ISSUE`/`CREATE_ISSUE`/
`ADD_DEPENDENCY`/`MARK_STALE`/`NEEDS_HUMAN`) plus a requirement coverage
map. Always dry-run — no GitHub mutation in this milestone. A new
`reconciler` Pi role reuses the existing `PiRunner` validation gate;
deterministic idempotency and patch-policy classification (`auto-safe` /
`requires-approval`) are pure and separately tested, never left to the LLM.

Design spec: `docs/superpowers/specs/2026-08-22-backlog-reconciliation-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-22-backlog-reconciliation.md`

---

## 2026-08-23 — Reconciliation apply-safe mode ✅

**Scope:** `autopilot reconcile-apply <analysisId>` loads a stored
reconciliation report and applies only deterministic `auto-safe` GitHub
patches, while keeping ambiguous or policy-sensitive changes human-gated.

- `reconcile-apply` command wired into the CLI with human and `--json`
  output, `--yes` unattended mode, and `--force` staleness override.
- `ApplyService` apply pipeline loads durable reconciliation artifacts,
  partitions auto-safe vs requires-approval patches, revalidates fresh
  GitHub state before each write, and continues after per-patch failures.
- Staleness guard defaults to 168 hours and is configurable via
  `reconciliation.reportStaleAfterHours`; negative values disable it.
- Non-TTY runs without `--yes` are preview-only and perform zero writes.
- Auto-safe writes shipped for `CREATE_ISSUE`, `ENRICH_ISSUE`, and
  `ADD_DEPENDENCY`; `MARK_STALE` and `NEEDS_HUMAN` remain skipped as
  requires-approval.
- Each run writes a durable `reconciliation-apply.json` artifact alongside
  the source analysis artifacts.

Design spec: `docs/superpowers/specs/2026-08-23-reconcile-apply-safe-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-23-reconcile-apply-safe.md`

---

## 2026-08-24 — `REMOVE_DEPENDENCY` wired into `ApplyService` ✅

**Scope:** Fixed the pre-existing `ApplyService.apply()` gate that
unconditionally skipped every `requires-approval` patch before `prepare()`
ever ran, so `REMOVE_DEPENDENCY` — always `requires-approval` — can now be
applied through `reconcile-apply` via explicit interactive confirmation,
while `MARK_STALE`/`NEEDS_HUMAN` remain hard-skipped.

- New `OFFERABLE_REQUIRES_APPROVAL` set in `apply-service.ts` distinguishes
  "requires-approval but still offerable via interactive confirmation"
  (`REMOVE_DEPENDENCY`) from "requires-approval and never offered"
  (`MARK_STALE`, `NEEDS_HUMAN`) — an `ApplyService`-local concept; the
  shared `PatchPolicy` type is unchanged (`REMOVE_DEPENDENCY` stays
  `requires-approval`).
- `REMOVE_DEPENDENCY` is never auto-applied under `--yes`, and a prior
  `"all"` interactive answer never fast-forwards it — it always stops for
  its own individual confirmation.
- `prepareRemoveDependency`/`applyRemoveDependencyFresh` mirror
  `prepareDependency`/`applyDependencyFresh`: re-fetch the issue fresh,
  re-check the managed-form dependency line is still present against
  current state, skip idempotently if already gone, otherwise write via
  `removeManagedDependencyFromBody`.
- `previewOnly` renders the `REMOVE_DEPENDENCY` diff like every other
  offerable/auto-safe write, without mutating GitHub.
- Apply ordering: `REMOVE_DEPENDENCY` sorts after `ADD_DEPENDENCY` (build
  up the dependency graph, then prune it) in `sortPatches`.

---

## 2026-08-24 — MERGE_DUPLICATE reconciliation patch ✅

**Scope:** Final patch type in the "Structured patch model" backlog item — the reconciler can now propose closing a duplicate issue in favor of a survivor.

- `MERGE_DUPLICATE` schema variant, patch policy (`requires-approval`, `OFFERABLE_REQUIRES_APPROVAL`), idempotency downgrade (closed-state check), prompt rule + example, preview renderer, and full `ApplyService` wiring (comment + close via the new `GitHubPort.closeIssue` primitive).
- Rewriting the duplicate's existing dependents and its epic checklist line are explicitly out of scope, deferred to a human or future reconciliation pass — matching `SPLIT_ISSUE`'s precedent.
- This closes the "Structured patch model" backlog item in full. `MARK_READY` remains permanently excluded (see the 2026-08-24 `REMOVE_DEPENDENCY` design spec §6).

Design spec: `docs/superpowers/specs/2026-08-24-merge-duplicate-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-24-merge-duplicate.md`

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

---

## 2026-08-23 — Continuous backlog intake ✅

**Scope:** Mutating counterpart to `analyze` and queue-append mechanism for the daemon.

- `autopilot discover <ref> [moreRefs...]` — mutating sibling of `analyze`; reconciles the `agent:ready` label to match computed readiness; never touches `agent:in-progress`.
- `autopilot queue add <issue...>` — appends issues to a running daemon's queue via a new atomically-written `queue-pending.json`.
- Daemon just-in-time claim (`agent:in-progress`) before each run and outcome-dependent release (cleared on success, left in place on BLOCKED/FAILED as a "needs a human" signal, both labels cleared on NEEDS_REFINEMENT).
- All label writes on the daemon and `discover` paths are best-effort — never block a run or change an exit code.

Design spec: `docs/superpowers/specs/2026-08-23-continuous-backlog-intake-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-23-continuous-backlog-intake.md`

---

## Greenfield bootstrap ✅

**Scope:** `autopilot bootstrap` wraps the `superpowers:brainstorming` skill to
turn requirements docs into an epic + issue breakdown for a zero-issue repo,
then writes the plan to GitHub.

- `--plan` phase: bootstrapper Pi session reads requirements docs and
  proposes an epic/task breakdown, with a size checker that bin-packs
  oversized tasks into split proposals and a config proposer for a starter
  `autopilot.yaml`. Plan is rendered to Markdown (Mermaid dependency graph +
  wave table) and stored via `PlanStore`.
- `--apply` phase: `ApplyService` writes the stored plan to GitHub via the
  now-implemented `GitHubPort.createIssue`, idempotently (checked against
  existing issues before creating).
- `GitHubPort.createIssue` / `GitHubAdapter.createIssue` — implemented and
  shared by both the bootstrap apply path and reconciliation's `CREATE_ISSUE`
  apply-safe patch.

---

## 2026-08-24 — M4 dependency-aware scheduler ✅

**Scope:** Bounded-concurrency daemon scheduling over explicit issue inputs or analyze/discover reports.

- `scheduler.maxConcurrentRuns` plus `start --max-concurrent` control daemon concurrency; default remains `1`.
- Scheduler state is persisted in `queue.json` while preserving M3 queue fields.
- Dependencies are satisfied by GitHub-closed issues or local `PR_OPEN` history.
- Path/glob workspace scopes prevent concurrent conflicting runs; unknown scope conflicts with everything.
- Cross-queue elapsed/started/failed budgets stop new starts at scheduling boundaries without interrupting active runs.
- `status` shows scheduler summary and per-issue state in human and JSON modes.

Design spec: `docs/superpowers/specs/2026-08-24-m4-dependency-aware-scheduler-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-24-m4-dependency-aware-scheduler.md`

---

## 2026-08-25 — `NEEDS_HUMAN` answered interactively, with a recommendation default ✅

**Scope:** `NEEDS_HUMAN` was previously always hard-skipped — its questions
were generated but never reached the operator except by reading the raw
reconciliation report. It is now offerable through `reconcile-apply` (added
to `OFFERABLE_REQUIRES_APPROVAL`), with its own per-question interaction
instead of the generic `[y/n/a/q]` menu.

- `BacklogPatchSchema`'s `NEEDS_HUMAN.questions` changed from `string[]` to
  `{ question, recommendation }[]` — the reconciler prompt now requires a
  recommendation for every question it raises. Breaking change: stored
  reports from before this change no longer validate; re-run `reconcile`.
- New `askQuestion` in `apply-preview.ts` prompts per question and shows the
  recommendation as the default; blank input accepts it, any other input
  overrides it. There is no skip state — every question always gets an
  answer.
- When the patch has a target issue, `ApplyService` posts one comment with
  every Q/A pair (marking each as "(recommendation accepted)" or
  "(override)") and records the patch as `applied`.
- `NEEDS_HUMAN` with `issue: null` (epic/requirement-level ambiguity) still
  hard-skips — there is no comment target to write to.
- Never auto-applied under `--yes` (unattended has no one to answer) or a
  prior `"all"` interactive answer — always stops for its own questions.
- Preview-only mode (non-TTY without `--yes`) shows the questions and
  recommendations without prompting or writing, like every other offerable
  write.

---

## 2026-08-25 — Reconciler steering from apply results (Tier 1) ✅

**Scope:** Feed human-declined apply patches (`skippedBy: "user"` in
`reconciliation-apply.json`) back into the next `reconcile <epic>` run's
reconciler prompt, so the model stops re-proposing patches a human already
declined.

- **Per-epic apply index.** `ApplyService.apply()` writes a stable
  latest-apply pointer per epic (`runs/_latest/<owner>/<repo>/apply-epic-<N>.json`)
  via new `ArtifactStore.writeLatestApply`/`readLatestApply`, mirroring the
  readiness-pointer mechanism — no directory scan.
- **Steering signal.** A pure `extractDeclines()` helper plus a `DeclinedPatch`
  type reduce an apply report to its human-declined patches; every other
  outcome (`requires-approval` gate, idempotent, `failed`, applied,
  `NEEDS_HUMAN` answers) is explicitly excluded.
- **Prompt contract.** `buildReconcilerPrompt` gained an optional
  `applySteering` input that renders an "Apply steering context" section
  (styled like the existing prior-REQ-ID section) and a Rules line. The rule
  and section are conditional: a first-run reconcile with no declines renders
  a byte-identical prompt.
- **Reconcile wiring.** `ReconciliationService.reconcile()` reads the per-epic
  pointer, loads the referenced apply report, extracts declines, and passes
  them to the prompt.
- **Index integrity.** The pointer is only repointed by runs that record durable
  human decisions — preview-only runs and aborted (`q`) runs no longer
  overwrite the index, so a later reconcile does not silently lose prior
  steering.
- Command-level integration test drives the real `reconcile-apply` command and
  asserts the pointer round-trips, closing the apply→reconcile loop.

Deferred: free-text `declineReason` capture (the `reason` field is plumbed but
no writer populates it), and single-slot pointer retention (declines from
apply N-2 are forgotten once apply N-1 lands). Both documented in the design
spec §12.

Design spec: `docs/superpowers/specs/2026-08-25-reconciler-steering-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-25-reconciler-steering.md`

---

## 2026-08-25 — Minimal label policy for reconciliation-created issues

`CREATE_ISSUE` now has an explicit minimal label policy. Final backlog label
taxonomy remains deferred: reconciliation-created backlog work items receive
only the structural `task` label, and an existing issue reused by title is
linked to the epic without being relabeled. The reconciler does not infer labels
from requirements, patch metadata, source documents, readiness, or epic context.

Operational labels stay owned by their lifecycle paths: `agent:ready` and
`agent:in-progress` belong to `discover`/daemon claim-release, while `split`
marks a split parent as a tracking checklist rather than runnable task work.
`reconcile apply` now ensures the labels it creates or applies exist first:
`task` for `CREATE_ISSUE` and split children, and `split` before marking the
split parent.

Deferred: the final label taxonomy and any configurable repository-specific
label policy.

---

## Backlog — missing features

Gap review of the repo against `docs/resources/requirements.md` and
`docs/resources/extend_requirements.md` (as of 2026-08-25). Grouped by rough
priority; pick from the top.

### Reconciliation apply-safe follow-ups 🔲

- **Apply-all workflow.** Interactive per-patch `all` exists inside one run,
  but there is no broader apply-all command/workflow for a report set.
- **Concurrent application.** Apply-safe runs patches sequentially; concurrent
  application and conflict handling are deferred.

_(Removed from this list as of 2026-08-25: **reconciler steering from apply
results (Tier 1)** — now shipped; see its section above.)_

### Merge governance (M5) 🔲

- **Automatic merge.** `publication.autoMerge` is a reserved config field,
  unenforced everywhere in the pipeline. (requirements.md §18)

### Observability (M5) 🔲

- **Epic-tree progress view** — a dashboard-style rollup like the example
  in requirements.md §25 (`✓ #101 ... ● #103 ... IMPLEMENTING`). Today
  `status`/`inspect` only cover one run at a time.

### Smaller/design-level gaps

- **Dedicated verifier role.** Verification is deterministic (shell
  commands) rather than an independent LLM verifier session distinct from
  the Reviewer — allowed under "MAY combine roles" (requirements.md §9),
  but acceptance-criteria interpretation still rides on the Reviewer alone.
- **Broader plan-evolution detection.** `MARK_STALE` covers this within
  reconciliation; there's no general "replan affected future work"
  mechanism outside that flow. (requirements.md §20)
