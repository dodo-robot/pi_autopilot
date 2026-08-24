# M4 Dependency-Aware Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's strict FIFO loop with a backward-compatible dependency-aware scheduler that can run safe independent issues concurrently.

**Architecture:** Add durable scheduler state to `queue.json`, normalize dependency/workspace metadata at `start`, then have `DaemonRunner` schedule through a small executor seam. Keep default behavior sequential (`maxConcurrentRuns: 1`), preserve existing queue fields for compatibility, and implement conflict/dependency/budget decisions as pure units before wiring them into daemon concurrency.

**Tech Stack:** TypeScript/ESM, Node.js 22.5+, `commander`, `zod`, SQLite-backed `RunStore`, existing JSON queue files, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-m4-dependency-aware-scheduler-design.md`

## Global Constraints

- No new runtime dependencies.
- `scheduler.maxConcurrentRuns` defaults to `1` and must be a positive integer.
- `scheduler.idleTimeoutMinutes` defaults to `0` and must be a non-negative integer.
- Scheduler budget caps are optional; `null` or absence means no cap.
- Queue-level budgets are checked only before starting new work; active runs are never cancelled by a budget.
- Dependency satisfaction is hybrid: GitHub closed state or local `PR_OPEN` history.
- Scheduling uses explicit `start` inputs or `report.executable`; no repo-wide discovery loop.
- Workspace conflicts are path/glob based only; unknown/missing scope conflicts with everything.
- M4 runs in-process through an executor seam; no worker child processes.
- Label claim/release failures remain best-effort and must not change scheduling outcomes.
- After changing function signatures, component/module exports, or queue/status types, grep all callers and update them before marking a task done.
- Use `npx vitest run`, `npm run typecheck`, and targeted tests as listed in each task; run `npm run check` before the final completion claim.

---

## File Map

**New files:**

| File | Responsibility |
|---|---|
| `src/scheduler/policy.ts` | Scheduler policy schema helpers and CLI override parsing helpers. |
| `src/scheduler/state.ts` | Scheduler state TypeScript interfaces, state constants, constructors, and queue compatibility helpers. |
| `src/scheduler/workspace-scope.ts` | Parse workspace-scope hints from issue bodies/report rows and conservatively detect path/glob conflicts. |
| `src/scheduler/dependencies.ts` | Extract dependency issue numbers, compute dependency snapshots, and detect cycles/invalid metadata. |
| `src/scheduler/scheduler.ts` | Pure scheduling transitions: candidate selection, budget checks, completion handling, pending issue merge. |
| `tests/unit/scheduler/policy.test.ts` | Policy defaults, config validation, CLI override parsing. |
| `tests/unit/scheduler/workspace-scope.test.ts` | Scope parser and conflict truth table. |
| `tests/unit/scheduler/dependencies.test.ts` | Dependency extraction, hybrid satisfaction, invalid refs, cycle scoping. |
| `tests/unit/scheduler/scheduler.test.ts` | Pure scheduler behavior: starts, completion, conflicts, budgets, idle decisions. |

**Modified files:**

| File | Change |
|---|---|
| `src/config/schema.ts` | Add optional `scheduler` config section. |
| `src/daemon/queue-store.ts` | Add `scheduler?: SchedulerState` to `DaemonQueue`; preserve old fields. |
| `src/commands/start.ts` | Add scheduler CLI flags, load config, normalize scheduler state before writing queue. |
| `src/daemon/daemon-entry.ts` | Pass scheduler dependencies into `DaemonRunner`: GitHub state fetcher, run-history checker, scheduler executor hooks. |
| `src/daemon/daemon-runner.ts` | Replace strict sequential loop with scheduler loop when `queue.scheduler` exists; keep compatibility for absent scheduler state. |
| `src/commands/status.ts` | Render scheduler summary/table and include scheduler state in daemon JSON output. |
| `src/ui/reporter.ts` | Add scheduler-aware daemon status formatting helper or extend existing `formatDaemonStatus`. |
| `src/domain/backlog.ts` | Add optional workspace-scope field to report issue rows only if Task 3 needs report caching; keep analyze reports backward-compatible. |
| `tests/unit/config/schema.test.ts` | Scheduler config schema tests. |
| `tests/unit/commands/start.test.ts` | Scheduler flags and initialized queue state tests. |
| `tests/unit/daemon/daemon-runner.test.ts` | Concurrent scheduling, dependency blocking, conflict blocking, budget, idle, and compatibility tests. |
| `tests/unit/commands/status-daemon.test.ts` | Scheduler human/JSON status tests. |
| `tests/integration/daemon/daemon-lifecycle.test.ts` | Regression: default remains sequential; optional smoke for pending queue under scheduler. |
| `docs/MILESTONES.md` | Mark M4 dependency-aware scheduler delivered after implementation is complete. |

---

### Task 1: Scheduler policy config and CLI parsing

**Files:**
- Create: `src/scheduler/policy.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/commands/start.ts`
- Test: `tests/unit/config/schema.test.ts`
- Test: `tests/unit/scheduler/policy.test.ts`
- Test: `tests/unit/commands/start.test.ts`

**Interfaces:**
- Consumes: existing `AutopilotConfigSchema` in `src/config/schema.ts`; existing `registerStartCommand()` option parsing in `src/commands/start.ts`.
- Produces:
  - `SchedulerPolicy` type.
  - `SchedulerPolicySchema` zod schema.
  - `DEFAULT_SCHEDULER_POLICY: SchedulerPolicy`.
  - `resolveSchedulerPolicy(config: AutopilotConfig, overrides: SchedulerCliOverrides): SchedulerPolicy`.
  - `parseOptionalPositiveInt(raw: string | undefined, flagName: string): number | null`.
  - `parseOptionalNonNegativeInt(raw: string | undefined, flagName: string): number | null`.

- [ ] **Step 1: Write failing config schema tests**

Add to `tests/unit/config/schema.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { AutopilotConfigSchema } from "../../../src/config/schema.js";

describe("scheduler config", () => {
  const baseConfig = {
    version: 1,
    commands: { verify: ["npm test"] },
  };

  it("defaults to sequential scheduling", () => {
    const parsed = AutopilotConfigSchema.parse(baseConfig);
    expect(parsed.scheduler).toEqual({
      maxConcurrentRuns: 1,
      idleTimeoutMinutes: 0,
      budgets: {
        maxElapsedMinutes: null,
        maxStartedRuns: null,
        maxFailedRuns: null,
      },
    });
  });

  it("accepts explicit scheduler policy", () => {
    const parsed = AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: {
        maxConcurrentRuns: 3,
        idleTimeoutMinutes: 5,
        budgets: {
          maxElapsedMinutes: 120,
          maxStartedRuns: 10,
          maxFailedRuns: 2,
        },
      },
    });
    expect(parsed.scheduler.maxConcurrentRuns).toBe(3);
    expect(parsed.scheduler.idleTimeoutMinutes).toBe(5);
    expect(parsed.scheduler.budgets.maxElapsedMinutes).toBe(120);
    expect(parsed.scheduler.budgets.maxStartedRuns).toBe(10);
    expect(parsed.scheduler.budgets.maxFailedRuns).toBe(2);
  });

  it("rejects invalid scheduler numbers", () => {
    expect(() => AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: { maxConcurrentRuns: 0 },
    })).toThrow();
    expect(() => AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: { idleTimeoutMinutes: -1 },
    })).toThrow();
    expect(() => AutopilotConfigSchema.parse({
      ...baseConfig,
      scheduler: { budgets: { maxFailedRuns: -1 } },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run config test and verify it fails**

Run:

```bash
npx vitest run tests/unit/config/schema.test.ts
```

Expected: FAIL because `parsed.scheduler` does not exist yet.

- [ ] **Step 3: Add scheduler schema to `src/config/schema.ts`**

Add near the existing config sub-schemas:

```typescript
const OptionalNonNegativeIntSchema = z.number().int().nonnegative().nullable().default(null);

export const SchedulerConfigSchema = z
  .object({
    maxConcurrentRuns: z.number().int().positive().default(1),
    idleTimeoutMinutes: z.number().int().nonnegative().default(0),
    budgets: z
      .object({
        maxElapsedMinutes: OptionalNonNegativeIntSchema,
        maxStartedRuns: OptionalNonNegativeIntSchema,
        maxFailedRuns: OptionalNonNegativeIntSchema,
      })
      .prefault({}),
  })
  .prefault({});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
```

Then add to `AutopilotConfigSchema`:

```typescript
scheduler: SchedulerConfigSchema,
```

- [ ] **Step 4: Run config test and verify it passes**

Run:

```bash
npx vitest run tests/unit/config/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing policy helper tests**

Create `tests/unit/scheduler/policy.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULER_POLICY,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  resolveSchedulerPolicy,
} from "../../../src/scheduler/policy.js";
import type { AutopilotConfig } from "../../../src/config/schema.js";

function configWithScheduler(scheduler: AutopilotConfig["scheduler"]): AutopilotConfig {
  return {
    version: 1,
    workspace: { baseBranch: "main", branchPrefix: "autopilot/", requireCleanCheckout: true, retainBlockedWorktree: true },
    commands: { setup: [], verify: ["npm test"] },
    agents: {},
    agentPolicy: { allowedCommands: ["npm"], protectedPaths: [], allowNetwork: false },
    budgets: {
      refiner: { timeoutMinutes: 5 },
      reconciler: { timeoutMinutes: 10 },
      implementation: { timeoutMinutes: 60, maxAttempts: 3 },
      review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
    },
    publication: { draftPr: false, issueComment: "concise", autoMerge: false },
    reconciliation: { reportStaleAfterHours: 168 },
    bootstrap: { tokenThreshold: 80_000 },
    scheduler,
  };
}

describe("scheduler policy helpers", () => {
  it("exports sequential defaults", () => {
    expect(DEFAULT_SCHEDULER_POLICY).toEqual({
      maxConcurrentRuns: 1,
      idleTimeoutMinutes: 0,
      budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
    });
  });

  it("uses config values when no CLI override is present", () => {
    const policy = resolveSchedulerPolicy(configWithScheduler({
      maxConcurrentRuns: 2,
      idleTimeoutMinutes: 7,
      budgets: { maxElapsedMinutes: 90, maxStartedRuns: 8, maxFailedRuns: 1 },
    }), {});
    expect(policy.maxConcurrentRuns).toBe(2);
    expect(policy.idleTimeoutMinutes).toBe(7);
    expect(policy.budgets).toEqual({ maxElapsedMinutes: 90, maxStartedRuns: 8, maxFailedRuns: 1 });
  });

  it("lets CLI override config for one daemon start", () => {
    const policy = resolveSchedulerPolicy(configWithScheduler({
      maxConcurrentRuns: 2,
      idleTimeoutMinutes: 7,
      budgets: { maxElapsedMinutes: 90, maxStartedRuns: 8, maxFailedRuns: 1 },
    }), {
      maxConcurrentRuns: 4,
      idleTimeoutMinutes: 0,
      maxElapsedMinutes: 30,
      maxStartedRuns: 3,
      maxFailedRuns: 0,
    });
    expect(policy).toEqual({
      maxConcurrentRuns: 4,
      idleTimeoutMinutes: 0,
      budgets: { maxElapsedMinutes: 30, maxStartedRuns: 3, maxFailedRuns: 0 },
    });
  });

  it("parses positive and non-negative CLI integers", () => {
    expect(parseOptionalPositiveInt("2", "--max-concurrent")).toBe(2);
    expect(parseOptionalPositiveInt(undefined, "--max-concurrent")).toBeNull();
    expect(parseOptionalNonNegativeInt("0", "--idle-timeout")).toBe(0);
    expect(parseOptionalNonNegativeInt(undefined, "--idle-timeout")).toBeNull();
  });

  it("rejects invalid CLI integers with flag names", () => {
    expect(() => parseOptionalPositiveInt("0", "--max-concurrent")).toThrow(/--max-concurrent/);
    expect(() => parseOptionalPositiveInt("1.5", "--max-concurrent")).toThrow(/--max-concurrent/);
    expect(() => parseOptionalNonNegativeInt("-1", "--idle-timeout")).toThrow(/--idle-timeout/);
    expect(() => parseOptionalNonNegativeInt("abc", "--idle-timeout")).toThrow(/--idle-timeout/);
  });
});
```

- [ ] **Step 6: Run policy test and verify it fails**

Run:

```bash
npx vitest run tests/unit/scheduler/policy.test.ts
```

Expected: FAIL because `src/scheduler/policy.ts` does not exist.

- [ ] **Step 7: Implement `src/scheduler/policy.ts`**

Create:

```typescript
import type { AutopilotConfig } from "../config/schema.js";

export interface SchedulerPolicy {
  maxConcurrentRuns: number;
  idleTimeoutMinutes: number;
  budgets: {
    maxElapsedMinutes: number | null;
    maxStartedRuns: number | null;
    maxFailedRuns: number | null;
  };
}

export interface SchedulerCliOverrides {
  maxConcurrentRuns?: number;
  idleTimeoutMinutes?: number;
  maxElapsedMinutes?: number;
  maxStartedRuns?: number;
  maxFailedRuns?: number;
}

export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicy = {
  maxConcurrentRuns: 1,
  idleTimeoutMinutes: 0,
  budgets: {
    maxElapsedMinutes: null,
    maxStartedRuns: null,
    maxFailedRuns: null,
  },
};

export function parseOptionalPositiveInt(raw: string | undefined, flagName: string): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${flagName} '${raw}' (expected a positive integer)`);
  }
  return parsed;
}

export function parseOptionalNonNegativeInt(raw: string | undefined, flagName: string): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${flagName} '${raw}' (expected a non-negative integer)`);
  }
  return parsed;
}

export function resolveSchedulerPolicy(
  config: AutopilotConfig,
  overrides: SchedulerCliOverrides,
): SchedulerPolicy {
  return {
    maxConcurrentRuns: overrides.maxConcurrentRuns ?? config.scheduler.maxConcurrentRuns,
    idleTimeoutMinutes: overrides.idleTimeoutMinutes ?? config.scheduler.idleTimeoutMinutes,
    budgets: {
      maxElapsedMinutes: overrides.maxElapsedMinutes ?? config.scheduler.budgets.maxElapsedMinutes,
      maxStartedRuns: overrides.maxStartedRuns ?? config.scheduler.budgets.maxStartedRuns,
      maxFailedRuns: overrides.maxFailedRuns ?? config.scheduler.budgets.maxFailedRuns,
    },
  };
}
```

- [ ] **Step 8: Wire CLI flags into `start` without using them yet**

In `src/commands/start.ts`, import the parsing helpers and register options:

```typescript
import {
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  type SchedulerCliOverrides,
} from "../scheduler/policy.js";
```

Add options to the command chain:

```typescript
.option("--max-concurrent <n>", "override scheduler.maxConcurrentRuns for this daemon")
.option("--max-elapsed <minutes>", "override scheduler.budgets.maxElapsedMinutes")
.option("--max-started-runs <n>", "override scheduler.budgets.maxStartedRuns")
.option("--max-failed-runs <n>", "override scheduler.budgets.maxFailedRuns")
.option("--idle-timeout <minutes>", "override scheduler.idleTimeoutMinutes")
```

Add helper near `resolveStartOverrides`:

```typescript
function resolveSchedulerCliOverrides(opts: Record<string, string | boolean | undefined>): SchedulerCliOverrides {
  const maxConcurrentRuns = parseOptionalPositiveInt(
    typeof opts.maxConcurrent === "string" ? opts.maxConcurrent : undefined,
    "--max-concurrent",
  );
  const idleTimeoutMinutes = parseOptionalNonNegativeInt(
    typeof opts.idleTimeout === "string" ? opts.idleTimeout : undefined,
    "--idle-timeout",
  );
  const maxElapsedMinutes = parseOptionalNonNegativeInt(
    typeof opts.maxElapsed === "string" ? opts.maxElapsed : undefined,
    "--max-elapsed",
  );
  const maxStartedRuns = parseOptionalNonNegativeInt(
    typeof opts.maxStartedRuns === "string" ? opts.maxStartedRuns : undefined,
    "--max-started-runs",
  );
  const maxFailedRuns = parseOptionalNonNegativeInt(
    typeof opts.maxFailedRuns === "string" ? opts.maxFailedRuns : undefined,
    "--max-failed-runs",
  );
  return {
    ...(maxConcurrentRuns === null ? {} : { maxConcurrentRuns }),
    ...(idleTimeoutMinutes === null ? {} : { idleTimeoutMinutes }),
    ...(maxElapsedMinutes === null ? {} : { maxElapsedMinutes }),
    ...(maxStartedRuns === null ? {} : { maxStartedRuns }),
    ...(maxFailedRuns === null ? {} : { maxFailedRuns }),
  };
}
```

Call it inside the action's existing `try` block, next to `resolveStartOverrides(opts)`, and report parse errors through the existing `start:` error path. Store the parsed value in a local variable for Task 5:

```typescript
let schedulerCliOverrides: SchedulerCliOverrides;
try {
  overrides = resolveStartOverrides(opts);
  schedulerCliOverrides = resolveSchedulerCliOverrides(opts);
} catch (err) {
  stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
  setExitCode(1);
  return;
}
void schedulerCliOverrides;
```

- [ ] **Step 9: Add CLI parse tests for invalid scheduler flags**

Add to `tests/unit/commands/start.test.ts`:

```typescript
it("rejects an invalid max concurrency", async () => {
  const messages: string[] = [];
  let exitCode: number | undefined;
  const program = makeProgram({
    stderr: (line) => messages.push(line),
    setExitCode: (code) => { exitCode = code; },
  });

  await program.parseAsync(["start", "42", "--max-concurrent", "0"], { from: "user" });

  expect(exitCode).toBe(1);
  expect(messages.join("\n")).toMatch(/invalid --max-concurrent/);
});

it("rejects an invalid idle timeout", async () => {
  const messages: string[] = [];
  let exitCode: number | undefined;
  const program = makeProgram({
    stderr: (line) => messages.push(line),
    setExitCode: (code) => { exitCode = code; },
  });

  await program.parseAsync(["start", "42", "--idle-timeout", "-1"], { from: "user" });

  expect(exitCode).toBe(1);
  expect(messages.join("\n")).toMatch(/invalid --idle-timeout/);
});
```

If `makeProgram` does not exist in the file, use the existing helper pattern from `tests/unit/commands/start.test.ts`; do not create a second incompatible helper.

- [ ] **Step 10: Run targeted tests**

Run:

```bash
npx vitest run tests/unit/config/schema.test.ts tests/unit/scheduler/policy.test.ts tests/unit/commands/start.test.ts
```

Expected: PASS.

- [ ] **Step 11: Grep callers after config type change**

Run:

```bash
grep -R "AutopilotConfig" -n src tests | sed -n '1,200p'
grep -R "scheduler" -n src/config tests/unit/config tests/unit/commands/start.test.ts | sed -n '1,200p'
```

Update any test config fixtures that now need a `scheduler` field because they construct a full `AutopilotConfig` object instead of parsing through the zod defaults.

- [ ] **Step 12: Commit**

```bash
git add src/config/schema.ts src/commands/start.ts src/scheduler/policy.ts tests/unit/config/schema.test.ts tests/unit/scheduler/policy.test.ts tests/unit/commands/start.test.ts
git commit -m "feat(scheduler): add scheduler policy configuration"
```

---

### Task 2: Durable scheduler state types and queue compatibility

**Files:**
- Create: `src/scheduler/state.ts`
- Modify: `src/daemon/queue-store.ts`
- Test: `tests/unit/daemon/queue-store.test.ts`
- Test: `tests/unit/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `SchedulerPolicy` from `src/scheduler/policy.ts`; existing `CompletedRun` and `DaemonQueue` in `src/daemon/queue-store.ts`.
- Produces:
  - `SchedulerIssueState` union.
  - `DependencySnapshot`, `WorkspaceScope`, `SchedulerIssue`, `ActiveSchedulerRun`, `SchedulerBudgetUsage`, `SchedulerState` interfaces.
  - `UNKNOWN_WORKSPACE_SCOPE: WorkspaceScope`.
  - `createInitialSchedulerState(input): SchedulerState`.
  - `ensureSchedulerState(queue, policy, now): SchedulerState`.

- [ ] **Step 1: Write failing state constructor tests**

Create or append to `tests/unit/scheduler/scheduler.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_WORKSPACE_SCOPE,
  createInitialSchedulerState,
  ensureSchedulerState,
} from "../../../src/scheduler/state.js";
import type { DaemonQueue } from "../../../src/daemon/queue-store.js";

const policy = {
  maxConcurrentRuns: 1,
  idleTimeoutMinutes: 0,
  budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
};

describe("scheduler state", () => {
  it("creates initial scheduler state from normalized issues", () => {
    const state = createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        {
          issueNumber: 42,
          dependencies: [],
          workspaceScope: { kind: "paths", patterns: ["src/daemon/**"], source: "issue-contract" },
          initialState: "PENDING",
          reason: "ready",
        },
      ],
    });

    expect(state.version).toBe(1);
    expect(state.policy).toEqual(policy);
    expect(state.activeRuns).toEqual([]);
    expect(state.budgets).toEqual({ startedRuns: 0, failedRuns: 0, elapsedMinutes: 0, stopReason: null });
    expect(state.issues[0]).toMatchObject({ issueNumber: 42, state: "PENDING", reason: "ready" });
  });

  it("initializes absent scheduler state from an old queue", () => {
    const queue: DaemonQueue = {
      repository: { owner: "acme", repo: "widgets" },
      issues: [42],
      currentIndex: 0,
      startedAt: "2026-08-24T00:00:00.000Z",
      completedRuns: [],
    };

    const state = ensureSchedulerState(queue, policy, () => "2026-08-24T00:01:00.000Z");

    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({
      issueNumber: 42,
      state: "PENDING",
      workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
      dependencies: [],
    });
  });
});
```

- [ ] **Step 2: Run scheduler state test and verify it fails**

Run:

```bash
npx vitest run tests/unit/scheduler/scheduler.test.ts
```

Expected: FAIL because `src/scheduler/state.ts` does not exist.

- [ ] **Step 3: Implement `src/scheduler/state.ts`**

Create:

```typescript
import type { SchedulerPolicy } from "./policy.js";
import type { DaemonQueue } from "../daemon/queue-store.js";

export type SchedulerIssueState =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "DEFERRED_DEPENDENCY"
  | "DEFERRED_CONFLICT"
  | "DEFERRED_INVALID";

export interface DependencySnapshot {
  issueNumber: number;
  satisfied: boolean;
  source: "github-closed" | "local-pr-open" | "unsatisfied" | "invalid";
  checkedAt: string;
}

export interface WorkspaceScope {
  kind: "paths" | "unknown";
  patterns: string[];
  source: "issue-contract" | "analysis-report" | "missing";
}

export interface SchedulerIssue {
  issueNumber: number;
  state: SchedulerIssueState;
  dependencies: DependencySnapshot[];
  workspaceScope: WorkspaceScope;
  reason: string | null;
  runId: string | null;
  outcome: string | null;
}

export interface ActiveSchedulerRun {
  issueNumber: number;
  runId: string | null;
  startedAt: string;
  workspaceScope: WorkspaceScope;
}

export interface SchedulerBudgetUsage {
  startedRuns: number;
  failedRuns: number;
  elapsedMinutes: number;
  stopReason: string | null;
}

export interface SchedulerState {
  version: 1;
  policy: SchedulerPolicy;
  startedAt: string;
  lastUpdatedAt: string;
  issues: SchedulerIssue[];
  activeRuns: ActiveSchedulerRun[];
  budgets: SchedulerBudgetUsage;
  lastBlockedRefreshAt: string | null;
  idleSince: string | null;
}

export const UNKNOWN_WORKSPACE_SCOPE: WorkspaceScope = {
  kind: "unknown",
  patterns: [],
  source: "missing",
};

export interface InitialSchedulerIssueInput {
  issueNumber: number;
  dependencies: DependencySnapshot[];
  workspaceScope: WorkspaceScope;
  initialState: SchedulerIssueState;
  reason: string | null;
}

export function createInitialSchedulerState(input: {
  policy: SchedulerPolicy;
  startedAt: string;
  issues: InitialSchedulerIssueInput[];
}): SchedulerState {
  return {
    version: 1,
    policy: input.policy,
    startedAt: input.startedAt,
    lastUpdatedAt: input.startedAt,
    issues: input.issues.map((issue) => ({
      issueNumber: issue.issueNumber,
      state: issue.initialState,
      dependencies: issue.dependencies,
      workspaceScope: issue.workspaceScope,
      reason: issue.reason,
      runId: null,
      outcome: null,
    })),
    activeRuns: [],
    budgets: {
      startedRuns: 0,
      failedRuns: 0,
      elapsedMinutes: 0,
      stopReason: null,
    },
    lastBlockedRefreshAt: null,
    idleSince: null,
  };
}

export function ensureSchedulerState(
  queue: DaemonQueue,
  policy: SchedulerPolicy,
  now: () => string,
): SchedulerState {
  if (queue.scheduler !== undefined) return queue.scheduler;
  return createInitialSchedulerState({
    policy,
    startedAt: queue.startedAt,
    issues: queue.issues.slice(queue.currentIndex).map((issueNumber) => ({
      issueNumber,
      dependencies: [],
      workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
      initialState: "PENDING",
      reason: "legacy queue entry",
    })),
  });
}
```

- [ ] **Step 4: Extend `DaemonQueue` type**

In `src/daemon/queue-store.ts`, import the type and add optional scheduler:

```typescript
import type { SchedulerState } from "../scheduler/state.js";
```

Change interface:

```typescript
export interface DaemonQueue {
  repository: RepositoryRef;
  issues: number[];
  currentIndex: number;
  startedAt: string;
  completedRuns: CompletedRun[];
  overrides?: RunOverrides;
  scheduler?: SchedulerState;
}
```

- [ ] **Step 5: Add queue-store round-trip test with scheduler field**

Append to `tests/unit/daemon/queue-store.test.ts`:

```typescript
it("round-trips queue scheduler state without dropping old fields", () => {
  const store = makeStore();
  const queue = {
    repository: { owner: "acme", repo: "widgets" },
    issues: [42],
    currentIndex: 0,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy: { maxConcurrentRuns: 1, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [{ issueNumber: 42, dependencies: [], workspaceScope: UNKNOWN_WORKSPACE_SCOPE, initialState: "PENDING", reason: "ready" }],
    }),
  };

  store.write(queue);

  expect(store.read()).toEqual(queue);
});
```

If `makeStore()` is named differently in the existing test, use the existing helper and add imports for `createInitialSchedulerState` and `UNKNOWN_WORKSPACE_SCOPE`.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npx vitest run tests/unit/scheduler/scheduler.test.ts tests/unit/daemon/queue-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Grep queue type callers**

Run:

```bash
grep -R "DaemonQueue\|completedRuns\|currentIndex\|queue\.scheduler" -n src tests | sed -n '1,240p'
```

No old caller should require a scheduler field. If TypeScript reports any fixture type errors, keep scheduler optional and update only fixtures that explicitly assert full shape.

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/state.ts src/daemon/queue-store.ts tests/unit/scheduler/scheduler.test.ts tests/unit/daemon/queue-store.test.ts
git commit -m "feat(scheduler): add durable scheduler state"
```

---

### Task 3: Workspace-scope parsing and conflict detection

**Files:**
- Create: `src/scheduler/workspace-scope.ts`
- Test: `tests/unit/scheduler/workspace-scope.test.ts`
- Optional modify: `src/domain/backlog.ts` if report rows need to carry cached scope.
- Optional test: `tests/unit/domain/backlog.test.ts` if `BacklogReportSchema` changes.

**Interfaces:**
- Consumes: `WorkspaceScope` and `UNKNOWN_WORKSPACE_SCOPE` from `src/scheduler/state.ts`; issue body strings.
- Produces:
  - `parseWorkspaceScopeFromIssueBody(body: string): WorkspaceScope`.
  - `normalizePathPattern(pattern: string): string`.
  - `workspaceScopesConflict(a: WorkspaceScope, b: WorkspaceScope): boolean`.
  - `workspaceScopeReason(scope: WorkspaceScope): string`.

- [ ] **Step 1: Write failing workspace-scope tests**

Create `tests/unit/scheduler/workspace-scope.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  normalizePathPattern,
  parseWorkspaceScopeFromIssueBody,
  workspaceScopeReason,
  workspaceScopesConflict,
} from "../../../src/scheduler/workspace-scope.js";
import type { WorkspaceScope } from "../../../src/scheduler/state.js";

const scope = (patterns: string[]): WorkspaceScope => ({ kind: "paths", patterns, source: "issue-contract" });

describe("workspace scope", () => {
  it("parses workspace scope from the autonomous execution contract", () => {
    const body = [
      "Intro",
      "<!-- autopilot-refinement:start -->",
      "## Autonomous execution contract",
      "### Workspace scope",
      "- src/daemon/**",
      "- tests/unit/daemon/**",
      "### Validation",
      "- npm test",
      "<!-- autopilot-refinement:end -->",
    ].join("\n");

    expect(parseWorkspaceScopeFromIssueBody(body)).toEqual({
      kind: "paths",
      patterns: ["src/daemon/**", "tests/unit/daemon/**"],
      source: "issue-contract",
    });
  });

  it("returns unknown when no scope section exists", () => {
    expect(parseWorkspaceScopeFromIssueBody("plain issue body")).toEqual({
      kind: "unknown",
      patterns: [],
      source: "missing",
    });
  });

  it("normalizes leading dot slash and duplicate slashes", () => {
    expect(normalizePathPattern("./src//daemon/**")).toBe("src/daemon/**");
  });

  it("conflicts unknown scope with everything", () => {
    expect(workspaceScopesConflict({ kind: "unknown", patterns: [], source: "missing" }, scope(["src/daemon/**"]))).toBe(true);
    expect(workspaceScopesConflict({ kind: "unknown", patterns: [], source: "missing" }, { kind: "unknown", patterns: [], source: "missing" })).toBe(true);
  });

  it("detects exact and parent-child path conflicts", () => {
    expect(workspaceScopesConflict(scope(["src/daemon/daemon-runner.ts"]), scope(["src/daemon/daemon-runner.ts"]))).toBe(true);
    expect(workspaceScopesConflict(scope(["src/daemon/**"]), scope(["src/daemon/daemon-runner.ts"]))).toBe(true);
    expect(workspaceScopesConflict(scope(["src/daemon"]), scope(["src/daemon/daemon-runner.ts"]))).toBe(true);
  });

  it("treats disjoint top-level paths as non-conflicting", () => {
    expect(workspaceScopesConflict(scope(["src/daemon/**"]), scope(["src/commands/**"]))).toBe(false);
  });

  it("returns human-readable scope reasons", () => {
    expect(workspaceScopeReason(scope(["src/daemon/**"]))).toBe("src/daemon/**");
    expect(workspaceScopeReason({ kind: "unknown", patterns: [], source: "missing" })).toBe("unknown workspace scope");
  });
});
```

- [ ] **Step 2: Run workspace-scope test and verify it fails**

Run:

```bash
npx vitest run tests/unit/scheduler/workspace-scope.test.ts
```

Expected: FAIL because `src/scheduler/workspace-scope.ts` does not exist.

- [ ] **Step 3: Implement parser and conservative conflict matcher**

Create `src/scheduler/workspace-scope.ts`:

```typescript
import { UNKNOWN_WORKSPACE_SCOPE, type WorkspaceScope } from "./state.js";

const WORKSPACE_SCOPE_HEADING = /^###\s+Workspace scope\s*$/i;
const NEXT_HEADING = /^###\s+/;

export function normalizePathPattern(pattern: string): string {
  return pattern
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

export function parseWorkspaceScopeFromIssueBody(body: string): WorkspaceScope {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => WORKSPACE_SCOPE_HEADING.test(line.trim()));
  if (start === -1) return UNKNOWN_WORKSPACE_SCOPE;

  const patterns: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (NEXT_HEADING.test(line)) break;
    if (line.length === 0) continue;
    const bullet = line.match(/^-\s+(.+)$/);
    const value = normalizePathPattern(bullet?.[1] ?? line);
    if (value.length > 0 && value.toLowerCase() !== "none.") patterns.push(value);
  }

  if (patterns.length === 0) return UNKNOWN_WORKSPACE_SCOPE;
  return { kind: "paths", patterns: Array.from(new Set(patterns)), source: "issue-contract" };
}

export function workspaceScopesConflict(a: WorkspaceScope, b: WorkspaceScope): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return true;
  for (const left of a.patterns.map(normalizePathPattern)) {
    for (const right of b.patterns.map(normalizePathPattern)) {
      if (patternsConflict(left, right)) return true;
    }
  }
  return false;
}

export function workspaceScopeReason(scope: WorkspaceScope): string {
  if (scope.kind === "unknown") return "unknown workspace scope";
  return scope.patterns.join(", ");
}

function patternsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const aPrefix = globPrefix(a);
  const bPrefix = globPrefix(b);
  if (isSameOrChild(aPrefix, bPrefix) || isSameOrChild(bPrefix, aPrefix)) return true;
  return false;
}

function globPrefix(pattern: string): string {
  const wildcard = pattern.search(/[\*\?\[]/);
  const raw = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return normalizePathPattern(raw.replace(/\/[^/]*$/, (match) => match.includes(".") ? "" : match));
}

function isSameOrChild(parent: string, child: string): boolean {
  if (parent.length === 0 || child.length === 0) return true;
  return child === parent || child.startsWith(`${parent}/`);
}
```

The matcher is intentionally conservative: the tests in Step 1 define the required behavior for exact, parent/child, wildcard, and disjoint path cases.

- [ ] **Step 4: Run workspace-scope test and verify it passes**

Run:

```bash
npx vitest run tests/unit/scheduler/workspace-scope.test.ts
```

Expected: PASS.

- [ ] **Step 5: Decide whether `BacklogReportSchema` needs cached scope now**

If `src/domain/backlog.ts` is modified, add only an optional field so existing analyze reports parse:

```typescript
workspaceScope: z
  .object({
    kind: z.enum(["paths", "unknown"]),
    patterns: z.array(z.string()),
    source: z.enum(["issue-contract", "analysis-report", "missing"]),
  })
  .optional(),
```

Add a `tests/unit/domain/backlog.test.ts` case that parses a report with `workspaceScope` and still parses a report without it. If no production code writes cached scope in this milestone, skip this file change and let `start` parse issue bodies directly.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npx vitest run tests/unit/scheduler/workspace-scope.test.ts tests/unit/domain/backlog.test.ts
```

Expected: PASS. If `src/domain/backlog.ts` was not changed, `tests/unit/domain/backlog.test.ts` should still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/workspace-scope.ts tests/unit/scheduler/workspace-scope.test.ts src/domain/backlog.ts tests/unit/domain/backlog.test.ts
git commit -m "feat(scheduler): add workspace scope conflict checks"
```

If `src/domain/backlog.ts` and `tests/unit/domain/backlog.test.ts` were unchanged, omit them from `git add`.

---

### Task 4: Dependency normalization and cycle detection

**Files:**
- Create: `src/scheduler/dependencies.ts`
- Modify: `src/persistence/run-store.ts`
- Test: `tests/unit/scheduler/dependencies.test.ts`
- Test: `tests/integration/persistence/run-store.test.ts`

**Interfaces:**
- Consumes: `MANAGED_DEPENDENCY_PATTERN`, `LINE_DEPENDENCY_PATTERN`, `dependencyNumberFromMatch` from `src/analysis/dependency-markers.ts`; `GitHubIssue` from `src/github/github-adapter.ts`; `RunStore`.
- Produces:
  - `extractDependencyNumbers(body: string): number[]`.
  - `detectDependencyCycles(graph: Map<number, number[]>): Set<number>`.
  - `buildDependencySnapshots(input): Promise<Map<number, DependencySnapshot[]>>`.
  - `RunStore.hasSuccessfulPrOpenForIssue(owner, repo, issueNumber): boolean`.

- [ ] **Step 1: Write failing dependency tests**

Create `tests/unit/scheduler/dependencies.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildDependencySnapshots,
  detectDependencyCycles,
  extractDependencyNumbers,
} from "../../../src/scheduler/dependencies.js";

describe("scheduler dependencies", () => {
  it("extracts managed and line dependency markers once", () => {
    const body = [
      "depends on: #10",
      "dependency 11",
      "### Dependencies",
      "- #12 (unsatisfied)",
      "- #10 (unsatisfied)",
    ].join("\n");
    expect(extractDependencyNumbers(body)).toEqual([10, 11, 12]);
  });

  it("detects only issues participating in cycles", () => {
    const cycles = detectDependencyCycles(new Map([
      [1, [2]],
      [2, [3]],
      [3, [1]],
      [4, [1]],
      [5, []],
    ]));
    expect(Array.from(cycles).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("builds hybrid dependency snapshots", async () => {
    const snapshots = await buildDependencySnapshots({
      repository: { owner: "acme", repo: "widgets" },
      issues: [
        { issueNumber: 42, body: "depends on: #10\ndepends on: #11\ndepends on: #12" },
      ],
      now: () => "2026-08-24T00:00:00.000Z",
      getIssueState: async (issueNumber) => issueNumber === 10 ? "closed" : "open",
      hasLocalPrOpen: async (issueNumber) => issueNumber === 11,
    });

    expect(snapshots.get(42)).toEqual([
      { issueNumber: 10, satisfied: true, source: "github-closed", checkedAt: "2026-08-24T00:00:00.000Z" },
      { issueNumber: 11, satisfied: true, source: "local-pr-open", checkedAt: "2026-08-24T00:00:00.000Z" },
      { issueNumber: 12, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" },
    ]);
  });

  it("marks dependency fetch failures as invalid snapshots", async () => {
    const snapshots = await buildDependencySnapshots({
      repository: { owner: "acme", repo: "widgets" },
      issues: [{ issueNumber: 42, body: "depends on: #99" }],
      now: () => "2026-08-24T00:00:00.000Z",
      getIssueState: async () => { throw new Error("not found"); },
      hasLocalPrOpen: async () => false,
    });

    expect(snapshots.get(42)).toEqual([
      { issueNumber: 99, satisfied: false, source: "invalid", checkedAt: "2026-08-24T00:00:00.000Z" },
    ]);
  });
});
```

- [ ] **Step 2: Run dependency tests and verify they fail**

Run:

```bash
npx vitest run tests/unit/scheduler/dependencies.test.ts
```

Expected: FAIL because `src/scheduler/dependencies.ts` does not exist.

- [ ] **Step 3: Implement dependency helper module**

Create `src/scheduler/dependencies.ts`:

```typescript
import {
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
  dependencyNumberFromMatch,
} from "../analysis/dependency-markers.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { DependencySnapshot } from "./state.js";

export function extractDependencyNumbers(body: string): number[] {
  const numbers: number[] = [];
  for (const pattern of [MANAGED_DEPENDENCY_PATTERN, LINE_DEPENDENCY_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      numbers.push(dependencyNumberFromMatch(match));
    }
  }
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

export function detectDependencyCycles(graph: Map<number, number[]>): Set<number> {
  const index = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const cyclic = new Set<number>();
  let nextIndex = 0;

  function strongConnect(node: number): void {
    index.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue;
      if (!index.has(dep)) {
        strongConnect(dep);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(dep)!));
      } else if (onStack.has(dep)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(dep)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const component: number[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      const selfCycle = component.length === 1 && (graph.get(component[0]!) ?? []).includes(component[0]!);
      if (component.length > 1 || selfCycle) {
        for (const member of component) cyclic.add(member);
      }
    }
  }

  for (const node of graph.keys()) {
    if (!index.has(node)) strongConnect(node);
  }
  return cyclic;
}

export async function buildDependencySnapshots(input: {
  repository: RepositoryRef;
  issues: Array<{ issueNumber: number; body: string }>;
  now: () => string;
  getIssueState(issueNumber: number): Promise<string>;
  hasLocalPrOpen(issueNumber: number): Promise<boolean>;
}): Promise<Map<number, DependencySnapshot[]>> {
  const result = new Map<number, DependencySnapshot[]>();
  for (const issue of input.issues) {
    const snapshots: DependencySnapshot[] = [];
    for (const dependency of extractDependencyNumbers(issue.body)) {
      const checkedAt = input.now();
      try {
        const state = await input.getIssueState(dependency);
        if (state === "closed") {
          snapshots.push({ issueNumber: dependency, satisfied: true, source: "github-closed", checkedAt });
        } else if (await input.hasLocalPrOpen(dependency)) {
          snapshots.push({ issueNumber: dependency, satisfied: true, source: "local-pr-open", checkedAt });
        } else {
          snapshots.push({ issueNumber: dependency, satisfied: false, source: "unsatisfied", checkedAt });
        }
      } catch {
        snapshots.push({ issueNumber: dependency, satisfied: false, source: "invalid", checkedAt });
      }
    }
    result.set(issue.issueNumber, snapshots);
  }
  return result;
}
```

- [ ] **Step 4: Run dependency tests and verify they pass**

Run:

```bash
npx vitest run tests/unit/scheduler/dependencies.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add run-history query test**

Add to `tests/integration/persistence/run-store.test.ts`:

```typescript
it("reports whether an issue has a successful PR_OPEN run", () => {
  const run = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 42 });
  store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
  store.transition(run.id, "READINESS_CHECK", "WORKSPACE_CREATION", null);
  store.transition(run.id, "WORKSPACE_CREATION", "IMPLEMENTATION", null);
  store.transition(run.id, "IMPLEMENTATION", "VERIFICATION", null);
  store.transition(run.id, "VERIFICATION", "INDEPENDENT_REVIEW", null);
  store.transition(run.id, "INDEPENDENT_REVIEW", "PUBLICATION", null);
  store.transition(run.id, "PUBLICATION", "PR_OPEN", null);

  expect(store.hasSuccessfulPrOpenForIssue("acme", "widgets", 42)).toBe(true);
  expect(store.hasSuccessfulPrOpenForIssue("acme", "widgets", 43)).toBe(false);
});
```

Use the existing store setup variable names in that file. If its tests use a helper to create terminal runs, use that helper but keep the assertion exact.

- [ ] **Step 6: Implement `RunStore.hasSuccessfulPrOpenForIssue`**

In `src/persistence/run-store.ts`, add:

```typescript
hasSuccessfulPrOpenForIssue(owner: string, repo: string, issueNumber: number): boolean {
  const row = this.db
    .prepare(
      `SELECT id FROM runs
       WHERE owner = ? AND repo = ? AND issue_number = ? AND stage = 'PR_OPEN'
       LIMIT 1`,
    )
    .get(owner, repo, issueNumber) as { id: string } | undefined;
  return row !== undefined;
}
```

- [ ] **Step 7: Run persistence and dependency tests**

Run:

```bash
npx vitest run tests/unit/scheduler/dependencies.test.ts tests/integration/persistence/run-store.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/dependencies.ts src/persistence/run-store.ts tests/unit/scheduler/dependencies.test.ts tests/integration/persistence/run-store.test.ts
git commit -m "feat(scheduler): normalize dependency state"
```

---

### Task 5: Scheduler state builder at `start`

**Files:**
- Modify: `src/commands/start.ts`
- Modify: `src/commands/start.ts` exported test seams if needed.
- Test: `tests/unit/commands/start.test.ts`

**Interfaces:**
- Consumes: `resolveSchedulerPolicy()` from Task 1; `createInitialSchedulerState()` from Task 2; `parseWorkspaceScopeFromIssueBody()` from Task 3; `buildDependencySnapshots()` and `detectDependencyCycles()` from Task 4; `GitHubPort.getIssue()`; `RunStore.hasSuccessfulPrOpenForIssue()`.
- Produces: `queue.scheduler` on every newly written queue.

- [ ] **Step 1: Add test seam types to `StartCommandDeps`**

Modify `src/commands/start.ts` later, but first write tests assuming these deps exist:

```typescript
createSchedulerState?: (input: {
  repository: RepositoryRef;
  issueNumbers: number[];
  policy: SchedulerPolicy;
  now: string;
}) => Promise<SchedulerState>;
now?: () => string;
```

- [ ] **Step 2: Write failing start queue scheduler tests**

Add to `tests/unit/commands/start.test.ts`:

```typescript
it("writes scheduler state and policy into queue.json", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "autopilot-start-scheduler-"));
  const spawned: Array<{ env: Record<string, string> }> = [];
  const program = makeProgram({
    dataDir,
    now: () => "2026-08-24T00:00:00.000Z",
    resolveContext: async () => ({ root: "/repo", repository: { owner: "acme", repo: "widgets" }, remoteUrl: "git@github.com:acme/widgets.git" }),
    verifyIssues: async () => undefined,
    spawnDaemon: (_entry, env) => { spawned.push({ env }); return { pid: 123 }; },
    createSchedulerState: async ({ issueNumbers, policy, now }) => createInitialSchedulerState({
      policy,
      startedAt: now,
      issues: issueNumbers.map((issueNumber) => ({
        issueNumber,
        dependencies: [],
        workspaceScope: { kind: "paths", patterns: [`src/${issueNumber}/**`], source: "issue-contract" },
        initialState: "PENDING",
        reason: "ready",
      })),
    }),
  });

  await program.parseAsync(["start", "42", "43", "--max-concurrent", "2", "--max-started-runs", "5"], { from: "user" });

  const queue = JSON.parse(readFileSync(path.join(dataDir, "daemon", "queue.json"), "utf8"));
  expect(queue.issues).toEqual([42, 43]);
  expect(queue.scheduler.policy.maxConcurrentRuns).toBe(2);
  expect(queue.scheduler.policy.budgets.maxStartedRuns).toBe(5);
  expect(queue.scheduler.issues.map((issue: { issueNumber: number }) => issue.issueNumber)).toEqual([42, 43]);
  expect(spawned).toHaveLength(1);
});
```

Adjust imports to match existing test helpers: `mkdtempSync`, `tmpdir`, `path`, `readFileSync`, and `createInitialSchedulerState`.

- [ ] **Step 3: Run start test and verify it fails**

Run:

```bash
npx vitest run tests/unit/commands/start.test.ts
```

Expected: FAIL because `queue.scheduler` is absent and test seams do not exist.

- [ ] **Step 4: Load config in start command before resolving scheduler policy**

In `src/commands/start.ts`, import:

```typescript
import { loadRepositoryConfig } from "../config/load-config.js";
import { RunStore } from "../persistence/run-store.js";
import { buildDependencySnapshots, detectDependencyCycles } from "../scheduler/dependencies.js";
import { resolveSchedulerPolicy, type SchedulerPolicy } from "../scheduler/policy.js";
import { createInitialSchedulerState, type SchedulerState, type InitialSchedulerIssueInput } from "../scheduler/state.js";
import { parseWorkspaceScopeFromIssueBody } from "../scheduler/workspace-scope.js";
```

Add deps:

```typescript
createSchedulerState?: (input: {
  repository: RepositoryRef;
  issueNumbers: number[];
  policy: SchedulerPolicy;
  now: string;
}) => Promise<SchedulerState>;
now?: () => string;
```

After `ctx` has been resolved and `issues` assigned, load config and resolve policy:

```typescript
const config = await loadRepositoryConfig(ctx.root);
const schedulerPolicy = resolveSchedulerPolicy(config, schedulerCliOverrides);
const startedAt = (deps.now ?? (() => new Date().toISOString()))();
const scheduler = deps.createSchedulerState !== undefined
  ? await deps.createSchedulerState({ repository: ctx.repository, issueNumbers: issues, policy: schedulerPolicy, now: startedAt })
  : await buildSchedulerState({ root: ctx.root, repository: ctx.repository, issueNumbers: issues, policy: schedulerPolicy, now: startedAt, runner });
```

Use `startedAt` for the top-level queue's `startedAt` too.

- [ ] **Step 5: Implement private `buildSchedulerState` helper in `start.ts`**

Add below `findLatestBacklogReport` or near other private helpers:

```typescript
async function buildSchedulerState(input: {
  root: string;
  repository: RepositoryRef;
  issueNumbers: number[];
  policy: SchedulerPolicy;
  now: string;
  runner: ProcessRunner;
}): Promise<SchedulerState> {
  const github = await GitHubAdapter.create(input.root, input.runner);
  const issues = [];
  for (const issueNumber of input.issueNumbers) {
    const issue = await github.getIssue(issueNumber);
    issues.push({ issueNumber, body: issue.body });
  }

  const runStore = new RunStore(appPaths().dbPath);
  try {
    const snapshots = await buildDependencySnapshots({
      repository: input.repository,
      issues,
      now: () => input.now,
      getIssueState: async (issueNumber) => (await github.getIssue(issueNumber)).state,
      hasLocalPrOpen: async (issueNumber) => runStore.hasSuccessfulPrOpenForIssue(
        input.repository.owner,
        input.repository.repo,
        issueNumber,
      ),
    });
    const graph = new Map<number, number[]>(
      issues.map((issue) => [issue.issueNumber, (snapshots.get(issue.issueNumber) ?? []).map((dep) => dep.issueNumber)]),
    );
    const cyclic = detectDependencyCycles(graph);
    const normalized: InitialSchedulerIssueInput[] = issues.map((issue) => {
      const dependencies = snapshots.get(issue.issueNumber) ?? [];
      const hasInvalid = dependencies.some((dep) => dep.source === "invalid");
      const hasUnsatisfied = dependencies.some((dep) => !dep.satisfied);
      const workspaceScope = parseWorkspaceScopeFromIssueBody(issue.body);
      if (cyclic.has(issue.issueNumber)) {
        return { issueNumber: issue.issueNumber, dependencies, workspaceScope, initialState: "DEFERRED_INVALID", reason: "dependency cycle" };
      }
      if (hasInvalid) {
        return { issueNumber: issue.issueNumber, dependencies, workspaceScope, initialState: "DEFERRED_INVALID", reason: "invalid dependency metadata" };
      }
      if (hasUnsatisfied) {
        return { issueNumber: issue.issueNumber, dependencies, workspaceScope, initialState: "DEFERRED_DEPENDENCY", reason: "waiting for dependencies" };
      }
      return { issueNumber: issue.issueNumber, dependencies, workspaceScope, initialState: "PENDING", reason: "ready" };
    });
    return createInitialSchedulerState({ policy: input.policy, startedAt: input.now, issues: normalized });
  } finally {
    runStore.close();
  }
}
```

Important: if `deps.dataDir` is set in tests or production, pass it into the helper instead of calling `appPaths()` with no argument. Adjust the helper signature to include `dataDir: string | undefined` and use `appPaths(input.dataDir).dbPath`.

- [ ] **Step 6: Write queue with scheduler**

Change `queueStore.write({ ... })` to include:

```typescript
startedAt,
scheduler,
```

Keep `issues`, `currentIndex`, and `completedRuns` unchanged for compatibility.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
npx vitest run tests/unit/commands/start.test.ts tests/unit/scheduler/dependencies.test.ts tests/unit/scheduler/workspace-scope.test.ts
```

Expected: PASS.

- [ ] **Step 8: Grep callers after start deps/type changes**

Run:

```bash
grep -R "StartCommandDeps\|registerStartCommand\|spawnDaemon\|verifyIssues\|QueueStore" -n src tests | sed -n '1,240p'
```

Update all tests that construct `StartCommandDeps` directly if TypeScript reports missing fields or incompatible test fakes.

- [ ] **Step 9: Commit**

```bash
git add src/commands/start.ts tests/unit/commands/start.test.ts
git commit -m "feat(scheduler): initialize scheduler state at start"
```

---

### Task 6: Pure scheduler transitions and budget decisions

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Test: `tests/unit/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: scheduler state types from `src/scheduler/state.ts`; `workspaceScopesConflict()` from `src/scheduler/workspace-scope.ts`; `CompletedRun` from `src/daemon/queue-store.ts`; `RunSummary` from `src/workflow/run-service.ts`.
- Produces:
  - `refreshConflictStates(state): SchedulerState`.
  - `findStartableIssue(state, now): SchedulerIssue | null`.
  - `markIssueRunning(state, issueNumber, runId, startedAt): SchedulerState`.
  - `completeIssue(state, summary, completedAt): SchedulerState`.
  - `mergePendingIssues(state, issueInputs): SchedulerState`.
  - `updateBudgetUsage(state, now): SchedulerState`.
  - `isStartBudgetExhausted(state): string | null`.

- [ ] **Step 1: Extend `tests/unit/scheduler/scheduler.test.ts` with pure scheduling tests**

Add tests below Task 2 tests:

```typescript
import {
  completeIssue,
  findStartableIssue,
  isStartBudgetExhausted,
  markIssueRunning,
  refreshConflictStates,
  updateBudgetUsage,
} from "../../../src/scheduler/scheduler.js";

const pathScope = (pattern: string) => ({ kind: "paths" as const, patterns: [pattern], source: "issue-contract" as const });

it("starts first pending issue with satisfied dependencies and no active conflict", () => {
  const state = createInitialSchedulerState({
    policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
    startedAt: "2026-08-24T00:00:00.000Z",
    issues: [
      { issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" },
      { issueNumber: 2, dependencies: [], workspaceScope: pathScope("src/b/**"), initialState: "PENDING", reason: "ready" },
    ],
  });

  expect(findStartableIssue(state, "2026-08-24T00:01:00.000Z")?.issueNumber).toBe(1);
});

it("does not start dependency-blocked issues", () => {
  const state = createInitialSchedulerState({
    policy,
    startedAt: "2026-08-24T00:00:00.000Z",
    issues: [{
      issueNumber: 2,
      dependencies: [{ issueNumber: 1, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" }],
      workspaceScope: pathScope("src/b/**"),
      initialState: "DEFERRED_DEPENDENCY",
      reason: "waiting for #1",
    }],
  });

  expect(findStartableIssue(state, "2026-08-24T00:01:00.000Z")).toBeNull();
});

it("does not start an issue whose workspace scope conflicts with an active run", () => {
  let state = createInitialSchedulerState({
    policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
    startedAt: "2026-08-24T00:00:00.000Z",
    issues: [
      { issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/daemon/**"), initialState: "PENDING", reason: "ready" },
      { issueNumber: 2, dependencies: [], workspaceScope: pathScope("src/daemon/daemon-runner.ts"), initialState: "PENDING", reason: "ready" },
    ],
  });
  state = markIssueRunning(state, 1, "run-1", "2026-08-24T00:01:00.000Z");
  state = refreshConflictStates(state);

  expect(findStartableIssue(state, "2026-08-24T00:02:00.000Z")).toBeNull();
  expect(state.issues.find((issue) => issue.issueNumber === 2)?.state).toBe("DEFERRED_CONFLICT");
});

it("marks completed PR_OPEN and unblocks dependents locally", () => {
  let state = createInitialSchedulerState({
    policy,
    startedAt: "2026-08-24T00:00:00.000Z",
    issues: [
      { issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" },
      { issueNumber: 2, dependencies: [{ issueNumber: 1, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" }], workspaceScope: pathScope("src/b/**"), initialState: "DEFERRED_DEPENDENCY", reason: "waiting for #1" },
    ],
  });
  state = markIssueRunning(state, 1, "run-1", "2026-08-24T00:01:00.000Z");
  state = completeIssue(state, {
    runId: "run-1",
    stage: "PR_OPEN",
    repository: { owner: "acme", repo: "widgets" },
    issueNumber: 1,
    publication: null,
    reason: null,
  }, "2026-08-24T00:02:00.000Z");

  expect(state.activeRuns).toEqual([]);
  expect(state.issues.find((issue) => issue.issueNumber === 1)?.state).toBe("COMPLETED");
  expect(state.issues.find((issue) => issue.issueNumber === 2)?.state).toBe("PENDING");
});

it("reports budget stop reasons without cancelling active runs", () => {
  const state = updateBudgetUsage(createInitialSchedulerState({
    policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: 10, maxStartedRuns: 1, maxFailedRuns: null } },
    startedAt: "2026-08-24T00:00:00.000Z",
    issues: [{ issueNumber: 1, dependencies: [], workspaceScope: pathScope("src/a/**"), initialState: "PENDING", reason: "ready" }],
  }), "2026-08-24T00:11:00.000Z");

  expect(isStartBudgetExhausted(state)).toMatch(/elapsed/);
});
```

- [ ] **Step 2: Run scheduler test and verify new cases fail**

Run:

```bash
npx vitest run tests/unit/scheduler/scheduler.test.ts
```

Expected: FAIL because `src/scheduler/scheduler.ts` does not exist.

- [ ] **Step 3: Implement scheduler transition functions**

Create `src/scheduler/scheduler.ts` with immutable-ish state updates. Use deep enough cloning to avoid mutating input arrays unexpectedly:

```typescript
import type { CompletedRun } from "../daemon/queue-store.js";
import type { RunSummary } from "../workflow/run-service.js";
import type { SchedulerIssue, SchedulerState } from "./state.js";
import { workspaceScopeReason, workspaceScopesConflict } from "./workspace-scope.js";

export function updateBudgetUsage(state: SchedulerState, now: string): SchedulerState {
  const elapsedMinutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(state.startedAt)) / 60_000));
  return { ...state, budgets: { ...state.budgets, elapsedMinutes }, lastUpdatedAt: now };
}

export function isStartBudgetExhausted(state: SchedulerState): string | null {
  const budgets = state.policy.budgets;
  if (budgets.maxElapsedMinutes !== null && state.budgets.elapsedMinutes >= budgets.maxElapsedMinutes) {
    return `max elapsed minutes reached (${state.budgets.elapsedMinutes}/${budgets.maxElapsedMinutes})`;
  }
  if (budgets.maxStartedRuns !== null && state.budgets.startedRuns >= budgets.maxStartedRuns) {
    return `max started runs reached (${state.budgets.startedRuns}/${budgets.maxStartedRuns})`;
  }
  if (budgets.maxFailedRuns !== null && state.budgets.failedRuns >= budgets.maxFailedRuns) {
    return `max failed runs reached (${state.budgets.failedRuns}/${budgets.maxFailedRuns})`;
  }
  return null;
}

export function findStartableIssue(state: SchedulerState, now: string): SchedulerIssue | null {
  const current = updateBudgetUsage(state, now);
  if (isStartBudgetExhausted(current) !== null) return null;
  if (current.activeRuns.length >= current.policy.maxConcurrentRuns) return null;
  return current.issues.find((issue) =>
    issue.state === "PENDING" &&
    issue.dependencies.every((dependency) => dependency.satisfied) &&
    !current.activeRuns.some((run) => workspaceScopesConflict(issue.workspaceScope, run.workspaceScope))
  ) ?? null;
}

export function markIssueRunning(state: SchedulerState, issueNumber: number, runId: string | null, startedAt: string): SchedulerState {
  const issue = state.issues.find((candidate) => candidate.issueNumber === issueNumber);
  if (issue === undefined) throw new Error(`cannot start unknown scheduler issue #${issueNumber}`);
  return {
    ...state,
    lastUpdatedAt: startedAt,
    idleSince: null,
    budgets: { ...state.budgets, startedRuns: state.budgets.startedRuns + 1 },
    issues: state.issues.map((candidate) => candidate.issueNumber === issueNumber
      ? { ...candidate, state: "RUNNING", runId, reason: "running" }
      : candidate),
    activeRuns: [...state.activeRuns, { issueNumber, runId, startedAt, workspaceScope: issue.workspaceScope }],
  };
}

export function completeIssue(state: SchedulerState, summary: RunSummary, completedAt: string): SchedulerState {
  const failed = summary.stage === "FAILED" || summary.stage === "BLOCKED";
  const completedIssues = state.issues.map((issue) => {
    if (issue.issueNumber === summary.issueNumber) {
      return { ...issue, state: "COMPLETED" as const, runId: summary.runId, outcome: summary.stage, reason: summary.stage };
    }
    if (summary.stage === "PR_OPEN") {
      const dependencies = issue.dependencies.map((dependency) => dependency.issueNumber === summary.issueNumber
        ? { ...dependency, satisfied: true, source: "local-pr-open" as const, checkedAt: completedAt }
        : dependency);
      const unblocked = issue.state === "DEFERRED_DEPENDENCY" && dependencies.every((dependency) => dependency.satisfied);
      return { ...issue, dependencies, ...(unblocked ? { state: "PENDING" as const, reason: "ready" } : {}) };
    }
    return issue;
  });

  return refreshConflictStates({
    ...state,
    lastUpdatedAt: completedAt,
    activeRuns: state.activeRuns.filter((run) => run.issueNumber !== summary.issueNumber),
    budgets: { ...state.budgets, failedRuns: state.budgets.failedRuns + (failed ? 1 : 0) },
    issues: completedIssues,
  });
}

export function toCompletedRun(summary: RunSummary, completedAt: string): CompletedRun {
  return {
    issueNumber: summary.issueNumber,
    outcome: summary.stage as CompletedRun["outcome"],
    completedAt,
    runId: summary.runId,
  };
}

export function refreshConflictStates(state: SchedulerState): SchedulerState {
  const issues = state.issues.map((issue) => {
    if (issue.state !== "PENDING" && issue.state !== "DEFERRED_CONFLICT") return issue;
    const conflict = state.activeRuns.find((run) => workspaceScopesConflict(issue.workspaceScope, run.workspaceScope));
    if (conflict !== undefined) {
      return { ...issue, state: "DEFERRED_CONFLICT" as const, reason: `conflicts with #${conflict.issueNumber}: ${workspaceScopeReason(conflict.workspaceScope)}` };
    }
    if (issue.state === "DEFERRED_CONFLICT") return { ...issue, state: "PENDING" as const, reason: "ready" };
    return issue;
  });
  return { ...state, issues };
}
```

Keep `findStartableIssue()` returning `SchedulerIssue | null` as defined in this task. Later tasks depend on `candidate.issueNumber`, `candidate.workspaceScope`, and the state union names exactly as written here.

- [ ] **Step 4: Run scheduler tests**

Run:

```bash
npx vitest run tests/unit/scheduler/scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git commit -m "feat(scheduler): add pure scheduling transitions"
```

---

### Task 7: DaemonRunner scheduler loop with in-process concurrency

**Files:**
- Modify: `src/daemon/daemon-runner.ts`
- Modify: `src/daemon/daemon-entry.ts`
- Test: `tests/unit/daemon/daemon-runner.test.ts`

**Interfaces:**
- Consumes: `SchedulerState` from Task 2; scheduler transition functions from Task 6; existing claim/release helpers inside `DaemonRunner`; `PendingQueueStore.drainAll()`.
- Produces:
  - `SchedulerExecutor` interface in `src/daemon/daemon-runner.ts` or imported from `src/scheduler/scheduler.ts` if placed there.
  - Daemon scheduler path when `queue.scheduler` exists.
  - Existing sequential behavior remains when `queue.scheduler` is absent or when default policy yields one-at-a-time execution.

- [ ] **Step 1: Write failing concurrent daemon test**

Add to `tests/unit/daemon/daemon-runner.test.ts`:

```typescript
it("starts disjoint pending scheduler issues up to maxConcurrentRuns", async () => {
  const deps = makeDeps();
  let resolveRun1!: (value: any) => void;
  const run1 = new Promise((resolve) => { resolveRun1 = resolve; });
  (deps.runService.start as ReturnType<typeof vi.fn>)
    .mockReturnValueOnce(run1)
    .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
    repository: { owner: "acme", repo: "widgets" },
    issues: [1, 2],
    currentIndex: 0,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        { issueNumber: 1, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/a/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" },
        { issueNumber: 2, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/b/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" },
      ],
    }),
  });

  const runPromise = new DaemonRunner(deps).run();
  await Promise.resolve();
  expect(deps.runService.start).toHaveBeenCalledTimes(2);
  resolveRun1({ runId: "run-1", stage: "PR_OPEN", issueNumber: 1, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });
  await runPromise;

  const finalWrite = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
  expect(finalWrite.scheduler.issues.every((issue: { state: string }) => issue.state === "COMPLETED")).toBe(true);
});
```

Add imports for `createInitialSchedulerState`.

- [ ] **Step 2: Add tests for conflict, budget, and executor throw**

Add three tests:

```typescript
it("does not run conflicting scheduler issues concurrently", async () => {
  const deps = makeDeps();
  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithSchedulerIssues({
    maxConcurrentRuns: 2,
    issues: [
      { issueNumber: 1, scope: "src/daemon/**" },
      { issueNumber: 2, scope: "src/daemon/daemon-runner.ts" },
    ],
  }));
  (deps.runService.start as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 1, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
    .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

  await new DaemonRunner(deps).run();

  expect(deps.runService.start).toHaveBeenNthCalledWith(1, 1, {});
  expect(deps.runService.start).toHaveBeenNthCalledWith(2, 2, {});
});

it("stops starting scheduler issues when maxStartedRuns is reached", async () => {
  const deps = makeDeps();
  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithSchedulerIssues({
    maxConcurrentRuns: 2,
    budgets: { maxElapsedMinutes: null, maxStartedRuns: 1, maxFailedRuns: null },
    issues: [{ issueNumber: 1, scope: "src/a/**" }, { issueNumber: 2, scope: "src/b/**" }],
  }));
  (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 1, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

  await new DaemonRunner(deps).run();

  expect(deps.runService.start).toHaveBeenCalledTimes(1);
});

it("records FAILED when scheduler executor throws", async () => {
  const deps = makeDeps();
  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithSchedulerIssues({
    maxConcurrentRuns: 1,
    issues: [{ issueNumber: 1, scope: "src/a/**" }],
  }));
  (deps.runService.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

  await new DaemonRunner(deps).run();

  const writes = (deps.queueStore.write as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
  expect(writes.at(-1).completedRuns[0].outcome).toBe("FAILED");
});
```

Define local test helper in the test file:

```typescript
function queueWithSchedulerIssues(input: {
  maxConcurrentRuns: number;
  budgets?: { maxElapsedMinutes: number | null; maxStartedRuns: number | null; maxFailedRuns: number | null };
  issues: Array<{ issueNumber: number; scope: string }>;
}) {
  const policy = {
    maxConcurrentRuns: input.maxConcurrentRuns,
    idleTimeoutMinutes: 0,
    budgets: input.budgets ?? { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
  };
  return {
    repository: { owner: "acme", repo: "widgets" },
    issues: input.issues.map((issue) => issue.issueNumber),
    currentIndex: 0,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy,
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: input.issues.map((issue) => ({
        issueNumber: issue.issueNumber,
        dependencies: [],
        workspaceScope: { kind: "paths", patterns: [issue.scope], source: "issue-contract" },
        initialState: "PENDING",
        reason: "ready",
      })),
    }),
  };
}
```

- [ ] **Step 3: Run daemon test and verify new cases fail**

Run:

```bash
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```

Expected: FAIL because `DaemonRunner` still runs strict FIFO.

- [ ] **Step 4: Add scheduler executor seam to `DaemonRunnerDeps`**

In `src/daemon/daemon-runner.ts`, keep `runService` for compatibility but add a derived executor in code:

```typescript
export interface SchedulerExecutor {
  start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
}
```

Use `this.deps.runService` as the executor for M4; do not add a second required dependency unless tests become clearer with an optional `schedulerExecutor?: SchedulerExecutor`.

- [ ] **Step 5: Split old sequential loop into `runSequentialQueue(queue)`**

Move current main queue loop into a private method:

```typescript
private async runSequentialQueue(queue: DaemonQueue): Promise<void> {
  // existing while currentIndex < issues.length behavior, unchanged except using this.deps
}
```

In `run()`, after crash reconciliation and first `mergePending(queue)`, branch:

```typescript
if (queue.scheduler === undefined) {
  await this.runSequentialQueue(queue);
} else {
  await this.runSchedulerQueue(queue);
}
```

Keep PID deletion and exit handling in `run()` after the branch.

- [ ] **Step 6: Implement `runSchedulerQueue(queue)`**

Use a simple rolling promise set. Persist after every state transition before starting external work.

```typescript
private async runSchedulerQueue(queue: DaemonQueue): Promise<void> {
  const active = new Set<Promise<void>>();

  const launchAvailable = (): void => {
    for (;;) {
      if (queue.scheduler === undefined) return;
      if (active.size >= queue.scheduler.policy.maxConcurrentRuns) return;
      queue.scheduler = refreshConflictStates(queue.scheduler);
      this.deps.queueStore.write(queue);
      const candidate = findStartableIssue(queue.scheduler, new Date().toISOString());
      if (candidate === null) return;
      const startedAt = new Date().toISOString();
      queue.scheduler = markIssueRunning(queue.scheduler, candidate.issueNumber, null, startedAt);
      this.deps.queueStore.write(queue);
      const promise = this.runOneScheduledIssue(queue, candidate.issueNumber)
        .finally(() => { active.delete(promise); });
      active.add(promise);
    }
  };

  launchAvailable();
  while (active.size > 0) {
    await Promise.race(active);
    this.mergePending(queue);
    launchAvailable();
    if (this.stopRequested) break;
  }
}
```

Then implement `runOneScheduledIssue`:

```typescript
private async runOneScheduledIssue(queue: DaemonQueue, issueNumber: number): Promise<void> {
  await this.claim(issueNumber);
  let summary: RunSummary;
  try {
    summary = await this.deps.runService.start(issueNumber, this.deps.overrides);
  } catch (err) {
    this.deps.logFile.error(`run failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
    summary = { runId: `failed-${issueNumber}`, stage: "FAILED", repository: queue.repository, issueNumber, publication: null, reason: err instanceof Error ? err.message : String(err) };
  }
  await this.release(issueNumber, summary.stage);
  const completedAt = new Date().toISOString();
  queue.scheduler = completeIssue(queue.scheduler!, summary, completedAt);
  queue.completedRuns.push(toCompletedRun(summary, completedAt));
  queue.currentIndex = queue.completedRuns.length;
  this.deps.queueStore.write(queue);
}
```

Import `findStartableIssue`, `refreshConflictStates`, `markIssueRunning`, `completeIssue`, and `toCompletedRun` from `src/scheduler/scheduler.ts`.

- [ ] **Step 7: Preserve pending queue behavior**

Current `mergePending(queue)` appends only to `queue.issues`. For scheduler queues, extend it so appended issues enter scheduler state as unknown-scope PENDING entries as a compatibility fallback. Task 8 replaces the production path with startup-equivalent normalization for new pending issues.

Inside `mergePending(queue)` after `queue.issues.push(...toAdd)`:

```typescript
if (queue.scheduler !== undefined) {
  queue.scheduler = {
    ...queue.scheduler,
    issues: [
      ...queue.scheduler.issues,
      ...toAdd.map((issueNumber) => ({
        issueNumber,
        state: "PENDING" as const,
        dependencies: [],
        workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
        reason: "pending queue entry",
        runId: null,
        outcome: null,
      })),
    ],
    lastUpdatedAt: new Date().toISOString(),
  };
}
```

Import `UNKNOWN_WORKSPACE_SCOPE`.

- [ ] **Step 8: Run daemon runner tests**

Run:

```bash
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```

Expected: PASS, including existing claim/release and pending-queue tests.

- [ ] **Step 9: Wire production daemon entry if deps changed**

If you added optional deps to `DaemonRunnerDeps`, update `src/daemon/daemon-entry.ts` construction. If you kept using `runService`, no daemon-entry code should be needed.

Run:

```bash
npx vitest run tests/unit/daemon/daemon-runner.test.ts tests/integration/daemon/daemon-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 10: Grep for queue loop assumptions**

Run:

```bash
grep -R "currentIndex\|completedRuns\|queue\.issues\|DaemonRunnerDeps" -n src tests | sed -n '1,260p'
```

Update any code that assumes `currentIndex` is the only daemon progress source. Status updates are Task 9; do not mix full status rendering into this task unless TypeScript requires it.

- [ ] **Step 11: Commit**

```bash
git add src/daemon/daemon-runner.ts src/daemon/daemon-entry.ts tests/unit/daemon/daemon-runner.test.ts tests/integration/daemon/daemon-lifecycle.test.ts
git commit -m "feat(scheduler): run scheduler queue in daemon"
```

Omit unchanged files from `git add`.

---

### Task 8: Blocked refresh, idle timeout, and pending queue normalization

**Files:**
- Modify: `src/daemon/daemon-runner.ts`
- Modify: `src/daemon/daemon-entry.ts`
- Test: `tests/unit/daemon/daemon-runner.test.ts`

**Interfaces:**
- Consumes: scheduler state and dependency snapshots.
- Produces:
  - Daemon dependency refresh hook when no work is schedulable.
  - Idle timeout behavior; default exits immediately.
  - Pending queue drain during idle waits.
  - Startup-equivalent scheduler normalization for issues added through `queue add`.

- [ ] **Step 1: Add dependency refresh deps to `DaemonRunnerDeps`**

Plan to add:

```typescript
schedulerRefresh?: {
  refreshDependencies(queue: DaemonQueue): Promise<DaemonQueue>;
};
schedulerPending?: {
  normalize(issueNumbers: number[], policy: SchedulerPolicy, now: string): Promise<InitialSchedulerIssueInput[]>;
};
now?: () => string;
sleep?: (ms: number) => Promise<void>;
```

Keep them optional so existing tests do not all need fakes. Default `now` is `new Date().toISOString()`. Default `sleep` uses `setTimeout`.

- [ ] **Step 2: Write failing blocked-refresh test**

Add to `tests/unit/daemon/daemon-runner.test.ts`:

```typescript
it("refreshes dependencies once when scheduler is blocked with no active runs", async () => {
  const deps = makeDeps({
    schedulerRefresh: {
      refreshDependencies: vi.fn(async (queue) => {
        const scheduler = queue.scheduler!;
        return {
          ...queue,
          scheduler: {
            ...scheduler,
            issues: scheduler.issues.map((issue) => issue.issueNumber === 2
              ? { ...issue, state: "PENDING", dependencies: issue.dependencies.map((dep) => ({ ...dep, satisfied: true, source: "github-closed", checkedAt: "2026-08-24T00:02:00.000Z" })), reason: "ready" }
              : issue),
            lastBlockedRefreshAt: "2026-08-24T00:02:00.000Z",
          },
        };
      }),
    },
  } as Partial<DaemonRunnerDeps>);
  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithBlockedDependency());
  (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 2, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

  await new DaemonRunner(deps).run();

  expect(deps.schedulerRefresh!.refreshDependencies).toHaveBeenCalledTimes(1);
  expect(deps.runService.start).toHaveBeenCalledWith(2, {});
});
```

Add helper:

```typescript
function queueWithBlockedDependency() {
  return {
    repository: { owner: "acme", repo: "widgets" },
    issues: [2],
    currentIndex: 0,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy: { maxConcurrentRuns: 1, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [{
        issueNumber: 2,
        dependencies: [{ issueNumber: 1, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" }],
        workspaceScope: { kind: "paths", patterns: ["src/b/**"], source: "issue-contract" },
        initialState: "DEFERRED_DEPENDENCY",
        reason: "waiting for #1",
      }],
    }),
  };
}
```

- [ ] **Step 3: Write failing idle timeout tests**

Add:

```typescript
it("exits immediately by default when scheduler remains blocked", async () => {
  const deps = makeDeps({
    schedulerRefresh: { refreshDependencies: vi.fn(async (queue) => queue) },
  } as Partial<DaemonRunnerDeps>);
  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queueWithBlockedDependency());

  await new DaemonRunner(deps).run();

  expect(deps.runService.start).not.toHaveBeenCalled();
  expect(deps.pidFile.delete).toHaveBeenCalled();
});

it("drains pending queue while idling", async () => {
  const deps = makeDeps({
    now: vi.fn()
      .mockReturnValueOnce("2026-08-24T00:00:00.000Z")
      .mockReturnValueOnce("2026-08-24T00:00:30.000Z")
      .mockReturnValue("2026-08-24T00:01:01.000Z"),
    sleep: vi.fn(async () => undefined),
    schedulerRefresh: { refreshDependencies: vi.fn(async (queue) => queue) },
  } as Partial<DaemonRunnerDeps>);
  const queue = queueWithBlockedDependency();
  queue.scheduler.policy.idleTimeoutMinutes = 1;
  (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue(queue);
  (deps.pendingQueueStore.drainAll as ReturnType<typeof vi.fn>)
    .mockReturnValueOnce([])
    .mockReturnValueOnce([99])
    .mockReturnValue([]);
  (deps.runService.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ runId: "run-99", stage: "PR_OPEN", issueNumber: 99, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

  await new DaemonRunner(deps).run();

  expect(deps.runService.start).toHaveBeenCalledWith(99, {});
});
```

- [ ] **Step 4: Run daemon tests and verify new cases fail**

Run:

```bash
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```

Expected: FAIL because blocked refresh/idle loop is absent.

- [ ] **Step 5: Implement blocked handling in scheduler loop**

In `runSchedulerQueue`, after `launchAvailable()` and when `active.size === 0`, add:

```typescript
let refreshedForBlockedState = false;

// inside loop when no active work exists and no launch happened:
if (!refreshedForBlockedState && this.deps.schedulerRefresh !== undefined) {
  queue = await this.deps.schedulerRefresh.refreshDependencies(queue);
  this.deps.queueStore.write(queue);
  refreshedForBlockedState = true;
  launchAvailable();
  if (active.size > 0) continue;
}

const idleTimeoutMinutes = queue.scheduler.policy.idleTimeoutMinutes;
if (idleTimeoutMinutes === 0) break;
await this.idleUntilPendingOrTimeout(queue, idleTimeoutMinutes);
launchAvailable();
if (active.size === 0) break;
```

Refactor method signatures if `queue` needs reassignment. Keep queue persistence after refresh.

- [ ] **Step 6: Implement `idleUntilPendingOrTimeout`**

Add private method:

```typescript
private async idleUntilPendingOrTimeout(queue: DaemonQueue, idleTimeoutMinutes: number): Promise<void> {
  const now = this.deps.now ?? (() => new Date().toISOString());
  const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const idleSince = now();
  queue.scheduler = { ...queue.scheduler!, idleSince, lastUpdatedAt: idleSince };
  this.deps.queueStore.write(queue);
  const timeoutMs = idleTimeoutMinutes * 60_000;
  for (;;) {
    await this.mergePending(queue);
    const hasPending = queue.scheduler!.issues.some((issue) => issue.state === "PENDING");
    if (hasPending) return;
    if (Date.parse(now()) - Date.parse(idleSince) >= timeoutMs) return;
    await sleep(1_000);
  }
}
```

- [ ] **Step 7: Normalize pending queue additions for scheduler queues**

Change `mergePending(queue)` to an async method so scheduler queues can normalize appended issues before writing them. Keep the unknown-scope fallback only for tests that do not inject `schedulerPending`:

```typescript
private async mergePending(queue: DaemonQueue): Promise<void> {
  const pending = this.deps.pendingQueueStore.drainAll();
  if (pending.length === 0) return;
  const existing = new Set(queue.issues);
  const toAdd = pending.filter((n) => !existing.has(n));
  if (toAdd.length === 0) return;
  queue.issues.push(...toAdd);
  if (queue.scheduler !== undefined) {
    const now = (this.deps.now ?? (() => new Date().toISOString()))();
    const normalized = this.deps.schedulerPending === undefined
      ? toAdd.map((issueNumber) => ({
          issueNumber,
          dependencies: [],
          workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
          initialState: "PENDING" as const,
          reason: "pending queue entry",
        }))
      : await this.deps.schedulerPending.normalize(toAdd, queue.scheduler.policy, now);
    queue.scheduler = {
      ...queue.scheduler,
      issues: [
        ...queue.scheduler.issues,
        ...normalized.map((issue) => ({
          issueNumber: issue.issueNumber,
          state: issue.initialState,
          dependencies: issue.dependencies,
          workspaceScope: issue.workspaceScope,
          reason: issue.reason,
          runId: null,
          outcome: null,
        })),
      ],
      lastUpdatedAt: now,
    };
  }
  this.deps.queueStore.write(queue);
  this.deps.logFile.info(`merged ${toAdd.length} pending issue(s): [${toAdd.join(",")}]`);
}
```

Update every call site from `this.mergePending(queue);` to `await this.mergePending(queue);`. Add a unit test that injects `schedulerPending.normalize`, returns a scoped normalized issue for `#99`, and asserts `queue.scheduler.issues` contains that scope after pending drain.

- [ ] **Step 8: Wire production refresh and pending normalization in `daemon-entry.ts`**

Add a simple production refresh implementation that reuses GitHub state plus `RunStore.hasSuccessfulPrOpenForIssue`:

```typescript
schedulerRefresh: {
  refreshDependencies: async (queue) => refreshSchedulerDependencies({ queue, github, runStore, now: () => new Date().toISOString() }),
},
schedulerPending: {
  normalize: async (issueNumbers, policy, now) => buildSchedulerIssueInputs({
    root: repository.root,
    repository: repository.repository,
    issueNumbers,
    now,
    github,
    runStore,
  }),
},
```

Extract the scheduler-state input normalization from `start.ts` into an exported helper, preferably `buildSchedulerIssueInputs()` in `src/scheduler/dependencies.ts` or a new `src/scheduler/normalize.ts`, so `start` and `daemon-entry` do not duplicate dependency/scope/cycle logic. Its signature should be:

```typescript
export async function buildSchedulerIssueInputs(input: {
  root?: string;
  repository: RepositoryRef;
  issueNumbers: number[];
  now: string;
  github: Pick<GitHubPort, "getIssue">;
  runStore: Pick<RunStore, "hasSuccessfulPrOpenForIssue">;
}): Promise<InitialSchedulerIssueInput[]>;
```

`buildSchedulerIssueInputs()` must fetch each issue, parse workspace scope from the issue body, build dependency snapshots, detect cycles among the normalized issue set, and return the same `InitialSchedulerIssueInput[]` shape used by `createInitialSchedulerState()`.

Create `refreshSchedulerDependencies` in `src/scheduler/dependencies.ts` so production and tests share one refresh path. Add these imports at the top of that file:

```typescript
import type { DaemonQueue } from "../daemon/queue-store.js";
import type { GitHubPort } from "../github/github-adapter.js";
import type { RunStore } from "../persistence/run-store.js";
```

Then add:

```typescript
export async function refreshSchedulerDependencies(input: {
  queue: DaemonQueue;
  github: Pick<GitHubPort, "getIssue">;
  runStore: Pick<RunStore, "hasSuccessfulPrOpenForIssue">;
  now: () => string;
}): Promise<DaemonQueue> {
  if (input.queue.scheduler === undefined) return input.queue;
  const repository = input.queue.repository;
  const refreshedIssues = [];
  for (const issue of input.queue.scheduler.issues) {
    if (issue.state !== "DEFERRED_DEPENDENCY") {
      refreshedIssues.push(issue);
      continue;
    }
    const dependencies = [];
    for (const dependency of issue.dependencies) {
      const checkedAt = input.now();
      try {
        const dependencyIssue = await input.github.getIssue(dependency.issueNumber);
        if (dependencyIssue.state === "closed") {
          dependencies.push({ ...dependency, satisfied: true, source: "github-closed" as const, checkedAt });
        } else if (input.runStore.hasSuccessfulPrOpenForIssue(repository.owner, repository.repo, dependency.issueNumber)) {
          dependencies.push({ ...dependency, satisfied: true, source: "local-pr-open" as const, checkedAt });
        } else {
          dependencies.push({ ...dependency, satisfied: false, source: "unsatisfied" as const, checkedAt });
        }
      } catch (error) {
        dependencies.push({ ...dependency, satisfied: false, source: "unsatisfied" as const, checkedAt });
      }
    }
    const unblocked = dependencies.every((dependency) => dependency.satisfied);
    refreshedIssues.push({
      ...issue,
      dependencies,
      state: unblocked ? "PENDING" as const : "DEFERRED_DEPENDENCY" as const,
      reason: unblocked ? "ready" : "waiting for dependencies",
    });
  }
  const refreshedAt = input.now();
  return {
    ...input.queue,
    scheduler: {
      ...input.queue.scheduler,
      issues: refreshedIssues,
      lastBlockedRefreshAt: refreshedAt,
      lastUpdatedAt: refreshedAt,
    },
  };
}
```

Add a unit test in `tests/unit/scheduler/dependencies.test.ts` that passes a queue with one `DEFERRED_DEPENDENCY` issue, fakes `github.getIssue()` returning `{ state: "closed" }` for its dependency, and asserts the issue becomes `PENDING`.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
npx vitest run tests/unit/daemon/daemon-runner.test.ts tests/unit/scheduler/dependencies.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/daemon-runner.ts src/daemon/daemon-entry.ts src/scheduler/dependencies.ts tests/unit/daemon/daemon-runner.test.ts tests/unit/scheduler/dependencies.test.ts
git commit -m "feat(scheduler): refresh blocked dependencies and idle safely"
```

Omit unchanged files from `git add`.

---

### Task 9: Scheduler-aware status output

**Files:**
- Modify: `src/commands/status.ts`
- Modify: `src/ui/reporter.ts`
- Test: `tests/unit/commands/status-daemon.test.ts`
- Test: `tests/unit/ui/reporter.test.ts`

**Interfaces:**
- Consumes: `queue.scheduler` and existing daemon status fields.
- Produces:
  - Human status with compact summary plus per-issue table.
  - `status --json` daemon mode that includes full scheduler object.

- [ ] **Step 1: Write failing daemon JSON status test**

Add to `tests/unit/commands/status-daemon.test.ts`:

```typescript
it("includes scheduler state in daemon --json output", async () => {
  const dataDir = makeDataDir();
  writePid(dataDir, process.pid);
  writeQueue(dataDir, queueWithSchedulerIssues({
    maxConcurrentRuns: 2,
    issues: [{ issueNumber: 1, scope: "src/a/**" }, { issueNumber: 2, scope: "src/b/**" }],
  }));
  const lines: string[] = [];
  const program = makeProgram({ dataDir, stdout: (line) => lines.push(line) });

  await program.parseAsync(["status", "--json"], { from: "user" });

  const parsed = JSON.parse(lines.join(""));
  expect(parsed.daemon.scheduler.policy.maxConcurrentRuns).toBe(2);
  expect(parsed.daemon.scheduler.issues).toHaveLength(2);
});
```

Use existing helper names in that file. If there is no `writeQueue`, add one consistent with existing tests.

- [ ] **Step 2: Write failing human status/reporter test**

Add to `tests/unit/ui/reporter.test.ts` or status daemon test:

```typescript
it("formats scheduler daemon status with summary and issue table", () => {
  const output = formatDaemonStatus({
    pid: 123,
    uptimeMs: 60_000,
    currentIssue: null,
    currentStage: null,
    currentStartedAt: null,
    remainingIssues: [],
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: 120, maxStartedRuns: 10, maxFailedRuns: 3 } },
      startedAt: "2026-08-24T00:00:00.000Z",
      issues: [
        { issueNumber: 1, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/a/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" },
      ],
    }),
  });

  expect(output).toContain("scheduler 0/2 active");
  expect(output).toContain("Issue");
  expect(output).toContain("#1");
  expect(output).toContain("PENDING");
});
```

- [ ] **Step 3: Run status tests and verify they fail**

Run:

```bash
npx vitest run tests/unit/commands/status-daemon.test.ts tests/unit/ui/reporter.test.ts
```

Expected: FAIL because status does not include scheduler state.

- [ ] **Step 4: Extend `formatDaemonStatus` input type**

In `src/ui/reporter.ts`, add optional scheduler field to the daemon formatter input:

```typescript
scheduler?: SchedulerState;
```

When absent, preserve current output exactly enough for existing tests. When present, render:

```typescript
lines.push(`Daemon      running  PID ${pid}  scheduler ${scheduler.activeRuns.length}/${scheduler.policy.maxConcurrentRuns} active`);
lines.push(`Budget      started ${scheduler.budgets.startedRuns}/${formatCap(scheduler.policy.budgets.maxStartedRuns)}  failed ${scheduler.budgets.failedRuns}/${formatCap(scheduler.policy.budgets.maxFailedRuns)}  elapsed ${scheduler.budgets.elapsedMinutes}m/${formatCap(scheduler.policy.budgets.maxElapsedMinutes, "m")}`);
lines.push("");
lines.push("Issue  State                 Reason");
for (const issue of scheduler.issues) {
  lines.push(`#${issue.issueNumber}    ${issue.state.padEnd(20)}  ${issue.reason ?? issue.outcome ?? ""}`);
}
```

Add helper:

```typescript
function formatCap(value: number | null, suffix = ""): string {
  return value === null ? "∞" : `${value}${suffix}`;
}
```

- [ ] **Step 5: Add daemon JSON mode in `status`**

Currently no-run-id daemon mode ignores `opts.json`. In `src/commands/status.ts`, when no run id and daemon queue exists:

```typescript
if (opts.json === true) {
  stdout(JSON.stringify({
    daemon: {
      pid,
      uptimeMs,
      queue,
      scheduler: queue.scheduler ?? null,
      currentIssue,
      currentStage,
      remainingIssues,
      completedRuns: queue.completedRuns,
    },
  }, null, 2));
  return;
}
```

For human mode, pass `scheduler: queue.scheduler` into `formatDaemonStatus`.

- [ ] **Step 6: Run status tests**

Run:

```bash
npx vitest run tests/unit/commands/status-daemon.test.ts tests/unit/ui/reporter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Grep status/reporter callers**

Run:

```bash
grep -R "formatDaemonStatus" -n src tests | sed -n '1,120p'
grep -R "status.*--json\|daemon.*scheduler" -n tests src | sed -n '1,160p'
```

Update all call sites that construct the formatter input directly.

- [ ] **Step 8: Commit**

```bash
git add src/commands/status.ts src/ui/reporter.ts tests/unit/commands/status-daemon.test.ts tests/unit/ui/reporter.test.ts
git commit -m "feat(scheduler): show scheduler state in status"
```

---

### Task 10: Integration/regression coverage and milestone docs

**Files:**
- Modify: `tests/integration/daemon/daemon-lifecycle.test.ts`
- Modify: `docs/MILESTONES.md`
- Optional modify: fake daemon helper under `tests/integration/daemon/` if needed.

**Interfaces:**
- Consumes: all M4 scheduler behavior from prior tasks.
- Produces: acceptance-level verification that default scheduling is backward-compatible and concurrent scheduling works with fake daemon runs.

- [ ] **Step 1: Add default sequential regression integration test**

In `tests/integration/daemon/daemon-lifecycle.test.ts`, add a test that writes a queue with scheduler policy `maxConcurrentRuns: 1` and verifies fake daemon completes in issue order:

```typescript
it("preserves sequential behavior with scheduler maxConcurrentRuns 1", async () => {
  writeSchedulerQueue(dataDir, [28, 29], { maxConcurrentRuns: 1 });
  const { wait } = spawnFakeDaemon(dataDir, { fakeDelayMs: 50 });

  const exitCode = await wait();

  expect(exitCode).toBe(0);
  const queue = JSON.parse(readFileSync(path.join(dataDir, "daemon", "queue.json"), "utf8"));
  expect(queue.completedRuns.map((run: { issueNumber: number }) => run.issueNumber)).toEqual([28, 29]);
  expect(queue.scheduler.issues.map((issue: { state: string }) => issue.state)).toEqual(["COMPLETED", "COMPLETED"]);
});
```

Add helper in the same file:

```typescript
function writeSchedulerQueue(dataDir: string, issues: number[], policyOverrides: { maxConcurrentRuns: number }): void {
  const daemonDir = path.join(dataDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const policy = {
    maxConcurrentRuns: policyOverrides.maxConcurrentRuns,
    idleTimeoutMinutes: 0,
    budgets: { maxElapsedMinutes: null, maxStartedRuns: null, maxFailedRuns: null },
  };
  writeFileSync(path.join(daemonDir, "queue.json"), JSON.stringify({
    repository: { owner: "acme", repo: "widgets" },
    issues,
    currentIndex: 0,
    startedAt,
    completedRuns: [],
    scheduler: createInitialSchedulerState({
      policy,
      startedAt,
      issues: issues.map((issueNumber) => ({
        issueNumber,
        dependencies: [],
        workspaceScope: { kind: "paths", patterns: [`src/${issueNumber}/**`], source: "issue-contract" },
        initialState: "PENDING",
        reason: "ready",
      })),
    }),
  }, null, 2));
}
```

Import `createInitialSchedulerState`.

- [ ] **Step 2: Add concurrent smoke integration test if fake daemon supports overlapping runs**

If `fake-daemon-entry.mjs` delegates to the real `DaemonRunner` with fake async run service, add:

```typescript
it("runs disjoint scheduler issues concurrently when maxConcurrentRuns is 2", async () => {
  writeSchedulerQueue(dataDir, [28, 29], { maxConcurrentRuns: 2 });
  const startedAt = Date.now();
  const { wait } = spawnFakeDaemon(dataDir, { fakeDelayMs: 250 });

  const exitCode = await wait();
  const elapsedMs = Date.now() - startedAt;

  expect(exitCode).toBe(0);
  expect(elapsedMs).toBeLessThan(450);
});
```

If the fake daemon is process-level and timing is flaky in CI, do not keep this integration test. Instead, rely on Task 7 unit tests for concurrency and keep only the sequential integration regression.

- [ ] **Step 3: Run integration daemon test**

Run:

```bash
npx vitest run tests/integration/daemon/daemon-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 4: Update milestone docs after implementation is verified locally**

In `docs/MILESTONES.md`, under `### Concurrency and scheduling (M4) 🔲`, move or replace the shipped bullets with this completed entry:

```markdown
## 2026-08-24 — M4 dependency-aware scheduler ✅

**Scope:** Bounded-concurrency daemon scheduling over explicit issue inputs or analyze/discover reports.

- `scheduler.maxConcurrentRuns` plus `start --max-concurrent` control daemon concurrency; default remains `1`.
- Scheduler state is persisted in `queue.json` while preserving M3 queue fields.
- Dependencies are satisfied by GitHub-closed issues or local `PR_OPEN` history.
- Path/glob workspace scopes prevent concurrent conflicting runs; unknown scope conflicts with everything.
- Cross-queue elapsed/started/failed budgets stop new starts at scheduling boundaries without interrupting active runs.
- `status` shows scheduler summary and per-issue state in human and JSON modes.

Design spec: `docs/superpowers/specs/2026-08-24-m4-dependency-aware-scheduler-design.md`
Implementation plan: `docs/superpowers/plans/2026-08-24-m4-dependency-aware-scheduler.md`
```

Remove or rewrite the corresponding backlog bullets so the file does not list shipped work as missing. Leave unrelated M5 and reconciliation follow-ups untouched.

- [ ] **Step 5: Run targeted docs/status tests**

Run:

```bash
npx vitest run tests/integration/daemon/daemon-lifecycle.test.ts tests/unit/commands/status-daemon.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/daemon/daemon-lifecycle.test.ts docs/MILESTONES.md
git commit -m "test(scheduler): cover scheduler daemon integration"
```

---

### Final verification after all tasks

- [ ] **Step 1: Run the full check script**

Run:

```bash
npm run check
```

Expected: `typecheck`, `vitest run`, and `tsc -p tsconfig.json` all exit 0.

- [ ] **Step 2: Inspect git status**

Run:

```bash
git status --short
```

Expected: clean working tree after all task commits, or only intentionally uncommitted notes/plans.

- [ ] **Step 3: Review acceptance criteria against the spec**

Check each item in `docs/superpowers/specs/2026-08-24-m4-dependency-aware-scheduler-design.md#17-acceptance-criteria` and map it to tests/tasks:

1. Default sequential behavior → Task 7 and Task 10 tests.
2. `--max-concurrent 2` disjoint concurrency → Task 7 tests and optional Task 10 smoke.
3. Unsatisfied dependencies do not start → Task 6 and Task 7 tests.
4. Local `PR_OPEN` unblocks dependents → Task 6 tests.
5. Overlapping/unknown scopes do not run together → Task 3 and Task 7 tests.
6. Invalid/cyclic metadata blocks only affected issues → Task 4 tests.
7. Budgets stop new starts only → Task 6 and Task 7 tests.
8. Blocked refresh and idle behavior → Task 8 tests.
9. `queue add` does not jump ahead → existing pending queue tests plus Task 8 idle test.
10. `status` explains scheduler state → Task 9 tests.

- [ ] **Step 4: Only after fresh verification, report completion with evidence**

Use the exact output from `npm run check` and `git status --short`; do not claim completion from memory or from an earlier run.
