# Pi Autopilot: Milestone 3 Design — Durable Autonomous Runner

**Date:** 2026-08-21
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

Milestone 1 delivered a supervised task runner: a human selects one issue, Autopilot checks or prepares it, runs it in an isolated worktree, reviews and verifies, then opens a PR. Milestone 2 delivered a backlog analyst: given an epic or explicit list, classify every issue as READY, NEEDS_REFINEMENT, BLOCKED, or AMBIGUOUS, and produce an actionable `executable` list.

M3 closes the loop: take that `executable` list (or an explicit queue), run unattended in the background, recover from crashes, and work through the queue one issue at a time until done. The human starts it and walks away.

Key constraints settled in brainstorming:

- **Sequential, one task at a time.** Concurrency (parallel runs for known-independent issues) is M4.
- **True background daemon.** Detaches from the terminal; survives shell exit, network dropouts, machine restarts.
- **Auto-resume on crash.** On restart, `RecoveryService` reconciles any interrupted run before touching the queue.
- **File-based control.** PID file + SIGTERM + `autopilot status` / `autopilot stop`. No sockets, no IPC.
- **Issue input: explicit list or `--from-analyze`.** Both reduce to an ordered queue of issue numbers.

## 2. Milestone context

| Milestone | Outcome |
|---|---|
| M1 — Supervised Task Runner | One issue: check/prepare → isolated run → review/verify → PR. *(done)* |
| M2 — Refinement and Readiness | Analyze existing epics and tasks, record readiness, identify executable work. *(done)* |
| **M3 — Durable Autonomous Runner** | **Background daemon, crash recovery, auto-resume, sequential queue, unattended one-task-at-a-time execution.** *(this spec)* |
| M4 — Epic Scheduler | Explicit dependencies, controlled concurrency, workspace-conflict prevention, epic progress reporting. |
| M5 — Adaptive Planning and Governance | Staleness detection, replanning, richer escalation/security policy, optional auto-merge, end-to-end traceability. |

Key boundary: **M3 does not add concurrency.** Running multiple issues simultaneously, workspace-conflict detection, and dependency scheduling belong to M4 and must not expand this slice.

## 3. Scope decisions

1. **Child-process daemon.** `autopilot start` spawns a detached `node` child process. The child owns the loop and truly outlives the parent shell. The PID written to disk is the child's PID.
2. **Sequential queue.** Issues are worked one at a time, in the order supplied. `currentIndex` advances only after a run reaches a terminal state.
3. **Auto-resume on crash.** On every daemon startup, `RecoveryService` inspects non-terminal runs before the queue loop begins. A resumed run completes first; a non-resumable interrupted run is marked FAILED and the queue continues.
4. **Immutable queue.** The issue list is fixed at `start` time. The daemon never re-orders or appends mid-run. Adding more issues requires stopping the daemon and restarting with a new queue.
5. **SIGTERM at stage boundaries.** A SIGTERM sets a `stopRequested` flag. The daemon never kills a Pi session mid-flight; it finishes the current agent stage, then exits cleanly.
6. **One daemon per repository.** Enforced via the PID file. `autopilot start` fails if a live daemon is already running for the repository.

## 4. Command interface

### 4.1 New commands

```text
autopilot start <issue> [more-issues...]
autopilot start --from-analyze [report-id]

autopilot stop
```

**`autopilot start`**

Resolves the issue queue (§5.1), writes `queue.json`, spawns the daemon child process (detached), writes the PID file, exits 0. Fails with exit 1 if:

- A live daemon is already running for this repository.
- The explicit issue list is empty after resolution.
- `--from-analyze` finds no prior report (no report exists for this repository), or the report's `executable` list is empty.
- Any explicit issue reference cannot be resolved to a GitHub issue.

Options inherited from M1 `run` (same semantics, passed through to `RunService`):

```text
--from-analyze [report-id]     use the executable list from a prior analyze report
                               (defaults to the most recent report for this repository)
--refiner-timeout <minutes>    override the refiner session timeout (same as M1 check/run)
--refiner-model <model>
--refiner-thinking <level>
--implementer-model <model>
--implementer-thinking <level>
--reviewer-model <model>
--reviewer-thinking <level>
```

**`autopilot stop`**

Reads the PID file, sends SIGTERM, waits up to 10 seconds for the process to exit (polls the PID with signal 0 every 500 ms), then reports. Exit 0 if the daemon stopped. Exit 1 if no daemon is running or the process did not exit within 10 seconds (with a clear message in each case).

### 4.2 Extended command: `autopilot status`

Adds a daemon block above the existing run list when a daemon is running:

```
Daemon    running  PID 12345  uptime 1h 23m
Current   #29 – Add cross-filter support  [IMPLEMENTING]  started 14m ago
Queue     #30 #31 #32  (3 remaining)
Done      #28 → PR_OPEN  #27 → BLOCKED
```

When no daemon is running, falls back to today's behaviour (completed runs only). Reads `pid`, `queue.json`, and the current run's `run-store` entry — all file reads, no IPC.

### 4.3 Exit codes

| Command | Code | Meaning |
|---|---|---|
| `start` | `0` | Daemon launched successfully |
| `start` | `1` | Infrastructure/argument error |
| `stop` | `0` | Daemon stopped |
| `stop` | `1` | No daemon running, or did not exit within 10 s |

The daemon process itself exits 0 on clean queue exhaustion or clean SIGTERM. It does not propagate run-level outcomes as exit codes — those are recorded in `queue.json` and inspectable via `status`.

## 5. Behavior

### 5.1 Queue resolution

`autopilot start` resolves the queue before spawning anything:

1. **Explicit list** (`autopilot start 28 29 30`): resolve each ref against the local repository origin (same rule as M1 `check`). Fail if any ref is unresolvable.
2. **From analyze** (`autopilot start --from-analyze`): load the named `BacklogReport` (or the most recent one for this repository by `generatedAt` timestamp if no ID is given). Read `report.executable` — the ordered list of READY issue numbers produced by M2. Fail if the list is empty.
3. **Both forms produce the same structure**: an ordered `number[]` written to `queue.json`.

### 5.2 Daemon startup sequence

On every startup (initial or after crash):

1. Write PID file.
2. Log daemon start with PID and queue.
3. Call `RecoveryService` to inspect non-terminal runs for this repository.
   - If an interrupted run is found: attempt auto-resume via `RecoveryService.resume()`.
     - Resume succeeds → the resumed run enters the normal loop first; it completes before the queue advances.
     - Resume fails (worktree corrupt, branch gone) → mark the run FAILED, log the reason, continue with the queue.
   - If no interrupted run is found: proceed directly to the queue loop.
4. Enter the main loop (§5.3).

### 5.3 Main loop

```
while currentIndex < issues.length and not stopRequested:
  issue = issues[currentIndex]
  log "starting run issue=<n>"
  outcome = RunService.run(issue)
  record outcome in queue.json (completedRuns, advance currentIndex)
  log "run complete issue=<n> outcome=<outcome>"

log "queue exhausted" (or "SIGTERM stop")
delete PID file
exit 0
```

SIGTERM sets `stopRequested = true`. The flag is checked **between issues only** — never between stages of a single run. The current run always reaches a terminal state (PR_OPEN, BLOCKED, NEEDS_REFINEMENT, FAILED) before the daemon exits.

`BLOCKED` and `NEEDS_REFINEMENT` outcomes are recorded and the daemon continues to the next issue. They are not errors — the daemon logs them and moves on.

### 5.4 Clean shutdown

On SIGTERM:

1. Set `stopRequested = true`.
2. Allow the current `RunService.run()` call to return normally.
3. Flush `queue.json` with the final `currentIndex` and `completedRuns`.
4. Delete the PID file.
5. Exit 0.

Log entry on SIGTERM receipt and on clean exit.

## 6. File layout and module boundaries

### 6.1 New files

```
src/daemon/
  daemon-entry.ts      # child process entry point — bootstrap deps, call DaemonRunner.run()
  daemon-runner.ts     # main loop: queue pop, RunService calls, SIGTERM handling, reconciliation
  pid-file.ts          # write / read / delete PID file; staleness check via signal 0
  queue-store.ts       # atomic read/write of queue.json (write-to-.tmp, rename)
  log-file.ts          # log path resolution, timestamped line writes, size-based rotation

src/commands/
  start.ts             # resolve queue, check for live daemon, spawn child, write PID, exit
  stop.ts              # read PID, SIGTERM, wait-poll, report
```

### 6.2 Modified files

```
src/commands/status.ts      # extend to render daemon block when PID file is live
src/ui/reporter.ts          # extend Reporter to format daemon status lines
```

### 6.3 Unchanged files (called as-is, no modifications)

```
src/workflow/run-service.ts       # called by DaemonRunner with no changes
src/workflow/recovery-service.ts  # called programmatically on daemon startup
src/persistence/run-store.ts      # read by status command as today
src/persistence/artifact-store.ts # written by RunService as today
src/analysis/backlog-analyst.ts   # read by start --from-analyze via BacklogReport JSON
```

**Key boundary:** `DaemonRunner` depends on `RunService`, `RecoveryService`, `QueueStore`, and `PidFile`. It knows nothing about GitHub directly. All GitHub interaction stays inside `RunService`. The daemon loop is pure orchestration.

### 6.4 Dependency injection

`DaemonRunner` accepts a `DaemonRunnerDeps` interface (same pattern as `RunServiceDeps` in M1) so integration tests can substitute a fake `RunService` without touching real Pi infrastructure. `daemon-entry.ts` wires production deps; tests wire fakes.

## 7. Persistence

### 7.1 PID file

**Path:** `~/.local/share/pi-autopilot/daemon/pid`

Plain text file containing the daemon's integer PID. Written by the daemon on startup; deleted on clean exit. Never written by `autopilot start` (the parent) — the child writes its own PID, eliminating a race between parent write and child startup.

**Staleness check:** Before trusting a PID, send signal 0 (`process.kill(pid, 0)`). If it throws `ESRCH`, the process is gone; delete the stale file and treat as "no daemon running."

### 7.2 Queue file

**Path:** `~/.local/share/pi-autopilot/daemon/queue.json`

```ts
interface DaemonQueue {
  repository: RepositoryRef;        // { owner, repo }
  issues: number[];                 // full ordered list — immutable after start
  currentIndex: number;             // index of issue currently running (or next to run)
  startedAt: string;                // ISO 8601
  completedRuns: {
    issueNumber: number;
    outcome: "PR_OPEN" | "BLOCKED" | "NEEDS_REFINEMENT" | "FAILED";
    completedAt: string;            // ISO 8601
    runId: string;                  // links to the M1 artifact store entry
  }[];
}
```

Written atomically on every state transition: write to `queue.json.tmp`, then `fs.renameSync` to `queue.json`. `currentIndex` advances only after a run reaches a terminal state. The `issues` array is never mutated after initial write.

### 7.3 Log file

**Path:** `~/.local/share/pi-autopilot/daemon/daemon.log`

Timestamped plain-text lines. Human-readable, not JSON. Example:

```
2026-08-21T10:45:00Z [INFO]  daemon started pid=12345 queue=[28,29,30]
2026-08-21T10:45:01Z [INFO]  reconciliation: no interrupted runs found
2026-08-21T10:45:02Z [INFO]  starting run issue=28
2026-08-21T11:12:34Z [INFO]  run complete issue=28 outcome=PR_OPEN
2026-08-21T11:12:35Z [INFO]  starting run issue=29
2026-08-21T11:34:00Z [INFO]  SIGTERM received — finishing current stage
2026-08-21T11:34:45Z [INFO]  daemon exiting cleanly after stage boundary
```

**Rotation:** when `daemon.log` exceeds 10 MB, rename to `daemon.log.1` (overwriting any previous `.1`) and open a fresh `daemon.log`. Single-threaded Node.js event loop makes this race-free.

## 8. Error handling and edge cases

| Scenario | Behaviour |
|---|---|
| Issue not READY when daemon picks it up | Readiness gate inside `RunService` fails; run ends NEEDS_REFINEMENT or BLOCKED; daemon logs and continues to next issue |
| All issues exhaust without PR_OPEN | Daemon logs summary, exits 0, deletes PID file; `status` shows all outcomes |
| Daemon already running on `start` | `start` sends signal 0 to stored PID, confirms alive, prints error, exits 1; no spawn attempted |
| Stale PID file (crash without cleanup) | `start` sends signal 0, gets ESRCH, deletes stale file, logs warning, spawns normally; `RecoveryService` handles interrupted run on new daemon startup |
| `--from-analyze` with no READY issues | `start` prints `"no READY issues in report <id>"`, exits 1; no spawn |
| `--from-analyze` without prior report | `start` prints `"no analyze report found — run autopilot analyze first"`, exits 1 |
| SIGTERM mid-run | Sets `stopRequested`; daemon completes current agent stage, flushes `queue.json`, deletes PID file, exits 0 |
| `stop` with no daemon running | Reads PID file (or finds none), prints `"no daemon running"`, exits 1 |
| `stop` timeout (daemon does not exit in 10 s) | Prints `"daemon did not stop within 10s (PID 12345) — kill manually"`, exits 1 |
| Resume fails on startup | Marks interrupted run FAILED, logs reason, continues with queue |

## 9. Out of scope for M3

Deliberately deferred:

- **Concurrent execution** of multiple issues. M4. M3 is strictly sequential.
- **Workspace-conflict detection** between parallel runs. M4.
- **Automatic issue selection** from the open backlog without a prior `analyze` pass. M4 scheduler.
- **Appending issues to a running queue.** Queue is immutable after `start`; stop and restart with a new list.
- **GitHub readiness markers** (`agent:ready` labels). M4 runner that claims tasks.
- **Web dashboard or rich TUI.** M5 observability.
- **Automatic merging.** M5 governance.
- **Budget enforcement across the queue** (total token spend cap for a multi-issue run). M4.

## 10. Acceptance criteria

M3 is complete when `autopilot start` demonstrates that:

1. `start <list>` resolves the issue list, spawns a detached daemon, exits immediately, and the daemon is visible via `autopilot status`.
2. `start --from-analyze` loads the most recent (by `generatedAt`) or named BacklogReport's `executable` list and uses it as the queue; exits 1 if no report exists for the repository or the list is empty.
3. The daemon works through the queue sequentially, one issue at a time, calling `RunService` for each.
4. Each run's outcome (PR_OPEN, BLOCKED, NEEDS_REFINEMENT, FAILED) is recorded in `queue.json` and visible in `autopilot status`.
5. On daemon restart after a crash, `RecoveryService` auto-resumes any interrupted run before the queue continues; a non-resumable interrupted run is marked FAILED and the queue proceeds.
6. `autopilot stop` sends SIGTERM; the daemon finishes the current agent stage, flushes state, deletes the PID file, and exits 0.
7. SIGTERM received mid-run never kills a Pi session mid-flight — the current stage always completes.
8. `autopilot start` exits 1 with a clear error if a live daemon is already running.
9. A stale PID file (process gone) is detected and cleaned up transparently on the next `start`.
10. `autopilot status` renders the daemon block (PID, uptime, current issue + stage, queue, completed runs) when a daemon is running, and falls back to today's output when none is running.
11. The full M1+M2 suite remains green, `npm run typecheck` and `npm run build` pass, and `npm test` covers the new daemon module and `start`/`stop` commands.

## 11. Deferred (whole-project reminders)

Consistent with M1 §16 and M2 §10, these remain out of scope for the whole effort and are owned by later milestones: automatic merging, dedicated verifier agents, dynamic model routing/fallback, automatic plan evolution, multi-machine/container execution, and a web dashboard.
