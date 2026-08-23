---
status: accepted
---

# Best-effort GitHub claim marker, not a distributed lock

The M4 "continuous backlog intake" work needs a GitHub-visible signal that an issue is being autonomously worked, so a human browsing GitHub (or a second pi-autopilot checkout on another machine) doesn't duplicate the effort. We chose a plain label transition — `agent:ready` → `agent:in-progress`, written by a new `discover` command and released just-in-time by the daemon around each issue it executes — rather than a real distributed lock. GitHub labels aren't compare-and-swap, so two writers can still race; we accept that risk rather than build coordination machinery, consistent with M3/M4's existing "reliability over autonomy" scope calls elsewhere in this project.

## Considered Options

- **Distributed lock** (e.g. requiring a successful atomic write before proceeding) — rejected: GitHub's label API offers no compare-and-swap primitive, and true multi-runner safety is exactly the concurrency work already deferred to later M4 scheduling.
- **Claim the whole queue upfront at `start`/`queue add` time** — rejected: would show queued-but-untouched issues as "in progress" to anyone checking GitHub, which is worse than no signal at all for the human-coordination purpose. We claim just-in-time, one issue at a time, instead.
- **Automatic expiry of stale claims** (timestamp + threshold) — rejected for now: a wrong auto-expiry (reclaiming a still-running issue too early) is a worse failure mode than requiring a human to manually remove an orphaned label after a crash.

## Consequences

- A crashed or killed daemon can leave an issue stuck on `agent:in-progress` with no automatic recovery; unsticking it is a manual step until real scheduling/ownership work lands.
- `analyze` remains strictly read-only; `discover` is introduced specifically as its mutating sibling so the read/write split stays explicit rather than blurring `analyze`'s existing contract.
