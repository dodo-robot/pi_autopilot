# Continuous Backlog Intake (`discover` + `queue add`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `autopilot discover <ref> [moreRefs...]` (the mutating, label-writing sibling of `analyze`) and `autopilot queue add <issue...>` (append issues to a running daemon's queue), plus the daemon's just-in-time claim/release label lifecycle and pending-queue drain.

**Architecture:** `discover` reuses `analyze`'s exact readiness computation (`BacklogAnalyst`) unchanged, then reconciles the `agent:ready` label per issue via a new pure `reconcileReadyLabel` function and three new narrow `GitHubPort` methods (`listLabels`/`addLabel`/`removeLabel`). `queue add` is a thin CLI writing to a new atomically-written `queue-pending.json` via `PendingQueueStore`, guarded by the existing `PidFile.isLive()` daemon-liveness check. `DaemonRunner`'s main loop gains a best-effort claim/release around each `runService.start` call and drains the pending queue once before the loop and once per iteration.

**Tech Stack:** TypeScript/ESM, Node.js 22.5+, `commander`, `vitest`, `@octokit/rest` (via existing `OctokitLike` port).

**Spec:** `docs/superpowers/specs/2026-08-23-continuous-backlog-intake-design.md`

## Global Constraints

- TypeScript strict mode; ESM-only (`.js` extensions on all local imports).
- No new runtime dependencies.
- `agent:ready` / `agent:in-progress` are hardcoded string constants, not configurable.
- All GitHub label writes on the daemon's claim/release path and inside `discover`'s reconciliation are **best-effort**: failures are logged, never thrown past the call site, and never change a run's outcome, the queue's `currentIndex` advancement, or `discover`'s exit code.
- `discover` never reads or writes `agent:in-progress`; it only ever adds/removes `agent:ready`, and skips any issue that already has `agent:in-progress`.
- `queue add` performs no readiness validation and no GitHub interaction — pure local file write, consistent with `start`'s existing explicit-list behavior.
- File writes to `queue-pending.json` use the same atomic tmp-file-then-`renameSync` pattern already used by `QueueStore` (`src/daemon/queue-store.ts`).
- Follow existing patterns: dependency-injection via a `deps` object on every class/command (mirror `AnalyzeCommandDeps`, `DaemonRunnerDeps`, `StartCommandDeps`).

---

## File Map

**New files:**

| File | Responsibility |
|---|---|
| `src/analysis/label-reconciliation.ts` | Pure `reconcileReadyLabel` function + `LabelAction` type |
| `src/daemon/pending-queue-store.ts` | `PendingQueueStore` — atomic append/drain of `queue-pending.json` |
| `src/commands/discover.ts` | CLI entry point for `autopilot discover` |
| `src/commands/queue.ts` | CLI entry point for `autopilot queue add` |
| `tests/unit/analysis/label-reconciliation.test.ts` | |
| `tests/unit/daemon/pending-queue-store.test.ts` | |
| `tests/unit/commands/discover.test.ts` | |
| `tests/unit/commands/queue.test.ts` | |

**Modified files:**

| File | Change |
|---|---|
| `src/github/github-adapter.ts` | Add `listLabels`/`addLabel`/`removeLabel` to `GitHubPort`, `OctokitLike`, and `GitHubAdapter` |
| `src/domain/backlog.ts` | Add `labelAction` field to `BacklogReportSchema`'s per-issue entry (optional, so `analyze`'s existing reports/tests are unaffected) |
| `src/platform/paths.ts` | Add `pendingQueuePath` to `AppPaths` |
| `src/daemon/daemon-runner.ts` | Add claim/release around `runService.start`, add pending-queue drain before and during the loop |
| `src/daemon/daemon-entry.ts` | Wire `github` and `pendingQueueStore` into the constructed `DaemonRunner` |
| `src/cli.ts` | Register `discover` and `queue` commands |
| `tests/unit/github/github-adapter.test.ts` | Add tests for the three new methods |
| `tests/unit/daemon/daemon-runner.test.ts` | Add tests for claim/release and pending-drain behavior |

---

## Task 1: `GitHubPort` label methods

**Files:**
- Modify: `src/github/github-adapter.ts`
- Test: `tests/unit/github/github-adapter.test.ts`

**Interfaces:**
- Produces (added to the existing `GitHubPort` interface):
  - `listLabels(number: number): Promise<string[]>`
  - `addLabel(number: number, name: string): Promise<void>`
  - `removeLabel(number: number, name: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/github/github-adapter.test.ts`, extending the existing `makeOctokit()` helper's `rest.issues` object with the three new mocked methods:

```typescript
// Inside makeOctokit(), add to octokit.rest.issues:
listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [{ name: "bug" }, { name: "agent:ready" }] }),
addLabels: vi.fn().mockResolvedValue({ data: [] }),
removeLabel: vi.fn().mockResolvedValue({ data: [] }),
```

Then add a new `describe` block at the end of the file:

```typescript
describe("GitHubAdapter label methods", () => {
  it("lists labels on an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    const labels = await github.listLabels(42);
    expect(labels).toEqual(["bug", "agent:ready"]);
    expect(octokit.rest.issues.listLabelsOnIssue).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
    });
  });

  it("adds a label to an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await github.addLabel(42, "agent:in-progress");
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      labels: ["agent:in-progress"],
    });
  });

  it("removes a label from an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await github.removeLabel(42, "agent:ready");
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      name: "agent:ready",
    });
  });

  it("treats a 404 on remove as success (label already absent)", async () => {
    const { octokit } = makeOctokit();
    (octokit.rest.issues.removeLabel as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const { github } = await makeAdapter(octokit);
    await expect(github.removeLabel(42, "agent:ready")).resolves.toBeUndefined();
  });

  it("wraps a non-404 remove failure in GitHubError", async () => {
    const { octokit } = makeOctokit();
    (octokit.rest.issues.removeLabel as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );
    const { github } = await makeAdapter(octokit);
    await expect(github.removeLabel(42, "agent:ready")).rejects.toBeInstanceOf(GitHubError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/github/github-adapter.test.ts
```
Expected: FAIL — `listLabels`/`addLabel`/`removeLabel` do not exist on `GitHubAdapter`, and the octokit fixture is missing the new mocked methods (the pre-existing tests in this file must still pass once the fixture additions land; only the new `describe` block should fail before Step 3).

- [ ] **Step 3: Extend `OctokitLike` and `GitHubPort` in `src/github/github-adapter.ts`**

Add to the `issues` block inside `OctokitLike`:

```typescript
listLabelsOnIssue(params: {
  owner: string;
  repo: string;
  issue_number: number;
}): Promise<{ data: Array<{ name?: string } | string> }>;
addLabels(params: {
  owner: string;
  repo: string;
  issue_number: number;
  labels: string[];
}): Promise<{ data: unknown }>;
removeLabel(params: {
  owner: string;
  repo: string;
  issue_number: number;
  name: string;
}): Promise<{ data: unknown }>;
```

Add to `GitHubPort`:

```typescript
listLabels(number: number): Promise<string[]>;
addLabel(number: number, name: string): Promise<void>;
removeLabel(number: number, name: string): Promise<void>;
```

- [ ] **Step 4: Implement the three methods on `GitHubAdapter`**

Add after the existing `ensureLabel` method:

```typescript
async listLabels(number: number): Promise<string[]> {
  try {
    const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    return data.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
  } catch (error) {
    throw new GitHubError(`failed to list labels for issue #${number}`, { cause: error });
  }
}

async addLabel(number: number, name: string): Promise<void> {
  try {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      labels: [name],
    });
  } catch (error) {
    throw new GitHubError(`failed to add label "${name}" to issue #${number}`, { cause: error });
  }
}

async removeLabel(number: number, name: string): Promise<void> {
  try {
    await this.octokit.rest.issues.removeLabel({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      name,
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return;
    throw new GitHubError(`failed to remove label "${name}" from issue #${number}`, { cause: error });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/github/github-adapter.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Full regression check and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run
npx tsc --noEmit
git add src/github/github-adapter.ts tests/unit/github/github-adapter.test.ts
git commit -m "feat(discover): add label list/add/remove to GitHubPort"
```

---

## Task 2: Pure label-reconciliation logic

**Files:**
- Create: `src/analysis/label-reconciliation.ts`
- Test: `tests/unit/analysis/label-reconciliation.test.ts`

**Interfaces:**
- Produces:
  - `type LabelAction = "labeled" | "unlabeled" | "unchanged" | "skipped-in-progress"`
  - `reconcileReadyLabel(input: { isReady: boolean; hasReadyLabel: boolean; hasInProgressLabel: boolean }): LabelAction`
  - `const AGENT_READY_LABEL = "agent:ready"`
  - `const AGENT_IN_PROGRESS_LABEL = "agent:in-progress"`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/analysis/label-reconciliation.test.ts
import { describe, expect, it } from "vitest";
import { reconcileReadyLabel } from "../../../src/analysis/label-reconciliation.js";

describe("reconcileReadyLabel", () => {
  it("skips when agent:in-progress is present, regardless of readiness", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: true }),
    ).toBe("skipped-in-progress");
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: true, hasInProgressLabel: true }),
    ).toBe("skipped-in-progress");
  });

  it("labels a ready issue missing the label", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: false }),
    ).toBe("labeled");
  });

  it("unlabels a non-ready issue carrying the label", () => {
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: true, hasInProgressLabel: false }),
    ).toBe("unlabeled");
  });

  it("leaves a ready issue that already has the label unchanged", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: true, hasInProgressLabel: false }),
    ).toBe("unchanged");
  });

  it("leaves a non-ready issue with no label unchanged", () => {
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: false, hasInProgressLabel: false }),
    ).toBe("unchanged");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/analysis/label-reconciliation.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/analysis/label-reconciliation.ts`**

```typescript
export const AGENT_READY_LABEL = "agent:ready";
export const AGENT_IN_PROGRESS_LABEL = "agent:in-progress";

export type LabelAction = "labeled" | "unlabeled" | "unchanged" | "skipped-in-progress";

/**
 * Decide what `discover` should do to an issue's `agent:ready` label given
 * its computed readiness and current label state. Never considers writing
 * `agent:in-progress` — that label is owned exclusively by the daemon's
 * just-in-time claim/release lifecycle (see `daemon-runner.ts`). An issue
 * already carrying `agent:in-progress` is always left alone: it is either
 * genuinely being worked right now, or stuck there from a past BLOCKED/
 * FAILED run — in both cases not `discover`'s to touch.
 */
export function reconcileReadyLabel(input: {
  isReady: boolean;
  hasReadyLabel: boolean;
  hasInProgressLabel: boolean;
}): LabelAction {
  if (input.hasInProgressLabel) return "skipped-in-progress";
  if (input.isReady && !input.hasReadyLabel) return "labeled";
  if (!input.isReady && input.hasReadyLabel) return "unlabeled";
  return "unchanged";
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/analysis/label-reconciliation.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/analysis/label-reconciliation.ts tests/unit/analysis/label-reconciliation.test.ts
git commit -m "feat(discover): add pure agent:ready label reconciliation logic"
```

---

## Task 3: `BacklogReportSchema` gains `labelAction`

**Files:**
- Modify: `src/domain/backlog.ts`
- Test: `tests/unit/domain/backlog.test.ts`

**Interfaces:**
- Consumes: `LabelAction` from `src/analysis/label-reconciliation.ts`
- Produces: `BacklogReportSchema`'s per-issue entry gains an optional `labelAction?: LabelAction` field. `analyze`'s existing reports (which never set this field) continue to validate unchanged.

- [ ] **Step 1: Write the failing test**

Check the existing test file first:

```bash
cd /Users/andrea.dodero/pi_autopilot
cat tests/unit/domain/backlog.test.ts
```

Add a new test case to that file (append to the existing `describe` block, matching its existing style):

```typescript
it("accepts an issue entry with an optional labelAction", () => {
  const report = parseBacklogReport({
    repository: { owner: "acme", repo: "widgets" },
    epicRef: null,
    requestedRefs: [42],
    generatedAt: "2026-08-23T00:00:00Z",
    analysisId: "discover-1",
    scope: { totalIssues: 1, analyzed: 1, unresolved: 0 },
    issues: [
      {
        issueNumber: 42,
        title: "Fix widget",
        url: "https://github.com/acme/widgets/issues/42",
        classification: "READY",
        screen: { classification: "READY", reasons: [] },
        readiness: null,
        labelAction: "labeled",
      },
    ],
    executable: [42],
    needsWork: [],
    summary: { ready: 1, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
    refinerSessions: 0,
  });
  expect(report.issues[0]!.labelAction).toBe("labeled");
});

it("still accepts a report with no labelAction (analyze's existing shape)", () => {
  const report = parseBacklogReport({
    repository: { owner: "acme", repo: "widgets" },
    epicRef: null,
    requestedRefs: [42],
    generatedAt: "2026-08-23T00:00:00Z",
    analysisId: "analyze-1",
    scope: { totalIssues: 1, analyzed: 1, unresolved: 0 },
    issues: [
      {
        issueNumber: 42,
        title: "Fix widget",
        url: "https://github.com/acme/widgets/issues/42",
        classification: "READY",
        screen: { classification: "READY", reasons: [] },
        readiness: null,
      },
    ],
    executable: [42],
    needsWork: [],
    summary: { ready: 1, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
    refinerSessions: 0,
  });
  expect(report.issues[0]!.labelAction).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/domain/backlog.test.ts
```
Expected: FAIL on the first new test — `labelAction` is stripped/rejected by the current schema (zod strips unknown keys by default, so `report.issues[0]!.labelAction` is `undefined` instead of `"labeled"`).

- [ ] **Step 3: Add the field to `BacklogReportSchema` in `src/domain/backlog.ts`**

```typescript
// Import at the top of the file:
import type { LabelAction } from "../analysis/label-reconciliation.js";

// Inside the `issues: z.array(z.object({ ... }))` schema, after `readiness`:
      readiness: z
        .object({
          analysisId: z.string().min(1),
          status: z.enum(["READY", "NEEDS_REFINEMENT"]),
        })
        .nullable(),
      labelAction: z
        .enum(["labeled", "unlabeled", "unchanged", "skipped-in-progress"])
        .optional(),
```

Note: `LabelAction` is imported only for documentation/type-linking purposes here — the zod `.enum(...)` call is the source of truth and must list the same four literal strings defined in `label-reconciliation.ts`. If the type import is unused after the schema addition (TypeScript strict mode flags unused imports), omit it and instead add a code comment referencing `label-reconciliation.ts` to keep the two enums visibly linked without an unused-import error:

```typescript
      // Keep in sync with LabelAction in ../analysis/label-reconciliation.ts
      labelAction: z
        .enum(["labeled", "unlabeled", "unchanged", "skipped-in-progress"])
        .optional(),
```

- [ ] **Step 4: Run tests to verify passing**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/domain/backlog.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Full regression check and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run
npx tsc --noEmit
git add src/domain/backlog.ts tests/unit/domain/backlog.test.ts
git commit -m "feat(discover): add optional labelAction field to BacklogReportSchema"
```

---

## Task 4: `PendingQueueStore`

**Files:**
- Create: `src/daemon/pending-queue-store.ts`
- Modify: `src/platform/paths.ts`
- Test: `tests/unit/daemon/pending-queue-store.test.ts`

**Interfaces:**
- Consumes: nothing beyond Node built-ins (`node:fs`)
- Produces:
  - `interface PendingQueue { issues: number[] }`
  - `class PendingQueueStore` with:
    - `constructor(deps: { pendingQueuePath: string; daemonDir: string })`
    - `append(issues: number[]): void`
    - `drainAll(): number[]`
  - `AppPaths` gains `pendingQueuePath: string`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/daemon/pending-queue-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingQueueStore } from "../../../src/daemon/pending-queue-store.js";

let tmpDir: string;
afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

function makeStore(): PendingQueueStore {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pending-queue-test-"));
  const daemonDir = path.join(tmpDir, "daemon");
  return new PendingQueueStore({
    pendingQueuePath: path.join(daemonDir, "queue-pending.json"),
    daemonDir,
  });
}

describe("PendingQueueStore", () => {
  it("drainAll returns an empty array when no file exists yet", () => {
    const store = makeStore();
    expect(store.drainAll()).toEqual([]);
  });

  it("append then drainAll round-trips the issue numbers", () => {
    const store = makeStore();
    store.append([42, 43]);
    expect(store.drainAll()).toEqual([42, 43]);
  });

  it("multiple appends accumulate before a drain", () => {
    const store = makeStore();
    store.append([1]);
    store.append([2, 3]);
    expect(store.drainAll()).toEqual([1, 2, 3]);
  });

  it("drainAll empties the file so a second drain returns nothing new", () => {
    const store = makeStore();
    store.append([42]);
    expect(store.drainAll()).toEqual([42]);
    expect(store.drainAll()).toEqual([]);
  });

  it("append after a drain starts a fresh list", () => {
    const store = makeStore();
    store.append([1]);
    store.drainAll();
    store.append([2]);
    expect(store.drainAll()).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/pending-queue-store.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/daemon/pending-queue-store.ts`**

Mirror `src/daemon/queue-store.ts`'s exact atomic tmp-file-then-rename pattern:

```typescript
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface PendingQueue {
  issues: number[];
}

export class PendingQueueStore {
  private readonly pendingQueuePath: string;
  private readonly daemonDir: string;
  private readonly tmpPath: string;

  constructor(deps: { pendingQueuePath: string; daemonDir: string }) {
    this.pendingQueuePath = deps.pendingQueuePath;
    this.daemonDir = deps.daemonDir;
    this.tmpPath = `${deps.pendingQueuePath}.tmp`;
  }

  private write(queue: PendingQueue): void {
    mkdirSync(this.daemonDir, { recursive: true });
    writeFileSync(this.tmpPath, JSON.stringify(queue, null, 2));
    renameSync(this.tmpPath, this.pendingQueuePath);
  }

  private read(): PendingQueue {
    if (!existsSync(this.pendingQueuePath)) return { issues: [] };
    const raw = readFileSync(this.pendingQueuePath, "utf8");
    return JSON.parse(raw) as PendingQueue;
  }

  /** Called by `queue add`: read-modify-atomic-write, appending to any
   * existing pending list. */
  append(issues: number[]): void {
    const current = this.read();
    this.write({ issues: [...current.issues, ...issues] });
  }

  /** Called by the daemon: read current contents, atomically reset to
   * `{ issues: [] }`, and return what was read. Always consumes everything
   * present at read time. */
  drainAll(): number[] {
    const current = this.read();
    this.write({ issues: [] });
    return current.issues;
  }
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/pending-queue-store.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Add `pendingQueuePath` to `AppPaths`**

In `src/platform/paths.ts`, add to the `AppPaths` interface:

```typescript
readonly queuePath: string;
readonly pendingQueuePath: string;   // <-- add, right after queuePath
readonly logPath: string;
```

And to the `appPaths()` return value:

```typescript
queuePath: path.join(daemonDir, "queue.json"),
pendingQueuePath: path.join(daemonDir, "queue-pending.json"),  // <-- add
logPath: path.join(daemonDir, "daemon.log"),
```

- [ ] **Step 6: Full regression check and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run
npx tsc --noEmit
git add src/daemon/pending-queue-store.ts src/platform/paths.ts tests/unit/daemon/pending-queue-store.test.ts
git commit -m "feat(queue-add): add PendingQueueStore and pendingQueuePath"
```

---

## Task 5: `queue add` command

**Files:**
- Create: `src/commands/queue.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/commands/queue.test.ts`

**Interfaces:**
- Consumes: `PidFile` from `src/daemon/pid-file.js`; `PendingQueueStore` from `src/daemon/pending-queue-store.js`; `appPaths` from `src/platform/paths.js`; `resolveIssueRefs` from `src/commands/args.js`; `resolveRepositoryContext` from `src/github/repository-context.js`
- Produces: `registerQueueCommand(program: Command, deps: QueueCommandDeps): void` — registers `queue add`; `QueueCommandDeps` exported for `cli.ts`'s `CliDeps` union

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/commands/queue.test.ts
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerQueueCommand } from "../../../src/commands/queue.js";
import type { QueueCommandDeps } from "../../../src/commands/queue.js";

function makeProgram(deps: QueueCommandDeps) {
  const program = new Command();
  program.exitOverride();
  registerQueueCommand(program, deps);
  return program;
}

describe("queue add command", () => {
  it("errors when no daemon is running", async () => {
    const errors: string[] = [];
    let exitCode: number | undefined;
    const deps: QueueCommandDeps = {
      isDaemonLive: () => false,
      appendPending: vi.fn(),
      stderr: (t) => errors.push(t),
      setExitCode: (c) => { exitCode = c; },
    };
    const program = makeProgram(deps);
    await program.parseAsync(["node", "autopilot", "queue", "add", "42"], { from: "user" });
    expect(errors.join(" ")).toMatch(/no daemon running/i);
    expect(exitCode).toBe(1);
    expect(deps.appendPending).not.toHaveBeenCalled();
  });

  it("appends parsed issue numbers when a daemon is running", async () => {
    let appended: number[] | undefined;
    const messages: string[] = [];
    const deps: QueueCommandDeps = {
      isDaemonLive: () => true,
      appendPending: (issues) => { appended = issues; },
      resolveIssues: async (refs) => refs.map(Number),
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    const program = makeProgram(deps);
    await program.parseAsync(["node", "autopilot", "queue", "add", "42", "43"], { from: "user" });
    expect(appended).toEqual([42, 43]);
    expect(messages.join(" ")).toMatch(/queued 2/i);
  });

  it("emits JSON when --json is passed", async () => {
    const messages: string[] = [];
    const deps: QueueCommandDeps = {
      isDaemonLive: () => true,
      appendPending: vi.fn(),
      resolveIssues: async (refs) => refs.map(Number),
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    const program = makeProgram(deps);
    await program.parseAsync(["node", "autopilot", "queue", "add", "42", "--json"], { from: "user" });
    const parsed = JSON.parse(messages.join(""));
    expect(parsed).toEqual({ queued: [42], daemonRunning: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/queue.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/commands/queue.ts`**

```typescript
import { Command } from "commander";
import { PidFile } from "../daemon/pid-file.js";
import { PendingQueueStore } from "../daemon/pending-queue-store.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { appPaths } from "../platform/paths.js";
import { ProcessRunner } from "../platform/process-runner.js";
import { resolveIssueRefs } from "./args.js";

export interface QueueCommandDeps {
  dataDir?: string;
  cwd?: string;
  /** Test seam: replaces PidFile.isLive(). */
  isDaemonLive?: () => boolean;
  /** Test seam: replaces PendingQueueStore.append(). */
  appendPending?: (issues: number[]) => void;
  /** Test seam: replaces resolveIssueRefs + resolveRepositoryContext. */
  resolveIssues?: (refs: string[]) => Promise<number[]>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export function registerQueueCommand(program: Command, deps: QueueCommandDeps = {}): void {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
  const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });

  const queueCommand = program.command("queue").description("Manage a running daemon's issue queue");

  queueCommand
    .command("add")
    .description("Append issues to a running daemon's queue")
    .argument("<issues...>", "issue numbers (bare or owner/repo#number)")
    .option("--json", "emit machine-readable output")
    .action(async (issueArgs: string[], opts: { json?: boolean }) => {
      const paths = appPaths(deps.dataDir);
      const isDaemonLive =
        deps.isDaemonLive ??
        (() => new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir }).isLive());

      if (!isDaemonLive()) {
        stderr("no daemon running — use autopilot start first");
        setExitCode(1);
        return;
      }

      try {
        const resolveIssues =
          deps.resolveIssues ??
          (async (refs: string[]) => {
            const cwd = deps.cwd ?? process.cwd();
            const runner = new ProcessRunner();
            const ctx = await resolveRepositoryContext(cwd, runner);
            return resolveIssueRefs(refs, ctx);
          });
        const issues = await resolveIssues(issueArgs);

        const appendPending =
          deps.appendPending ??
          ((nums: number[]) => {
            const store = new PendingQueueStore({
              pendingQueuePath: paths.pendingQueuePath,
              daemonDir: paths.daemonDir,
            });
            store.append(nums);
          });
        appendPending(issues);

        if (opts.json === true) {
          stdout(JSON.stringify({ queued: issues, daemonRunning: true }));
        } else {
          stdout(`Queued ${issues.length} issue(s) (pending until next daemon loop iteration).`);
        }
        setExitCode(0);
      } catch (error) {
        stderr(`queue add: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(1);
      }
    });
}
```

- [ ] **Step 4: Register the command in `src/cli.ts`**

Add to imports (alongside the `StopCommandDeps` import block):

```typescript
import type { QueueCommandDeps } from "./commands/queue.js";
import { registerQueueCommand } from "./commands/queue.js";
```

Add `QueueCommandDeps` to the `CliDeps` intersection type:

```typescript
export type CliDeps = CheckCommandDeps &
  PrepareCommandDeps &
  AnalyzeCommandDeps &
  RunCommandDeps &
  StatusCommandDeps &
  InspectCommandDeps &
  ResumeCommandDeps &
  RunsCommandDeps &
  AbandonCommandDeps &
  StartCommandDeps &
  StopCommandDeps &
  QueueCommandDeps &
  ReconcileCommandDeps &
  ReconcileApplyCommandDeps &
  BootstrapCommandDeps;
```

Add inside `buildProgram`, after `registerStopCommand(program, deps);`:

```typescript
registerQueueCommand(program, deps);
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/queue.test.ts
npx vitest run
```
Expected: all PASS, no regressions.

- [ ] **Step 6: TypeScript check and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx tsc --noEmit
git add src/commands/queue.ts src/cli.ts tests/unit/commands/queue.test.ts
git commit -m "feat(queue-add): add queue add CLI command"
```

---

## Task 6: Daemon claim/release lifecycle

**Files:**
- Modify: `src/daemon/daemon-runner.ts`
- Modify: `src/daemon/daemon-entry.ts`
- Test: `tests/unit/daemon/daemon-runner.test.ts`

**Interfaces:**
- Consumes: `AGENT_READY_LABEL`, `AGENT_IN_PROGRESS_LABEL` from `src/analysis/label-reconciliation.js`
- Produces: `DaemonRunnerDeps` gains a required `github: Pick<GitHubPort, "addLabel" | "removeLabel">` field. Claim/release calls happen around every `runService.start` invocation in the main loop.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/daemon/daemon-runner.test.ts`. First, update `makeDeps()` to include a `github` fake (all existing tests must keep passing with this addition — add it to the base `makeDeps()` return object, not as a new optional field, since it will become required):

```typescript
// Add to the imports at the top:
import { AGENT_READY_LABEL, AGENT_IN_PROGRESS_LABEL } from "../../../src/analysis/label-reconciliation.js";

// Inside makeDeps(), add to the returned object (alongside pidFile, queueStore, etc.):
    github: {
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    } as any,
```

Then add a new `describe` block at the end of the file:

```typescript
describe("DaemonRunner claim/release labels", () => {
  it("claims (removes agent:ready, adds agent:in-progress) before starting a run", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
    expect(deps.github.addLabel).toHaveBeenCalledWith(28, AGENT_IN_PROGRESS_LABEL);
    // Claim must happen before runService.start is called
    const removeOrder = (deps.github.removeLabel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const startOrder = (deps.runService.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(removeOrder).toBeLessThan(startOrder);
  });

  it("releases agent:in-progress only, on PR_OPEN", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    // Called once for the claim's remove(agent:ready), then once more for release's remove(agent:in-progress)
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_IN_PROGRESS_LABEL);
    expect(deps.github.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("leaves agent:in-progress in place on BLOCKED", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "BLOCKED", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    // Only the claim's removeLabel(agent:ready) call — no release removeLabel(agent:in-progress)
    expect(deps.github.removeLabel).toHaveBeenCalledTimes(1);
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
  });

  it("leaves agent:in-progress in place on FAILED", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "FAILED", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.github.removeLabel).toHaveBeenCalledTimes(1);
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
  });

  it("removes both labels on NEEDS_REFINEMENT", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "NEEDS_REFINEMENT", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_READY_LABEL);
    expect(deps.github.removeLabel).toHaveBeenCalledWith(28, AGENT_IN_PROGRESS_LABEL);
    expect(deps.github.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("never blocks the run when the claim label write throws", async () => {
    const deps = makeDeps();
    (deps.github.removeLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rate limited"));
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    expect(deps.logFile.error).toHaveBeenCalled();
  });

  it("never blocks queue advancement when the release label write throws", async () => {
    const deps = makeDeps();
    (deps.github.removeLabel as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // claim succeeds
      .mockRejectedValueOnce(new Error("rate limited")); // release fails
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });

    await new DaemonRunner(deps).run();

    expect(deps.queueStore.write).toHaveBeenCalled();
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```
Expected: FAIL — `deps.github` is undefined / claim-release calls don't happen yet.

- [ ] **Step 3: Implement the claim/release logic in `src/daemon/daemon-runner.ts`**

Add the import and extend `DaemonRunnerDeps`:

```typescript
import { AGENT_READY_LABEL, AGENT_IN_PROGRESS_LABEL } from "../analysis/label-reconciliation.js";

export interface DaemonRunnerDeps {
  pidFile: Pick<PidFile, "writePid" | "delete">;
  queueStore: Pick<QueueStore, "read" | "write">;
  logFile: Pick<LogFile, "info" | "error">;
  github: {
    addLabel(number: number, name: string): Promise<void>;
    removeLabel(number: number, name: string): Promise<void>;
  };
  runService: {
    start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
    resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
  };
  recoveryService: {
    reconcile(runId: string): Promise<{ runId: string; stage: string; actions: unknown[] }>;
    resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
  };
  runStore: {
    listNonterminalRuns(): Array<{ id: string; issueNumber: number; stage: string }>;
    transition(runId: string, from: string, to: string, evidenceRef: string | null): void;
  };
  overrides: RunOverrides;
  registerSignalHandler?: (signal: string, handler: () => void) => void;
  exit?: (code: number) => void;
}
```

Add two private helper methods to the `DaemonRunner` class:

```typescript
  private async claim(issueNumber: number): Promise<void> {
    try {
      await this.deps.github.removeLabel(issueNumber, AGENT_READY_LABEL);
      await this.deps.github.addLabel(issueNumber, AGENT_IN_PROGRESS_LABEL);
    } catch (err) {
      this.deps.logFile.error(
        `claim label update failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async release(issueNumber: number, stage: string): Promise<void> {
    try {
      if (stage === "PR_OPEN") {
        await this.deps.github.removeLabel(issueNumber, AGENT_IN_PROGRESS_LABEL);
      } else if (stage === "NEEDS_REFINEMENT") {
        await this.deps.github.removeLabel(issueNumber, AGENT_IN_PROGRESS_LABEL);
        await this.deps.github.removeLabel(issueNumber, AGENT_READY_LABEL);
      }
      // BLOCKED / FAILED: no-op — agent:in-progress stays as a "needs a human" signal.
    } catch (err) {
      this.deps.logFile.error(
        `release label update failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

Modify the main queue loop to call `claim` before `runService.start` and `release` after the outcome is known:

```typescript
    // --- Main queue loop ---
    while (queue.currentIndex < queue.issues.length && !this.stopRequested) {
      const issueNumber = queue.issues[queue.currentIndex]!;
      logFile.info(`starting run issue=${issueNumber}`);

      await this.claim(issueNumber);

      let summary: RunSummary;
      try {
        summary = await runService.start(issueNumber, overrides);
      } catch (err) {
        logFile.error(
          `run failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary = {
          runId: `failed-${issueNumber}`,
          stage: "FAILED",
          repository: queue.repository,
          issueNumber,
          publication: null,
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      await this.release(issueNumber, summary.stage);

      logFile.info(`run complete issue=${issueNumber} outcome=${summary.stage}`);
      // ...rest of the loop body (completedRuns, currentIndex, queueStore.write) unchanged...
```

- [ ] **Step 4: Update `src/daemon/daemon-entry.ts` to pass `github` into `DaemonRunner`**

`github` is already constructed earlier in `main()` via `GitHubAdapter.create(...)`. Add it to the `new DaemonRunner({...})` call:

```typescript
    const runner = new DaemonRunner({
      pidFile,
      queueStore,
      logFile,
      github: {
        addLabel: (number, name) => github.addLabel(number, name),
        removeLabel: (number, name) => github.removeLabel(number, name),
      },
      runService: {
        start: (issueNumber, overrides) => runService.start(issueNumber, overrides),
        resume: (runId, overrides) => runService.resume(runId, overrides),
      },
      recoveryService: {
        reconcile: (runId) => recoveryService.reconcile(runId),
        resume: (runId, overrides) => recoveryService.resume(runId, overrides),
      },
      runStore: {
        listNonterminalRuns: () => runStore.listNonterminalRuns(),
        transition: (id, from, to, ref) => runStore.transition(id, from as any, to as any, ref),
      },
      overrides: {},
    });
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```
Expected: all PASS, including all pre-existing tests in this file (they must still pass now that `github` is present in `makeDeps()`).

- [ ] **Step 6: Full regression check and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run
npx tsc --noEmit
npm run build
git add src/daemon/daemon-runner.ts src/daemon/daemon-entry.ts tests/unit/daemon/daemon-runner.test.ts
git commit -m "feat(discover): add daemon just-in-time claim/release label lifecycle"
```

---

## Task 7: Daemon pending-queue drain

**Files:**
- Modify: `src/daemon/daemon-runner.ts`
- Modify: `src/daemon/daemon-entry.ts`
- Test: `tests/unit/daemon/daemon-runner.test.ts`

**Interfaces:**
- Consumes: `PendingQueueStore` (as `Pick<PendingQueueStore, "drainAll">`)
- Produces: `DaemonRunnerDeps` gains a required `pendingQueueStore: Pick<PendingQueueStore, "drainAll">` field.

- [ ] **Step 1: Write the failing tests**

Update `makeDeps()` in `tests/unit/daemon/daemon-runner.test.ts` to add a `pendingQueueStore` fake to the base returned object:

```typescript
    pendingQueueStore: {
      drainAll: vi.fn().mockReturnValue([]),
    } as any,
```

Add a new `describe` block:

```typescript
describe("DaemonRunner pending queue merge", () => {
  it("drains pending once before the loop starts, merging new issues onto the queue", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([99]) // pre-loop drain
      .mockReturnValue([]);      // subsequent drains
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(2);
    expect(deps.runService.start).toHaveBeenNthCalledWith(2, 99, {});
  });

  it("drains pending once per loop iteration", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });

    await new DaemonRunner(deps).run();

    // Once before the loop + once after the single iteration = 2 calls
    expect(deps.pendingQueueStore.drainAll).toHaveBeenCalledTimes(2);
  });

  it("deduplicates pending issues already present anywhere in the full queue", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([28]) // already in queue.issues — must not duplicate
      .mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runId: "run-1", stage: "PR_OPEN", issueNumber: 28,
      repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null,
    });

    await new DaemonRunner(deps).run();

    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    expect(deps.runService.start).toHaveBeenCalledWith(28, {});
  });

  it("persists the merged queue via queueStore.write when pending issues are added", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" }, issues: [28], currentIndex: 0,
      startedAt: new Date().toISOString(), completedRuns: [],
    });
    (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([99])
      .mockReturnValue([]);
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();

    const writtenQueues = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(writtenQueues.some((q) => q.issues.includes(99))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```
Expected: FAIL — `deps.pendingQueueStore` is undefined / no merge behavior yet.

- [ ] **Step 3: Implement the pending-drain logic in `src/daemon/daemon-runner.ts`**

Extend `DaemonRunnerDeps`:

```typescript
export interface DaemonRunnerDeps {
  pidFile: Pick<PidFile, "writePid" | "delete">;
  queueStore: Pick<QueueStore, "read" | "write">;
  pendingQueueStore: Pick<PendingQueueStore, "drainAll">;
  logFile: Pick<LogFile, "info" | "error">;
  // ...rest unchanged...
}
```

Add the imports. `CompletedRun` is already imported from `./queue-store.js` at the top of this file; add `DaemonQueue` to that same import line (it is not currently imported), plus the new `PendingQueueStore` import:

```typescript
import type { QueueStore, CompletedRun, DaemonQueue } from "./queue-store.js";
import type { PendingQueueStore } from "./pending-queue-store.js";
```

Add a private helper and call it before the loop and at the end of each iteration:

```typescript
  private mergePending(queue: DaemonQueue): void {
    const pending = this.deps.pendingQueueStore.drainAll();
    if (pending.length === 0) return;
    const existing = new Set(queue.issues);
    const toAdd = pending.filter((n) => !existing.has(n));
    if (toAdd.length === 0) return;
    queue.issues.push(...toAdd);
    this.deps.queueStore.write(queue);
    this.deps.logFile.info(`merged ${toAdd.length} pending issue(s): [${toAdd.join(",")}]`);
  }
```

Call it right after crash reconciliation, before the `while` loop, and again at the end of the loop body after the existing `queueStore.write(queue)` call:

```typescript
    if (nonterminal.length === 0) {
      logFile.info("reconciliation: no interrupted runs found");
    }

    this.mergePending(queue);

    // --- Main queue loop ---
    while (queue.currentIndex < queue.issues.length && !this.stopRequested) {
      // ...existing claim/start/release/completedRuns/currentIndex body...
      queue.completedRuns.push(completed);
      queue.currentIndex += 1;
      queueStore.write(queue);
      this.mergePending(queue);
    }
```

- [ ] **Step 4: Update `src/daemon/daemon-entry.ts` to construct and pass `pendingQueueStore`**

Add the import and construct it alongside `queueStore`:

```typescript
import { PendingQueueStore } from "./pending-queue-store.js";

// ...alongside the existing `const queueStore = new QueueStore(...)`:
    const pendingQueueStore = new PendingQueueStore({
      pendingQueuePath: paths.pendingQueuePath,
      daemonDir: paths.daemonDir,
    });
```

Add it to the `new DaemonRunner({...})` call:

```typescript
    const runner = new DaemonRunner({
      pidFile,
      queueStore,
      pendingQueueStore,
      logFile,
      github: {
        addLabel: (number, name) => github.addLabel(number, name),
        removeLabel: (number, name) => github.removeLabel(number, name),
      },
      // ...rest unchanged...
    });
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```
Expected: all PASS, including every pre-existing test in the file.

- [ ] **Step 6: Full regression check and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run
npx tsc --noEmit
npm run build
git add src/daemon/daemon-runner.ts src/daemon/daemon-entry.ts tests/unit/daemon/daemon-runner.test.ts
git commit -m "feat(queue-add): drain pending queue before and during the daemon loop"
```

---

## Task 8: `discover` command

**Files:**
- Create: `src/commands/discover.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/commands/discover.test.ts`

**Interfaces:**
- Consumes: `BacklogAnalyst`/`AnalyzeCommandDeps`-style test seams (mirrors `analyze.ts`'s structure); `reconcileReadyLabel`, `AGENT_READY_LABEL`, `AGENT_IN_PROGRESS_LABEL` from `src/analysis/label-reconciliation.js`; `GitHubPort` from `src/github/github-adapter.js`
- Produces: `registerDiscoverCommand(program: Command, deps: DiscoverCommandDeps): void`; `DiscoverCommandDeps` exported for `cli.ts`'s `CliDeps` union

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/commands/discover.test.ts
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerDiscoverCommand } from "../../../src/commands/discover.js";
import type { DiscoverCommandDeps } from "../../../src/commands/discover.js";
import type { BacklogReport } from "../../../src/domain/backlog.js";

function makeProgram(deps: DiscoverCommandDeps) {
  const program = new Command();
  program.exitOverride();
  registerDiscoverCommand(program, deps);
  return program;
}

function baseReport(overrides: Partial<BacklogReport> = {}): BacklogReport {
  return {
    repository: { owner: "acme", repo: "widgets" },
    epicRef: null,
    requestedRefs: [42],
    generatedAt: "2026-08-23T00:00:00Z",
    analysisId: "discover-1",
    scope: { totalIssues: 1, analyzed: 1, unresolved: 0 },
    issues: [
      {
        issueNumber: 42,
        title: "Fix widget",
        url: "https://github.com/acme/widgets/issues/42",
        classification: "READY",
        screen: { classification: "READY", reasons: [] },
        readiness: null,
      },
    ],
    executable: [42],
    needsWork: [],
    summary: { ready: 1, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
    refinerSessions: 0,
    ...overrides,
  };
}

describe("discover command", () => {
  it("labels a READY issue with no existing labels", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const messages: string[] = [];
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => [],
      addLabel,
      removeLabel,
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["node", "autopilot", "discover", "42"], { from: "user" });
    expect(addLabel).toHaveBeenCalledWith(42, "agent:ready");
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it("unlabels a non-READY issue that currently has agent:ready", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport({
        issues: [{
          issueNumber: 42, title: "Fix widget", url: "https://github.com/acme/widgets/issues/42",
          classification: "NEEDS_REFINEMENT", screen: { classification: "NEEDS_REFINEMENT", reasons: [] }, readiness: null,
        }],
        executable: [], needsWork: [42],
        summary: { ready: 0, needsRefinement: 1, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
      }),
      listLabels: async () => ["agent:ready"],
      addLabel,
      removeLabel,
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["node", "autopilot", "discover", "42"], { from: "user" });
    expect(removeLabel).toHaveBeenCalledWith(42, "agent:ready");
    expect(addLabel).not.toHaveBeenCalled();
  });

  it("never touches labels on an issue with agent:in-progress", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => ["agent:in-progress"],
      addLabel,
      removeLabel,
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["node", "autopilot", "discover", "42"], { from: "user" });
    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it("includes labelAction in --json output", async () => {
    const messages: string[] = [];
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => [],
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["node", "autopilot", "discover", "42", "--json"], { from: "user" });
    const parsed = JSON.parse(messages.join(""));
    expect(parsed.issues[0].labelAction).toBe("labeled");
  });

  it("continues processing remaining issues when one issue's label write fails", async () => {
    const addLabel = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValue(undefined);
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport({
        requestedRefs: [42, 43],
        issues: [
          { issueNumber: 42, title: "A", url: "u1", classification: "READY", screen: { classification: "READY", reasons: [] }, readiness: null },
          { issueNumber: 43, title: "B", url: "u2", classification: "READY", screen: { classification: "READY", reasons: [] }, readiness: null },
        ],
        executable: [42, 43],
      }),
      listLabels: async () => [],
      addLabel,
      removeLabel: vi.fn(),
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["node", "autopilot", "discover", "42", "43"], { from: "user" });
    expect(addLabel).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/discover.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/commands/discover.ts`**

This largely mirrors `src/commands/analyze.ts` but adds the label-reconciliation step and a simplified dependency surface (via `analyze`/`listLabels`/`addLabel`/`removeLabel` seams) so the command can be tested without standing up the full `BacklogAnalyst`/`ReadinessService`/`GitHubAdapter` chain — those are exercised already by `analyze`'s own tests, and `discover` does not change their behavior.

```typescript
import { Command } from "commander";
import { BacklogAnalyst as BacklogAnalystImpl } from "../analysis/backlog-analyst.js";
import { isEpicBody } from "../analysis/issue-set.js";
import {
  reconcileReadyLabel,
  AGENT_READY_LABEL,
  AGENT_IN_PROGRESS_LABEL,
  type LabelAction,
} from "../analysis/label-reconciliation.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry } from "../config/schema.js";
import type { BacklogReport } from "../domain/backlog.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { ReadinessService as ReadinessServiceImpl } from "../readiness/readiness-service.js";
import type { ReadinessService } from "../readiness/readiness-service.js";
import { resolveIssueRefs, resolveRefinerModel, resolveRefinerTimeout } from "./args.js";

/** A `BacklogReport` issue entry with the added `labelAction` field. */
export type DiscoverReport = BacklogReport;

export interface DiscoverCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  /** Test seam: run the full readiness analysis, bypassing the real
   * BacklogAnalyst/ReadinessService/GitHubAdapter chain (already covered by
   * analyze's own tests — discover does not change that behavior). */
  analyze?: (
    ref: string,
    moreRefs: string[],
    opts: { deep?: boolean; model?: string; thinking?: string; refinerTimeout?: number },
  ) => Promise<BacklogReport>;
  listLabels?: (issueNumber: number) => Promise<string[]>;
  addLabel?: (issueNumber: number, name: string) => Promise<void>;
  removeLabel?: (issueNumber: number, name: string) => Promise<void>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface DiscoverOptions {
  json?: boolean;
  deep?: boolean;
  model?: string;
  thinking?: string;
  refinerTimeout?: number;
  minReady?: string;
}

export function registerDiscoverCommand(program: Command, deps: DiscoverCommandDeps = {}): void {
  program
    .command("discover")
    .description(
      "Analyze an epic (or explicit issue set) and reconcile the agent:ready label to match readiness",
    )
    .argument("<ref>", "issue/epic number, or owner/repo#number matching the local origin")
    .argument("[moreRefs...]", "additional issue references in an explicit set")
    .option("--json", "emit the backlog report as machine-readable JSON")
    .option("--deep", "run a full refiner session and readiness gate on every issue")
    .option("--model <model>", "override the refiner model")
    .option("--thinking <level>", "override the refiner thinking level")
    .option("--refiner-timeout <minutes>", "override the refiner session timeout in minutes")
    .action(async (ref: string, moreRefs: string[], opts: DiscoverOptions) => {
      const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
      const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
      const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });

      try {
        const { report, github } = await runDiscoverAnalysis(ref, moreRefs, opts, deps);

        const listLabels = deps.listLabels ?? ((n: number) => github!.listLabels(n));
        const addLabel = deps.addLabel ?? ((n: number, name: string) => github!.addLabel(n, name));
        const removeLabel = deps.removeLabel ?? ((n: number, name: string) => github!.removeLabel(n, name));

        const issuesWithAction: Array<BacklogReport["issues"][number] & { labelAction: LabelAction }> = [];
        for (const issue of report.issues) {
          let labels: string[];
          try {
            labels = await listLabels(issue.issueNumber);
          } catch (error) {
            stderr(`discover: failed to read labels for #${issue.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
            issuesWithAction.push({ ...issue, labelAction: "unchanged" });
            continue;
          }
          const action = reconcileReadyLabel({
            isReady: issue.classification === "READY",
            hasReadyLabel: labels.includes(AGENT_READY_LABEL),
            hasInProgressLabel: labels.includes(AGENT_IN_PROGRESS_LABEL),
          });
          try {
            if (action === "labeled") await addLabel(issue.issueNumber, AGENT_READY_LABEL);
            if (action === "unlabeled") await removeLabel(issue.issueNumber, AGENT_READY_LABEL);
          } catch (error) {
            stderr(`discover: failed to update label for #${issue.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
          }
          issuesWithAction.push({ ...issue, labelAction: action });
        }

        const finalReport: BacklogReport = { ...report, issues: issuesWithAction };

        if (opts.json === true) {
          stdout(JSON.stringify(finalReport, null, 2));
        } else {
          printHumanReport(finalReport, stdout);
        }
        setExitCode(0);
      } catch (error) {
        stderr(`autopilot discover: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(1);
      }
    });
}

async function runDiscoverAnalysis(
  ref: string,
  moreRefs: string[],
  opts: DiscoverOptions,
  deps: DiscoverCommandDeps,
): Promise<{ report: BacklogReport; github: GitHubPort | null }> {
  if (deps.analyze !== undefined) {
    const report = await deps.analyze(ref, moreRefs, opts);
    return { report, github: null };
  }

  // Production path: build the same chain analyze.ts builds.
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx: RepositoryContext = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const config: AutopilotConfig = await loadRepositoryConfig(ctx.root);
  const github: GitHubPort = await GitHubAdapter.create(ctx.root, runner);
  const paths: AppPaths = appPaths(deps.dataDir);

  const refinerModel: ResolvedRoleModel = resolveRefinerModel(
    {
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.thinking === undefined ? {} : { thinking: opts.thinking }),
    },
    config,
    deps.piDefaultModel,
  );
  const refinerTimeoutMs = resolveRefinerTimeout(opts.refinerTimeout, config);

  const readiness: Pick<ReadinessService, "check"> = new ReadinessServiceImpl({
    repository: ctx,
    config,
    github,
    pi: new PiRunner(runner, deps.piCommand),
    artifacts: new ArtifactStore(paths),
    paths,
    refinerModel,
    refinerTimeoutMs,
  });

  const analysisId = `discover-${Date.now()}`;
  const analyst = new BacklogAnalystImpl({
    repository: ctx,
    config,
    github,
    readiness,
    artifacts: new ArtifactStore(paths),
    paths,
    refinerModel,
    refinerTimeoutMs,
    analysisId,
    now: () => new Date().toISOString(),
  });

  const numbers = resolveIssueRefs([ref, ...moreRefs], ctx);
  let epicRef: number | null = null;
  let requestedRefs: number[] = numbers;
  if (moreRefs.length === 0 && numbers.length === 1) {
    const single = numbers[0]!;
    const issue = await github.getIssue(single);
    if (isEpicBody(issue.body)) {
      epicRef = single;
      requestedRefs = [];
    }
  }

  const report = await analyst.analyzeIssues({ epicRef, requestedRefs, deep: opts.deep === true });
  return { report, github };
}

function printHumanReport(report: BacklogReport, stdout: (text: string) => void): void {
  stdout(`Repository: ${report.repository.owner}/${report.repository.repo}`);
  for (const issue of report.issues) {
    const action = (issue as { labelAction?: LabelAction }).labelAction ?? "unchanged";
    stdout(
      `[${issue.classification}] #${issue.issueNumber} ${issue.title} (${issue.url}) — label: ${action}`,
    );
  }
  stdout(`Executable: ${report.executable.length > 0 ? report.executable.join(", ") : "(none)"}`);
  stdout(`Needs work: ${report.needsWork.length > 0 ? report.needsWork.join(", ") : "(none)"}`);
  stdout(
    `Summary: ${report.summary.ready} ready, ${report.summary.needsRefinement} needsRefinement, ` +
      `${report.summary.blocked} blocked, ${report.summary.ambiguous} ambiguous, ` +
      `${report.summary.skipped} skipped, ${report.summary.unresolved} unresolved`,
  );
  stdout(`Analysis ID: ${report.analysisId}`);
}
```

- [ ] **Step 4: Register the command in `src/cli.ts`**

Add to imports:

```typescript
import type { DiscoverCommandDeps } from "./commands/discover.js";
import { registerDiscoverCommand } from "./commands/discover.js";
```

Add `DiscoverCommandDeps` to the `CliDeps` intersection type (alongside `AnalyzeCommandDeps`):

```typescript
export type CliDeps = CheckCommandDeps &
  PrepareCommandDeps &
  AnalyzeCommandDeps &
  DiscoverCommandDeps &
  RunCommandDeps &
  StatusCommandDeps &
  InspectCommandDeps &
  ResumeCommandDeps &
  RunsCommandDeps &
  AbandonCommandDeps &
  StartCommandDeps &
  StopCommandDeps &
  QueueCommandDeps &
  ReconcileCommandDeps &
  ReconcileApplyCommandDeps &
  BootstrapCommandDeps;
```

Add inside `buildProgram`, after `registerAnalyzeCommand(program, deps);`:

```typescript
registerDiscoverCommand(program, deps);
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/discover.test.ts
npx vitest run
```
Expected: all PASS, no regressions.

- [ ] **Step 6: TypeScript check, build, and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx tsc --noEmit
npm run build
git add src/commands/discover.ts src/cli.ts tests/unit/commands/discover.test.ts
git commit -m "feat(discover): add discover CLI command"
```

---

## Task 9: Integration test — `queue add` picked up mid-run by the daemon

**Files:**
- Modify: `tests/integration/daemon/daemon-lifecycle.test.ts`

**Interfaces:**
- Consumes: whatever fakes/harness the existing lifecycle test already builds (read the file first — do not guess its shape)

- [ ] **Step 1: Read the existing integration test to learn its harness**

```bash
cd /Users/andrea.dodero/pi_autopilot
cat tests/integration/daemon/daemon-lifecycle.test.ts
cat tests/integration/daemon/fake-daemon-entry.mjs
```

- [ ] **Step 2: Write a failing test extending that harness**

Add a new test case to the existing `describe` block (match the file's existing setup/teardown and fake-daemon-entry wiring exactly — this step requires reading Step 1's output first since the harness spawns a real child process against a fake entry script). The new test's shape:

```typescript
it("picks up an issue added via queue add while the daemon is mid-run on an earlier issue", async () => {
  // 1. Write a queue.json with issues [28, 29] (mirror this file's existing
  //    queue-seeding helper).
  // 2. Spawn the fake daemon entry (mirror this file's existing spawn helper).
  // 3. While the daemon is working on issue 28 (use whatever synchronization
  //    the existing fake-daemon-entry script offers — check for a delay hook
  //    or a per-issue signal file already used by other tests in this file),
  //    write to queue-pending.json using a PendingQueueStore pointed at the
  //    same dataDir the daemon is using, appending issue 99.
  // 4. Wait for the daemon to finish (reuse this file's existing
  //    wait-for-daemon-exit helper).
  // 5. Assert the final queue.json's completedRuns includes issue 99,
  //    and that 99 was NOT part of the original queue.json write in step 1.
});
```

Do not write this test's exact body until Step 1's file contents are known — the fake daemon entry script's synchronization mechanism (delay/signal file/env var) determines exactly how to inject the `queue add` at the right moment. Follow the file's existing conventions precisely rather than introducing a new synchronization mechanism.

- [ ] **Step 3: Run to verify it fails for the right reason**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run build
npx vitest run tests/integration/daemon/daemon-lifecycle.test.ts
```
Expected: FAIL — issue 99 never gets executed (pending-drain wiring from Tasks 6–7 must already be present in `daemon-entry.ts`/`daemon-runner.ts`; if this test fails only because 99 isn't picked up, that confirms the test is exercising the right thing. If it fails for a harness/setup reason instead, fix the test's setup, not the production code).

- [ ] **Step 4: If the test still fails after confirming Tasks 6–7 are correctly wired, debug and fix**

This step should not require production code changes if Tasks 1–8 were completed correctly — its purpose is end-to-end confirmation, not new functionality. If a real gap is found, stop and report it rather than silently patching around it, since it means an earlier task's spec was not fully satisfied.

- [ ] **Step 5: Run the full e2e/integration suite and commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run
npm run build
npx vitest run --config vitest.e2e.config.ts
git add tests/integration/daemon/daemon-lifecycle.test.ts
git commit -m "test(queue-add): cover mid-run pickup via the daemon lifecycle integration test"
```

---

## Task 10: Update `docs/MILESTONES.md`

**Files:**
- Modify: `docs/MILESTONES.md`

- [ ] **Step 1: Add a completed milestone entry**

Insert a new `## 2026-08-23 — Continuous backlog intake ✅` section (following the exact style of the adjacent `## 2026-08-23 — Greenfield bootstrap ✅` entry — same header level, a **Scope:** paragraph, a bullet list of what shipped, then Design spec / Implementation plan links), placed immediately after the "Greenfield bootstrap" entry and before the "Backlog — missing features" section.

Content to include in the bullet list:
- `autopilot discover <ref> [moreRefs...]` — mutating sibling of `analyze`; reconciles the `agent:ready` label to match computed readiness; never touches `agent:in-progress`.
- `autopilot queue add <issue...>` — appends issues to a running daemon's queue via a new atomically-written `queue-pending.json`.
- Daemon just-in-time claim (`agent:in-progress`) before each run and outcome-dependent release (cleared on success, left in place on BLOCKED/FAILED as a "needs a human" signal, both labels cleared on NEEDS_REFINEMENT).
- All label writes on the daemon and `discover` paths are best-effort — never block a run or change an exit code.

Design spec: `docs/superpowers/specs/2026-08-23-continuous-backlog-intake-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-23-continuous-backlog-intake.md`

- [ ] **Step 2: Remove the now-shipped items from the "Continuous backlog intake (M4)" backlog section**

That section (under "Backlog — missing features") currently lists three bullet points: the `agent:ready` GitHub marker, the `discover` command, and `queue add`/pending-queue append. Delete the entire `### Continuous backlog intake (M4) 🔲` section and its three bullets — all three are now shipped, and their content has moved into the new completed-milestone entry from Step 1.

- [ ] **Step 3: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add docs/MILESTONES.md
git commit -m "docs: mark continuous backlog intake milestone complete"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task |
|---|---|
| §4 Command interface (`discover`, `queue add`) | Task 8, Task 5 |
| §6 `GitHubPort` additions | Task 1 |
| §7 `discover` label-reconciliation logic + output shape | Task 2, Task 3, Task 8 |
| §8 Daemon claim/release lifecycle | Task 6 |
| §9 Pending queue (`PendingQueueStore`, drain timing) | Task 4, Task 7 |
| §10 Data flow summary | Tasks 5, 6, 7, 8 collectively |
| §11 Error handling (best-effort writes, daemon-not-running hard error) | Task 1 (404 handling), Task 5 (hard error), Task 6 (best-effort tests), Task 8 (per-issue continue-on-failure) |
| §12 Testing | Every task includes its own tests; Task 9 covers the cross-cutting integration scenario |
| §14 Acceptance criteria 1–3 (discover behavior) | Task 8 |
| §14 Acceptance criteria 4–5 (queue add behavior) | Task 5, Task 9 |
| §14 Acceptance criteria 6–7 (claim/release) | Task 6 |
| §14 Acceptance criterion 8 (failures never change outcomes) | Task 6, Task 8 |

**Placeholder scan:** No TBDs. Task 9 intentionally defers its exact test body until the existing integration test file is read (its harness is unknown ahead of time), but this is explicit investigation guidance, not a vague instruction — the assertions and setup steps are fully specified, only the concrete fake-daemon synchronization call is deferred to reading real code first.

**Type consistency check:** `LabelAction` (Task 2) is used identically in `BacklogReportSchema` (Task 3, via a hand-synced zod enum with a comment cross-reference), `DaemonRunnerDeps` (Tasks 6–7), and `discover.ts` (Task 8). `AGENT_READY_LABEL`/`AGENT_IN_PROGRESS_LABEL` string constants are defined once in Task 2 and imported everywhere else that needs them (Tasks 6, 8) rather than re-declared. `PendingQueueStore.append`/`drainAll` signatures (Task 4) match their usage in `queue.ts` (Task 5) and `daemon-runner.ts`/`daemon-entry.ts` (Task 7). `GitHubPort.listLabels`/`addLabel`/`removeLabel` (Task 1) match their consumption in `daemon-runner.ts`'s narrowed `Pick` (Task 6) and `discover.ts`'s direct calls (Task 8).
