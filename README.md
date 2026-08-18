# Pi Autopilot

Autonomous development orchestration for Pi. Pi Autopilot is an external control plane that gives Pi bounded, role-specific headless sessions well-defined jobs, validates their structured results, and advances an explicit workflow — so a developer doesn't have to babysit every agent session.

> **Status: M1 in progress.** The `check` and `prepare` commands are implemented. The remaining M1 commands (`run`, `status`, `inspect`, `resume`, `abandon`) are designed but not yet built — see [Roadmap](#roadmap).

---

## What it does

Pi Autopilot (a TypeScript/Node.js CLI, invoked as `autopilot`) supervises a single GitHub issue at a time. In M1 (the current milestone) its job is to figure out whether an issue is ready for autonomous execution, and to turn an unready issue into a ready one — without a human having to write a detailed task breakdown first.

It runs only against a **clean local clone** of the repository and uses the local GitHub CLI (`gh`) and Pi CLI that are already installed and authenticated. The tool never stores your credentials.

The two implemented commands are:

- **`autopilot check <issue>`** — assess whether an issue is ready for autonomous execution. **Read-only**: it never modifies GitHub and never creates a workspace.
- **`autopilot prepare <issue>`** — run the same analysis, draft an improved "execution contract" for the issue, and apply it to the issue *only after you explicitly approve* the proposed edit.

M1 deliberately does **not** merge PRs, close issues, or pick tasks for you. Those stay human decisions.

---

## Prerequisites

Before you can use the tool, the repository and your machine must satisfy:

1. **A clean existing local clone** whose GitHub `origin` matches the issue's repository. The CLI validates this before doing anything.
2. **GitHub CLI (`gh`)** installed and authenticated (`gh auth login`).
3. **Pi CLI** installed, authenticated, and able to launch bounded headless sessions.
4. **A `.pi/autopilot.yaml` policy** committed in the repository root. Its `commands.verify` list is **mandatory** — a repository without at least one verification command cannot run.
5. **Node.js 22.5+** and npm.

---

## Installation and build

```bash
npm install        # install dependencies
npm run build      # compile TypeScript to dist/
```

After building you can invoke the compiled CLI:

```bash
./bin/autopilot.js ...        # the bin shim
node dist/cli.js ...          # compiled entry point
npm run start -- ...          # tsx from src/
```

The `bin` shim is declared in `package.json` (`"bin": { "autopilot": "bin/autopilot.js" }`), so after the CLI is built you can also link it globally (`npm link`) or install it as a dependency and call `autopilot ...`.

---

## Configuration

Repository policy lives in a versioned file at `.pi/autopilot.yaml` in the repository root. The current schema (version `1`) looks like this:

```yaml
version: 1

workspace:
  baseBranch: main            # default
  branchPrefix: autopilot/    # default
  requireCleanCheckout: true  # default
  retainBlockedWorktree: true # default

commands:
  setup: []                   # default: run before verify (optional)
  verify:                     # REQUIRED: at least one command
    - npm test

agents:
  refiner:
    model: anthropic/claude-sonnet-4
    thinking: high
  # implementer: , reviewer: — reserved for the run stage (M1)

agentPolicy:
  allowedCommands: [npm, npx, node, rg, find]   # default
  protectedPaths: []                             # default
  allowNetwork: false                            # default

budgets:
  implementation:
    timeoutMinutes: 60      # default
    maxAttempts: 3          # default
  review:
    timeoutMinutes: 20      # default
    maxCorrectionCycles: 2  # default

publication:
  draftPr: false            # default
  issueComment: concise     # default
  autoMerge: false          # default
```

Notes:

- **`commands.verify` is the only required key.** If your repository's test command lives elsewhere (e.g. `npx vitest run`), set it there. Autopilot will refuse to run without it.
- **`agents.refiner`** controls which model Pi uses to analyze an issue for `check`/`prepare`. You can override it per command with `--model` / `--thinking` (CLI overrides the repository config, which overrides user defaults, which fall back to Pi's default).
- Hardening keys (`agentPolicy.allowedCommands`, `protectedPaths`, `allowNetwork`, and the `budgets`/`publication` blocks) are present now so later M1 stages and their run/review commands use them; today they govern the refiner's sandbox.

---

## How to use the implemented commands

Both commands accept an issue as `<number>` (for an issue in the current repository) or `<owner>/<repo>#<number>` (which must match the local `origin`).

Shared options:

| Option | Meaning |
|---|---|
| `--json` | Emit a machine-readable report instead of the human-readable one |
| `--model <model>` | Override the refiner model for this invocation |
| `--thinking <level>` | Override the refiner thinking level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) |

### `autopilot check <issue>` — is this issue ready to run?

`check` assesses whether an issue can be converted into an unambiguous, testable execution contract. It:

1. resolves the local repository and the GitHub issue;
2. reads the issue, referenced specs, repo guidance, and relevant context;
3. launches a bounded refiner Pi session;
4. validates the refiner's structured result;
5. applies deterministic readiness rules;
6. prints `READY` or `NEEDS_REFINEMENT`, with an exit code of `0` (ready) or `2` (not ready).

A task is `READY` only when its contract has an unambiguous objective, relevant context, **testable acceptance criteria**, constraints/non-goals, and validation expectations, with no product ambiguity that would materially affect behavior. Engineering ambiguity (e.g. "which module owns this?") does not make it unready — product ambiguity does.

`check` is strictly **read-only**. It never writes to GitHub and never creates a workspace.

```bash
# inside the target repository
autopilot check 123
autopilot check 123 --json
autopilot check your-org/your-repo#123 --model anthropic/claude-opus-4-0
```

### `autopilot prepare <issue>` — draft and apply an execution contract

`prepare` runs the **same readiness analysis** as `check`, then drafts a structured execution contract for the issue. It shows you the proposed edit to the issue body and asks for explicit approval before touching GitHub.

If you approve, it updates only a **managed section** of the issue body, preserving all original content:

```markdown
<!-- autopilot-refinement:start -->
## Autonomous execution contract
<generated contract>
<!-- autopilot-refinement:end -->
```

A later `prepare` call replaces only that section. **In `--json` mode there is no interactive approval**, so the proposal is printed but **not** applied.

```bash
autopilot prepare 123            # proposes the diff and prompts for approval
autopilot prepare 123 --json     # prints the proposal without applying it
```

### Typical flow

```text
existing issue
    ↓
autopilot check          →  structured readiness report
    ↓
autopilot prepare        →  human reviews + approves proposed issue update
    ↓
autopilot check          →  READY
```

If `check` reports `NEEDS_REFINEMENT`, run `prepare` to draft the improvements, review and approve them, then `check` again until it returns `READY`.

---

## What the orchestrator owns (safety boundaries)

- `check` is read-only; `prepare` mutates **only** its managed section and **only after explicit approval**.
- The tool owns all Git/GitHub mutations; Pi agents are confined to bounded role sessions.
- M1 will not auto-select tasks, schedule dependencies, run concurrent tasks, merge PRs, or close issues — those remain supervisory/human decisions.

---

## What's not implemented yet

The M1 design also specifies these commands, which are **planned, not yet built** — calling them today will not work:

`autopilot run <issue>` · `autopilot status <run-id>` · `autopilot inspect <run-id>` · `autopilot resume <run-id>` · `autopilot abandon <run-id>`

These cover the execution stage: creating an isolated worktree, running bounded implementation + independent review with corrections, deterministic verification, opening a PR, and status/recovery operations.

---

## Roadmap

| Milestone | Outcome |
|---|---|
| **M1 — Supervised Task Runner** *(in progress)* | select one issue, prepare or check it, execute it in an isolated worktree with bounded corrections, independently review and verify, open a PR |
| **M2 — Refinement & Readiness** | analyze existing epics/tasks, propose issue augmentation, record readiness |
| **M3 — Durable Autonomous Runner** | background operation, crash recovery, budgets, resumable runs |
| **M4 — Epic Scheduler** | dependencies, controlled concurrency, conflict prevention |
| **M5 — Adaptive Planning & Governance** | staleness detection, replanning, policy, optional auto-merge, traceability |

See `docs/superpowers/specs/2026-08-18-pi-autopilot-m1-design.md` for the full M1 design and `docs/superpowers/plans/2026-08-18-pi-autopilot-m1-implementation.md` for the implementation plan.
