# Resume a FAILED run at its last stage + fresh-restart flag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `autopilot resume <run-id>` continue a `FAILED` run from the stage it stopped at — reusing the preserved worktree's existing implementation instead of re-implementing — and add a `--fresh` flag to `autopilot run` that discards the existing worktree/run and restarts clean.

**Architecture:** Persist the last non-terminal stage (`resume_at`) on a run when it fails; extend the state machine so an explicit administrative `RESUME` is legal out of `FAILED` (mirroring `BLOCKED`); generalize `executeResume` into a "resume-at-stage" path that re-verifies the existing worktree and continues from the failed role rather than re-running the implementer; add `--fresh` to the `run` command to drop the prior run record + worktree.

**Tech Stack:** TypeScript (Node), SQLite (`better-sqlite3` via `RunStore`), commander CLI, vitest.

**Spec:** [docs/superpowers/specs/2026-08-21-resume-failed-run-and-fresh-restart-design.md](../specs/2026-08-21-resume-failed-run-and-fresh-restart-design.md)

## Global Constraints

- The legal-transition map lives in `src/workflow/state-machine.ts`; `FAILED` and `BLOCKED` are terminal stages in `src/persistence/run-store.ts` (`TERMINAL_STAGE_SQL`).
- `RESUME` is the sole administrative exit from a quiescent/terminal stage and must never be reachable by automatic event dispatch.
- A `FAILED` run's preserved worktree may contain **uncommitted** implementation; resume must never `git reset --hard` or discard it except under the explicit `--fresh` path.
- Every production change must have a failing test first (TDD). Run the full suite (`npx vitest run`) plus `npx tsc --noEmit` after each task.
- The `resume` command's existing `BLOCKED`-only contract must keep working and stay tested.

---

### Task 1: Persist `resume_at` on the run record

Persist which non-terminal stage a run was in when it transitioned to `FAILED`, so a later resume knows where to re-enter.

**Files:**
- Modify: `src/persistence/run-store.ts` (schema `CREATE TABLE`, `migrate`, `RunRow`, `mapRunRow`, `RunRecord`, `CreateRunInput`, `transition`)
- Modify: `src/workflow/run-service.ts` — `runFailClosed` (writes `resume_at` on `FAILED`)
- Test: `tests/integration/persistence/run-store.test.ts`

**Interfaces:**
- Consumes: `RunRecord` (existing); `runStore.transition(runId, from, to, evidenceRef)` (existing).
- Produces: `RunRecord.resumeAt: RunStage | null`; `TransitionUpdate`/`setRunResumeAt(runId, stage)` style method on `RunStore`; a private `RunAttempt.currentStage` accessor or reuse `this.stage` for the "stage failed from".

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/persistence/run-store.test.ts`:

```ts
it("persists resume_at for a FAILED transition", () => {
  const store = new RunStore(inMemoryDb());
  const run = store.createRun({ repository, issueNumber: 1 });
  store.transition(run.id, "PREFLIGHT", "INDEPENDENT_REVIEW", null);
  store.transition(run.id, "INDEPENDENT_REVIEW", "FAILED", null, { resumeAt: "INDEPENDENT_REVIEW" });
  const reloaded = store.getRun(run.id)!;
  expect(reloaded.resumeAt).toBe("INDEPENDENT_REVIEW");
});
```

(The helper `inMemoryDb()` already exists in the persistence test file; follow its existing pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/persistence/run-store.test.ts -t "persists resume_at"`
Expected: FAIL — `RunRecord` has no `resumeAt` property / column missing.

- [ ] **Step 3: Implement resume_at persistence**

- Add column to the `runs` `CREATE TABLE` in `migrate()`: `` `resume_at TEXT, `` (after `task_snapshot_ref`).
- Add `resume_at TEXT` to `RunRow`; add `resume_at: string | null` to `mapRunRow`? Return typed `resumeAt`.
- Add `resumeAt: RunStage | null` to `RunRecord` (import `RunStageSchema`), parse with `row.resume_at === null ? null : RunStageSchema.parse(row.resume_at)`.
- Add an optional `resumeAt?: RunStage | null` to `CreateRunInput` and map into `CREATE`/`INSERT` (default null).
- Add a method to `RunStore`:

```ts
setRunResumeAt(runId: string, stage: RunStage): void {
  this.db.prepare(
    `UPDATE runs SET resume_at = ?, updated_at = ? WHERE id = ?`,
  ).run(stage, new Date().toISOString(), runId);
}
```

- Extend the existing `transition(runId, from, to, evidenceRef, opts?)` signature with an optional `opts?: { resumeAt?: RunStage }` — when `to === "FAILED"` and `opts.resumeAt` given, also `setRunResumeAt`. Keep the signature backward-compatible (existing callers pass no 5th arg).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/persistence/run-store.test.ts`
Expected: PASS

- [ ] **Step 5: In `runFailClosed`, write resume_at for FAILED**

In `src/workflow/run-service.ts`, `runFailClosed` (currently at ~line 460):

```ts
private async runFailClosed(body: () => Promise<RunSummary>): Promise<RunSummary> {
  try {
    return await body();
  } catch (error) {
    this.deps.runStore.transition(this.runId, this.stage, "FAILED", null, {
      resumeAt: this.stage,
    });
    if (error instanceof PiRunError) {
      return this.summary({ reason: error.message });
    }
    throw error;
  }
}
```

- [ ] **Step 6: Run tests + typecheck, commit**

Run: `npx vitest run tests/integration/persistence/run-store.test.ts tests/integration/workflow/run-service.test.ts src 2>/dev/null | tail -5; npx tsc --noEmit`
Expected: PASS, no TS errors.

```bash
git add src/persistence/run-store.ts src/workflow/run-service.ts tests/integration/persistence/run-store.test.ts
git commit -m "feat(run): record resume_at stage on FAILED runs"
```

---

### Task 2: State machine — allow administrative RESUME out of FAILED

Make `RESUME` legal from `FAILED` (and `BLOCKED`), resolving to a non-terminal stage, operator-only.

**Files:**
- Modify: `src/workflow/state-machine.ts` (`nextStage` `RESUME` branch, `RESUME` event type)
- Test: `tests/unit/workflow/state-machine.test.ts`

**Interfaces:**
- Consumes: existing `RunStage` union, `RESUME` event (`resumeTo: "IMPLEMENTATION" | "CORRECTION"`).
- Produces: `RESUME` accepted from `from === BLOCKED` **or** `from === FAILED`; returns `event.resumeTo`. For a `FAILED` run, `resumeTo` is validated to a stage the resumed path can enter.

- [ ] **Step 1: Write the failing test**

```ts
it("allows RESUME from FAILED into a non-terminal stage", () => {
  expect(nextStage({ type: "RESUME", resumeTo: "INDEPENDENT_REVIEW" }, "FAILED"))
    .toBe("INDEPENDENT_REVIEW");
});
```

(Verify the existing `nextStage` signature by reading the top of `state-machine.ts`; match its argument order and `RunStage` type.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/workflow/state-machine.test.ts -t "allows RESUME from FAILED"`
Expected: FAIL — RESUME throws for non-BLOCKED.

- [ ] **Step 3: Implement RESUME from FAILED**

In `nextStage`, change the guard so `RESUME` is accepted when `from === BLOCKED` **or** `from === FAILED`:

```ts
if (event.type === "RESUME") {
  if (from !== BLOCKED_STAGE && from !== "FAILED") {
    throw new Error(`illegal transition: ${from} -> ${event.resumeTo} (RESUME only applies from BLOCKED or FAILED)`);
  }
  return event.resumeTo;
}
```

Keep the `FAILED: new Set()` TRANSITIONS entry unchanged (RESUME is handled in the dedicated branch, not the table). Update the `RESUME` event type doc if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/workflow/state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workflow/state-machine.ts tests/unit/workflow/state-machine.test.ts
git commit -m "feat(state): allow administrative RESUME out of FAILED"
```

---

### Task 3: Generalize `RunService.resume` to accept FAILED and route to resume-at-stage

`RunService.resume` (currently `BLOCKED`-only) accepts `FAILED` too, reads `resumeAt`, and dispatches to a new stage-aware resume entry point.

**Files:**
- Modify: `src/workflow/run-service.ts` — `RunService.resume` (~line 217)
- Modify: `src/workflow/recovery-service.ts` — `resume` (`~line 150`) gate
- Test: `tests/integration/workflow/recovery-service.test.ts`, `tests/integration/workflow/run-service.test.ts`

**Interfaces:**
- Consumes: `RunRecord.resumeAt` (Task 1); `nextStage` RESUME-from-FAILED (Task 2).
- Produces: `RunAttempt.executeResume(snapshot, workspace, resumeTo: RunStage)` — signature gains a `resumeTo` argument (Task 4 implements its branches).

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/workflow/run-service.test.ts`:

```ts
it("allows resume of a FAILED run and routes to its recorded stage", async () => {
  // Build a run that reached INDEPENDENT_REVIEW then FAILED (reuse existing
  // run-service integration helpers). Then call service.resume(runId) and
  // assert it does NOT launch an implementer (no implementer attempt
  // recorded) and instead runs verification + review.
});
```

Use the existing run-service test fixture helpers (`taskSnapshotRefiner`, `implementerCompleted`, `reviewerApproved`, the `makeHarness` style) to set up a FAILED run whose `resumeAt` is `INDEPENDENT_REVIEW`. Match the existing harness API in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts -t "allows resume of a FAILED"`
Expected: FAIL — `resume` throws `stage is FAILED, not BLOCKED`.

- [ ] **Step 3: Update recovery-service resume gate**

In `recovery-service.ts` `resume`, replace the `run.stage !== "BLOCKED"` guard with accept-BLOCKED-or-FAILED:

```ts
if (run.stage !== "BLOCKED" && run.stage !== "FAILED") {
  throw new RecoveryError(`cannot resume run ${runId}: stage is ${run.stage}, not BLOCKED or FAILED`);
}
```

- [ ] **Step 4: Update run-service resume to accept FAILED + dispatch**

In `RunService.resume`:
- Replace `if (run.stage !== "BLOCKED")` with `if (run.stage !== "BLOCKED" && run.stage !== "FAILED")`.
- When `run.stage === "BLOCKED"` → existing path (`executeResume(snapshot, workspace, "IMPLEMENTATION")` — pass the existing `resumeTo`, see Task 4).
- When `run.stage === "FAILED"`:
  - Compute `const resumeTo = run.resumeAt ?? "IMPLEMENTATION"` (fallback: IMPLEMENTATION).
  - Validate via `nextStage({ type: "RESUME", resumeTo }, "FAILED")` (throws on illegal).
  - Locate workspace (existing code already does this; keep the `!status.exists` guard).
  - Call `attempt.executeResume(snapshot, workspace, resumeTo)`.

- [ ] **Step 5: Run affected tests + typecheck**

Run: `npx vitest run tests/integration/workflow/recovery-service.test.ts tests/integration/workflow/run-service.test.ts; npx tsc --noEmit`
Expected: PASS (Task 4 implements the new `resumeTo` behaviors; if Task 4 is not done yet, this test may fail — implement Task 3 and Task 4 in the same commit, before declaring green).

- [ ] **Step 6: Commit** (with Task 4)

```bash
git add src/workflow/run-service.ts src/workflow/recovery-service.ts tests/integration/workflow/run-service.test.ts tests/integration/workflow/recovery-service.test.ts
git commit -m "feat(resume): accept FAILED runs and route to resume-at-stage"
```

---

### Task 4: Resume-at-stage — reuse worktree, verify, then retry the failed role

Implement the stage-aware body: for `resumeTo === "IMPLEMENTATION"` keep the existing correction behavior; for `resumeTo === "VERIFICATION"` verify then loop; for `resumeTo === "INDEPENDENT_REVIEW"` verify the existing work, then review (and publish on approval / fall back to correction on CHANGES_REQUESTED).

**Files:**
- Modify: `src/workflow/run-service.ts` — signature `executeResume(snapshot, workspace, resumeTo)` and its body
- Test: `tests/integration/workflow/run-service.test.ts`

**Interfaces:**
- Consumes: `runVerification(workspace, verificationRunner)` → `VerificationEvidence`; `runReview(snapshot, workspace, verification)` → `ReviewOutcome`; `publishRun(...)`; `handleVerificationFailure(verification)` → `RunSummary | null`; `Workspace`; `VerificationRunner` (all existing, in scope).
- Produces: updated `executeResume(snapshot, workspace, resumeTo: RunStage): Promise<RunSummary>`.

- [ ] **Step 1: Write the failing test**

Add a test that a FAILED run with `resumeAt === "INDEPENDENT_REVIEW"` re-runs verification on the preserved worktree and then launches a reviewer (no implementer attempt): assert an implementer attempt is NOT recorded and a reviewer attempt IS recorded (count attempts by role). Also assert verification runs on the existing work.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts -t "FAILED INDEPENDENT_REVIEW"`
Expected: FAIL (no implementer-skip behavior yet).

- [ ] **Step 3: Implement executeResume(snapshot, workspace, resumeTo)**

Rewrite `executeResume` to branch on `resumeTo`:

```ts
async executeResume(
  snapshot: TaskSnapshot,
  workspace: Workspace,
  resumeTo: RunStage,
): Promise<RunSummary> {
  return await this.runFailClosed(() => {
    const workspaceManager = new WorkspaceManager({...});
    const verificationRunner = new VerificationRunner({...});

    if (resumeTo === "IMPLEMENTATION") {
      this.transition("IMPLEMENTATION", null);
      return this.runImplementationLoop(
        snapshot, workspace, workspaceManager, verificationRunner,
        buildResumeCorrectionPrompt(snapshot),
      );
    }

    // resumeTo is VERIFICATION or INDEPENDENT_REVIEW: the implementation is
    // already present in the preserved worktree. Verify it, then continue.
    this.transition("VERIFICATION", null);
    const verification = await this.runVerification(workspace, verificationRunner);
    if (!verification.passed) {
      const blocked = await this.handleVerificationFailure(verification);
      if (blocked !== null) return blocked;
      // Correction: continue via the implementation loop with the correction prompt.
      return await this.runImplementationLoop(
        snapshot, workspace, workspaceManager, verificationRunner,
        buildVerificationCorrectionPrompt(snapshot, verification),
      );
    }

    // No fresh implementer session on this path; reuse the last one.
    const lastImplementer = await this.lastImplementerResult();

    const reviewOutcome = await this.runReview(snapshot, workspace, verification);
    if (reviewOutcome.kind === "terminal") return reviewOutcome.summary;
    if (reviewOutcome.kind === "approved") {
      return await this.publishRun(
        snapshot, workspace, workspaceManager, verification,
        reviewOutcome.review, lastImplementer,
      );
    }
    // CHANGES_REQUESTED: bounded correction loop.
    this.transition("IMPLEMENTATION", null);
    return await this.runImplementationLoop(
      snapshot, workspace, workspaceManager, verificationRunner,
      buildReviewCorrectionPrompt(snapshot, reviewOutcome.review),
    );
  });
}
```

Note: `publishRun` expects an `ImplementerResult`. On the resume-at-review path there is no fresh implementer session, so add the private helper `lastImplementerResult(): Promise<ImplementerResult>` that reads the most recent persisted implementer result artifact named `implementer-result-<n>.json` (the name `handleImplementerResult` writes when persisting an implementer outcome). Use `ArtifactStore`'s existing read-before-write method — check `artifact-store.ts` for a read method (e.g. `readJsonIfExists`) and use it; if the artifact is absent (the run failed during review after an implementer whose outcome wasn't persisted as `implementer-result-N.json`), make `publishRun` tolerate a null implementer result (all those fields are already handled by the snapshot/verification), or thread a minimal stubbed `ImplementerResult` with the COMPLETED shape the earlier stages already produced. Do not invent a new persistence API.

- [ ] **Step 4: Verify the happy-path and FAILED-record tests pass**

Run: `npx vitest run tests/integration/workflow/run-service.test.ts tests/integration/workflow/recovery-service.test.ts`
Expected: PASS; no implementer attempt recorded on the INDEPENDENT_REVIEW resume.

- [ ] **Step 5: Add a publishRun null-tolerant test**

If you added null-tolerance, add a unit test in `tests/integration/workflow/run-service.test.ts` asserting that resuming a FAILED INDEPENDENT_REVIEW run with an approved reviewer reaches `PR_OPEN` without recording a new implementer attempt.

- [ ] **Step 6: Run full suite + typecheck, commit**

Run: `npx vitest run; npx tsc --noEmit`
Expected: PASS, no TS errors.

```bash
git add src/workflow/run-service.ts tests/integration/workflow/run-service.test.ts
git commit -m "feat(resume): resume-at-stage reuses worktree and retries failed role"
```

---

### Task 5: `--fresh` flag on `run` — drop existing worktree + run record, restart clean

`autopilot run <issue> --fresh` discards any active/terminal run record and its worktree for that issue, then starts completely from the base branch.

**Files:**
- Modify: `src/commands/run.ts` (`RunOptions`, `runIssue`, action)
- Modify: `src/workflow/run-service.ts` — `start` (accept a discard option) or a pre-step in the command
- Modify: `src/github/repository-context.ts` or a workspace helper only if needed (prefer keeping discard in the command + a `RunStore.abandonRun(runId)` / add a `drop(runId)` in `RunStore`)
- Test: `tests/integration/commands/run.test.ts`

**Interfaces:**
- Consumes: `RunStore.getActiveRunForIssue(owner, repo, issueNumber)`; `RunStore.transition`/`listTransitions`; `WorkspaceManager.locate/inspect`.
- Produces: `RunStore.dropRun(runId: string): void` (delete run + its attempts/transitions/verification_runs/review_findings in a transaction).
- Consumes (for worktree removal): `WorkspaceManager.locate({ runId, issueNumber, title, baseBranch })` + `WorkspaceManager.inspect(workspace)` + a `WorkspaceManager.remove(workspace)` (may already exist; if not, add one that runs `git worktree remove --force` since discard is explicit).

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/commands/run.test.ts`:

```ts
it("--fresh drops a prior run and its worktree, then starts clean", async () => {
  const harness = makeHarness("run-cmd-fresh", root);
  // Pre-create an active run + worktree for the issue (reuse helpers).
  await harness.run(["run", "42", "--fresh"]);
  // Assert the old worktree path no longer exists and a fresh run was created.
});
```

Use the existing fixture/harness patterns; the key behaviour to assert: with `--fresh`, an existing worktree for the issue is removed and a new clean run starts (new run id, worktree recreated from base branch).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/commands/run.test.ts -t "--fresh"`
Expected: FAIL — no `--fresh` option / no discard behavior.

- [ ] **Step 3: Add `--fresh` option and discard in the command**

- Add `fresh?: boolean` to `RunOptions`; add `.option("--fresh", "drop any existing worktree/run for this issue and start over")`.
- In `run.ts` `runIssue`, before constructing/starting `RunService`: if `opts.fresh === true`, find the active run for the issue via `RunStore.getActiveRunForIssue(ctx.repository.owner, ctx.repository.repo, number)`; if one exists, call `dropRun(runId)` and remove its worktree; then proceed to start fresh.

- [ ] **Step 4: Implement `RunStore.dropRun`**

```ts
dropRun(runId: string): void {
  const del = this.db.transaction(() => {
    this.db.prepare(`DELETE FROM review_findings WHERE run_id = ?`).run(runId);
    this.db.prepare(`DELETE FROM verification_runs WHERE run_id = ?`).run(runId);
    this.db.prepare(`DELETE FROM attempts WHERE run_id = ?`).run(runId);
    this.db.prepare(`DELETE FROM transitions WHERE run_id = ?`).run(runId);
    this.db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
  });
  del();
}
```

(Add a matching worktree-removal helper. Check `WorkspaceManager` for an existing remove method; if absent, add `remove(workspace)` that runs `git worktree remove --force <path>` and `git worktree prune`. Only ever call it from the explicit `--fresh` path.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integration/commands/run.test.ts -t "--fresh"`
Expected: PASS

- [ ] **Step 6: Run full suite + typecheck, commit**

Run: `npx vitest run; npx tsc --noEmit`
Expected: PASS, no TS errors.

```bash
git add src/commands/run.ts src/workflow/run-service.ts src/persistence/run-store.ts src/workspace/workspace-manager.ts tests/integration/commands/run.test.ts
git commit -m "feat(run): add --fresh to discard worktree/run and start clean"
```

---

### Task 6: Document + verify end-to-end

**Files:**
- Modify: `README.md` (resume FAILED + `--fresh` usage)
- Modify: `docs/superpowers/specs/2026-08-21-resume-failed-run-and-fresh-restart-design.md` (mark decisions resolved if not already)

**Interfaces:** none new.

- [ ] **Step 1: Update README**

Document: `autopilot resume <run-id>` now works for runs that reached a non-terminal stage before failing (reuses the worktree, re-verifies, retries the failed role); `autopilot run <issue> --fresh` discards any existing worktree/run for the issue and starts clean.

- [ ] **Step 2: Run the full suite + build**

Run: `npx vitest run; npx tsc --noEmit; npm run build`
Expected: ALL PASS, no TS errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-21-resume-failed-run-and-fresh-restart-design.md
git commit -m "docs: document FAILED-run resume and --fresh restart"
```
