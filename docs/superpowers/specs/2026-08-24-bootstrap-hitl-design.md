# Pi Autopilot: Interactive HITL for `bootstrap --plan`

**Date:** 2026-08-24
**Status:** Draft for review

## 1. Problem

`autopilot bootstrap --plan` reads requirement documents and instructs a
headless `bootstrapper` Pi session to "use the superpowers brainstorming
skill" to infer a full backlog (epics, issues, dependency graph, parallel
waves).

Two defects block this today:

1. **The brainstorming skill cannot be loaded.** The session runs inside the
   repository worktree with a guard (`assertWorkspacePath`) that denies any
   tool read outside the worktree. The skill lives at
   `~/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md`,
   so the session's `read` of it is blocked (`path outside worktree`). The
   session stalls on the guard error and never produces a plan.

2. **Even if loaded, the skill needs a human.** The brainstorming skill is an
   interactive process: if the human partner approves it asks one clarifying
   question at a time and waits for an answer, and enforces a hard gate on
   proceeding without human sign-off. `--plan` runs `pi --print --mode json`
   with stdin ignored and no live channel, so there is no way for a real
   operator to answer those questions.

**Decision (confirmed with operator):** `bootstrap` is a **human-in-the-loop
(HITL)** tool. There is **no auto-answer mode**. Every clarifying question the
bootstrapper has is surfaced to the operator, who answers it interactively
before the session continues.

## 2. Scope

1. **Skill access:** let the bootstrapper load the brainstorming skill.
2. **HITL:** let the operator answer the bootstrapper's clarifying questions
   live during `--plan`.

Out of scope:
- Auto-answer / headless `bootstrap` planning. `--plan` is interactive by
  design.
- HITL for the *other* roles (`run`, `reconcile`, etc.). Those remain
  fully autonomous this milestone. Only `bootstrapper` gains the channel.
- A resumable-offline Q&A flow (pause run, answer later, resume). Question →
  immediate answer in the same session.

## 3. Design

### 3.1 Skill access (guard `skillPaths` allow-list)

Add a `skillPaths: string[]` field to the **guard envelope** and to
`GuardEnvelope`. If the session's role is `bootstrapper`, the guard allows a
guarded read of a path that is an ancestor-or-equal of an entry in
`skillPaths`, in addition to the normal worktree rule. This mirrors the way
`protectedPaths` is excluded (but in reverse: it *permits* a small set of
paths).

Concretely, `assertWorkspacePath` already rejects non-worktree paths; the
guard extension will run its own allow-list check *before* delegating to
`assertWorkspacePath`:

```
if (isAllowedBySkillPaths(resolvedPath, envelope.skillPaths)) return undefined;
// else assertWorkspacePath(...) — current behaviour
```

Also pass `--skill <brainstorming SKILL.md>` (or the skill directory) to the
pi invocation for the `bootstrapper` role so the skill is injected into the
session system prompt at startup, rather than relying on the model to
discover and read it. This both removes a failure mode and guarantees the
skill is present.

### 3.2 HITL channel (`ask_human` tool, blocking file contract)

Add a guard-registered tool to the session:

- `name: ask_human`
- `parameters: { question: string, context?: string }`
- Behaviour: atomically write `<diag>/ask/NNN-question.json` with
  `{ question, context }`, then **block** (return a promise that resolves
  only once `<diag>/ask/NNN-answer.json` exists), then return the answer text
  to the model.

The tool increments a monotonically increasing `NNN` sequence for one run so
the host can process questions in order and never races. `ask_human` is added
to the bootstrapper role's `allowedTools`.

**Host side (`BootstrapService.plan`):** while `pi.run(...)` is awaiting the
child process, poll `<diag>/ask/` for new `*-question.json` files. On each new
one:

1. Print the question to stdout, clearly framed, e.g.:
   `[bootstrapper asks] <question>`
   (plus context, if any).
2. Read the operator's answer from stdin (a single line; the tool is used for
   short clarifications).
3. Write the answer to the corresponding `*-answer.json`.

Because `pi.run()` blocks on the child, the host must run the child promoter
and the question-watcher **concurrently**:

```
const answers = startAnswerPump(diagDir, stdout, stdin);
try {
  execution = await pi.run(request);   // child runs, emits questions
} finally {
  answers.stop();
}
```

Implementation detail: the `ProcessRunner` currently blocks on the child
(`await processRunner.run(...)`). The answer pump can be a `setInterval`/loop
in the host that runs on its own timeline since the parent Node process is
single-threaded but event-driven — the writes are async and the child is a
separate process. The pump polls the dir on an interval (e.g. 200ms) and on
each tick checks for new question files; `readline`/`fs` are all async so the
event loop is not starved.

### 3.3 File contract (data dir)

Per run, under `<run-dir>/diagnostics/ask/`:

```
ask/
  000-question.json   {"question": "...", "context": "..."}
  000-answer.json     {"answer": "..."}
  001-question.json
  001-answer.json
```

The guard extension (child) writes `*-question.json` and reads
`*-answer.json`. The host writes `*-answer.json` and reads
`*-question.json`. Polling with a sequence number keeps both sides
deterministic and idempotent.

Use an atomic create (`flag: "wx"`) for both question and answer files so a
restarted observer cannot see a half-written file and a stale pump cannot
answer the same question twice.

### 3.4 Signature changes

- `PiRunRequest` gains `skillPaths: string[]` and `skills: string[]`
  (paths passed via `--skill`).
- `GuardEnvelope` gains `skillPaths: string[]`.
- `allowedTools` for the `bootstrapper` role gains `"ask_human"`.
- `BootstrapServiceDeps` gains an optional `onQuestion?: (q: Question) => Promise<string>` (seam for tests and for swapping stdin/stdout in a future UI).
- `BootstrapService.plan` starts the answer pump and wires it to the default console implementation if `onQuestion` is not provided.

### 3.5 Prompt update

The bootstrapper prompt is updated to:

- Tell the model it **can and should** use `ask_human` to resolve genuinely
  ambiguous product decisions before finalising the plan.
- Frame the skill correctly: it is a **HITL** reasoning aid; clarifying
  questions go to the operator via `ask_human`, and the model waits for the
  answer.
- Keep the existing `submit_result` output contract unchanged (so downstream
  `--apply` is unaffected).

## 4. Explicit non-goals / rejected approaches

- **Auto-answer mode** (rejected — operator confirmed HITL only).
- **Reading the skill through an unfenced read.** We allow-list
  `skillPaths` rather than removing the worktree guard. The security boundary
  is preserved; only explicitly listed skill files are readable, and only
  reads (bootstrapper has no write tools).
- **Resumable offline Q&A.** The child would need to be serialized and
  relaunched; out of scope this milestone.

## 5. Testing

TDD; every change starts from a failing test.

- `guard-extension.test.ts`:
  - a guarded `read` of a path inside `skillPaths` is allowed;
  - a `read` of a path outside worktree and outside `skillPaths` is still
    blocked;
  - `ask_human` writes a sequenced question file and blocks until an answer
    file appears, then returns the answer.
- `pi-runner` tests: `--skill` args and `skillPaths` are propagated to the
  child invocation.
- `bootstrap-service.test.ts`: with a fake Pi that emits a question file, the
  fake `onQuestion` handler is invoked once and the returned answer is written
  back; a second question is sequential.
- `bootstrap` command integration: an end-to-end (fake pi) run that exercises
  the pump.

Run: `npx vitest run` (752 existing tests must stay green) and
`npm run build`.

## 6. Rollout / manual verification

1. `npm run build`, then run `autopilot bootstrap --plan` interactively
   against `Smityx/revalbis` Batch 1.
2. Confirm the brainstorming skill is loaded (session log shows
   `SkillInvocationMessage` / skill present).
3. When the bootstrapper asks a clarifying question, confirm it prints to the
   terminal, accepts a typed answer, and the session resumes to produce a
   `plan.json` + `bootstrap-plan.md`.
4. Confirm the plan renders and is reviewable.

## 7. Files touched

- `src/pi/guard-extension.ts` — guard envelope schema, skill allow-list,
  `ask_human` tool.
- `src/pi/pi-runner.ts` — propagate `skillPaths`/`skills`, add `ask_human` to
  bootstrapper tools, `--skill` args.
- `src/bootstrap/answer-pump.ts` (new) — question watcher + answer writer;
  testable standalone.
- `src/bootstrap/bootstrap-service.ts` — start pump around `pi.run`.
- `src/bootstrap/bootstrapper-prompt.ts` — HITL wording.
- `src/config/schema.ts` — `bootstrap.skillPaths` config.
- README (`docs/`) — document interactive `--plan` and the Q&A flow.
