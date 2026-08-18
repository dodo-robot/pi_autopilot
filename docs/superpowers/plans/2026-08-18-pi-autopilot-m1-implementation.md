# Pi Autopilot Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a supervised TypeScript CLI that prepares or checks one GitHub issue, executes it through bounded Pi implementation and independent review in an isolated worktree, verifies the exact result, and opens a PR without merging or closing the issue.

**Architecture:** A pure workflow core coordinates narrow adapters for GitHub, Git, Pi, subprocesses, SQLite, and artifact storage. Pi sessions return through a guarded `submit_result` extension instead of prose parsing; the orchestrator alone owns Git/GitHub mutations and deterministic verification. Each task below ends in an independently testable deliverable and a focused commit.

**Tech Stack:** Node.js 22+, TypeScript 5, npm, Commander, Zod, YAML, Octokit, Node built-in SQLite, Pi CLI 0.84.2+, Pi extension API, Vitest

**Spec:** `docs/superpowers/specs/2026-08-18-pi-autopilot-m1-design.md`

## Global Constraints

- Run only from a clean existing local clone whose GitHub `origin` matches the requested issue.
- Require authenticated local `gh` and Pi CLIs; never persist their credentials.
- Keep operational data under the platform data directory, defaulting to `~/.local/share/pi-autopilot` on macOS/Linux.
- Use sibling Git worktrees and one `autopilot/<issue>-<slug>` branch per run; never modify the primary checkout.
- The orchestrator exclusively owns commits, pushes, issue updates, comments, and PR creation.
- `check` is read-only; `prepare` mutates only its managed issue section and only after explicit approval.
- Every role uses a fresh bounded Pi session and a versioned structured result contract.
- Verification must run outside Pi and pass for the exact tree that is committed.
- Allow at most two correction cycles and three implementation attempts by default.
- M1 must not select tasks automatically, schedule dependencies, run concurrent tasks, merge PRs, or close issues.
- Use TDD for every behavior: observe the focused test fail before adding the implementation.

## Planned file map

```text
package.json                              Project scripts, dependencies, CLI bin
bin/autopilot.js                          Small executable loader for compiled CLI
src/cli.ts                                Commander command registration and dependency wiring
src/domain/contracts.ts                   Task, role-result, model, run, and evidence schemas
src/config/schema.ts                      `.pi/autopilot.yaml` and user-default schemas
src/config/load-config.ts                 Config loading, merge order, and model resolution
src/platform/process-runner.ts            Bounded subprocess abstraction
src/platform/paths.ts                     Application data and run-artifact paths
src/persistence/run-store.ts              SQLite schema and transactional run operations
src/persistence/artifact-store.ts         Atomic JSON/text artifact persistence
src/github/github-adapter.ts              GitHub issue, comment, and PR operations
src/github/repository-context.ts           Local-origin parsing and repository validation
src/security/command-policy.ts            Command/path checks shared with Pi extension
src/pi/guard-extension.ts                 Pi tool-call guard and `submit_result` tool
src/pi/pi-runner.ts                       Headless Pi invocation and result validation
src/readiness/prompt.ts                    Refiner prompt construction
src/readiness/readiness-service.ts         Check and immutable task-snapshot creation
src/readiness/refinement-section.ts        Managed issue-section replacement
src/workspace/workspace-manager.ts         Branch/worktree creation, inspection, commit, cleanup
src/verification/verification-runner.ts    Setup/verification execution and tree evidence
src/workflow/state-machine.ts              Pure legal transition model
src/workflow/budgets.ts                    Attempt/correction/repetition limits
src/publication/publisher.ts               Idempotent push, PR, and concise issue comment
src/workflow/run-service.ts                End-to-end implementation/review/correction workflow
src/workflow/recovery-service.ts           Reconcile, resume, inspect, and abandon operations
src/commands/*.ts                          Thin CLI handlers
src/testing/fake-pi.ts                     Controllable fake Pi executable for contract tests
tests/unit/**                              Focused unit tests matching source modules
tests/integration/**                       SQLite, Git, Pi, workflow, and recovery tests
tests/fixtures/**                          Policies, issues, role results, and fixture repositories
```

---

### Task 1: Project foundation, domain contracts, and configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `bin/autopilot.js`
- Create: `src/domain/contracts.ts`
- Create: `src/config/schema.ts`
- Create: `src/config/load-config.ts`
- Create: `tests/unit/config/load-config.test.ts`
- Create: `tests/fixtures/config/minimal.yaml`

**Interfaces:**
- Produces: `TaskSnapshotSchema`, `RoleResultSchema`, `RunRecord`, `RunStage`, `AutopilotConfig`, `loadRepositoryConfig(root)`, and `resolveRoleModel(role, cli, repo, user, piDefault)`.
- Consumes: no project interfaces.

- [ ] **Step 1: Create the npm/TypeScript test harness**

Use Node ESM, Node 22, strict TypeScript, and these scripts:

```json
{
  "name": "pi-autopilot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "autopilot": "bin/autopilot.js" },
  "engines": { "node": ">=22.5" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "tsx src/cli.ts"
  },
  "dependencies": {
    "@octokit/rest": "^22.0.0",
    "commander": "^14.0.0",
    "shell-quote": "^1.8.3",
    "yaml": "^2.8.1",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.84.2",
    "@types/node": "^22.0.0",
    "@types/shell-quote": "^1.7.5",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`bin/autopilot.js` must contain:

```js
#!/usr/bin/env node
import "../dist/cli.js";
```

Run: `npm install`
Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 2: Write failing configuration/model-resolution tests**

Cover valid YAML, missing verification commands, unsupported schema version, and precedence:

```ts
expect(resolveRoleModel("reviewer", cli, repo, user, piDefault)).toEqual({
  model: "openai/gpt-5.2",
  thinking: "high",
  source: "cli",
});
await expect(loadRepositoryConfig(fixtureRoot("missing-verify"))).rejects.toThrow(
  "commands.verify must contain at least one command",
);
```

Run: `npx vitest run tests/unit/config/load-config.test.ts`
Expected: FAIL because the config modules do not exist.

- [ ] **Step 3: Define versioned domain and configuration schemas**

Use Zod discriminated unions. Define exact role outcomes and immutable task fields:

```ts
export const RoleSchema = z.enum(["refiner", "implementer", "reviewer"]);
export const RunStageSchema = z.enum([
  "PREFLIGHT", "READINESS_CHECK", "WORKSPACE_CREATION", "IMPLEMENTATION",
  "VERIFICATION", "INDEPENDENT_REVIEW", "CORRECTION", "PUBLICATION",
  "PR_OPEN", "NEEDS_REFINEMENT", "BLOCKED", "FAILED", "CANCELLED",
]);
export const TaskSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({ owner: z.string().min(1), repo: z.string().min(1) }),
  issue: z.object({ number: z.number().int().positive(), nodeId: z.string(), updatedAt: z.string() }),
  objective: z.string().min(1),
  context: z.string(),
  expectedBehavior: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.object({ id: z.string(), text: z.string().min(1) })).min(1),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  validation: z.array(z.string()).min(1),
  dependencies: z.array(z.object({ issue: z.number().int().positive(), satisfied: z.boolean() })),
  canonicalReferences: z.array(z.string()),
  sourceBodyHash: z.string().min(1),
});
```

Define `RefinerResultSchema`, `ImplementerResultSchema`, and `ReviewerResultSchema`, then export `RoleResultSchema` as their union. Reviewer findings must contain `severity`, `criterionId`, `path`, `line`, `evidence`, and `requestedChange`.

- [ ] **Step 4: Implement config loading and model precedence**

Parse `.pi/autopilot.yaml`, reject missing verification commands, and merge role models in the documented order. Keep user defaults optional and inject the Pi default rather than discovering it in this module.

Run: `npx vitest run tests/unit/config/load-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all commands pass.

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts bin src/domain src/config tests/unit/config tests/fixtures/config
git commit -m "feat: establish autopilot contracts and configuration"
```

---

### Task 2: Process abstraction, application paths, and durable run storage

**Files:**
- Create: `src/platform/process-runner.ts`
- Create: `src/platform/paths.ts`
- Create: `src/persistence/artifact-store.ts`
- Create: `src/persistence/run-store.ts`
- Create: `tests/unit/platform/process-runner.test.ts`
- Create: `tests/integration/persistence/run-store.test.ts`

**Interfaces:**
- Produces: `ProcessRunner.run(request): Promise<ProcessResult>`, `ArtifactStore.writeJson/readJson/appendEvent`, and `RunStore.createRun/getRun/transition/recordAttempt/getActiveRunForIssue/listNonterminalRuns`.
- Consumes: `RunStage`, `TaskSnapshot`, and role/model types from Task 1.

- [ ] **Step 1: Write failing subprocess timeout tests**

Test stdout/stderr capture, nonzero exit, environment allowlisting, and process-group termination:

```ts
const result = await runner.run({
  command: process.execPath,
  args: ["-e", "setTimeout(() => {}, 10_000)"],
  cwd: tempDir,
  timeoutMs: 25,
  env: {},
});
expect(result.timedOut).toBe(true);
expect(result.exitCode).toBeNull();
```

Run: `npx vitest run tests/unit/platform/process-runner.test.ts`
Expected: FAIL because `ProcessRunner` does not exist.

- [ ] **Step 2: Implement bounded subprocess execution**

Use `child_process.spawn`, detached process groups on POSIX, bounded output buffers, `SIGTERM` followed by `SIGKILL`, and an explicit environment object. Return:

```ts
export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}
```

Run the focused test and expect PASS.

- [ ] **Step 3: Write failing transactional persistence tests**

Use a temporary SQLite file. Assert compare-and-set transitions, event insertion in the same transaction, active-run uniqueness per issue, and restart persistence:

```ts
const run = store.createRun(input);
store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", evidenceRef);
expect(store.getRun(run.id)?.stage).toBe("READINESS_CHECK");
expect(() => store.transition(run.id, "PREFLIGHT", "FAILED", null)).toThrow("stale stage");
```

Run: `npx vitest run tests/integration/persistence/run-store.test.ts`
Expected: FAIL because persistence is absent.

- [ ] **Step 4: Implement paths, atomic artifacts, and SQLite store**

Use `node:sqlite` `DatabaseSync`. Enable WAL and foreign keys. Create tables for `runs`, `attempts`, `transitions`, `verification_runs`, `review_findings`, and `publications`. Store large payloads by artifact-relative path. Write JSON through a temporary file followed by `rename`.

The `runs` table must enforce one active row for `(owner, repo, issue_number)` using a partial unique index over nonterminal stages.

Run both Task 2 test files and expect PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add src/platform src/persistence tests/unit/platform tests/integration/persistence
git commit -m "feat: add durable run storage and bounded processes"
```

---

### Task 3: Repository context and GitHub adapter

**Files:**
- Create: `src/github/repository-context.ts`
- Create: `src/github/github-adapter.ts`
- Create: `tests/unit/github/repository-context.test.ts`
- Create: `tests/unit/github/github-adapter.test.ts`

**Interfaces:**
- Produces: `resolveRepositoryContext(root, processRunner)`, `GitHubPort`, and `GitHubAdapter.create(root, processRunner)`.
- Consumes: `ProcessRunner` from Task 2.

- [ ] **Step 1: Write failing origin-resolution tests**

Cover SSH and HTTPS remotes, detached/nonrepository directories, dirty checkout, and mismatched issue references:

```ts
expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
```

Run the focused test; expect module-not-found failure.

- [ ] **Step 2: Implement repository resolution**

Use `git rev-parse --show-toplevel`, `git remote get-url origin`, `git status --porcelain`, and `git branch --show-current`. Return the canonical root, owner/repo, current branch, origin URL, and cleanliness. Reject non-GitHub remotes and a requested `owner/repo` mismatch.

- [ ] **Step 3: Write failing GitHub adapter tests**

Inject a fake Octokit-shaped client and fake `gh auth token` process result. Test issue retrieval, issue-body update, comment creation, PR lookup by head, and PR creation:

```ts
expect(await github.getIssue(42)).toMatchObject({ number: 42, nodeId: "I_42" });
expect(fakeIssues.update).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", issue_number: 42, body: nextBody });
```

Run the adapter test; expect FAIL.

- [ ] **Step 4: Implement authenticated GitHub operations**

Obtain the token only via `gh auth token`; pass it directly to Octokit and never log or persist it. Define `GitHubPort` methods:

```ts
getIssue(number: number): Promise<GitHubIssue>;
updateIssueBody(number: number, body: string): Promise<GitHubIssue>;
createIssueComment(number: number, body: string): Promise<void>;
findPullRequestByHead(head: string): Promise<PullRequestRef | null>;
createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
```

Run Task 3 tests and expect PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/github tests/unit/github
git commit -m "feat: add repository and GitHub adapters"
```

---

### Task 4: Pi command guard, structured submission, and role runner

**Files:**
- Create: `src/security/command-policy.ts`
- Create: `src/pi/guard-extension.ts`
- Create: `src/pi/pi-runner.ts`
- Create: `tests/unit/security/command-policy.test.ts`
- Create: `tests/integration/pi/pi-runner.test.ts`
- Create: `tests/fixtures/pi/fake-pi.mjs`

**Interfaces:**
- Produces: `evaluateShellCommand`, `assertWorkspacePath`, `PiRunner.run(request)`, and the compiled guard extension loaded by Pi.
- Consumes: `ProcessRunner`, role-result schemas, role/model config, and `ArtifactStore`.

- [ ] **Step 1: Write failing command/path policy tests**

Prove allowed executables pass while shell composition, GitHub mutation, destructive Git, paths outside the worktree, and protected paths fail:

```ts
expect(evaluateShellCommand("npm test -- --run", ["npm"])).toEqual({ allowed: true });
expect(evaluateShellCommand("npm test && git push", ["npm"])).toMatchObject({ allowed: false });
expect(evaluateShellCommand("git reset --hard", ["git"])).toMatchObject({ allowed: false });
expect(() => assertWorkspacePath(root, "../secret", [])).toThrow("outside worktree");
```

Run the policy test and observe FAIL.

- [ ] **Step 2: Implement fail-closed policy evaluation**

Parse with `shell-quote`. Reject operators, substitutions, redirections, absolute executables, `gh`, forbidden Git subcommands, and any first token outside `allowedCommands`. Resolve tool paths with `realpath` where the target exists and lexical normalization where it does not. Reject paths outside the worktree and any configured protected path.

Run the policy test and expect PASS.

- [ ] **Step 3: Write failing Pi runner contract tests**

The fake Pi executable should read its arguments and either write a valid submitted result, omit the result, write malformed JSON, sleep past timeout, or exit nonzero. Assert that only a valid role-matching result succeeds.

```ts
const execution = await pi.run({ role: "reviewer", model, prompt: "review", worktree, policy, timeoutMs: 500 });
expect(execution.result.outcome).toBe("APPROVED");
await expect(pi.run(malformedRequest)).rejects.toThrow("invalid reviewer result");
```

Run the integration test and observe FAIL.

- [ ] **Step 4: Implement the Pi guard extension**

Register `tool_call` and block disallowed `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` requests. Register `submit_result` with this public shape:

```ts
pi.registerTool({
  name: "submit_result",
  label: "Submit role result",
  description: "Submit the final structured result exactly once",
  parameters: Type.Object({ payload: Type.String() }),
  async execute(_id, { payload }) {
    writeFileSync(resultPath, payload, { flag: "wx", mode: 0o600 });
    return { content: [{ type: "text", text: "Result accepted" }], details: {} };
  },
});
```

Read the guard envelope path from `AUTOPILOT_GUARD_CONFIG`; the envelope contains worktree, role, result path, protected paths, and allowed commands. Do not include secrets.

- [ ] **Step 5: Implement bounded Pi invocation**

Spawn Pi from the worktree with `--print --mode json --approve`, a dedicated session directory, role-specific `--model` and `--thinking`, the compiled guard extension, and a role-specific tool allowlist. Refiner/reviewer tools are read-only plus `submit_result`; implementer additionally receives guarded `bash`, `edit`, and `write`.

After exit, require exactly one result file and validate it with the role-specific Zod schema. Persist stdout/stderr as diagnostic artifacts but never derive the outcome from them.

Run Task 4 tests and expect PASS.

- [ ] **Step 6: Verify with the installed Pi CLI and commit**

Run: `pi --version`
Expected: version `0.84.2` or newer.

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS.

```bash
git add src/security src/pi tests/unit/security tests/integration/pi tests/fixtures/pi
git commit -m "feat: add guarded structured Pi execution"
```

---

### Task 5: Readiness analysis and `check`

**Files:**
- Create: `src/readiness/prompt.ts`
- Create: `src/readiness/readiness-service.ts`
- Create: `src/commands/check.ts`
- Create: `src/cli.ts`
- Create: `tests/unit/readiness/readiness-service.test.ts`
- Create: `tests/integration/commands/check.test.ts`

**Interfaces:**
- Produces: `ReadinessService.check(issueNumber): Promise<ReadinessReport>` and `registerCheckCommand(program, deps)`.
- Consumes: repository context, config, `GitHubPort`, `PiRunner`, `ArtifactStore`, and `TaskSnapshotSchema`.

- [ ] **Step 1: Write failing semantic readiness tests**

Test a complete free-form issue, missing acceptance criteria, unsatisfied dependencies, manual-only validation, and product ambiguity. Assert that a refiner's `READY` cannot bypass deterministic checks:

```ts
const report = await service.check(42);
expect(report.status).toBe("NEEDS_REFINEMENT");
expect(report.gaps).toContainEqual(expect.objectContaining({ code: "NO_TESTABLE_ACCEPTANCE_CRITERIA" }));
expect(github.updateIssueBody).not.toHaveBeenCalled();
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement the refiner prompt and readiness gate**

The prompt must instruct the refiner to inspect repository guidance and referenced canonical files, distinguish engineering from product ambiguity, and call `submit_result`. Hash the issue body with SHA-256. Validate objective, expected behavior, acceptance criteria, validation, dependencies, and ambiguity deterministically after schema validation.

Store the report and valid snapshot as run-independent artifacts. Never mutate GitHub.

- [ ] **Step 3: Write failing `check` command tests**

Inject dependencies into the command handler. Assert human-readable and `--json` output, exit code `0` for ready and `2` for needs refinement.

Run the command test and observe FAIL.

- [ ] **Step 4: Register the CLI and implement `check`**

Make `src/cli.ts` export `buildProgram(deps)` for tests and run only when invoked as the entry module. The handler must resolve shorthand issue numbers against `origin`, print gaps with suggested additions, and make no mutation calls.

Run Task 5 tests and expect PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/readiness src/commands/check.ts src/cli.ts tests/unit/readiness tests/integration/commands
git commit -m "feat: add semantic issue readiness checks"
```

---

### Task 6: Managed refinement and `prepare`

**Files:**
- Create: `src/readiness/refinement-section.ts`
- Create: `src/commands/prepare.ts`
- Create: `tests/unit/readiness/refinement-section.test.ts`
- Create: `tests/integration/commands/prepare.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `upsertRefinementSection(body, snapshot): string` and `registerPrepareCommand`.
- Consumes: `ReadinessService`, `GitHubPort`, and the injected confirmation prompt.

- [ ] **Step 1: Write failing managed-section tests**

Cover append, replacement, malformed duplicate markers, preservation of original content, and stable reruns:

```ts
const once = upsertRefinementSection("Original context", snapshot);
const twice = upsertRefinementSection(once, changedSnapshot);
expect(twice).toContain("Original context");
expect(twice.match(/autopilot-refinement:start/g)).toHaveLength(1);
expect(twice).not.toContain(snapshot.objective);
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement deterministic Markdown rendering**

Render Goal, Context, Expected behavior, Acceptance criteria, Constraints, Non-goals, Validation, Dependencies, and References in a fixed order. Replace only the single valid managed section; reject unbalanced or duplicate markers rather than guessing.

- [ ] **Step 3: Write failing `prepare` approval tests**

Assert the diff is shown, rejection causes no mutation, approval updates exactly once, and a concurrent issue-body change aborts before update:

```ts
confirmation.resolve(false);
await command.run();
expect(github.updateIssueBody).not.toHaveBeenCalled();
```

Run the command test and observe FAIL.

- [ ] **Step 4: Implement `prepare`**

Fetch the issue, run semantic analysis, render the proposed body, show a unified diff, and ask for explicit approval. Re-fetch immediately before mutation and require the original `updatedAt` and body hash to match. In `--json` mode, emit the proposal but do not apply it because no interactive approval is available.

Run Task 6 tests and expect PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/readiness/refinement-section.ts src/commands/prepare.ts src/cli.ts tests/unit/readiness/refinement-section.test.ts tests/integration/commands/prepare.test.ts
git commit -m "feat: add approved issue preparation"
```

---

### Task 7: Isolated workspace lifecycle

**Files:**
- Create: `src/workspace/workspace-manager.ts`
- Create: `tests/integration/workspace/workspace-manager.test.ts`

**Interfaces:**
- Produces: `WorkspaceManager.create`, `inspect`, `treeHash`, `commit`, and `removeSuccessful`.
- Consumes: `ProcessRunner`, repository context, run ID, issue number/title, and workspace policy.

- [ ] **Step 1: Write failing real-Git integration tests**

Create a temporary repository with an initial commit and bare remote. Test sibling worktree creation, branch slugging, dirty-primary rejection, active branch collision, commit creation, and preservation of blocked worktrees.

```ts
const workspace = await manager.create({ runId: "run-1", issueNumber: 42, title: "Token refresh", baseBranch: "main" });
expect(workspace.branch).toBe("autopilot/42-token-refresh");
expect(workspace.path).not.toBe(repoRoot);
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement worktree creation and inspection**

Use orchestrator-owned Git commands only. Create the sibling path under `<parent>/.pi-autopilot-worktrees/<repo>/<run-id>`. Refuse dirty primary state when configured, protected base mismatch, existing branch ownership mismatch, or a path already registered to another run.

- [ ] **Step 3: Implement exact-tree commit and cleanup**

`treeHash` returns `git write-tree` after staging in a temporary index or, at final publication, stages the worktree and returns the staged tree. `commit` stages all task changes, verifies the staged tree equals the latest verified tree hash, and creates a commit with `Refs #<issue>` in the body. Do not push.

Successful cleanup runs only after durable PR evidence exists. Blocked/failed cleanup is never automatic.

Run the test and expect PASS.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/workspace tests/integration/workspace
git commit -m "feat: add isolated worktree lifecycle"
```

---

### Task 8: Deterministic setup and verification

**Files:**
- Create: `src/verification/verification-runner.ts`
- Create: `tests/integration/verification/verification-runner.test.ts`

**Interfaces:**
- Produces: `VerificationRunner.runSetup` and `runVerification`, returning `VerificationEvidence` with `treeHash`, command results, and artifact references.
- Consumes: `ProcessRunner`, `ArtifactStore`, config commands, timeouts, and `WorkspaceManager.treeHash`.

- [ ] **Step 1: Write failing verification tests**

Cover ordered commands, early setup failure, complete verification reporting, timeout, output truncation, clean explicit environment, and tree-hash capture:

```ts
const evidence = await verifier.runVerification(workspace, [passCommand, failCommand]);
expect(evidence.passed).toBe(false);
expect(evidence.commands.map((item) => item.exitCode)).toEqual([0, 1]);
expect(evidence.treeHash).toMatch(/^[0-9a-f]{40,64}$/);
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement policy-driven execution**

Execute setup once per workspace attempt and all verification commands in declared order. Use the repository root as cwd, explicit inherited safe variables (`PATH`, `HOME`, locale, package-manager cache variables), and configured nonsecret additions. Persist bounded stdout/stderr per command. Continue verification after a failed check so the reviewer receives complete evidence; setup failure stops implementation.

- [ ] **Step 3: Bind evidence to the exact tree**

Capture the worktree tree hash after the final command. Include policy hash, timestamps, command text, exit status, timeout status, duration, and artifact paths. `passed` is true only when every configured verification command exits zero and does not time out.

Run the test and expect PASS.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/verification tests/integration/verification
git commit -m "feat: add deterministic verification evidence"
```

---

### Task 9: Pure workflow state machine and loop budgets

**Files:**
- Create: `src/workflow/state-machine.ts`
- Create: `src/workflow/budgets.ts`
- Create: `tests/unit/workflow/state-machine.test.ts`
- Create: `tests/unit/workflow/budgets.test.ts`

**Interfaces:**
- Produces: `assertTransition(from, to)`, `nextStage(event, context)`, `BudgetTracker`, and `fingerprintFailure`.
- Consumes: run stages and role outcomes from Task 1.

- [ ] **Step 1: Write the complete transition-table tests**

Use table-driven tests for every legal edge and representative illegal edges. Include correction cycles, readiness failure, cancellation from nonterminal stages, and publication only after passing verification plus approval.

```ts
expect(nextStage({ type: "REVIEW_RESULT", outcome: "CHANGES_REQUESTED" }, { correctionCycles: 0 })).toBe("CORRECTION");
expect(() => assertTransition("IMPLEMENTATION", "PUBLICATION")).toThrow("illegal transition");
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement the pure transition model**

Keep the legal transition map exhaustive over `RunStage`. Require explicit event inputs; never infer success from missing data. Terminal states have no outgoing edges.

- [ ] **Step 3: Write failing budget/repetition tests**

Assert three implementation attempts, two correction cycles, stage deadlines, and a repeated normalized fingerprint block:

```ts
tracker.recordFailure({ stage: "VERIFICATION", command: "npm test", exitCode: 1, findings: ["src/a.ts: assertion"] });
expect(tracker.recordFailure(sameFailure).decision).toBe("BLOCK_REPEATED_FAILURE");
```

Run and observe FAIL.

- [ ] **Step 4: Implement budget tracking and stable fingerprints**

Normalize volatile paths, timestamps, whitespace, and durations before SHA-256 hashing. Keep counters in persisted attempt data; the pure tracker receives current values and returns the next decision without writing storage itself.

Run Task 9 tests and expect PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/workflow/state-machine.ts src/workflow/budgets.ts tests/unit/workflow
git commit -m "feat: define bounded workflow transitions"
```

---

### Task 10: Idempotent publication

**Files:**
- Create: `src/publication/publisher.ts`
- Create: `tests/integration/publication/publisher.test.ts`

**Interfaces:**
- Produces: `Publisher.publish(input): Promise<PublicationResult>`.
- Consumes: `WorkspaceManager`, `GitHubPort`, `ProcessRunner`, `RunStore`, frozen snapshot, approved review, and passing verification evidence.

- [ ] **Step 1: Write failing publication tests**

Test tree mismatch rejection, orchestrator commit, push, existing-PR reconciliation, PR-body evidence, concise issue comment, interrupted retry, and no issue closure/merge calls.

```ts
await expect(publisher.publish({ ...input, verification: { ...verification, treeHash: "wrong" } })).rejects.toThrow("tree changed after verification");
expect(github.createIssueComment).toHaveBeenCalledTimes(1);
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement commit and push ordering**

Require approved review and passing verification. Recompute the staged tree, compare it with `verification.treeHash`, commit, persist commit SHA, then push with `git push --set-upstream origin <branch>`. Never force-push.

- [ ] **Step 3: Implement idempotent PR and comment publication**

Before creating a PR, query by head branch. If present, reconcile and reuse it. Build the PR body from the frozen objective, acceptance criteria, implementation summary, verification commands/results, reviewer approval, and run ID. Persist PR identity before posting the issue comment. Record a comment marker containing the run ID and avoid duplicate comments on resume.

Run the test and expect PASS.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/publication tests/integration/publication
git commit -m "feat: publish verified work idempotently"
```

---

### Task 11: End-to-end run orchestration and bounded corrections

**Files:**
- Create: `src/workflow/run-service.ts`
- Create: `src/commands/run.ts`
- Create: `tests/integration/workflow/run-service.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `RunService.start(issueNumber, overrides)` and `registerRunCommand`.
- Consumes: all ports from Tasks 2–10.

- [ ] **Step 1: Write failing happy-path orchestration test**

Use fakes for GitHub/Pi and a real temporary Git repository, SQLite store, worktree, and verification commands. Assert exact stage order:

```ts
expect(store.transitions(run.id).map((item) => item.to)).toEqual([
  "READINESS_CHECK", "WORKSPACE_CREATION", "IMPLEMENTATION", "VERIFICATION",
  "INDEPENDENT_REVIEW", "PUBLICATION", "PR_OPEN",
]);
```

Assert the implementer cannot publish and the reviewer receives no implementer transcript.

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement preflight through initial implementation**

Resolve repository/config/models, validate `gh` and Pi versions/auth availability, check active-run uniqueness, run readiness, freeze the snapshot, create the workspace, run setup, then launch the implementer. Persist each transition before starting the side effect for the next stage and persist its evidence before advancing again.

- [ ] **Step 3: Write failing correction and terminal-path tests**

Cover failed readiness, implementer block, failed verification, one successful correction, two exhausted corrections, product ambiguity, malformed role output, repeated failure, and changed issue before publication.

Run the focused test and observe the new cases fail.

- [ ] **Step 4: Implement verification/review/correction loop**

After implementer `COMPLETED`, run deterministic verification. If it fails and budget remains, send only current worktree state and verification evidence to a fresh correction session. After passing verification, launch a fresh reviewer. On `CHANGES_REQUESTED`, persist findings and start a fresh correction session. Stop at two correction cycles or earlier repetition/budget exhaustion.

Before publication, re-fetch the issue and compare `updatedAt` and body hash with the snapshot. Material change transitions to `BLOCKED`. Approval plus exact-tree verification invokes `Publisher.publish`.

- [ ] **Step 5: Register `run` CLI output**

Print concise stage updates by subscribing to persisted transition events. Support `--json`, per-role model overrides, and thinking overrides. Return exit code `0` only for `PR_OPEN`, `2` for readiness/block states, and `1` for failures.

Run Task 11 tests and expect PASS.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/workflow/run-service.ts src/commands/run.ts src/cli.ts tests/integration/workflow/run-service.test.ts
git commit -m "feat: orchestrate supervised task execution"
```

---

### Task 12: Recovery, resume, status, inspect, and abandon

**Files:**
- Create: `src/workflow/recovery-service.ts`
- Create: `src/commands/status.ts`
- Create: `src/commands/inspect.ts`
- Create: `src/commands/resume.ts`
- Create: `src/commands/abandon.ts`
- Create: `tests/integration/workflow/recovery-service.test.ts`
- Create: `tests/integration/commands/operator-commands.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `RecoveryService.reconcile/resume/abandon`, plus four CLI command registrations.
- Consumes: `RunStore`, `ArtifactStore`, `WorkspaceManager`, `GitHubPort`, `RunService`, and persisted process/publication metadata.

- [ ] **Step 1: Write failing reconciliation tests**

Seed nonterminal runs interrupted during implementation, verification, push, and PR creation. Assert no stage is assumed successful and remote side effects are queried before retry:

```ts
const recovery = await service.reconcile(run.id);
expect(recovery.actions).toContainEqual({ type: "REUSE_EXISTING_PR", number: 77 });
expect(github.createPullRequest).not.toHaveBeenCalled();
```

Run the focused test and observe FAIL.

- [ ] **Step 2: Implement conservative reconciliation**

Inspect PID/session metadata, worktree existence, branch/HEAD, current tree, verification evidence, remote branch, and PR-by-head. Return explicit recommended actions. Reuse completed evidence only when its recorded tree hash still matches. Never automatically restart an uncertain agent stage.

- [ ] **Step 3: Write failing operator-command tests**

Assert `status` reports current/next states, `inspect` reports snapshot/evidence/models/transitions with redaction, `resume` launches a fresh attempt in the preserved workspace, and `abandon` marks `CANCELLED` without deleting files.

Run and observe FAIL.

- [ ] **Step 4: Implement operator commands**

`resume` must require a resumable blocked or recovered state, preserve the snapshot, accept explicit model overrides, increment attempt counters, and invoke the correction path in `RunService`. `abandon` uses a compare-and-set transition to `CANCELLED`. All commands support stable `--json` output.

Run Task 12 tests and expect PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test && npm run build`

```bash
git add src/workflow/recovery-service.ts src/commands src/cli.ts tests/integration/workflow/recovery-service.test.ts tests/integration/commands/operator-commands.test.ts
git commit -m "feat: add run recovery and operator controls"
```

---

### Task 13: Acceptance suite, sample policy, and operator documentation

**Files:**
- Create: `src/testing/fake-pi.ts`
- Create: `tests/e2e/supervised-task-run.test.ts`
- Create: `tests/e2e/safety-and-recovery.test.ts`
- Create: `examples/autopilot.yaml`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: a controllable fake Pi binary, executable acceptance suite, installation guide, issue-preparation guide, policy reference, and runbook.
- Consumes: the public CLI and all M1 behavior.

- [ ] **Step 1: Write the failing successful-run acceptance test**

Build a fixture repository plus bare remote, fake GitHub server/adapter, and scripted fake Pi. Exercise the compiled CLI through `check`, `prepare`, and `run`. Assert:

```ts
expect(result.exitCode).toBe(0);
expect(remote.hasBranch("autopilot/42-token-refresh")).toBe(true);
expect(github.pullRequests).toHaveLength(1);
expect(github.issueComments[0].body).toContain("Run ID:");
expect(primaryCheckoutHead).toBe(originalHead);
```

Run: `npx vitest run tests/e2e/supervised-task-run.test.ts`
Expected: FAIL until the fake executable and any missing wiring are complete.

- [ ] **Step 2: Implement the controllable fake Pi executable and complete wiring**

The fake reads a scenario file keyed by role and attempt, writes the configured `submit_result` payload path, optionally mutates the worktree, sleeps, exits nonzero, or emits malformed output. Add dependency wiring in `src/cli.ts` that uses real adapters by default and test adapters only through constructor injection—not environment-controlled production backdoors.

Run the successful acceptance test and expect PASS.

- [ ] **Step 3: Write and pass safety/recovery acceptance tests**

Cover denied destructive commands, protected-path writes, failed verification, two correction cycles, interrupted publication, deduplicated PR/comment creation, blocked worktree preservation, and explicit resume with a fresh session.

Run: `npx vitest run tests/e2e/safety-and-recovery.test.ts`
Expected: PASS after fixing only defects exposed by these acceptance cases.

- [ ] **Step 4: Add the sample policy and operator guide**

Document:

- Node, `gh`, Pi, and authentication prerequisites;
- installation and `npm link` usage;
- the minimum issue execution contract;
- `check → prepare → check → run` workflow;
- all CLI commands and exit codes;
- role-specific model resolution and overrides;
- `.pi/autopilot.yaml` fields using `examples/autopilot.yaml`;
- data/artifact location and redaction;
- blocked-run inspect/resume/abandon runbook;
- explicit M1 non-goals, especially no merge or issue closure.

Add `test:e2e` and `check` scripts:

```json
{
  "test:e2e": "vitest run tests/e2e",
  "check": "npm run typecheck && npm test && npm run build"
}
```

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run check
npm run test:e2e
npm pack --dry-run
```

Expected: all tests pass, TypeScript compiles, and the package contains `bin`, `dist`, `README.md`, and the sample policy but excludes tests and local run artifacts.

- [ ] **Step 6: Perform a local opt-in smoke test**

In a disposable GitHub test repository with a harmless ready issue and no protected credentials in the worktree, run:

```bash
npm link
pi --version
gh auth status
autopilot check <test-issue-number>
```

Expected: preflight succeeds, the issue is assessed without mutation, and local evidence contains no token values. Do not run `autopilot run` against a real repository until the developer explicitly approves that smoke-test issue.

- [ ] **Step 7: Commit the acceptance deliverable**

```bash
git add src/testing tests/e2e examples README.md package.json package-lock.json
git commit -m "docs: complete autopilot M1 acceptance workflow"
```

---

## Final spec-coverage verification

Before declaring M1 complete, map the implementation evidence to every acceptance criterion in Section 15 of the design:

1. `check` ready/unready and no mutation → Tasks 5 and 13.
2. approved managed-section preparation → Task 6.
3. role-specific recorded model resolution → Tasks 1, 2, and 4.
4. isolated ready-task execution → Tasks 7, 11, and 13.
5. verification independent of agent claims → Task 8.
6. fresh independent review and bounded corrections → Tasks 4, 9, and 11.
7. safe explicit terminal behavior → Tasks 4, 9, 11, and 13.
8. interruption inspection/resume without duplication → Tasks 2, 10, and 12.
9. orchestrator-created commit, branch, PR, and concise comment → Tasks 7, 10, and 13.
10. untouched primary checkout, issue closure, and merge state → Tasks 3, 7, 10, and 13.

Run the final gate from a clean checkout:

```bash
npm ci
npm run check
npm run test:e2e
git status --short
```

Expected: every command passes and `git status --short` is empty.
