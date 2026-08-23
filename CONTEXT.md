# Pi Autopilot

An autonomous executor that turns GitHub issues into merged, reviewed work: it selects executable tasks from a backlog, runs an isolated agent against each, and reports status back to GitHub.

## Language

**Readiness**:
A computed, stateless property of an issue: whether it passes the checklist (unambiguous objective, testable acceptance criteria, satisfied dependencies, bounded scope, etc.) that qualifies it for autonomous execution. Re-derivable at any time; not itself a mutation.
_Avoid_: "ready" as a synonym for claimed — readiness and claiming are different lifecycles (see **Claim**).

**Claim**:
A mutex asserted on an issue once an executor commits to working it, represented as a GitHub label transition (`agent:ready` → `agent:in-progress`). Exists for best-effort human and cross-machine coordination, not as a hard distributed lock — concurrent writers can still race; that risk is accepted rather than engineered away.
_Avoid_: "lock" (implies stronger guarantees than intended), "reservation"

**Analyze**:
The strictly read-only command that computes readiness for a set of issues and reports it (human text or JSON); never mutates GitHub.
_Avoid_: using "analyze" to mean anything that writes back

**Discover**:
The mutating counterpart to Analyze: reuses the same readiness computation but also writes/removes the `agent:ready` label on GitHub to reflect current state, replacing the need for a prior Analyze pass before selecting work. Scoped like Analyze, by explicit ref(s) passed on each invocation — not a persistent background poll.
_Avoid_: conflating with Analyze; Discover mutates, Analyze does not

**Queue**:
The ordered list of issue numbers a running daemon executes sequentially. Immutable at `start` time in the sense that its original contents are never reordered or removed — but see **Pending queue** for how new work joins a live run.
_Avoid_: implying the queue can never grow — it can, via the pending queue

**Pending queue**:
A separate, additions-only file that `queue add` writes to and the daemon drains once per loop iteration, merging new issue numbers onto the tail of the live queue (FIFO, deduplicated against the full existing queue). Keeps the daemon as sole writer of `queue.json`, avoiding races on the queue's own state.
_Avoid_: writing directly to `queue.json` from outside the daemon

**Just-in-time claim**:
The rule that an issue's claim transition happens only immediately before the daemon begins executing it — never for the whole queue at once at `start`/`queue add` time. Keeps GitHub's visible state honest: only the issue actually in progress shows as claimed.
