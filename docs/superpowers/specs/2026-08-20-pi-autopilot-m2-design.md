# Pi Autopilot: Milestone 2 Design — Backlog Analyst

**Date:** 2026-08-20
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

Milestone 1 delivered a supervised task runner: a human selects one issue, Autopilot checks or prepares it, runs it in an isolated worktree, reviews and verifies, then opens a PR. M2 moves from *one issue* to *the backlog*: it answers, non-destructively, "given an epic (or a set of issues), which tasks are ready to execute, which need more specification, which are blocked, and which are ambiguous?"

M2 is **read-only against GitHub**. It analyzes existing epics and tasks, proposes **nothing** — it records readiness and identifies executable work without mutating the backlog. Issue augmentation remains the separate, human-gated M1 `prepare` flow. M2 produces an actionable, inspectable backlog report that a future milestone (M3/M4 runner or scheduler) can act on.

## 2. Milestone context

The long-term design (see M1 spec §2) decomposes development into milestones:

| Milestone | Outcome |
|---|---|
| M1 — Supervised Task Runner | One issue: check/prepare → isolated run → review/verify → PR. *(done)* |
| **M2 — Refinement and Readiness** | **Analyze existing epics and tasks, propose issue augmentation, record readiness, and identify executable work without silently changing product scope.** *(this spec)* |
| M3 — Durable Autonomous Runner | Background operation, crash recovery, budgets, resumable runs, unattended selection of one task at a time. |
| M4 — Epic Scheduler | Explicit dependencies, multiple executable tasks, controlled concurrency, workspace-conflict prevention, epic progress reporting. |
| M5 — Adaptive Planning and Governance | Staleness detection, replanning, richer escalation/security policy, optional auto-merge, end-to-end traceability. |

Key boundary fact: **M2 is not a continuation of the runner.** The runner's vertical slice is complete in M1. M2 delivers the *proactive/automatic* backlog-analysis capability, as the first step toward the M3/M4 scheduler. M2 deliberately does **not** implement bulk refinement application, GitHub readiness markers, or task selection — those belong to later milestones and are enumerated in §8.

## 3. Scope decisions (approved in brainstorming)

These decisions shape the whole M2 design:

1. **Backlog-analyst-first.** M2's primary deliverable is a read-only backlog analyst: scan a set of issues, classify each, identify executable work. Augmentation stays the per-issue, approval-gated M1 `prepare` flow.
2. **Input shapes (primary, then secondary):**
   - Primary: a single **epic reference** — analyze all tasks *inside* its body that resolve to real GitHub issues.
   - Secondary: an **explicit list** of issue references.
   - Deferred: repository-wide auto-discovery of the entire open backlog (M4 scheduler concern).
3. **Report-first output.** The analyst produces a durable per-run report (human-readable + `--json`), inspectable later. It does **not** write readiness back into GitHub (that is mutation, and belongs with the M3 runner that claims ready tasks).
4. **Resolvable issues only.** The analyst analyzes entries that resolve to existing GitHub issues. Prose-only checklist bullets are reported as unresolved but never scaffolded or turned into new issues (bulk backlog editing is a later milestone; requirements §3/§5.1 say preserve and adopt existing backlog, don't recreate).
5. **Heuristic screen first, refiner only for candidates.** The analyst runs a cheap deterministic screen over every issue; a full refiner session is launched only for issues in a candidate band (or all of them under `--deep`). This keeps M2 fast and cheap over an epic while reserving refiner spend (§5-min sessions) for issues that genuinely need it.

## 4. Command interface

New command:

```text
autopilot analyze <ref> [more-refs...]

# Epic ref: analyze tasks referenced by epic issue #28
autopilot analyze 28

# Explicit set
autopilot analyze 28 29 30
autopilot analyze owner/repo#28 owner/repo#29

# Options
--deep         run a full refiner session on every issue
--json         emit the report as machine-readable JSON
--min-ready N  exit non-zero if fewer than N issues are ready
```

Inside the target repository, an epic/issue ref is a bare number, or `owner/repo#number` matching the local origin (same resolution rule as M1 `check`). An epic ref and an explicit list are interchangeable inputs: all reduce to "a set of issues to analyze."

### 4.1 Exit codes

| Code | Meaning |
|---|---|
| `0` | All issues ready (or `--min-ready` satisfied). |
| `2` | At least one issue needs refinement (or `--min-ready` unsatisfied). |
| `1` | Infrastructure/argument error. |

## 5. Behavior of `autopilot analyze`

1. Resolve the local repository and GitHub origin.
2. Resolve the requested refs: for a single epic ref, read the epic body's task checklist, collect entries that resolve to real issues, and de-dupe; for an explicit list, resolve each ref directly. Prose-only checklist items are listed in the report as `unresolved` but not analyzed.
3. Load repository policy (`.pi/autopilot.yaml`) for model/budget resolution, exactly as M1 `check` does.
4. For each issue in scope, run the **heuristic screen** (§6.1). Deterministic, no Pi session.
5. Decide the refiner band (§6.2): which issues also get a refiner session. By default only candidates; under `--deep`, every issue.
6. For refined issues, reuse M1's `ReadinessService` (same prompt, model resolution, deterministic gate) and persist the per-issue readiness report as today.
7. Assemble a `BacklogReport` (§7) covering all issues, persist it as a durable run artifact, and render a human-readable summary (or `--json`).
8. **Never mutate GitHub.** `analyze` is strictly read-only: it does not update issues, does not write refinement sections, does not create workspaces.

## 6. Architecture and module boundaries

New module `src/analysis/backlog-analyst.ts` orchestrates the set-level pass. It composes existing M1 pieces (GitHub port, artifact store, `ReadinessService`, refiner model resolution, `fake-pi` in tests) rather than introducing new contracts.

```text
src/commands/analyze.ts            CLI wiring (mirrors check.ts)
src/analysis/backlog-analyst.ts    set orchestration, report building
src/analysis/heuristic-screen.ts   cheap deterministic triage
src/analysis/issue-set.ts          resolve epic body / explicit list → issue set
src/domain/backlog.ts              BacklogReport + classification types
tests/unit/analysis/*              heuristic screen, resolvers, analyst, command
```

### 6.1 Heuristic screen (`heuristic-screen.ts`)

A pure, deterministic function from an issue body (plus repository/config context) to a classification with reasons. No Pi session, no network beyond reading the issue:

- **Wants a refinement pass** if the issue lacks an objective marker / autopilot-refinement section / acceptance-criteria markers.
- **Wants a refiner if it is a candidate** (§6.2).
- **Blocked (dependency)** if it references unsatisfied dependencies (explicit `(#n)` references whose target is not closed/ready).
- **Ambiguous (product)** if it surfaces product-ambiguity signals (conflicting requirements wording, unresolved product questions), matching the M1 `PRODUCT_AMBIGUITY` concept.
- **Ready** if it already carries a valid autopilot-refinement execution contract.

The screen returns a labeled classification plus the *reasons* it selected (so the report is transparent, never a black box). It is deliberately conservative: a screen `READY` only when a valid execution contract is already present; anything uncertain falls through to a band that either gets a refiner (candidate) or is reported as needing refinement.

### 6.2 Refiner band

Non-`--deep`: a refiner session is launched only for issues whose screen lands in the **candidate** band — issues that are plausibly near-ready and where a refiner could resolve engineering ambiguity or draft a missing contract, but not:

- issues already cleanly READY (a refiner would be wasted), nor
- issues that clearly lack everything (a refiner would confirm the obvious; the screen already answers it).

The exact candidate classification is deterministic and defined in the heuristic screen. The threshold is tunable — see §6.3.

`--deep` forces a refiner session (and the full M1 readiness gate) on every issue, effectively "batch `check`."

### 6.3 Tunables

- The candidate-band threshold is a named constant in the heuristic screen, adjustable in code. It is **not** a CLI flag and **not** a new policy schema field in M2 — the `budgets.refiner.timeoutMinutes` knob from M1 already controls refiner cost, and a dedicated M2 policy section plus a CLI tunable are deferred until a user reports needing them.

## 7. Report model (`src/domain/backlog.ts`)

```ts
type BacklogClassification =
  | "READY"            // passes the gate (screen READY, or refined+gate READY)
  | "NEEDS_REFINEMENT" // needs a contract / more specification
  | "BLOCKED"          // unsatisfied dependencies
  | "AMBIGUOUS"        // unresolved product ambiguity
  | "SKIPPED";         // not analyzed (e.g. unresolvable prose bullet)

interface BacklogReport {
  repository: RepositoryRef;
  epicRef?: number;              // when the input was a single epic
  requestedRefs: number[];       // as resolved
  generatedAt: string;
  scope: {
    totalIssues: number;
    analyzed: number;
    unresolved: number;          // prose bullets not resolvable to issues
  };
  issues: {
    issueNumber: number;
    title: string;
    url: string;
    classification: BacklogClassification;
    screen: Record<string, unknown>;          // deterministic screen reasons
    readiness: ReadinessReport | null;        // when a refiner ran
  }[];
  executable: number[];          // the "identify executable work" output (resolved source order)
  needsWork: number[];
  summary: {
    ready: number;
    needsRefinement: number;
    blocked: number;
    ambiguous: number;
    skipped: number;
    unresolved: number;
  };
  refinerSessions: number;       // observability: how expensive the pass was
}
```

`executable` is the M2 deliverable: the list (in resolved source order) of ready, gate-passing issues that a future M3/M4 runner could select from. Classifications map 1:1 to M1's `ReadinessStatus`, extended with explicit set-level `BLOCKED`/`AMBIGUOUS`/`SKIPPED` so the report is actionable.

The report is written to the durable run store / artifact store, so it is inspectable via the M1 inspect surface rather than only shown on the console.

## 8. Out of scope for M2

Deliberately deferred (enumerated so the first slice stays focused):

- **Applying issue augmentation in bulk** (editing many issue bodies). Stays human-gated per-issue via M1 `prepare`. Bulk *apply* is a later milestone.
- **GitHub readiness markers** (`agent:ready` on the issue). This is mutation and belongs with the M3 runner that actually claims ready tasks.
- **Repository-wide auto-discovery** of the whole open backlog, and **automatic selection** of the next task. M4 scheduler.
- **Concurrent analysis** of multiple issues. M2 runs a single pass over a set sequentially. M4 adds concurrency.
- **Epic-level semantic analysis** beyond enumerating its tasks — coherence, task overlap, obsolete-task detection, missing-dependency proposals (§5.2 of requirements). A natural M2 follow-on, not the first slice.
- **A dedicated verifier / new agent roles.** M2 adds no roles; it reuses the M1 refiner.

## 9. Acceptance criteria

M2 is complete when `autopilot analyze` demonstrates that:

1. `analyze <epic>` enumerates the epic's referenced task issues from its body, de-dupes, and analyzes exactly the resolvable ones, listing unresolvable prose bullets as `SKIPPED` without scaffolding them.
2. `analyze <list>` analyzes the explicit set.
3. The heuristic screen classifies each issue deterministically (READY / NEEDS_REFINEMENT / BLOCKED / AMBIGUOUS) with transparent reasons and zero Pi sessions for non-candidate issues.
4. A refiner session runs only for candidate issues by default, and for every issue under `--deep`.
5. Refined issues pass through the **same deterministic readiness gate** as M1 `check`; screen/refiner outcomes never override the gate.
6. The command is **read-only**: it never mutates GitHub, writes no refinement section, and creates no workspace.
7. A durable `BacklogReport` (with `executable`, `needsWork`, and `summary`) is persisted and inspectable.
8. `--json` emits the report as machine-readable JSON; exit codes follow §4.1; `--min-ready` fails non-zero below the threshold.
9. The full M1 suite remains green, `npm run typecheck` and `npm run build` pass, and `npm test` covers the new analysis module and `analyze` command.

## 10. Deferred (whole-project reminders)

Consistent with M1 §16, these remain out of scope for the whole effort and are owned by later milestones: automatic merging, dedicated verifier agents, dynamic model routing/fallback, automatic plan evolution, multi-machine/container execution, and a web dashboard.
