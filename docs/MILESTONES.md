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
