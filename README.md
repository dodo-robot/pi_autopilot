# Pi Autopilot

Pi Autopilot is a supervised, TypeScript/Node.js CLI that runs one GitHub
issue through bounded Pi implementation, deterministic verification, and
independent review in an isolated Git worktree, then opens a pull request.
It is an external control plane: Pi sessions are bounded, role-specific
workers, never owners of durable workflow state. See
`docs/superpowers/specs/2026-08-18-pi-autopilot-m1-design.md` for the full
design.

This is Milestone 1 (M1) — a supervised task runner for one issue at a
time, started explicitly by a developer — plus Milestone 2 (M2), a
read-only backlog analyst (`autopilot analyze`) that scans an epic or an
explicit issue set and records which tasks are ready to execute, without
mutating GitHub. See "M1 non-goals" below for what M1 deliberately does
not do yet.

## Prerequisites

- **Node.js 22.5+** (`node --version`). The CLI is ESM-only.
- **GitHub CLI (`gh`)**, installed and authenticated (`gh auth status`).
  Autopilot resolves its GitHub token from `gh auth token`; it never reads
  or stores a token itself.
- **Pi CLI (`pi`)**, installed and authenticated for headless sessions
  (`pi --version`). Autopilot launches `pi --print --mode json --approve
  --session-dir ... --model ... --tools ... --extension ...` for every
  role session.
- A local clone of the target repository with a GitHub `origin` remote
  (SSH or HTTPS, `github.com` only in M1).
- A valid `.pi/autopilot.yaml` policy file in the target repository (see
  "Policy reference" below; `examples/autopilot.yaml` is a complete
  starting point).

Autopilot refuses to start if any of these are missing: it validates the
repository's `origin`, the policy file, and (per role) model availability
during preflight, before creating any workspace.

## Installation and `npm link`

From this repository:

```bash
npm install
npm run build
npm link
```

`npm link` installs the `autopilot` command globally (backed by
`bin/autopilot.js` → the compiled `dist/cli.js`). Run `autopilot` from
inside the target repository's working directory — it resolves the
repository root, `origin`, and `.pi/autopilot.yaml` relative to the
current working directory (or `--cwd`-equivalent test overrides; there is
no CLI flag for this in M1, so `cd` into the repository first).

To develop Autopilot itself without linking, use `npx tsx src/cli.ts
<command>` from this repository, or `npm run start -- <command>`.

## The minimum issue execution contract

`autopilot run` only proceeds past readiness for an issue whose content
(as analyzed by the refiner and gated by deterministic rules) yields:

- an unambiguous objective — one concrete outcome;
- expected behavior — at least one observable behavior after
  implementation;
- testable acceptance criteria — at least one, each with an id;
- validation — at least one automated command or check (manual-only
  validation, e.g. "manually verify in the browser", is never sufficient
  and blocks readiness);
- every referenced GitHub issue represented under dependencies, with
  unresolved (`satisfied: false`) dependencies blocking readiness;
- no unresolved **product** ambiguity (a business-rule or user-facing
  behavior decision). Engineering ambiguity (which module owns a
  behavior, which existing tests cover an area) does not block readiness
  — the refiner is expected to resolve it by inspecting the repository.

If any of this is missing, `check` reports `NEEDS_REFINEMENT` with
actionable gaps (see `src/readiness/readiness-service.ts` for the full gap
catalog) instead of proceeding.

## Workflow: `check` → `prepare` → `check` → `run`

```text
existing issue
    ↓
autopilot check <issue>          # read-only readiness assessment
    ↓
NEEDS_REFINEMENT (with gaps)
    ↓
autopilot prepare <issue>        # draft + preview + approve an issue update
    ↓
human reviews the diff, approves
    ↓
autopilot check <issue>          # re-check; expect READY
    ↓
autopilot run <issue>            # execute the ready task end to end
```

`check` never mutates GitHub. `prepare` drafts an improved execution
contract and shows a unified diff of the proposed change to a **managed
section** of the issue body before asking for explicit approval; nothing
is written to GitHub until you approve (or `--json`, which only previews).
Once `check` reports `READY`, `run` executes the task in an isolated
worktree and opens a PR on success.

## Backlog reconciliation: `reconcile`

```text
requirement/architecture docs + existing epic + repository
    ↓
autopilot reconcile <epic>       # one reconciler session; always dry-run
    ↓
coverage map + typed patch plan (KEEP/ENRICH_ISSUE/CREATE_ISSUE/
ADD_DEPENDENCY/MARK_STALE/NEEDS_HUMAN)
```

`reconcile` answers a different question than `analyze`: not "is this issue
ready to run" but "does the epic's backlog, taken as a whole, actually
reflect the requirements and the repository — and if not, what should
change?" It never mutates GitHub in this milestone: every patch is a
proposal for a human to review, annotated with a deterministic
`auto-safe`/`requires-approval` classification that a future `apply-safe`
mode will act on. A second `reconcile` run over an unchanged epic downgrades
previously-proposed enrichments to `KEEP` rather than re-proposing them.

Requirement documents are resolved with the same precedence as model
overrides elsewhere: `--requirements <path>` (repeatable; a file or a
directory of top-level `*.md` files) overrides
`reconciliation.requirementsPaths` in `.pi/autopilot.yaml`; with neither
set, `requirements.md` at the repository root is used if present, otherwise
reconciliation proceeds with no requirement documents. An explicitly
configured or requested path that does not exist is a preflight error —
`reconcile` never silently reconciles with absent context it was told to
use.

See `docs/superpowers/specs/2026-08-22-backlog-reconciliation-design.md`
for the full design.

## CLI commands and exit codes

```text
autopilot check <issue>            # read-only readiness assessment
autopilot prepare <issue>          # draft + approve a managed issue update
autopilot run <issue>              # execute a ready issue end to end (--fresh discards any prior worktree/run and restarts)
autopilot analyze <ref>            # assess backlog readiness across an epic or explicit issue set (read-only)
autopilot reconcile <epic>         # propose a backlog patch plan against requirement docs (read-only, always dry-run)
autopilot status <run-id>          # current stage + next valid action
autopilot inspect <run-id>         # snapshot, evidence, model usage, history
autopilot resume <run-id>          # fresh correction attempt for a BLOCKED or FAILED run
                                    #  - BLOCKED: restart the implementer in the preserved worktree
                                    #  - FAILED:  re-verify the existing implementation, then retry the interrupted role at its resume_at stage
autopilot abandon <run-id>         # mark a run CANCELLED (keeps worktree/branch)
```

`<issue>` accepts a bare issue number or a fully-qualified
`owner/repo#number` reference, which must match the local repository's
`origin`.

Every command accepts `--json` for a stable, machine-readable result on
stdout; human-readable output is the default.

`check` and `prepare` also accept `--refiner-timeout <minutes>` to override
the refiner session timeout (falling back to the repository policy's
`budgets.refiner.timeoutMinutes`, then a 5-minute default).

| Command | Exit `0` | Exit `1` | Exit `2` |
|---|---|---|---|
| `check` | `READY` | thrown error (invalid ref, config, etc.) | `NEEDS_REFINEMENT` |
| `prepare` | always (declined/applied/`--json` preview) | thrown error, or the issue changed during analysis | — |
| `run` | `PR_OPEN` | thrown error | `NEEDS_REFINEMENT` or `BLOCKED` |
| `analyze` | executable work exists and no needs-refinement (or `--min-ready` satisfied) | argument/infrastructure error | zero executable work, any needs-refinement, or `--min-ready` unsatisfied |
| `reconcile` | report generated | thrown error (invalid ref, missing `--requirements` path, etc.) | — |
| `resume` | `PR_OPEN` | thrown error (including "not BLOCKED or FAILED") | `NEEDS_REFINEMENT` or `BLOCKED` |
| `status` | run found | run not found, or thrown error | — |
| `inspect` | run found | run not found, or thrown error | — |
| `abandon` | run marked `CANCELLED` | thrown error (including "already terminal") | — |

## Role-specific model resolution and overrides

Models are selected per role (`refiner`, `implementer`, `reviewer`), not
per run. Resolution precedence, highest first:

1. **CLI override** — `--model`/`--thinking` apply to every role;
   `--refiner-model`/`--refiner-thinking`,
   `--implementer-model`/`--implementer-thinking`,
   `--reviewer-model`/`--reviewer-thinking` override one role on top of
   the global flags (`run`/`resume` only; `check`/`prepare` only launch a
   refiner session, so they accept `--model`/`--thinking` without a role
   prefix).
2. **Repository role configuration** — the `agents:` section of
   `.pi/autopilot.yaml`.
3. **Autopilot user defaults** — reserved for a future per-user default
   config; not yet implemented in M1 (falls through to the next tier).
4. **Pi default model** — `anthropic/claude-sonnet-4` at `thinking: high`
   (`DEFAULT_PI_MODEL` in `src/config/load-config.ts`), used only when no
   higher-precedence tier resolves a role.

The resolved `{ model, thinking, source }` for every role is recorded with
each attempt (`autopilot inspect <run-id> --json` shows it under
`attempts[].model`/`attempts[].thinking`) and preflight-checked for
availability before a workspace is created.

```bash
# Override every role's model for one run:
autopilot run 42 --model openai/gpt-5.2 --thinking high

# Override only the implementer, leaving the reviewer at its
# repository-configured (or default) model:
autopilot run 42 --implementer-model anthropic/claude-opus-4 --implementer-thinking max
```

## Policy reference (`.pi/autopilot.yaml`)

Every participating repository must have a valid, versioned
`.pi/autopilot.yaml`. Autopilot validates it (via the schema in
`src/config/schema.ts`) before any readiness analysis or workspace
creation, and refuses to guess missing verification commands. Copy
[`examples/autopilot.yaml`](examples/autopilot.yaml) as a starting point —
it is a complete, schema-valid policy with a comment above every field.

| Section | Field | Meaning |
|---|---|---|
| `version` | | Must be `1`. Unsupported versions fail preflight. |
| `workspace` | `baseBranch` | Protected base branch every run's worktree is created from (default `main`). |
| | `branchPrefix` | Prefix for every run's dedicated branch (default `autopilot/`). |
| | `requireCleanCheckout` | Refuse to start a run when the primary checkout is dirty (default `true`). |
| | `retainBlockedWorktree` | Keep a blocked/failed run's worktree and branch on disk instead of deleting them (default `true`). |
| `commands` | `setup` | Commands run once, in order, before implementation. |
| | `verify` | Commands run after every implementation attempt; **required**, at least one. |
| `agents` | `refiner`/`implementer`/`reviewer` | Optional `{ model, thinking }` per role. Omitted roles fall through the precedence chain above. |
| | `reconciler` | Same shape as `refiner`/`implementer`/`reviewer` — optional `{ model, thinking }` for the reconciler role. |
| `agentPolicy` | `allowedCommands` | Bare executable names an implementer session's `bash` tool may invoke. Dangerous/dispatcher commands (`git push`, `gh`, `rm`, shells, etc.) are always denied regardless of this list. |
| | `protectedPaths` | Paths, relative to the worktree, no tool call may read, write, or otherwise touch. |
| | `allowNetwork` | Reserved; M1 has no network-allowlisting mechanism yet. |
| `budgets` | `refiner.timeoutMinutes` | Per-session timeout for a refiner session (`check`/`prepare`). Default 5 minutes. |
| | `implementation.timeoutMinutes`/`maxAttempts` | Per-session timeout and max implementer attempts before `BLOCKED`. |
| | `review.timeoutMinutes`/`maxCorrectionCycles` | Per-session timeout and max `CHANGES_REQUESTED` correction cycles before `BLOCKED`. |
| | `reconciler.timeoutMinutes` | Per-session timeout for a reconciler session (`reconcile`). Default 10 minutes. |
| `publication` | `draftPr` | Open the PR as a draft. |
| | `issueComment` | Only `concise` is supported in M1. |
| | `autoMerge` | Reserved; M1 never merges regardless of this value. |
| `reconciliation` | `requirementsPaths` | Files or directories (repository-relative) to read as requirement/architecture context for `reconcile`. Omitted → `requirements.md` at the repository root if present, else none. An explicit empty list (`[]`) means "no requirement documents," and is preserved as such. |

## Data, artifact location, and redaction

Operational state lives **outside** the target repository, under
`~/.local/share/pi-autopilot/` by default (override with
`AUTOPILOT_DATA_DIR`, mainly useful for tests):

```text
~/.local/share/pi-autopilot/
├── autopilot.db          # SQLite: runs, stages, attempts, transitions, publication records
└── runs/
    └── <run-id>/
        ├── task-snapshot.json
        ├── <role>-<n>/{session,diagnostics}/   # per-attempt Pi session + guard envelope + result
        ├── verification-<n>.json               # deterministic verification evidence
        └── review-<n>.json                     # reviewer findings
```

`autopilot inspect <run-id>` is the primary way to read this state; it
never prints raw secrets. Every value it emits — including captured
command stdout/stderr embedded in verification evidence — passes through
`src/commands/redact.ts` first: values under a sensitive-looking key
(`token`, `secret`, `password`, `apiKey`, `credential`, `auth*`) and
secret-shaped values found anywhere (GitHub `ghp_…`/`github_pat_…` tokens,
`Bearer …` headers) are replaced with `[REDACTED]` before being printed or
serialized, in both human and `--json` output.

## Blocked/FAILED-run runbook: inspect, resume, abandon

## Blocked runs

A run reaches `BLOCKED` when useful work exists but continuing requires
human input or a new bounded attempt — a failed setup command, an
implementer or reviewer reporting `BLOCKED`/`NEEDS_REPLAN`, an exhausted
implementation-attempt or correction-cycle budget, a repeated (fingerprint
-identical) failure, or a source issue that changed materially before
publication. Its worktree and branch are preserved on disk (subject to
`workspace.retainBlockedWorktree`, default `true`) for diagnosis.

```bash
# 1. See the current stage and the next valid action.
autopilot status <run-id>

# 2. Inspect the frozen task snapshot, transition history, model usage,
#    and the latest verification/review evidence (redacted).
autopilot inspect <run-id> --json

# 3a. Continue with one fresh, transcript-free correction attempt in the
#     SAME preserved worktree and branch. Only legal from BLOCKED; every
#     other stage (including every terminal stage) is rejected. Optional
#     model overrides are the same --model/--thinking flags as `run`.
autopilot resume <run-id> [--model ... --thinking ...]

# 3b. Or, give up on this run without deleting its worktree/branch —
#     they remain for manual diagnosis or cleanup.
autopilot abandon <run-id>
```

`resume` never continues hidden conversational context: it starts a fresh
implementer session that sees only the frozen task snapshot (and, if the
prior attempt failed at verification, the current worktree state), and it
is subject to the same budgets as the original run (attempt/cycle counters
carry over, they do not reset).

## FAILED runs

A run lands in `FAILED` when a non-readiness stage errors or when the issue
turned out not to be testable at runtime; the worktree and branch are
also preserved (subject to `workspace.retainBlockedWorktree`). Unlike a
`BLOCKED` run, a `FAILED` run's implementation may still be sound but
unfinished — the failure happened mid-flight rather than at a decision
point awaiting human input.

If the failure happened at a non-terminal stage (for example
`VERIFICATION` or `INDEPENDENT_REVIEW`), the run records that stage in
`resume_at`, and `resume` can continue from exactly there:

```bash
# Continue a run that failed at INDEPENDENT_REVIEW: re-verify the
# existing implementation in place, then retry the reviewer (no
# re-implementation). Optional model overrides as with `run`.
autopilot resume <run-id> [--model ... --thinking ...]
```

`resume` on a `FAILED` run **re-verifies** the preserved worktree's
existing implementation rather than re-implementing it, then retries the
interrupted role: an accepted review publishes; a verification failure or
`CHANGES_REQUESTED` falls into the same bounded correction loop as a
`BLOCKED` resume (attempt/cycle budgets carry over). If the failure was at
`IMPLEMENTATION` (no usable implementation yet), `resume` proceeds as a
normal fresh implementation attempt.

## Starting over from scratch: `run --fresh`

The escape hatch when resumes are not converging is a full restart:

```bash
# Discard the existing worktree and run record for the issue and start a
# clean run from the base branch.
autopilot run <issue> --fresh
```

`--fresh` is **destructive**: it immediately discards the most recent
worktree and run record for that issue (no confirmation prompt) before
beginning a fresh run, which also unblocks a "branch already exists"
failure from a prior FAILED run. Use it only when you are willing to throw
away the previous attempt's work.

## M1 non-goals

Milestone 1 deliberately does **not**:

- automatically select which issue to work on (a human always names one);
- merge a pull request, under any configuration (`publication.autoMerge`
  is reserved for a later milestone and is never acted on in M1);
- close or otherwise mutate the source issue beyond `prepare`'s managed
  refinement section and the one concise comment `run` posts on success;
- apply workflow labels, publish raw session transcripts, or automatically
  publish a partial/blocked branch;
- run a background daemon — every command is a single, explicit,
  developer-initiated invocation;
- perform bulk or automatic backlog refinement across multiple issues;
- schedule or run multiple tasks concurrently;
- dynamically route or fall back between models after a failure;
- automatically evolve or replan a task's scope mid-run (`NEEDS_REPLAN`
  from the implementer maps to `BLOCKED`, requiring an explicit human
  `resume`, never an automatic replan).

See `docs/superpowers/specs/2026-08-18-pi-autopilot-m1-design.md` Section
16 for the complete deferred-scope list.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit + integration tests (vitest run)
npm run build         # tsc -p tsconfig.json -> dist/
npm run check         # typecheck && test && build, in that order
```

### Acceptance suite (`npm run test:e2e`)

```bash
npm run build          # test:e2e depends on the compiled dist/testing/fake-pi.js
npm run test:e2e
```

The acceptance suite (`tests/e2e/`) exercises the **compiled CLI**
(`buildProgram`, wired with the real `PiRunner`, `WorkspaceManager`,
`VerificationRunner`, and `Publisher`) against real temporary Git
repositories and a bare remote. It replaces only the two external
services M1 depends on, through constructor-injection seams that already
exist for exactly this purpose — never through an environment-controlled
production backdoor:

- **GitHub**: an in-memory fake satisfying `GitHubPort`, injected via the
  `createGitHub` seam every command already exposes for testing.
- **Pi**: the real `PiRunner`, pointed at a real, standalone, compiled
  executable (`src/testing/fake-pi.ts` → `dist/testing/fake-pi.js`) via
  the `piCommand` override the same `PiRunner` already accepts in
  production. The fake reads a JSON **scenario** file (steps keyed by role
  and, optionally, a 1-based attempt number for that role) to decide
  whether to submit a scripted result, mutate the worktree, sleep past a
  timeout, exit nonzero, or emit malformed output — the same mechanism
  `tests/fixtures/pi/fake-pi.mjs` uses for lower-level `PiRunner`
  contract tests, extended to script an entire multi-attempt run. Because
  `PiRunner`'s real environment plumbing deliberately never forwards
  arbitrary test environment variables into the sandboxed session
  process, the scenario file's path travels the same way a real
  refiner/implementer/reviewer prompt would carry any other context: as a
  `FAKE_PI_SCENARIO:<path>` marker embedded in the GitHub issue body (and
  echoed forward into the frozen task snapshot), which the fake extracts
  from its own prompt argument.

`tests/e2e/safety-and-recovery.test.ts` additionally proves that the
orchestrator's `agentPolicy.allowedCommands`/`protectedPaths`
configuration reaches a real session's guard envelope: the fake evaluates
a scripted "policy attempt" against the real
`src/security/command-policy.ts` functions (the same module the
production guard extension calls from inside a live Pi session) and
reports `BLOCKED` if the policy would deny it. The real-time interception
of a live session's tool calls is unit/integration-tested separately in
`tests/unit/pi/guard-extension.test.ts` and
`tests/unit/security/command-policy.test.ts`, since a standalone fake
executable never receives an actual `tool_call` event.

### Opt-in real-repository smoke test (gated — requires explicit approval)

M1 also expects an opt-in, real-Pi smoke test against a disposable GitHub
test repository, run **manually** and only after a developer has
explicitly approved doing so against a specific, harmless, ready test
issue. Do not run this without that approval, and never against a
repository containing protected credentials in its worktree.

```bash
# Only after explicit approval of a specific <test-issue-number>:
npm link
pi --version
gh auth status
autopilot check <test-issue-number>
```

Expected: preflight succeeds, the issue is assessed without any mutation,
and local evidence (`autopilot inspect`) contains no token values. Do
**not** run `autopilot run` against a real repository as part of this
smoke test unless the developer has separately approved that specific
run.
