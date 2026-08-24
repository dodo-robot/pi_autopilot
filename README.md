# Pi Autopilot

A supervised TypeScript/Node.js CLI that runs a GitHub issue through bounded
Pi implementation, deterministic verification, and independent review in an
isolated Git worktree, then opens a pull request.

Autopilot is an external control plane: Pi sessions are bounded, role-specific
workers — they never own durable workflow state. Full design:
`docs/superpowers/specs/`.

---

## Prerequisites

- **Node.js 22.5+** (`node --version`) — ESM-only.
- **GitHub CLI** (`gh`), installed and authenticated (`gh auth status`).
  Autopilot resolves its token via `gh auth token`.
- **Pi CLI** (`pi`), installed and authenticated for headless sessions.
- A local clone of the target repository with a `github.com` `origin` remote.
- A valid `.pi/autopilot.yaml` in the target repository
  (see [Policy reference](#policy-reference) and `examples/autopilot.yaml`).

Autopilot validates all of the above — and per-role model availability — during
preflight, before creating any workspace.

---

## Installation

```bash
npm install
npm run build
npm link        # installs the `autopilot` command globally
```

Run `autopilot` from inside the target repository, or use `--cwd` for the
working directory. For development without linking:

```bash
npx tsx src/cli.ts <command>
# or
npm run start -- <command>
```

---

## Workflow

```text
autopilot check <issue>      # read-only readiness assessment
autopilot prepare <issue>    # draft + preview + approve an issue update
autopilot check <issue>      # re-check; expect READY
autopilot run <issue>        # execute the ready task end to end
```

`check` never mutates GitHub. `prepare` shows a unified diff of the proposed
change to a **managed section** of the issue body and requires explicit
approval before writing anything. `run` creates an isolated worktree, runs
the implementation/verification/review pipeline, and opens a PR on success.

---

## Commands

| Command | Description |
|---|---|
| `check <issue>` | Read-only readiness assessment |
| `prepare <issue>` | Draft + approve a managed issue update |
| `run <issue>` | Execute a ready issue end to end (`--fresh` discards any prior run) |
| `analyze <ref>` | Assess backlog readiness across an epic or issue set (read-only) |
| `reconcile <epic>` | Propose a backlog patch plan against requirement docs and the repository (read-only, always dry-run) |
| `bootstrap --plan` / `--apply <plan-id>` | Seed a project backlog from requirement documents: infer epics/issues/dependency waves via the brainstorming skill, then apply them to GitHub as a Projects v2 board + issues |

> **`bootstrap --plan` is interactive (HITL).** It loads the superpowers
> brainstorming skill and asks the operator clarifying questions one at a time
> as it structures the backlog. Run it in a terminal; answer each
> `[bootstrapper asks]` prompt on the same line. There is no auto-answer mode.
| `status <run-id>` | Current stage and next valid action |
| `inspect <run-id>` | Snapshot, evidence, model usage, history |
| `resume <run-id>` | Fresh correction attempt for a `BLOCKED` or `FAILED` run |
| `abandon <run-id>` | Mark a run `CANCELLED` (keeps worktree/branch) |

`<issue>` accepts a bare number or `owner/repo#number`. All commands accept
`--json` for machine-readable output.

**Exit codes** — `0` success, `1` thrown error, `2` soft failure
(`NEEDS_REFINEMENT`, `BLOCKED`, zero executable work, etc.).

---

## Readiness contract

`run` proceeds only when an issue's content yields:

- an unambiguous objective (one concrete outcome);
- expected behavior — at least one observable behavior after implementation;
- testable acceptance criteria — at least one, each with an `id`;
- at least one automated validation command (manual-only blocks readiness);
- all referenced GitHub issues listed as dependencies;
- no unresolved **product** ambiguity (engineering ambiguity is resolved by
  the refiner inspecting the repository).

Missing fields produce `NEEDS_REFINEMENT` with actionable gaps. Fix them with
`prepare`, then `check` again.

---

## Model resolution

Models are selected per role (`refiner`, `implementer`, `reviewer`).
Precedence (highest first):

1. CLI flags — `--model`/`--thinking` (all roles); `--<role>-model`/`--<role>-thinking` (one role).
2. Repository config — `agents:` section of `.pi/autopilot.yaml`.
3. Default — `anthropic/claude-sonnet-4` at `thinking: high`.

The resolved model is recorded per attempt (`autopilot inspect <run-id> --json`).

```bash
# Override every role:
autopilot run 42 --model openai/gpt-5.2 --thinking high

# Override only the implementer:
autopilot run 42 --implementer-model anthropic/claude-opus-4 --implementer-thinking max
```

---

## Policy reference

Every participating repository needs a `.pi/autopilot.yaml`. Start from
`examples/autopilot.yaml` (fully commented). Key fields:

| Section | Field | Meaning |
|---|---|---|
| `version` | | Must be `1`. |
| `workspace` | `baseBranch` | Base branch for worktrees (default `main`). |
| | `branchPrefix` | Branch prefix (default `autopilot/`). |
| | `requireCleanCheckout` | Refuse dirty primary checkout (default `true`). |
| | `retainBlockedWorktree` | Keep worktree on block/fail (default `true`). |
| `commands` | `setup` | Commands run once before implementation. |
| | `verify` | Commands run after each attempt — **required**. |
| `agents` | `refiner`/`implementer`/`reviewer`/`reconciler` | Optional `{ model, thinking }` per role. |
| `agentPolicy` | `allowedCommands` | Executable names the implementer's `bash` tool may invoke. |
| | `protectedPaths` | Paths no tool call may touch. |
| `budgets` | `refiner.timeoutMinutes` | Refiner session timeout (default 5 min). |
| | `reconciler.timeoutMinutes` | Reconciler session timeout (default 10 min). |
| | `implementation.timeoutMinutes`/`maxAttempts` | Implementer timeout and max attempts. |
| | `review.timeoutMinutes`/`maxCorrectionCycles` | Reviewer timeout and max correction cycles. |
| `publication` | `draftPr` | Open PR as draft. |
| | `issueComment` | `concise` only in M1. |
| `reconciliation` | `requirementsPaths` | Files/directories of requirement docs for `reconcile`. Omitted → `requirements.md` at the repo root if present, else none. |

---

## Artifacts and data location

State lives under `~/.local/share/pi-autopilot/` (override with
`AUTOPILOT_DATA_DIR`):

```text
~/.local/share/pi-autopilot/
├── autopilot.db          # SQLite: runs, stages, attempts, transitions
└── runs/
    └── <run-id>/
        ├── task-snapshot.json
        ├── <role>-<n>/{session,diagnostics}/
        ├── verification-<n>.json
        └── review-<n>.json
```

`autopilot inspect <run-id>` is the primary interface. All output passes
through redaction: sensitive keys and secret-shaped values (`ghp_…`, `Bearer …`,
etc.) are replaced with `[REDACTED]`.

---

## Handling blocked and failed runs

**`BLOCKED`** — useful work exists but needs human input (exhausted budget,
`NEEDS_REPLAN`, etc.). Worktree is preserved.

**`FAILED`** — a non-readiness stage errored mid-flight. Worktree is preserved.

```bash
autopilot status <run-id>         # see stage and next action
autopilot inspect <run-id> --json # full evidence (redacted)
autopilot resume <run-id>         # fresh attempt in the preserved worktree
autopilot abandon <run-id>        # give up, keep worktree for manual diagnosis
```

`resume` starts a fresh session — no hidden conversational context — and
carries over attempt/cycle budgets. For a `FAILED` run, it re-verifies the
existing implementation before retrying the interrupted role.

**Full restart** (when resumes aren't converging):

```bash
autopilot run <issue> --fresh     # discards prior worktree and run record
```

---

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit + integration (vitest run)
npm run build         # tsc -> dist/
npm run check         # typecheck && test && build
```

### Acceptance suite

```bash
npm run build          # required: compiles dist/testing/fake-pi.js
npm run test:e2e
```

The acceptance suite exercises the compiled CLI against real temporary Git
repositories and a bare remote, replacing only two external services:

- **GitHub** — an in-memory fake injected via `createGitHub`.
- **Pi** — the real `PiRunner` pointed at `dist/testing/fake-pi.js`, which
  reads a JSON scenario file (keyed by role and attempt) to script results,
  worktree mutations, timeouts, or malformed output. The scenario path travels
  as a `FAKE_PI_SCENARIO:<path>` marker in the issue body — the same path a
  real prompt would carry any other context.

---

## Milestone progress

See [`docs/MILESTONES.md`](docs/MILESTONES.md) for milestone status,
scope, and deferred work.
