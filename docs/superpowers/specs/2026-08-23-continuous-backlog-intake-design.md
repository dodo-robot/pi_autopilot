# Pi Autopilot: Continuous Backlog Intake Design — `discover` + `queue add`

**Date:** 2026-08-23
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

M3 delivered a durable autonomous runner: `autopilot start` resolves a fixed,
explicit issue queue and works through it unattended, surviving crashes. But
the queue is immutable at `start` time, and there is no GitHub-visible signal
that an issue is claimed — a human (or a second `pi-autopilot` checkout) has
no way to tell, without inspecting this tool's local state, whether an issue
is already being autonomously worked.

This slice closes that gap with two new, independent commands:

- **`discover <ref> [moreRefs...]`** — the mutating sibling of the read-only
  `analyze`. Computes the same readiness as `analyze`, but also writes or
  removes an `agent:ready` GitHub label to make computed readiness visible
  on the issue itself.
- **`queue add <issue...>`** — appends issue numbers to a live daemon's
  queue without stopping and restarting it.

Design settled via a grilling session on 2026-08-22 (vocabulary in
[`CONTEXT.md`](../../CONTEXT.md): Readiness, Claim, Analyze, Discover,
Queue, Pending queue) and [ADR-0001](../../adr/0001-best-effort-github-claim-marker.md)
(the claim mechanism's trade-offs). This document is the implementation-level
design that follows from those decisions, refined through a second
brainstorming pass on 2026-08-23.

## 2. Relationship to the existing roadmap

| Milestone | Outcome |
|---|---|
| M1 — Supervised Task Runner | One issue: check/prepare → isolated run → review/verify → PR. *(done)* |
| M2 — Refinement and Readiness | Read-only `analyze` of epics/task sets. *(done)* |
| M3 — Durable Autonomous Runner | Background daemon, crash recovery, sequential immutable queue. *(done)* |
| **Continuous backlog intake (M4, part 1)** | **`discover` (claim marker), `queue add` (live queue growth).** *(this spec)* |
| Concurrency and scheduling (M4, part 2) | Parallel execution, workspace-conflict detection, dependency-aware ordering, cross-queue budgets. *(deferred — not this spec)* |
| M5 — Adaptive Planning and Governance | Auto-merge, epic-tree observability, replanning. *(deferred)* |

Key boundary: this slice does **not** add concurrency, automatic scheduling
of *which* issue to work next, or any change to how the daemon picks the
next issue from the queue (still strict FIFO). It only makes readiness
visible on GitHub and lets a human grow a running queue.

## 3. Scope decisions

Carried over from the grilling session (ADR-0001 + CONTEXT.md) and treated
as fixed constraints for this design:

1. **Best-effort marker, not a lock.** `agent:ready` / `agent:in-progress`
   are plain label transitions with no compare-and-swap guarantee. Two
   writers can still race; this is accepted, not engineered away.
2. **Just-in-time claim.** The daemon writes `agent:in-progress` immediately
   before starting an issue — never for the whole queue upfront at `start`
   or `queue add` time.
3. **`discover` mirrors `analyze`'s signature** and reuses its readiness
   computation (`BacklogAnalyst`), adding only the label-reconciliation
   side effect.
4. **`queue add` does no readiness validation** — consistent with `start`'s
   existing explicit-list behavior; a human can queue anything.
5. **No automatic stale-claim expiry.** A crashed daemon can leave an issue
   on `agent:in-progress` indefinitely; unsticking it is a manual step.
6. **Decisions from this round's brainstorming** (new, resolved below in
   §6–§7): the dual meaning of `agent:in-progress` after a bad outcome,
   `discover`'s behavior when it encounters `agent:in-progress`, claim/release
   write ordering and failure handling, pending-queue file mechanics, and
   `discover`'s output shape.

## 4. Command interface

### `autopilot discover <ref> [moreRefs...]`

Same argument shape as `analyze`: `<ref>` is an epic issue number (or
`owner/repo#number`) whose checklist is expanded into a set, or the first of
an explicit list when combined with `[moreRefs...]`.

```
autopilot discover 120                # epic checklist
autopilot discover 12 14 19           # explicit issue set
autopilot discover 120 --json
autopilot discover 120 --deep         # full refiner session per issue, same as analyze --deep
```

Flags mirror `analyze` exactly (`--json`, `--deep`, `--model`, `--thinking`,
`--refiner-timeout`, `--min-ready`) with identical semantics. No new flags
are introduced — `discover`'s only difference from `analyze` is the write
side effect described in §7.

**Exit codes:** identical to `analyze` (`0` success regardless of how many
issues ended up READY; `1` on a thrown error). Label-write failures never
change the exit code (see §8).

### `autopilot queue add <issue...>`

```
autopilot queue add 42                # single issue
autopilot queue add 42 43 44          # multiple in one call
```

- Requires a live daemon for the current repository (checked via the
  existing `PidFile` staleness check used by `autopilot stop`/`status`);
  errors with a clear message and exit code `1` if no daemon is running —
  there is nothing to append to.
- Performs no readiness check and no GitHub interaction. Purely a local
  file write to `queue-pending.json`.
- Prints the resulting pending count (e.g., `Queued 2 issue(s) (pending until next daemon loop iteration).`).
- `--json` emits `{ "queued": [42, 43], "daemonRunning": true }`.

## 5. Configuration

No new configuration surface. `agent:ready` and `agent:in-progress` are
fixed string constants (not configurable — no stated need, trivial to add
later). No new `.pi/autopilot.yaml` section.

## 6. `GitHubPort` additions

`GitHubIssue` (in `src/github/github-adapter.ts`) does not carry labels
today, and widening it would touch every existing caller/fixture. Instead,
three new narrow methods are added to `GitHubPort`:

```typescript
export interface GitHubPort {
  // ...existing methods unchanged...
  listLabels(number: number): Promise<string[]>;
  addLabel(number: number, name: string): Promise<void>;
  removeLabel(number: number, name: string): Promise<void>;
}
```

`GitHubAdapter` implementations:

```typescript
async listLabels(number: number): Promise<string[]> {
  try {
    const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
      owner: this.owner, repo: this.repo, issue_number: number,
    });
    return data.map((l) => (typeof l === "string" ? l : l.name ?? ""));
  } catch (error) {
    throw new GitHubError(`failed to list labels for issue #${number}`, { cause: error });
  }
}

async addLabel(number: number, name: string): Promise<void> {
  try {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner, repo: this.repo, issue_number: number, labels: [name],
    });
  } catch (error) {
    throw new GitHubError(`failed to add label "${name}" to issue #${number}`, { cause: error });
  }
}

async removeLabel(number: number, name: string): Promise<void> {
  try {
    await this.octokit.rest.issues.removeLabel({
      owner: this.owner, repo: this.repo, issue_number: number, name,
    });
  } catch (error) {
    // 404 means the label was already absent — treat as success, matching
    // the idempotent-removal semantics the rest of the codebase uses.
    const status = (error as { status?: number }).status;
    if (status === 404) return;
    throw new GitHubError(`failed to remove label "${name}" from issue #${number}`, { cause: error });
  }
}
```

`ensureLabel` (already present from the bootstrap milestone) is reused to
create the `agent:ready` / `agent:in-progress` label definitions on first
use — called once by `discover`/the daemon before the first `addLabel`.

## 7. `discover` label-reconciliation logic

Pure, independently testable function, called once per analyzed issue after
`BacklogAnalyst` produces its per-issue `classification`:

```typescript
export type LabelAction = "labeled" | "unlabeled" | "unchanged" | "skipped-in-progress";

export function reconcileReadyLabel(input: {
  isReady: boolean;              // classification === "READY"
  hasReadyLabel: boolean;
  hasInProgressLabel: boolean;
}): LabelAction {
  if (input.hasInProgressLabel) return "skipped-in-progress";
  if (input.isReady && !input.hasReadyLabel) return "labeled";
  if (!input.isReady && input.hasReadyLabel) return "unlabeled";
  return "unchanged";
}
```

`discover`'s command flow per issue: `listLabels` → compute `LabelAction` via
`reconcileReadyLabel` → apply (`addLabel("agent:ready")` /
`removeLabel("agent:ready")` / no-op) → record the action against that
issue's row in the report.

**`agent:in-progress` is never read for its own sake here beyond the
skip check, and never written by `discover`.** An issue mid-run (or stuck
there from a past BLOCKED/FAILED run) is left entirely alone — `discover`
treats it as "not mine to touch," matching the best-effort, non-locking
philosophy: it never fights a running daemon and never silently resets a
stuck marker a human hasn't looked at.

### Output shape

`discover` reuses `analyze`'s existing `BacklogReport` schema and renderer,
adding one field per issue row:

```typescript
// Extends the existing per-issue entry in BacklogReportSchema:
labelAction: z.enum(["labeled", "unlabeled", "unchanged", "skipped-in-progress"]),
```

Human output renders the same table `analyze` does, with an extra column;
`--json` includes `labelAction` on every issue entry. This keeps `discover`
and `analyze` structurally identical — any tooling parsing `analyze --json`
today can be pointed at `discover --json` with one new field to read.

## 8. Daemon claim/release lifecycle

### Claim (before starting a run)

In `DaemonRunner.run()`'s main loop, immediately before
`runService.start(issueNumber, overrides)`:

```typescript
try {
  await github.removeLabel(issueNumber, "agent:ready");
  await github.addLabel(issueNumber, "agent:in-progress");
} catch (err) {
  logFile.error(`claim label update failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
  // Best-effort only — the run proceeds regardless.
}
```

Order matters for visibility (§ per brainstorming): remove-then-add means an
issue is never seen wearing both labels at once from GitHub's perspective
(as atomic as two sequential REST calls can be).

### Release (after a run reaches a terminal state)

```typescript
try {
  if (summary.stage === "PR_OPEN") {
    await github.removeLabel(issueNumber, "agent:in-progress");
  } else if (summary.stage === "NEEDS_REFINEMENT") {
    await github.removeLabel(issueNumber, "agent:in-progress");
    await github.removeLabel(issueNumber, "agent:ready");
  }
  // BLOCKED / FAILED: no-op — agent:in-progress stays as a "needs a human" signal.
} catch (err) {
  logFile.error(`release label update failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
  // Best-effort only — queue advancement proceeds regardless.
}
```

Rationale for the outcome split:
- **PR_OPEN (success):** fully released — no marker left behind.
- **BLOCKED / FAILED:** `agent:in-progress` is deliberately left in place.
  It now carries a second meaning — "stuck, needs a human" — rather than
  only "currently being worked." This is an accepted overload: a human
  investigating a stuck issue sees the same label whether the daemon is
  still working it or gave up, and must check `autopilot status`/`inspect`
  to tell the difference. No new label is introduced for this distinction.
- **NEEDS_REFINEMENT:** treated differently from BLOCKED/FAILED because it
  isn't "stuck" — it's simply no longer autonomously actionable until a
  human runs `prepare`. Both labels are removed; the issue falls back out
  of the claim system entirely and will not be re-claimed by `discover`
  until it becomes ready again (readiness itself is what re-gates it, not
  a leftover label).

**All label writes on both ends are best-effort and non-blocking:** a
failure is logged and the run/queue-advancement proceeds exactly as if the
label call had succeeded. GitHub label API errors must never stop actual
autonomous work.

## 9. Pending queue (`queue add` → daemon)

### File shape

`queue-pending.json` (path: `<dataDir>/daemon/queue-pending.json`, added to
`AppPaths` alongside the existing `daemonDir`/`pidPath`/`queuePath`/`logPath`):

```typescript
export interface PendingQueue {
  issues: number[];
}
```

### `PendingQueueStore`

Mirrors `QueueStore`'s existing atomic-rename pattern exactly:

```typescript
export class PendingQueueStore {
  constructor(deps: { pendingQueuePath: string; daemonDir: string }) { /* ... */ }

  /** Called by `queue add`: read-modify-atomic-write, appending to any
   * existing pending list (does not require a prior write). */
  append(issues: number[]): void { /* read current or [], concat, tmp+rename */ }

  /** Called by the daemon: read current contents, atomically reset to
   * `{ issues: [] }`, and return what was read. A drain always consumes
   * everything present at read time. */
  drainAll(): number[] { /* read current or [], write {issues: []} via tmp+rename, return read value */ }
}
```

Atomicity relies on the same `writeFileSync` + `renameSync` sequence
`QueueStore` already uses — a `queue add` write and a daemon drain can never
interleave into a torn read; the daemon sees either the pre-add or
post-add file, never a partial one.

### Drain timing in `DaemonRunner`

Drained **once before the main loop starts** (so an issue added during
crash-recovery isn't stranded for a full extra run) **and once per loop
iteration**, colocated with the existing `queueStore.write(queue)` call at
the end of each iteration body:

```typescript
// Before the main loop (after crash reconciliation, before the while-loop):
mergePending();

// ...existing while (queue.currentIndex < queue.issues.length && !stopRequested) loop...
  // ...existing run + completedRuns + currentIndex bump...
  queueStore.write(queue);
  mergePending();
// ...loop end...

function mergePending(): void {
  const pending = pendingQueueStore.drainAll();
  if (pending.length === 0) return;
  const existing = new Set(queue.issues);
  const toAdd = pending.filter((n) => !existing.has(n));
  if (toAdd.length === 0) return;
  queue.issues.push(...toAdd);
  queueStore.write(queue);
  logFile.info(`merged ${toAdd.length} pending issue(s): [${toAdd.join(",")}]`);
}
```

Deduplication is against the **full** `queue.issues` array (including
already-completed entries before `currentIndex`), not just the remaining
tail — an issue already run once this session is never re-queued by a
stray `queue add`, consistent with "FIFO, deduplicated against the full
existing queue" from the original design.

The pending file is truncated on every drain regardless of whether
anything new was merged (simplest option — the existing full-queue dedup
already protects the only real edge case, a `queue add` landing exactly
mid-drain, at worst delaying it one extra iteration rather than losing or
duplicating it).

## 10. Data flow summary

**`discover <ref>`:**
`resolveIssueSet` → `BacklogAnalyst.analyzeIssues` (unchanged, same as
`analyze`) → for each issue: `listLabels` → `reconcileReadyLabel` → apply
label action → attach `labelAction` to report row → render (human or
`--json`), reusing `analyze`'s existing report code paths.

**`queue add <issue...>`:**
Check daemon liveness (`PidFile`) → `PendingQueueStore.append(issues)` →
print confirmation.

**Daemon loop (modified):**
`mergePending()` before the loop and after each `queueStore.write` →
claim (`removeLabel`/`addLabel`, best-effort) → `runService.start` →
release (best-effort, outcome-dependent) → existing `completedRuns`
bookkeeping unchanged.

## 11. Error handling

- **`discover` label-write failures** (e.g., transient GitHub API error
  while reconciling one issue's label): logged as a per-issue warning in
  the report (reuse the existing `reasons`/warnings mechanism `analyze`
  already has for partial failures), but do not abort the whole command —
  remaining issues in the set are still processed. `discover`'s own exit
  code is unaffected by label-write failures (matches the "best-effort,
  never blocking" philosophy applied consistently here).
- **Daemon claim/release failures:** logged to `daemon.log` only, never
  thrown, never affect run outcome or queue advancement (§8).
- **`queue add` with no live daemon:** hard error, exit code `1` — this is
  a genuine usage mistake (nothing will ever drain the file), not a
  best-effort scenario.
- **`queue add` with a malformed/nonexistent issue number:** no validation
  performed (§3.4); the daemon will surface the failure naturally when it
  eventually calls `runService.start` on that issue (existing FAILED-run
  handling applies unchanged).

## 12. Testing

- **`reconcileReadyLabel`** — pure function, full truth-table coverage (4
  input combinations × the `skipped-in-progress` short-circuit).
- **`PendingQueueStore`** — round-trip `append`/`drainAll`, atomic
  tmp-then-rename write verified via a fake fs or real tmpdir, dedup
  behavior when `append` is called multiple times before a drain, empty-file
  handling (no prior file exists).
- **`GitHubAdapter` new methods** — `listLabels`/`addLabel`/`removeLabel`
  against a fake Octokit, including the 404-on-remove idempotency case.
- **`discover` command** — fake `GitHubPort` + fake `BacklogAnalyst`,
  asserting: READY issue with no `agent:ready` gets labeled; non-READY
  issue with `agent:ready` gets unlabeled; issue with `agent:in-progress`
  is never touched regardless of computed readiness; report/JSON output
  includes `labelAction` per issue.
- **`DaemonRunner` claim/release** — fake `GitHubPort` spy asserting exact
  calls per outcome (`PR_OPEN` → in-progress removed; `BLOCKED`/`FAILED` →
  no removal calls; `NEEDS_REFINEMENT` → both removed); a throwing fake
  `GitHubPort` must never prevent `runService.start` from being called or
  `completedRuns` from being recorded.
- **`DaemonRunner` pending-merge** — fake `PendingQueueStore` asserting
  drain is called once before the loop and once per iteration; new issues
  are appended to `queue.issues` and persisted via `queueStore.write`;
  duplicates already present anywhere in `queue.issues` are dropped.
- **`queue add` command** — daemon-not-running error path; successful
  append path (assert `PendingQueueStore.append` called with parsed issue
  numbers); `--json` output shape.
- **Integration:** extend the existing `tests/integration/daemon/daemon-lifecycle.test.ts`
  to cover `queue add` while the fake daemon is mid-run on an earlier issue,
  asserting the added issue is executed before the daemon exits.

## 13. Out of scope for this milestone

- Automatic issue selection without a prior `discover`/`analyze` pass —
  `discover` always requires an explicit ref/epic argument, same as
  `analyze`.
- Any change to daemon ordering/scheduling — still strict FIFO over
  `queue.issues`, unaffected by how entries arrived (explicit `start` list
  vs. merged pending).
- Concurrent execution, workspace-conflict detection, dependency-aware
  scheduling, cross-queue budgets — all remain M4 "part 2" (see §2).
- Automatic stale-claim expiry or any distributed-lock mechanism —
  explicitly rejected in ADR-0001.
- Configurable label names — hardcoded constants; no stated need.
- A background poll that runs `discover` automatically — on-demand only,
  invoked explicitly by a human.

## 14. Acceptance criteria

1. `autopilot discover <ref>` produces output structurally identical to
   `autopilot analyze <ref>` plus a `labelAction` field per issue. Unlike
   `analyze`, it does mutate GitHub — but its only possible write is
   adding or removing the `agent:ready` label; it never touches issue
   bodies, comments, or any other label.
2. Running `discover` twice in a row with no repository changes between
   runs results in `unchanged` for every issue on the second run.
3. An issue with `agent:in-progress` present is never labeled or unlabeled
   by `discover`, regardless of its computed readiness.
4. `autopilot queue add <issue>` against a running daemon results in that
   issue being executed by the daemon without requiring a restart, and
   without being able to jump ahead of issues already in the immutable
   queue at the time it was added.
5. `autopilot queue add <issue>` against a repository with no running
   daemon fails clearly with exit code `1` and writes nothing.
6. The daemon claims (`agent:in-progress`) an issue just before starting
   it and never shows both `agent:ready` and `agent:in-progress`
   simultaneously (assuming sequential, non-racing label API calls).
7. On `PR_OPEN`, no claim/ready labels remain on the issue. On `BLOCKED`
   or `FAILED`, `agent:in-progress` remains. On `NEEDS_REFINEMENT`, neither
   label remains.
8. A simulated GitHub label-API failure during claim, release, or
   `discover`'s reconciliation never changes the run outcome, the queue's
   `currentIndex` advancement, or `discover`'s exit code — only produces a
   log line / report warning.

## 15. Assumptions and open questions

- Assumes `octokit.rest.issues.addLabels` / `removeLabel` /
  `listLabelsOnIssue` are the correct REST endpoints for label mutation on
  an existing issue (standard Octokit REST surface, consistent with the
  `getLabel`/`createLabel` calls `ensureLabel` already uses).
- No open questions remain from this round of brainstorming; all decision
  points raised were resolved (see §3.6, §7, §8, §9).
