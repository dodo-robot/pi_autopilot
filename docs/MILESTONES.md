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

## M3 — Autonomous backlog executor 🔲

**Scope:** Unattended loop over ready issues — auto-select, run, and
publish without human per-issue invocation.

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

## Backlog — missing features

Gap review of the repo against `docs/resources/requirements.md` and
`docs/resources/extend_requirements.md` as of 2026-08-22. Grouped by rough
priority; pick from the top.

### Reconciliation apply-safe follow-ups 🔲

- **Reconciler steering from apply results.** Declined/skipped apply
  decisions are recorded, but they do not yet feed the next reconciliation
  prompt or patch policy.
- **Apply-all workflow.** Interactive per-patch `all` exists inside one run,
  but there is no broader apply-all command/workflow for a report set.
- **Remaining patch types:** `SPLIT_ISSUE`, `MERGE_DUPLICATE`,
  `REMOVE_DEPENDENCY`, `MARK_READY` — documented in
  `src/domain/reconciliation.ts` as a future extension of the
  `BacklogPatch` union. (extend_requirements.md §"Structured patch model")
- **Label policy on `CREATE_ISSUE`.** Created issues currently use the
  minimal shipped label behavior; final label taxonomy is still deferred.
- **Concurrent application.** Apply-safe runs patches sequentially; concurrent
  application and conflict handling are deferred.
- **Oversized-task detection driving `SPLIT_ISSUE` proposals.**
  (extend_requirements.md §"Task size and splitting")

### Greenfield bootstrap (no existing backlog) 🔲

Not a violation of spec — `requirements.md` §3 explicitly says the system
must *not* assume it generates epics/tasks from scratch, and §23 routes
that path through Superpowers instead (`new requirement → Superpowers →
autonomous workflow`). But it's a real on-ramp gap worth tracking, and the
shape of the fix is settled:

- **No entry point for a zero-issue repo.** Every command (`check`,
  `prepare`, `run`, `analyze`, `reconcile`, and the planned `discover`)
  requires an existing issue or epic number. A developer with only a
  `requirements.md` and no GitHub issues has to leave this CLI entirely,
  run Superpowers by hand, and come back once a first epic exists.
- **Design direction: a new `bootstrap` command wrapping the
  `superpowers:brainstorming` skill** (the general-purpose skill, not this
  repo's own narrow `brainstormer` role — that one only asks clarifying
  questions about a single already-existing issue) with the explicit goal
  "produce an epic + issue breakdown from these requirements docs," rather
  than inventing a bespoke greenfield-planning prompt from scratch.
- **No new patch/spec types needed.** An "epic" here is already just a
  plain issue whose body is a Markdown checklist of `- #n` bullets
  (`isEpicBody`/`collectEpicIssueRefs` in `src/analysis/issue-set.ts`) — no
  separate GitHub entity to model. `bootstrap`'s output can reuse the
  `IssueSpec`/`CREATE_ISSUE` shapes already defined in
  `src/domain/reconciliation.ts`: one root `CREATE_ISSUE` with a
  checklist-body spec for the epic, one per child task with `epic` pointed
  at it. Should run dry-run-first, mirroring `analyze`/`reconcile`.
- **No GitHub issue/epic write capability at all.** `github-adapter.ts`
  has no `createIssue` method — so even once `apply-safe` lands, neither
  `bootstrap` nor reconciliation's `CREATE_ISSUE` patch has anywhere to
  write. This blocks bootstrap *and* the reconciliation apply-safe
  milestone above; implementing `createIssue` once unblocks both.

### Continuous backlog intake (M4) 🔲

Design settled via grilling session 2026-08-22; see [CONTEXT.md](../CONTEXT.md)
for vocabulary (Readiness, Claim, Analyze, Discover, Queue, Pending queue)
and [ADR-0001](adr/0001-best-effort-github-claim-marker.md) for the claim
mechanism's trade-offs. Deliberately deferred from M3 by
`m3-design.md` §9 — M3 itself ships as already scoped (immutable queue,
explicit list, no GitHub write-back); these three land together as M4 work,
not M3.

- **`agent:ready` GitHub marker.** A claim/mutex (`agent:ready` →
  `agent:in-progress`), not a re-derivable property — readiness itself is
  already computed locally by `analyze`. Written by a new `discover`
  command (the mutating sibling of read-only `analyze`); transitioned
  just-in-time by the daemon around each issue it executes, not for the
  whole queue upfront. Best-effort only — no distributed locking, no
  automatic stale-claim expiry. (requirements.md §6, §24)
- **Automatic issue selection without a prior `analyze` pass.** New
  `discover <ref> [moreRefs...]` command, mirroring `analyze`'s signature,
  scans and writes the `agent:ready` label — removing the need to run
  `analyze` before `start`. On-demand only (no background poll); fully
  decoupled from queue-append below — `discover` reports/labels, a human
  decides whether to queue anything. (requirements.md §4, §26)
- **Appending to a running queue.** A separate additions-only
  `queue-pending.json`, written by a new `queue add <issue>` command and
  drained by the daemon once per loop iteration, merged onto the queue's
  tail (FIFO, deduplicated). Keeps the daemon the sole writer of
  `queue.json`. `queue add` does no readiness validation, consistent with
  `start`'s existing explicit-list behavior. (M3 design §9)

### Concurrency and scheduling (M4) 🔲

- **Concurrent execution of independent issues.** Daemon is strictly
  sequential; explicitly deferred to M4 in the M3 design doc.
  (requirements.md §8, §13)
- **Workspace-conflict detection between parallel runs.** (requirements.md §8)
- **Dependency-graph-aware scheduling** that prefers work whose
  dependencies are satisfied, rather than a fixed queue order.
  (requirements.md §13)
- **Cross-queue budgets** — a total token/time/attempt cap spanning an
  entire `start` run, not just one issue. (requirements.md §15)

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
