# Resume a FAILED run at its last stage + fresh-restart flag

## Problem

A run that fails at a non-readiness stage today is permanently terminal:
`FAILED` has no legal outgoing transition, and `autopilot resume` only
accepts `BLOCKED` and always re-launches the implementer. So a run that
fails at `INDEPENDENT_REVIEW` — with implementation already present
(possibly uncommitted) in the preserved worktree, as with issue #179 —
cannot be continued. The only option is to run the issue again from
scratch, discarding the completed implementation work.

We want:
1. A way to **resume a FAILED run from the stage where it stopped**,
   reusing the preserved worktree's existing implementation instead of
   re-implementing it, and continuing with verification/review.
2. A **fresh-restart flag** on `run` that drops the existing worktree and
   run record for the issue and starts completely over.

## Current behavior constraints

- `FAILED` is a terminal stage (`state-machine.ts`): `FAILED: new Set()`,
  and `nextStage` rejects any `RESUME` event whose `from` is not `BLOCKED`.
- `RecoveryService.resume` and `RunService.resume` both gate on
  `run.stage === "BLOCKED"`.
- `RunAttempt.executeResume` always transitions to `IMPLEMENTATION` and
  runs `runImplementationLoop` with a fresh correction prompt — i.e. it
  re-runs the implementer.
- The run record persists the current stage and `task_snapshot_ref` but
  does **not** persist which non-terminal stage was active when the run
  failed.
- The preserved worktree holds the implementer's (possibly uncommitted)
  work; for #179 it contained `minerva/semantic/module.py`,
  `tests/semantic/test_module.py`, and edits to `tests/conftest.py`.

## Design (approach A1)

### 1. Persist the stage a FAILED run should resume from

- Add a nullable column to the `runs` table, e.g. `resume_at TEXT`.
- In `runFailClosed`, whenever the run is transitioned to `FAILED`, record
  the last reached non-terminal stage into `resume_at` (best-effort; the
  orphaning protection already ensures a non-terminal stage existed).

### 2. State machine: allow administrative resume out of FAILED

- Mirror the `BLOCKED` rule: `nextStage` accepts a `RESUME` event from
  `FAILED` into a legal non-terminal stage, but only through an explicit
  administrative `RESUME` — never automatic dispatch.
- `RunAttempt.executeResume` for a `FAILED` run uses the recorded
  `resume_at` stage rather than always starting at `IMPLEMENTATION`.

### 3. "Resume-at-stage" mode in `run`/`resume`

The resumed attempt **reuses the preserved worktree as-is** (including
uncommitted implementation) instead of re-running the implementer:

- Re-run **verification** on the existing worktree to confirm the
  implementation is sound.
- If verification passes, continue from the failed stage (e.g. a fresh
  reviewer session for `INDEPENDENT_REVIEW`).
- If verification fails, fall back to a fresh implementer correction
  (existing BLOCKED behavior).

### 4. Fresh-start flag on `run`

Add a flag to `autopilot run <issue>` that drops any existing worktree and
run record for that issue and starts clean from the base branch. This is
the escape hatch when repeated resumes are not converging.

## Open decisions

> All resolved and implemented in `feat/resume-failed-run` (Tasks 1-5).

- Resume destination semantics: re-run verification then the failing role
  (recommended) vs. retry only the failing role.
  **Resolved**: re-run verification then the failing role; verification
  failure falls back to the bounded implementer-correction loop.
- Fresh-restart flag name (e.g. `--fresh` / `--discard`).
  **Resolved**: `--fresh` on `run`, destructive with no confirmation
  prompt.
- Whether to keep the existing BLOCKED-only `resume` contract intact and
  add FAILED handling alongside it, or generalize.
  **Resolved**: keep the BLOCKED contract intact and add FAILED handling
  alongside it (BLOCKED always resumes the implementer; FAILED resumes at
  its recorded `resume_at` stage).
- Sequencing: immediate manual unblock of #179 vs. building the feature
  first.
  **Resolved**: build the feature first; #179 was then completed manually
  via the preserved worktree.
