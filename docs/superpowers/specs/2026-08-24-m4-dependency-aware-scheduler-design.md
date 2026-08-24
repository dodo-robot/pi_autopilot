# Pi Autopilot: M4 Dependency-Aware Scheduler Design

**Date:** 2026-08-24
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

M3 delivered a durable daemon that works through a queue sequentially. The
continuous-backlog-intake slice added GitHub-visible readiness/claim labels
and `queue add`, but deliberately kept the daemon FIFO and single-threaded.
M4 part 2 turns that daemon into a conservative scheduler: it may run multiple
independent issues at once, but only when dependencies, workspace scope, and
queue-level budgets allow it.

This milestone is not a repo-wide autonomous planner. A human still provides
explicit input — issue refs or an analyze/discover report — and the scheduler
operates over that bounded issue set.

## 2. Relationship to the existing roadmap

| Milestone | Outcome |
|---|---|
| M1 — Supervised Task Runner | One issue: check/prepare → isolated run → review/verify → PR. *(done)* |
| M2 — Refinement and Readiness | Read-only backlog analysis of epics/task sets. *(done)* |
| M3 — Durable Autonomous Runner | Background daemon, crash recovery, sequential queue. *(done)* |
| Continuous backlog intake (M4, part 1) | `discover`, `queue add`, claim/release labels. *(done)* |
| **M4 — Dependency-Aware Scheduler** | **Bounded concurrency, dependency-aware ordering, workspace-scope conflict prevention, cross-queue start budgets.** *(this spec)* |
| M5 — Adaptive Planning and Governance | Auto-merge, richer observability, stale-claim expiry/replanning. *(deferred)* |

Key boundary: M4 changes **which queued issue can start next** and **how many
can run concurrently**. It does not change issue refinement, implementation,
review, verification, publication, reconciliation, or merge governance.

## 3. Scope decisions

1. **Dependency-aware over explicit inputs.** `start` still receives explicit
   issue refs or a prior analyze/discover report. No repo-wide discovery loop.
2. **Hybrid dependency satisfaction.** A dependency is satisfied if the
   dependency issue is closed on GitHub or local autopilot history records a
   successful `PR_OPEN` outcome for that dependency.
3. **Static workspace scope.** Conflicts are detected from path/glob scope
   hints, not from an LLM preflight. Missing or unknown scope conflicts with
   everything.
4. **Backward-compatible default.** `scheduler.maxConcurrentRuns` defaults to
   `1`, so existing sequential daemon behavior remains the default.
5. **In-process concurrency with an executor seam.** M4 runs concurrent
   `RunService.start()` calls inside the daemon process. The scheduler state
   and executor interface must not assume that this will always be in-process;
   a later milestone can replace it with worker child processes.
6. **Budgets checked only before starts.** Queue-level budgets prevent new
   work from starting. They never cancel active runs.
7. **Partial scheduling.** Invalid dependency metadata blocks only affected
   issues. Independent schedulable work continues.
8. **Default idle timeout is zero.** If no issue can run and no active run
   exists, the daemon refreshes dependency states once, then exits unless an
   explicit idle timeout asks it to wait for `queue add` or external progress.

## 4. Command and configuration interface

### 4.1 `autopilot start`

Existing `start` inputs stay valid:

```text
autopilot start <issue> [more-issues...]
autopilot start --from-analyze [report-id]
```

M4 adds scheduling options:

```text
--max-concurrent <n>       override scheduler.maxConcurrentRuns for this daemon
--max-elapsed <minutes>    override scheduler.budgets.maxElapsedMinutes
--max-started-runs <n>     override scheduler.budgets.maxStartedRuns
--max-failed-runs <n>      override scheduler.budgets.maxFailedRuns
--idle-timeout <minutes>   override scheduler.idleTimeoutMinutes
```

All overrides are written into `queue.json` so crash recovery and daemon
restart preserve the scheduling policy for that queue.

### 4.2 Configuration

Add an optional `scheduler` section to `.pi/autopilot.yaml`:

```yaml
scheduler:
  maxConcurrentRuns: 1
  idleTimeoutMinutes: 0
  budgets:
    maxElapsedMinutes: null
    maxStartedRuns: null
    maxFailedRuns: null
```

Rules:

- `maxConcurrentRuns` must be a positive integer. Default: `1`.
- `idleTimeoutMinutes` must be a non-negative integer. Default: `0`.
- Each budget is optional. `null` / absent means no cap for that dimension.
- CLI overrides apply only to the daemon being started.

## 5. Scheduler state in `queue.json`

M4 keeps M3's top-level queue fields so old sequential queues can still be
read:

```typescript
interface DaemonQueue {
  repository: RepositoryRef;
  issues: number[];
  currentIndex: number;
  completedRuns: CompletedRun[];
  overrides?: RunOverrides;
  scheduler?: SchedulerState;
}
```

When `scheduler` is absent, the daemon may either run the old sequential path
or initialize a scheduler section from the existing queue. Newly written M4
queues always include `scheduler`.

```typescript
type SchedulerIssueState =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "DEFERRED_DEPENDENCY"
  | "DEFERRED_CONFLICT"
  | "DEFERRED_INVALID";

interface SchedulerState {
  version: 1;
  policy: SchedulerPolicy;
  startedAt: string;
  lastUpdatedAt: string;
  issues: SchedulerIssue[];
  activeRuns: ActiveSchedulerRun[];
  budgets: SchedulerBudgetUsage;
  lastBlockedRefreshAt: string | null;
  idleSince: string | null;
}

interface SchedulerIssue {
  issueNumber: number;
  state: SchedulerIssueState;
  dependencies: DependencySnapshot[];
  workspaceScope: WorkspaceScope;
  reason: string | null;
  runId: string | null;
  outcome: string | null;
}

interface DependencySnapshot {
  issueNumber: number;
  satisfied: boolean;
  source: "github-closed" | "local-pr-open" | "unsatisfied" | "invalid";
  checkedAt: string;
}

interface WorkspaceScope {
  kind: "paths" | "unknown";
  patterns: string[];
  source: "issue-contract" | "analysis-report" | "missing";
}

interface ActiveSchedulerRun {
  issueNumber: number;
  runId: string | null;
  startedAt: string;
  workspaceScope: WorkspaceScope;
}

interface SchedulerPolicy {
  maxConcurrentRuns: number;
  idleTimeoutMinutes: number;
  budgets: {
    maxElapsedMinutes: number | null;
    maxStartedRuns: number | null;
    maxFailedRuns: number | null;
  };
}

interface SchedulerBudgetUsage {
  startedRuns: number;
  failedRuns: number;
  elapsedMinutes: number;
  stopReason: string | null;
}
```

`queue.completedRuns` remains the compatibility summary. `scheduler.issues`
is the source of truth for M4 status and scheduling decisions.

## 6. Dependency normalization

At `start`, Autopilot builds the scheduler snapshot before spawning the daemon:

1. Resolve the input issue list:
   - explicit refs → ordered issue numbers, preserving CLI order;
   - report input → `report.executable`, preserving report order and the
     existing `start --from-analyze` compatibility contract.
2. Fetch current issue metadata for each issue.

If a human wants to schedule issues that are not in a report's `executable`
set yet, they must pass those issues explicitly to `start`. M4 does not
reinterpret non-executable M2 classifications as runnable work; `RunService`
keeps the final per-issue readiness gate before implementation starts.
3. Parse existing managed dependency markers from issue bodies and existing
   epic/task conventions. M4 does not introduce a new dependency syntax.
4. Normalize dependency references into `DependencySnapshot[]`.
5. Detect invalid references and dependency cycles.
6. Write `scheduler.issues`:
   - valid issues with unsatisfied dependencies start as `DEFERRED_DEPENDENCY`;
   - valid issues with satisfied dependencies start as `PENDING`;
   - issues with invalid dependency metadata or cycles start as
     `DEFERRED_INVALID` with a human-readable reason.

Dependency-cycle handling is scoped to the affected strongly connected
component: a cycle among #10/#11 does not block #12 if #12 is otherwise valid.

## 7. Dependency satisfaction during daemon execution

The scheduler uses hybrid satisfaction:

- **GitHub closed:** the dependency issue's current state is `closed`.
- **Local success:** the local run store or queue history records `PR_OPEN` for
  that dependency issue.

The daemon schedules from the snapshot during normal operation. It does not
poll GitHub before every start. When no issue is schedulable and no active run
exists, it performs one blocked refresh:

1. Re-fetch current state for unsatisfied dependency issues.
2. Recompute satisfaction from GitHub closed state plus local `PR_OPEN` history.
3. Move newly unblocked issues to `PENDING`.
4. Re-run scheduling.
5. If still blocked, enter idle/exit handling (§12).

Transient GitHub refresh failures do not make an issue runnable. They leave
that dependency unsatisfied and record the refresh error in the issue reason.

## 8. Workspace scope and conflict detection

Workspace scope is path/glob based only.

### 8.1 Scope source

The issue body is authoritative when it contains an explicit workspace-scope
section in the autonomous execution contract. Analyze/discover reports may
cache the interpreted scope for faster startup, but if the issue body contains
scope, the issue body wins.

If no scope is available, the scheduler records:

```typescript
{ kind: "unknown", patterns: [], source: "missing" }
```

Unknown scope conflicts with every active run and every other unknown-scope
candidate. This is intentionally conservative.

### 8.2 Conflict rule

Two `paths` scopes conflict when any pattern pair has an exact, parent/child,
or glob-overlap relationship. The implementation should prefer a simple,
documented conservative matcher over a clever one. False positives are
acceptable; false negatives are not.

A candidate can start only if its scope does not conflict with any
`activeRuns[].workspaceScope`.

Workspace scope is held only while a run is active. It is released when the
run reaches any terminal outcome, including `PR_OPEN`. M4 prevents concurrent
conflicting edits; it does not reserve paths until PR merge.

## 9. Scheduling algorithm

The daemon repeatedly fills available concurrency slots:

```text
while activeRuns.length < maxConcurrentRuns:
  update budget usage
  if any start budget is exhausted: stop scheduling new work
  candidates = scheduler.issues in original input order with state PENDING
  pick first candidate whose dependencies are satisfied and scope has no active conflict
  if none: break
  mark candidate RUNNING, persist queue.json
  claim labels best-effort
  launch executor.start(issue)
```

When a run finishes:

1. Release claim labels using the existing outcome-dependent rules.
2. Mark the issue `COMPLETED` with outcome/runId.
3. Append/update `queue.completedRuns` for compatibility.
4. Increment failure budget usage if the outcome is `FAILED` or `BLOCKED`.
5. Recompute dependency satisfaction for queued issues using local `PR_OPEN`
   history. Any issue unblocked by the completed run moves to `PENDING`.
6. Persist `queue.json`.
7. Attempt to fill available slots again.

Issues deferred only by active workspace conflicts should not be permanently
stuck. They are represented as `DEFERRED_CONFLICT` for status clarity while
the conflict exists, and return to `PENDING` when the conflicting active run
finishes.

## 10. Executor seam

Introduce a small scheduler-facing executor interface:

```typescript
interface SchedulerExecutor {
  start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
}
```

M4's production executor delegates to `RunService.start()`. Tests can inject a
fake executor. The scheduler must not depend on `RunService` internals beyond
`RunSummary`.

This seam keeps M4 in-process while preserving a path to future worker child
processes.

## 11. Queue add under the scheduler

`queue add` continues to write `queue-pending.json`. The scheduler daemon
drains pending issues:

- before the first scheduling pass;
- after each run completion;
- during idle waits, if `idleTimeoutMinutes > 0`.

New pending issues are normalized into scheduler entries using the same rules
as startup. They do not jump ahead of already pending issues; original queue
order remains stable, with new issues appended at the tail.

If a pending issue duplicates any existing scheduler issue, it is dropped.

## 12. Idle and exit behavior

If no run is active and no issue is schedulable:

1. Perform the blocked dependency refresh (§7) if it has not already been
   performed for the current blocked state.
2. If refresh makes work schedulable, continue.
3. If a start budget is exhausted, exit cleanly with `scheduler.budgets.stopReason` set.
4. If `idleTimeoutMinutes` is `0`, exit cleanly with a blocked/drained reason.
5. Otherwise, set `idleSince` and wait up to `idleTimeoutMinutes`, periodically
   draining `queue-pending.json` and retrying scheduling.
6. If the timeout expires with no schedulable work, exit cleanly.

The daemon never spins in a tight loop while idle. Polling interval is an
implementation detail, but should be long enough to avoid busy waiting and
short enough for `queue add` to feel responsive.

## 13. Cross-queue budgets

M4 budgets are enforced only at start boundaries. Active runs are allowed to
finish even if a budget is exceeded while they run.

Budget dimensions:

- `maxElapsedMinutes`: measured from `scheduler.startedAt`.
- `maxStartedRuns`: total issue runs launched by this daemon.
- `maxFailedRuns`: count of outcomes that represent failed autonomous progress
  (`FAILED` and `BLOCKED`). `NEEDS_REFINEMENT` is not a failed run for this
  budget; it is a readiness outcome.

When a budget prevents new starts, the scheduler records a clear stop reason
and exits once no active runs remain.

## 14. Status output

`autopilot status` should show both a compact scheduler summary and a
per-issue table when `queue.scheduler` is present.

Human output shape:

```text
Daemon      running  PID 12345  scheduler 2/3 active
Budget      started 4/10  failed 1/3  elapsed 42m/120m
Active      #42 RUNNING  run-abc  scope src/daemon/**
Pending     3 pending, 2 dependency-blocked, 1 conflict-blocked, 0 invalid

Issue  State                 Reason
#42    RUNNING               run-abc
#43    PENDING               ready
#44    DEFERRED_DEPENDENCY   waiting for #42
#45    DEFERRED_CONFLICT     conflicts with #42: src/daemon/**
#46    DEFERRED_INVALID      dependency cycle: #46 -> #47 -> #46
#48    COMPLETED             PR_OPEN run-def
```

`status --json` exposes the full `scheduler` object plus the existing daemon
status fields. Existing consumers that only read the old fields should keep
working.

## 15. Error handling

- **Invalid dependency metadata:** mark affected issues `DEFERRED_INVALID`;
  continue with independent work.
- **Workspace-scope parse failure:** treat as unknown scope and record the
  parse failure as the issue reason. Unknown scope is safe because it conflicts
  with everything.
- **Executor throws before returning a `RunSummary`:** synthesize a `FAILED`
  outcome for that issue, record it, release labels according to FAILED rules,
  and continue if budgets allow.
- **Claim/release label failures:** same as continuous backlog intake — log
  only; they never block scheduling, queue advancement, or exit-code behavior.
- **GitHub dependency refresh failure:** leave affected dependencies
  unsatisfied and record the error. Do not run the issue based on stale hope.
- **Queue write failure:** fatal daemon error. Scheduler state durability is a
  safety requirement before starting or completing work.

## 16. Testing

- **Config/schema tests:** default scheduler policy, CLI override validation,
  invalid non-positive concurrency, invalid negative idle timeout/budgets.
- **Scheduler-state initialization:** explicit issues and report input both
  produce `scheduler.version = 1`, stable issue order, normalized dependencies,
  and valid initial states.
- **Dependency graph tests:** closed dependency, local `PR_OPEN` dependency,
  unsatisfied dependency, invalid ref, and cycle affecting only cycle members.
- **Workspace conflict tests:** exact path overlap, parent/child overlap, glob
  overlap, disjoint paths, unknown-vs-known, unknown-vs-unknown.
- **Scheduling tests:** fills up to `maxConcurrentRuns`, preserves input order
  among candidates, does not start dependency-blocked or conflict-blocked
  issues, releases conflict after terminal outcome.
- **Budget tests:** max elapsed, max started runs, max failed runs; verify
  budgets prevent new starts but never cancel active fake executor promises.
- **Idle tests:** default exits immediately when blocked/drained; non-zero idle
  drains pending queue and starts newly appended work; timeout exits cleanly.
- **Status tests:** human output includes summary and per-issue table; JSON
  includes full scheduler state.
- **Regression tests:** with default `maxConcurrentRuns: 1`, existing M3 queue
  behavior remains sequential.

## 17. Acceptance criteria

1. With default configuration, `autopilot start` remains sequential and
   existing M3/M4 part-1 tests continue to pass.
2. With `--max-concurrent 2`, two dependency-free issues with disjoint path
   scopes can run concurrently.
3. An issue whose dependency is neither GitHub-closed nor locally `PR_OPEN`
   is not started until that dependency becomes satisfied.
4. When a dependency issue completes as `PR_OPEN` in the same daemon session,
   dependent issues may become schedulable without waiting for GitHub closure.
5. Two issues with overlapping or unknown workspace scopes never run at the
   same time.
6. Invalid or cyclic dependency metadata blocks only affected issues; unrelated
   ready issues still run.
7. Queue-level budgets stop new starts at scheduling boundaries and never
   interrupt active runs.
8. When no work is schedulable, the daemon refreshes dependency states once,
   then exits immediately by default or idles up to the configured timeout.
9. `queue add` appends work to a running scheduler daemon without jumping
   ahead of existing pending issues.
10. `autopilot status` explains active, pending, dependency-blocked,
    conflict-blocked, invalid, and completed scheduler entries in both human
    and JSON modes.

## 18. Out of scope

- Repo-wide automatic discovery with no explicit input.
- Automatic stale-claim expiry or distributed locking.
- Automatic PR merge, issue closure, or post-`PR_OPEN` merge governance.
- Worker child processes per issue.
- Token-budget enforcement.
- LLM/Pi preflight probes for predicted touched files.
- Serial PR conflict management after publication.
- Changes to reconciliation or apply-safe behavior.
- New dependency syntax beyond existing issue metadata/managed markers.

## 19. Assumptions

- Existing dependency markers are sufficiently parseable for M4 scheduling.
  If the implementation finds they are not, the implementation plan should
  first add a narrow parser/spec for the current marker format rather than
  inventing a new dependency model.
- Workspace-scope contract syntax exists or can be added as a small extension
  to the autonomous execution contract. Missing scope remains safe because it
  conflicts with everything.
- No open product questions remain from brainstorming; implementation may still
  surface mechanical questions about exact parser names or test fixture shape.
