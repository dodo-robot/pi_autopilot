# Pi Autopilot: Bootstrap Design

**Date:** 2026-08-23
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

`autopilot bootstrap` is the entry point for a project that has requirement
documents but no backlog yet. It reads one or more requirement files, uses an
LLM to propose a structured set of epics and issues, saves a plan artifact
the user can review and edit, then applies it to GitHub — creating issues, a
Projects v2 board, and a starter `autopilot.yaml` if none exists.

Bootstrap is a standalone command, independent of `reconcile`. After bootstrap
has run and a backlog exists, `reconcile` handles ongoing drift between
requirements and the backlog. The two commands share doc-reading infrastructure
but have separate service layers.

---

## 2. Relationship to the existing roadmap

| Milestone | Outcome |
|---|---|
| M1 — Supervised Task Runner | One issue: check/prepare → isolated run → review/verify → PR. *(done)* |
| M2 — Refinement and Readiness | Analyze existing epics and tasks, record readiness, identify executable work. *(done)* |
| M3 — Durable Autonomous Runner | Background daemon, crash recovery, auto-resume, sequential queue. *(done)* |
| Backlog Reconciliation | Patch-plan proposals against an existing epic's issues: coverage, staleness, missing work. *(done)* |
| **Bootstrap** | **Seed a project from scratch: requirement docs → epics + issues + Projects v2 board + autopilot.yaml.** *(this spec)* |
| M4 — Epic Scheduler | Explicit dependencies, controlled concurrency, workspace-conflict prevention, epic progress reporting. |
| M5 — Adaptive Planning and Governance | Staleness detection, replanning, richer escalation/security policy, optional auto-merge, end-to-end traceability. |

Bootstrap operates at *project inception*, before any M1–M3 execution begins.
It is a precursor to M4's scheduler, which will want a well-formed backlog
before making concurrency/ordering decisions.

---

## 3. Scope decisions

Settled in brainstorming:

1. **Standalone command.** `autopilot bootstrap` — not a flag on `reconcile`,
   not a mode of a unified `plan` command. After bootstrap, `reconcile` handles
   ongoing drift.

2. **LLM-inferred epics.** The AI reads all docs together and proposes how many
   epics make sense based on logical domains/themes. The user sees and approves
   the structure before anything is written to GitHub.

3. **Two explicit phases.** `--plan` produces and saves a plan artifact.
   `--apply <plan-id>` reads the saved plan and executes GitHub writes. The
   user can edit the plan between steps.

4. **Refuse-and-advise on oversized input.** If combined docs exceed a token
   threshold, bootstrap refuses and prints a concrete batching suggestion. It
   does not auto-chunk or silently degrade.

5. **Both plan artifact formats.** `plan.json` (machine-readable, consumed by
   `--apply`) and `bootstrap-plan.md` (human-readable Markdown, for review and
   light editing). `--apply` reads only the JSON; Markdown edits are not
   round-tripped in this milestone.

6. **autopilot.yaml bootstrap.** If no `.pi/autopilot.yaml` exists, bootstrap
   proposes a starter config in the plan and writes it during `--apply`. It
   never overwrites an existing config.

7. **Full GitHub Projects v2 board creation.** `--apply` creates a board if
   none exists (offering to create one), creates epics and child issues, patches
   epic checklists with real issue numbers, and adds all issues to the board
   with `Todo` status.

8. **New `bootstrapper` role** added to the `autopilot.yaml` schema alongside
   existing roles.

Out of scope for this milestone:
- `--from-markdown` flag to round-trip Markdown edits back to JSON.
- `SPLIT_ISSUE` / `MERGE_DUPLICATE` patch types (belong to reconcile's future
  extended patch set).
- Applying bootstrap plans from multiple batches to the same board in a single
  command (the user runs `--apply` once per plan-id).

---

## 4. Command interface

```text
autopilot bootstrap --plan  [--requirements <path>...]  [--out <dir>]
autopilot bootstrap --apply <plan-id>
```

### 4.1 `--plan` phase

| Flag | Description |
|---|---|
| `--requirements <path>` | Repeatable. Requirement document paths (repo-relative). Falls back to `requirements/` directory or `requirements.md` if omitted. |
| `--out <dir>` | Override the output directory for plan files. Default: autopilot data dir. |
| `--json` | Emit machine-readable output to stdout in addition to saving artifacts. |

Workflow:
1. Resolve repository context (same as all other commands).
2. Load `autopilot.yaml` if present; fall back to built-in defaults if absent.
3. Read all requirement documents.
4. Run the size check (§5). Refuse with split advice if over threshold.
5. Run a `bootstrapper` Pi session to produce the structured plan.
6. Save `plan.json` and render `bootstrap-plan.md` (§6).
7. Print the plan-id and the path to `bootstrap-plan.md`.

### 4.2 `--apply` phase

| Flag | Description |
|---|---|
| `<plan-id>` | Required. The plan-id printed by `--plan`. |
| `--json` | Emit machine-readable progress to stdout. |

Workflow (in order, stopping on failure — see §7):
1. Read `plan.json` by plan-id.
2. Preflight: verify GitHub auth scopes (`repo`, `project`).
3. Create Projects v2 board if absent (§7.1).
4. Create epic issues (§7.2).
5. Create child issues (§7.3).
6. Patch epic bodies with real child issue numbers (§7.4).
7. Add all issues to the board with `Todo` status (§7.5).
8. Write `autopilot.yaml` if absent (§7.6).

### 4.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Thrown error (config, auth, unexpected) |
| 2 | Soft failure (input too large, partial apply failure) |

---

## 5. Size check and split advisor

Before invoking the LLM, bootstrap measures the combined token footprint of
all requirement documents. Estimation uses a simple character-count heuristic
(~4 chars per token), consistent with how `reconcile` estimates document size.

**Threshold:** 80,000 tokens (configurable via `bootstrap.tokenThreshold` in
`autopilot.yaml`). This leaves headroom for the bootstrapper prompt and
expected output within a large-context window.

**On threshold exceeded — bootstrap refuses:**

```
✗ Input too large to process in one pass.
  Total estimated tokens: ~112,000 (threshold: 80,000)

  Suggested batches:
    Batch 1 (~38k tokens): requirements/auth.md, requirements/billing.md
    Batch 2 (~41k tokens): requirements/reporting.md, requirements/api.md
    Batch 3 (~33k tokens): requirements/infra.md

  Run each batch separately:
    autopilot bootstrap --plan --requirements requirements/auth.md requirements/billing.md
    autopilot bootstrap --plan --requirements requirements/reporting.md requirements/api.md
    autopilot bootstrap --plan --requirements requirements/infra.md

  Then apply each plan in order:
    autopilot bootstrap --apply <plan-id-1>
    autopilot bootstrap --apply <plan-id-2>
    autopilot bootstrap --apply <plan-id-3>
```

**Split heuristic:** greedy bin-packing by document size, targeting roughly
equal batch sizes below the threshold. Documents are never split mid-file —
each file goes into exactly one batch.

---

## 6. Plan artifact and Markdown preview

### 6.1 `plan.json`

Saved to `~/.local/share/autopilot/bootstrap/<plan-id>/plan.json`.

```json
{
  "planId": "bootstrap-2026-08-23-abc123",
  "createdAt": "2026-08-23T10:00:00Z",
  "requirementDocs": ["requirements/auth.md", "requirements/billing.md"],
  "proposedConfig": {
    "roles": {
      "bootstrapper": { "model": "..." },
      "implementer":  { "model": "..." },
      "reviewer":     { "model": "..." },
      "verifier":     { "model": "..." }
    }
  },
  "projectBoard": {
    "title": "My Project",
    "columns": ["Todo", "In Progress", "Done"]
  },
  "epics": [
    {
      "title": "Authentication & Authorization",
      "description": "...",
      "labels": ["epic"],
      "issues": [
        {
          "title": "Implement JWT login",
          "body": "...",
          "labels": ["task"],
          "requirementRef": { "doc": "requirements/auth.md", "section": "## Login" }
        },
        {
          "title": "Add OAuth2 provider",
          "body": "...",
          "labels": ["task"],
          "requirementRef": { "doc": "requirements/auth.md", "section": "## OAuth" }
        }
      ]
    }
  ]
}
```

`proposedConfig` is `null` if `autopilot.yaml` already exists at plan time.

### 6.2 `bootstrap-plan.md`

Written alongside `plan.json`; path printed to terminal on completion. A
human-readable Markdown rendering of the full plan:

- Each epic as a `##` section with its description and a numbered list of
  child issue titles and bodies.
- A `## Proposed autopilot.yaml` fenced block (omitted if config already
  exists).
- A `## Project Board` section showing the board title and columns.

The user can read and edit this file freely. `--apply` reads only `plan.json`.
Markdown edits are not round-tripped in this milestone; a `--from-markdown`
flag is a noted future extension.

---

## 7. GitHub writes (`--apply`)

Applied in order. Each step is logged to the terminal as it completes. On
failure, bootstrap prints which steps succeeded, which failed, and confirms
that re-running `--apply <plan-id>` is safe (idempotent for completed steps).

### 7.1 Create Projects v2 board

If no Projects v2 board exists in the repo's owning org/user:
- Bootstrap prints the proposed board name (from `plan.json`) and asks
  `Create board "<name>"? [y/N]`.
- On yes: creates the board with the columns in `plan.json`
  (`Todo`, `In Progress`, `Done` by default).
- If a board already exists: lists available boards by number/name and asks
  the user to select one.

**Preflight:** bootstrap checks for the `project` GitHub OAuth scope before
starting. If missing, it prints a clear error with the `gh auth refresh`
command needed to add it.

### 7.2 Create epic issues

One GitHub issue per epic. Body is a placeholder checklist (child references
filled in step 7.4). Label `epic` created if absent.

### 7.3 Create child issues

One GitHub issue per task. Body includes:
- The task description from `plan.json`.
- A `## Requirements` section citing the source doc and section
  (`requirementRef`).

Label `task` created if absent.

### 7.4 Patch epic bodies

Each epic issue body is updated with its real child issue checklist:

```markdown
## Tasks
- [ ] #42 Implement JWT login
- [ ] #43 Add OAuth2 provider
```

This is the exact format `analyze` and `reconcile` already consume — no
changes needed to those commands.

### 7.5 Add issues to board

All epic and child issues added to the selected Projects v2 board with
status `Todo`.

### 7.6 Write `autopilot.yaml`

If `.pi/autopilot.yaml` is absent:
- Writes the `proposedConfig` from `plan.json` to `.pi/autopilot.yaml`.
- Commits with message `chore: add autopilot.yaml (bootstrapped)`.
- Reports what it wrote.

If `.pi/autopilot.yaml` already exists: skips this step entirely — never
overwrites.

---

## 8. Architecture and new components

Bootstrap slots into the existing codebase as a new top-level command with
its own service layer, parallel to `reconcile`. No existing files are
modified (except `src/cli.ts` to register the command and the `autopilot.yaml`
schema to add the `bootstrapper` role).

### 8.1 New files

```
src/
  commands/
    bootstrap.ts              # CLI entry point; --plan / --apply dispatch
  bootstrap/
    size-checker.ts           # Token estimation + bin-pack split advisor
    bootstrapper-prompt.ts    # Pi session prompt for the bootstrapper role
    bootstrap-service.ts      # Orchestrates --plan: calls Pi, saves artifacts
    apply-service.ts          # Orchestrates --apply: GitHub writes in order
    plan-renderer.ts          # Renders plan.json → bootstrap-plan.md
    plan-store.ts             # Read/write plan.json by plan-id (nanoid)
    config-proposer.ts        # Generates starter autopilot.yaml content
  github/
    projects-adapter.ts       # New: GitHub Projects v2 API (create board, add issues)
```

### 8.2 Reused without modification

| Component | Usage |
|---|---|
| `PiRunner` | Runs the bootstrapper Pi session (same pattern as reconciler/refiner) |
| `GitHubAdapter` | Existing issue create/update calls |
| `ArtifactStore` / `appPaths` | Artifact directory conventions |
| `loadRepositoryConfig` | With graceful fallback when no config exists |
| `resolveRepositoryContext` | Repo detection |

### 8.3 Schema change

`autopilot.yaml` schema gains a `bootstrapper` role entry alongside the
existing `reconciler`, `refiner`, `implementer`, `reviewer`, `verifier`. The
`bootstrap.tokenThreshold` key is added under a new top-level `bootstrap`
section.

### 8.4 `projects-adapter.ts`

Wraps the GitHub Projects v2 GraphQL API. Exposes:
- `listBoards()` — list existing Projects v2 boards for the repo owner.
- `createBoard(title, columns)` — create a new board.
- `addIssueToBoard(boardId, issueId, status)` — add an issue with a given status.

Injected into `ApplyService` as a port (same dependency-injection pattern used
by `GitHubAdapter` throughout the codebase), so tests can substitute a fake.

---

## 9. Testing

- **Unit tests** for `size-checker.ts` (threshold logic, bin-pack heuristic),
  `plan-store.ts` (round-trip JSON), `plan-renderer.ts` (Markdown output),
  `config-proposer.ts` (output shape).
- **Unit tests** for `bootstrap-service.ts` and `apply-service.ts` with fake
  `PiRunner`, fake `GitHubAdapter`, fake `ProjectsAdapter` (same pattern as
  `reconciliation-service.test.ts`).
- **Unit tests** for `bootstrap.ts` command (CLI flag parsing, `--plan` /
  `--apply` dispatch, error paths).
- **No e2e tests** in this milestone — consistent with `reconcile`, which also
  has no e2e tests.

---

## 10. Future extensions (not in scope)

- `--from-markdown`: round-trip Markdown edits back to `plan.json` before
  `--apply`.
- `autopilot bootstrap --merge <plan-id-1> <plan-id-2>`: merge multiple batch
  plans into a single board run.
- Board column customisation via CLI flag.
- `SPLIT_ISSUE` / `MERGE_DUPLICATE` patch types (belong to reconcile's
  extended patch set, M5).
- Interactive plan editor (TUI).
