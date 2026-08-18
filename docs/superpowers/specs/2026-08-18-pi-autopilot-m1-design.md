# Pi Autopilot: Milestone Decomposition and Milestone 1 Design

**Date:** 2026-08-18  
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

Pi Autopilot will provide bounded autonomous software development based on explicit, durable project state. It will repeatedly give role-specific Pi sessions well-defined jobs, validate their structured results, and advance an explicit workflow. It will not rely on one indefinitely running conversational context to manage an entire project.

The long-term vision includes backlog refinement, dependency-aware scheduling, recovery, concurrency, replanning, and policy-driven automation. The first implementation will prove a smaller supervised vertical slice before adding those capabilities.

## 2. Milestone decomposition

Development will follow a vertical capability progression.

| Milestone | Outcome |
|---|---|
| **M1 — Supervised Task Runner** | A human selects one issue. Autopilot checks or prepares it, creates an isolated worktree, runs implementation and bounded corrections, independently reviews and verifies the result, then opens a PR. |
| **M2 — Refinement and Readiness** | Analyze existing epics and tasks, propose issue augmentation, record readiness, and identify executable work without silently changing product scope. |
| **M3 — Durable Autonomous Runner** | Add background operation, crash recovery, abandoned-session reconciliation, execution budgets, resumable runs, and unattended selection of one task at a time. |
| **M4 — Epic Scheduler** | Add explicit dependencies, multiple executable tasks, controlled concurrency, workspace-conflict prevention, and epic progress reporting. |
| **M5 — Adaptive Planning and Governance** | Add staleness detection, replanning, richer escalation and security policy, optional automatic merging, and end-to-end requirements traceability. |

This sequence proves the riskiest integration end to end before introducing scheduling infrastructure. M1's task snapshots, workflow states, agent contracts, and evidence records must remain usable foundations for later milestones.

## 3. Milestone 1 scope

M1 is a TypeScript/Node.js CLI started explicitly by a developer from a clean existing local clone. It assumes:

- the repository has a GitHub `origin`;
- GitHub CLI (`gh`) is installed and authenticated;
- Pi CLI is installed, authenticated, and can launch bounded headless sessions;
- the repository contains a valid `.pi/autopilot.yaml` policy;
- implementation uses a dedicated sibling Git worktree and branch;
- merging and issue closure remain human decisions.

M1 supports these commands:

```text
autopilot check <issue>
autopilot prepare <issue>
autopilot run <issue>
autopilot status <run-id>
autopilot inspect <run-id>
autopilot resume <run-id>
autopilot abandon <run-id>
```

Inside the target repository, `<issue>` may be an issue number. A full `owner/repo#number` reference is also accepted but must match the repository's GitHub `origin`.

## 4. Architecture

Autopilot is an external control plane. Pi sessions are bounded workers, not owners of durable workflow state.

```text
CLI
 │
 ├── GitHub adapter ───── gh authentication and GitHub API
 ├── Readiness service ── check, prepare, and task snapshots
 ├── Workflow engine ──── explicit transitions and budgets
 ├── Pi runner ────────── bounded role-specific headless sessions
 ├── Workspace manager ── branches and sibling worktrees
 ├── Verification runner ─ repository-configured commands
 ├── PR publisher ─────── commit, push, PR, and concise issue comment
 └── Run store ────────── local SQLite state and evidence
```

The workflow engine depends on interfaces for GitHub, Pi, Git, verification, and persistence. Tests can replace each adapter without launching real agents or mutating real repositories.

### 4.1 Ownership boundaries

**The orchestrator owns:**

- readiness decisions after structured analysis;
- durable workflow transitions and budgets;
- worktree and branch lifecycle;
- commits, pushes, and PR creation;
- GitHub issue mutation;
- deterministic verification;
- recovery, resume, and abandonment.

**Pi agents own only their bounded role:**

- the refiner extracts and evaluates the execution contract;
- the implementer modifies its assigned worktree;
- the reviewer independently evaluates the diff against the frozen task.

**GitHub owns:** canonical issue and PR state.

**SQLite owns:** operational run state, attempts, session/model metadata, findings, and recovery information.

**`.pi/autopilot.yaml` owns:** versioned repository policy, commands, and role-specific model defaults.

## 5. Readiness and issue preparation

A task is ready only when it can be converted into a structured execution contract containing:

- an unambiguous objective;
- relevant context and expected behavior;
- testable acceptance criteria;
- constraints and useful non-goals;
- validation expectations;
- represented or satisfied dependencies;
- no unresolved product ambiguity that would materially affect behavior.

Engineering ambiguity, such as locating the responsible module or existing tests, does not necessarily make a task unready. Product ambiguity does.

### 5.1 `autopilot check`

`check`:

1. resolves the local repository and GitHub issue;
2. reads the issue, referenced specifications, repository guidance, and relevant repository context;
3. launches a bounded refiner session;
4. validates its structured result;
5. applies deterministic readiness rules;
6. returns `READY` or `NEEDS_REFINEMENT` with actionable gaps.

It never modifies GitHub.

### 5.2 `autopilot prepare`

`prepare` performs the same analysis and drafts an improved execution contract. It shows the issue-body diff and requires explicit developer approval before updating GitHub.

The original issue content is preserved. Autopilot updates only a managed section:

```markdown
<!-- autopilot-refinement:start -->
## Autonomous execution contract
<generated execution contract>
<!-- autopilot-refinement:end -->
```

A later `prepare` invocation replaces only this section. Bulk and automatic backlog refinement remain M2 concerns.

### 5.3 Preparing an initially unready issue

The expected workflow is:

```text
existing issue
    ↓
autopilot check
    ↓
structured readiness report
    ↓
autopilot prepare
    ↓
human reviews and approves proposed issue update
    ↓
autopilot check
    ↓
READY
    ↓
autopilot run
```

## 6. Execution workflow

A run freezes an immutable task snapshot and advances through explicit stages:

```text
PREFLIGHT
  → READINESS_CHECK
  → WORKSPACE_CREATION
  → IMPLEMENTATION
  → VERIFICATION
  → INDEPENDENT_REVIEW
  → [CORRECTION → VERIFICATION → INDEPENDENT_REVIEW] × 2
  → PUBLICATION
  → PR_OPEN
```

The frozen task snapshot includes the normalized execution contract, source issue identity and revision, canonical references, repository identity, and resolved repository policy. It records what the agents were asked to implement even if the issue later changes.

Before publication, Autopilot checks whether the source issue changed materially after snapshot creation. A material change blocks publication pending human review; it is not silently incorporated.

### 6.1 Terminal states

```text
PR_OPEN
NEEDS_REFINEMENT
BLOCKED
FAILED
CANCELLED
```

- `PR_OPEN`: review and verification passed, and publication succeeded.
- `NEEDS_REFINEMENT`: the task failed the readiness gate.
- `BLOCKED`: useful work is preserved but human input or a new bounded attempt is required.
- `FAILED`: infrastructure or an invariant failure prevents safe continuation.
- `CANCELLED`: the developer explicitly abandoned the run.

### 6.2 Resume

`autopilot resume <run-id>` reloads the frozen task snapshot, preserved branch and worktree, current diff, verification failures, and unresolved review findings. It starts a fresh bounded implementer session rather than continuing hidden conversational context.

A resume uses the recorded role configuration unless the developer explicitly overrides it. It creates a new attempt record and remains subject to configured budgets.

## 7. Agent contracts

Each role returns JSON matching a versioned role-specific schema. Human-readable prose may accompany the result, but workflow decisions use only validated structured fields. Malformed or unrecognized output cannot advance the run.

### 7.1 Refiner

Outcomes:

```text
READY
NEEDS_REFINEMENT
PRODUCT_AMBIGUITY
FAILED
```

The result includes the normalized task snapshot, missing information, represented dependencies, ambiguities, and suggested issue additions.

### 7.2 Implementer

Outcomes:

```text
COMPLETED
BLOCKED
NEEDS_REFINEMENT
NEEDS_REPLAN
FAILED
```

The result includes a summary, changed paths, commands attempted, unresolved problems, and evidence locations. `COMPLETED` advances only to verification; the implementer cannot approve its own work.

### 7.3 Reviewer

Outcomes:

```text
APPROVED
CHANGES_REQUESTED
PRODUCT_AMBIGUITY
FAILED
```

The result includes a disposition for each acceptance criterion and findings with severity, location, evidence, and requested correction.

Every review cycle uses a fresh session. The reviewer receives the frozen task snapshot, current diff, deterministic verification evidence, and relevant repository guidance. It does not receive the implementer's transcript or private reasoning.

A dedicated verifier agent is deferred. M1 uses independent model review plus orchestrator-run deterministic verification.

## 8. Model selection and budgets

Models are selected per role rather than per run. Resolution precedence is:

1. per-command CLI override;
2. repository role configuration;
3. Autopilot user defaults;
4. current Pi default model.

The resolved provider, model, thinking level, and available budget are recorded in each attempt. Preflight confirms that configured models are available before creating a worktree. A resumed attempt may explicitly use a different model.

Using a different model family for review is encouraged but not required. Reviewer independence comes from fresh context and independent evidence, not solely from model diversity.

Example configuration:

```yaml
agents:
  refiner:
    model: anthropic/claude-sonnet-4
    thinking: high
  implementer:
    model: anthropic/claude-sonnet-4
    thinking: high
  reviewer:
    model: openai/gpt-5.2
    thinking: high

budgets:
  implementation:
    timeoutMinutes: 60
    maxAttempts: 3
  review:
    timeoutMinutes: 20
    maxCorrectionCycles: 2
```

M1 does not dynamically route tasks or switch models after failure. Later policy milestones may add that behavior.

Each agent execution has bounded duration and, where Pi exposes them, turn/tool and token/cost limits. Equivalent failures are fingerprinted from the workflow stage, command, exit status, and normalized findings. Repetition or budget exhaustion transitions to `BLOCKED` rather than creating an uncontrolled retry loop.

## 9. Repository configuration and safety

Every participating repository must provide `.pi/autopilot.yaml`. Autopilot validates the file before readiness analysis or workspace creation and refuses to guess missing verification commands.

```yaml
version: 1

workspace:
  baseBranch: main
  branchPrefix: autopilot/
  requireCleanCheckout: true
  retainBlockedWorktree: true

commands:
  setup:
    - npm ci
  verify:
    - npm run lint
    - npm run typecheck
    - npm test

agentPolicy:
  allowedCommands:
    - npm
    - npx
    - node
    - rg
    - find
  protectedPaths:
    - .github/workflows/
  allowNetwork: false

publication:
  draftPr: false
  issueComment: concise
  autoMerge: false
```

The exact schema will be versioned. Unsupported schema versions fail preflight.

### 9.1 Safety controls

Agents are denied:

- `git push`, merge, reset, clean, and branch deletion;
- `gh` and direct GitHub mutation;
- access to unrelated worktrees;
- mutation of protected paths;
- undeclared environment secrets;
- commands outside repository policy.

The orchestrator refuses to operate on the primary working tree, protected branches, dirty checkouts when cleanliness is required, or a GitHub repository that does not match `origin`.

M1 uses sibling Git worktrees and a dedicated branch for each run. Failed and blocked worktrees are retained for diagnosis. Successful worktrees may be removed only after the PR is created and all evidence is durable.

## 10. Verification and review

Verification is deterministic and independent of implementer claims:

1. run configured setup commands in the isolated worktree;
2. run every configured verification command with an individual timeout;
3. capture command, bounded environment metadata, exit status, duration, and bounded output;
4. provide that evidence to the reviewer;
5. after corrections, rerun verification before starting a fresh review;
6. require the latest passing result to correspond to the exact tree that will be committed.

Manual-only acceptance criteria are not silently accepted. They make a task unready unless the repository defines an orchestrator-supported verification mechanism.

Review findings are returned to a fresh implementer session for at most two correction cycles. Review approval and passing verification are both required. Repeated findings, exhausted budgets, unresolved product ambiguity, or an inability to prove acceptance criteria transition to `BLOCKED`.

## 11. Persistence and recovery

Operational state lives outside the target repository:

```text
~/.local/share/pi-autopilot/
├── autopilot.db
└── runs/
    └── <run-id>/
        ├── task-snapshot.json
        ├── events.jsonl
        ├── verification/
        ├── reviews/
        └── session-results/
```

SQLite stores compact indexed state. Larger immutable evidence is stored in run artifacts referenced by the database.

Core records include:

- repositories and source issues;
- runs and current workflow stages;
- immutable task snapshot identities;
- attempts and resolved model configuration;
- Pi session/process identifiers;
- worktree and branch ownership;
- verification executions;
- review findings and dispositions;
- state-transition events;
- publication results.

Stage transitions and evidence references are recorded transactionally. A uniqueness constraint prevents multiple active M1 runs for the same repository issue.

M1 has no background daemon, but interruption is recoverable. At startup, Autopilot inspects nonterminal runs and reconciles the recorded Pi process/session, worktree, branch, Git state, and relevant GitHub state. It never assumes an interrupted side effect succeeded. For example, it checks GitHub before retrying a push or PR creation.

The developer may resume, inspect, or abandon a recovered run. Abandonment marks the run `CANCELLED` but does not delete its branch or worktree unless the developer separately requests cleanup.

## 12. GitHub behavior

M1 makes only these GitHub mutations:

1. `prepare` updates the managed refinement section after explicit confirmation.
2. A successful `run` pushes the orchestrator-created branch and opens a linked PR.
3. A successful `run` posts one concise source-issue comment with the run ID, PR link, and verification summary.

Blocked and failed runs remain local by default. M1 does not apply workflow labels, publish transcripts, close issues, merge PRs, or automatically publish partial branches.

The PR contains:

- the source issue and frozen task objective;
- an acceptance-criterion checklist;
- an implementation summary;
- verification commands and results;
- the independent review result;
- the Autopilot run ID.

Closing keywords are disabled in M1 unless a later policy explicitly enables them.

## 13. Operator experience and observability

Default CLI output shows concise stages, decisions, and evidence rather than raw agent transcripts:

```text
Run: 01JEXAMPLE      Issue: owner/repo#123
Task: Add token refresh validation

✓ Readiness         READY
✓ Workspace         autopilot/123-token-refresh
✓ Implementation    14 files changed
✓ Verification      3/3 commands passed
● Review             Reviewing acceptance criteria
○ Publication        Pending
```

- `status` shows current state and the next valid action.
- `inspect` shows task snapshots, verification output, review findings, model usage, and transition history.
- raw session output remains in local run artifacts for diagnosis;
- `--json` emits stable machine-readable command results;
- secrets and configured sensitive values are redacted before persistence.

## 14. Testing strategy

### 14.1 Unit tests

Unit tests cover:

- readiness rules and task-snapshot validation;
- workflow state transitions;
- budget and repeated-failure handling;
- model and configuration resolution;
- command-policy enforcement;
- managed issue-section updates;
- redaction and evidence serialization.

### 14.2 Integration tests

Integration tests use real temporary Git repositories and worktrees while replacing external Pi and GitHub services. They cover:

- SQLite persistence and interrupted-run reconciliation;
- workspace isolation and branch ownership;
- verification command execution and timeout handling;
- commit/tree identity before publication;
- blocked-run resume behavior;
- idempotent reconciliation of interrupted GitHub side effects.

### 14.3 End-to-end contract tests

A controllable fake Pi executable simulates:

- successful implementation and review;
- malformed structured output;
- timeout or crash;
- failed verification;
- requested corrections;
- repeated findings;
- product ambiguity.

An opt-in real-Pi smoke suite runs only when local credentials and configured models are available. The Pi adapter encapsulates exact headless invocation and output handling so Pi CLI/version differences do not leak into the workflow engine.

## 15. Milestone 1 acceptance criteria

M1 is complete when Autopilot demonstrates that:

1. `check` classifies ready and unready issues without mutation.
2. `prepare` previews a managed-section diff and updates only after approval.
3. Role-specific models resolve predictably and are recorded.
4. `run` completes a ready fixture issue in an isolated worktree.
5. Verification executes independently of agent claims.
6. A fresh reviewer can approve or request bounded corrections.
7. Unsafe, malformed, ambiguous, repeated, or budget-exhausted work stops explicitly.
8. Interrupted work can be inspected and resumed without duplicate execution or publication.
9. A successful run creates a commit, branch, PR, and concise issue comment.
10. The primary checkout, issue closure, and merge state remain untouched.

## 16. Deferred from Milestone 1

The following remain explicitly out of scope:

- automatic task selection;
- bulk backlog refinement;
- dependency scheduling;
- concurrent task execution;
- background daemon operation;
- automatic merging;
- dedicated verifier agents;
- dynamic model routing or fallback;
- automatic plan evolution;
- multi-machine or container execution;
- a web dashboard.

These capabilities belong to Milestones 2–5 and must not expand the first vertical slice.
