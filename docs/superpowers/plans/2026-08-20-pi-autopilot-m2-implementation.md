# Pi Autopilot M2 — Backlog Analyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `autopilot analyze` — a read-only backlog analyst that resolves an epic (or an explicit issue set) to real GitHub issues, runs a cheap deterministic heuristic screen over each, launches a refiner session only for candidate issues (or all under `--deep`), applies the M1 deterministic readiness gate, and produces a durable, inspectable `BacklogReport` that identifies executable work.

**Architecture:** New `src/analysis/` module composes existing M1 pieces (GitHub port, `ReadinessService`, `ArtifactStore`, refiner model resolution) rather than introducing new contracts or agent roles. A new `heuristic-screen.ts` is a pure, testable function. A new `analyze` command mirrors `check`/`prepare` wiring. A small refactor extracts the shared issue-ref/model/timeout helpers that `check.ts` and `prepare.ts` currently duplicate so `analyze` does not copy a third time.

**Tech Stack:** TypeScript, Node.js, commander, zod, Octokit (`@octokit/rest`), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-pi-autopilot-m2-design.md`

## Global Constraints

- M2 is **read-only against GitHub**: `analyze` must never call `updateIssueBody`, `createIssueComment`, `createPullRequest`, or create a workspace. Tests assert zero mutation calls.
- Deterministic readiness gate is authoritative: refiner/screen outcomes never override `computeReadinessGaps`.
- Analysis is sequential (single pass over a set); no concurrency.
- Reuse M1 contracts (`ReadinessService`, `computeReadinessGaps`, `TaskSnapshotSchema`, `ArtifactStore`, `GitHubPort`, `fake-pi`); do not add new agent roles.
- Keep the full M1 suite green; pass `npm run typecheck`, `npm run build`, and `npm test`.
- Exit codes: `0` executable work exists AND there is no needs-refinement (BLOCKED/AMBIGUOUS/SKIPPED are normal triage outcomes, not errors); `2` zero executable work, any needs-refinement, or `--min-ready` unsatisfied; `1` argument/infrastructure error.
- Working branch: `feature/pi-autopilot-m2` (checked out; the design spec is already committed here).
- `package.json.bak-untracked`, `package-lock.json.bak-untracked`, and `requirements.md` in the repo root are untracked scratch/backup files — never add or modify them.

---

### Task 1: Extract shared command argument helpers

**Files:**
- Create: `src/commands/args.ts`
- Modify: `src/commands/check.ts` (remove local `resolveIssueRef`/`resolveRefinerModel`/`resolveRefinerTimeout`; import from `args.ts`)
- Modify: `src/commands/prepare.ts` (same removal/import)
- Test: `tests/integration/commands/check.test.ts` (unchanged — proves the refactor is behavior-neutral) and `tests/unit/commands/args.test.ts` (new)

**Interfaces:**
- Consumes: `RepositoryContext` from `src/github/repository-context.js`; `AutopilotConfig`, `RoleModelOverride`, `ThinkingLevelSchema` from `src/config/schema.js`; `resolveRoleModel`, `ResolvedRoleModel`, `DEFAULT_PI_MODEL`, `RoleModelEntry` from `src/config/load-config.js`.
- Produces (later tasks rely on these exact names/signatures):
  - `resolveIssueRef(issueRef: string, ctx: RepositoryContext): { number: number }` — throws on invalid ref or origin mismatch.
  - `resolveIssueRefs(refs: string[], ctx: RepositoryContext): number[]` — resolves each entry, de-dupes, preserves order. (New; used by `analyze`.)
  - `resolveRefinerModel(opts, config, piDefault): ResolvedRoleModel` where `opts` is `{ model?: string; thinking?: string }`.
  - `resolveRefinerTimeout(timeoutMinutes: number | undefined, config: AutopilotConfig): number` — returns milliseconds; `timeoutMinutes` `undefined` → `config.budgets.refiner.timeoutMinutes`.

**Behavior note:** These three helpers are copied verbatim today in both `check.ts` and `prepare.ts`. Extract each to `args.ts` and update **both** callers to import them. `resolveIssueRefs` is new and throws `Error` if any ref is invalid, reusing `resolveIssueRef` per entry.

- [ ] **Step 1: Write the failing unit tests for `args.ts`**

Create `tests/unit/commands/args.test.ts` (new file; this is a pure-logic file with no I/O, so a unit test is appropriate). Mirror the origin-matching and model-precedence assertions already covered in `check.test.ts` and add the new list resolver:

```ts
import { describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import { DEFAULT_PI_MODEL } from "../../../src/config/load-config.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import {
  resolveIssueRef,
  resolveIssueRefs,
  resolveRefinerModel,
  resolveRefinerTimeout,
} from "../../../src/commands/args.js";

const ctx: RepositoryContext = {
  root: "/tmp/repo",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config = {
  versions: [],
  schemaVersion: 1,
  workspace: { baseBranch: "main", branchPrefix: "autopilot/", requireCleanCheckout: true, retainBlockedWorktree: true },
  commands: { setup: [], verify: ["npm test"] },
  agents: {},
  agentPolicy: { allowedCommands: [], protectedPaths: [], allowNetwork: false },
  budgets: { refiner: { timeoutMinutes: 5 }, implementation: { timeoutMinutes: 60, maxAttempts: 3 }, review: { timeoutMinutes: 20, maxCorrectionCycles: 2 } },
  publication: { draftPr: false, issueComment: "concise", autoMerge: false },
} as AutopilotConfig;

describe("resolveIssueRef", () => {
  it("accepts a bare issue number", () => {
    expect(resolveIssueRef("42", ctx)).toEqual({ number: 42 });
  });
  it("accepts a qualified ref matching the origin", () => {
    expect(resolveIssueRef("acme/widgets#42", ctx)).toEqual({ number: 42 });
  });
  it("rejects a qualified ref that does not match the origin", () => {
    expect(() => resolveIssueRef("other/repo#42", ctx)).toThrow(/origin/);
  });
  it("rejects a malformed ref", () => {
    expect(() => resolveIssueRef("not-a-ref", ctx)).toThrow(/invalid issue reference/);
  });
});

describe("resolveIssueRefs", () => {
  it("resolves a list, de-duping and preserving order", () => {
    expect(resolveIssueRefs(["28", "29", "28", "acme/widgets#29"], ctx)).toEqual([28, 29]);
  });
  it("rejects a malformed entry", () => {
    expect(() => resolveIssueRefs(["28", "bogus"], ctx)).toThrow(/invalid issue reference/);
  });
});

describe("resolveRefinerModel", () => {
  it("applies CLI overrides with source 'cli'", () => {
    const resolved = resolveRefinerModel({ model: "openai/gpt-5.2", thinking: "high" }, config, undefined);
    expect(resolved).toEqual({
      model: "openai/gpt-5.2",
      thinking: "high",
      source: "cli",
    });
  });
  it("falls back to the Pi default when no override is given", () => {
    const resolved = resolveRefinerModel({}, config, DEFAULT_PI_MODEL);
    expect(resolved.model).toBe(DEFAULT_PI_MODEL.model);
  });
  it("rejects an invalid thinking level", () => {
    expect(() => resolveRefinerModel({ thinking: "turbo" }, config, undefined)).toThrow(/thinking/);
  });
});

describe("resolveRefinerTimeout", () => {
  it("uses the explicit timeout when provided", () => {
    expect(resolveRefinerTimeout(12, config)).toBe(12 * 60_000);
  });
  it("falls back to the policy value when the override is undefined", () => {
    expect(resolveRefinerTimeout(undefined, config)).toBe(5 * 60_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/commands/args.test.ts`
Expected: FAIL — module `src/commands/args.js` not found.

- [ ] **Step 3: Create `src/commands/args.ts` and rewire `check.ts`/`prepare.ts`**

Create `src/commands/args.ts` with the four exported functions. Copy the implementations verbatim from `check.ts`/`prepare.ts` (the current duplicate code), and add the list resolver:

```ts
import type {
  AutopilotConfig,
  RoleModelEntry,
  RoleModelOverride,
} from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import {
  DEFAULT_PI_MODEL,
  resolveRoleModel,
} from "../config/load-config.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { assertRepositoryMatches } from "../github/repository-context.js";

/** Resolve a single issue reference to its number. */
export function resolveIssueRef(
  issueRef: string,
  ctx: RepositoryContext,
): { number: number } {
  const trimmed = issueRef.trim();
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare !== null) {
    return { number: Number(bare[1]) };
  }
  const qualified = /^([^/]+)\/([^/]+)#(\d+)$/.exec(trimmed);
  if (qualified !== null) {
    assertRepositoryMatches(ctx, {
      owner: qualified[1] ?? "",
      repo: qualified[2] ?? "",
    });
    return { number: Number(qualified[3]) };
  }
  throw new Error(
    `invalid issue reference '${issueRef}' (expected <number> or <owner>/<repo>#<number>)`,
  );
}

/** Resolve many refs, de-duping and preserving first-seen order. */
export function resolveIssueRefs(
  refs: string[],
  ctx: RepositoryContext,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ref of refs) {
    const { number } = resolveIssueRef(ref, ctx);
    if (!seen.has(number)) {
      seen.add(number);
      out.push(number);
    }
  }
  return out;
}

/** Resolve the refiner role model with CLI-override precedence. */
export function resolveRefinerModel(
  opts: { model?: string; thinking?: string },
  config: AutopilotConfig,
  piDefault: RoleModelEntry | undefined,
): ResolvedRoleModel {
  const override: RoleModelOverride = {};
  if (opts.model !== undefined) {
    override.model = opts.model;
  }
  if (opts.thinking !== undefined) {
    const parsed = ThinkingLevelSchema.safeParse(opts.thinking);
    if (!parsed.success) {
      throw new Error(
        `invalid thinking level '${opts.thinking}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
      );
    }
    override.thinking = parsed.data;
  }
  return resolveRoleModel(
    "refiner",
    override.model !== undefined || override.thinking !== undefined
      ? override
      : null,
    config.agents,
    null,
    piDefault ?? DEFAULT_PI_MODEL,
  );
}

/**
 * Resolve the refiner session timeout in milliseconds. Precedence:
 * explicit flag, then the repository policy's
 * `budgets.refiner.timeoutMinutes`, then the built-in default.
 */
export function resolveRefinerTimeout(
  timeoutMinutes: number | undefined,
  config: AutopilotConfig,
): number {
  const minutes = timeoutMinutes ?? config.budgets.refiner.timeoutMinutes;
  return minutes * 60_000;
}
```

Then edit `check.ts`:
- Remove the local `function resolveIssueRef(...)`, `function resolveRefinerModel(...)`, and `function resolveRefinerTimeout(...)`.
- Add `import { resolveIssueRef, resolveRefinerModel, resolveRefinerTimeout } from "./args.js";`
- Update the call sites: `resolveRefinerTimeout(opts.refinerTimeout, config)` (replaces `resolveRefinerTimeout(opts, config)`) and `resolveRefinerModel({ model: opts.model, thinking: opts.thinking }, config, deps.piDefaultModel)`.
- After removal, these imports become **unused** and must be removed from `check.ts`: `DEFAULT_PI_MODEL` and `resolveRoleModel` (from `load-config.js`), `RoleModelOverride` (from `schema.js` — but KEEP `AutopilotConfig` and `RoleModelEntry` from that same import), `ThinkingLevelSchema` (from `schema.js`), and `assertRepositoryMatches` (from `repository-context.js` — keep `resolveRepositoryContext`). Keep `ResolvedRoleModel` (still used by the `createReadiness` deps type).

Edit `prepare.ts` similarly: remove the local copies of `resolveIssueRef`, `resolveRefinerModel`, `resolveRefinerTimeout`; add the `./args.js` import; update the two call sites (`resolveRefinerTimeout(opts.refinerTimeout, config)`, `resolveRefinerModel({ model: opts.model, thinking: opts.thinking }, config, deps.piDefaultModel)`). After removal these imports become **unused** and must be removed from `prepare.ts`: `ResolvedRoleModel`, `DEFAULT_PI_MODEL`, `resolveRoleModel` (from `load-config.js`), `RoleModelEntry` and `RoleModelOverride` (from `schema.js` — KEEP `AutopilotConfig`), `ThinkingLevelSchema` (from `schema.js`), and `assertRepositoryMatches` (from `repository-context.js` — keep `resolveRepositoryContext`). `Command`, `GitHubPort`, `GitHubAdapter`, `RepositoryContext`, `ArtifactStore`, `PiRunner`, `appPaths`, `AppPaths`, `ProcessRunner`/`ProcessRunnerImpl`, `ReadinessReport`, `ReadinessService`, `sha256`, the `refinement-section` imports, and `CheckCommandDeps` remain needed by `prepare.ts` — do not touch them.

Note: `tsconfig.json` does not set `noUnusedLocals`, so leaving an unused import would NOT fail `npm run typecheck`. Still remove the imports listed above — the repo keeps imports tidy and the build stays warning-free.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run tests/unit/commands/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing command tests to confirm the refactor is behavior-neutral**

Run: `npx vitest run tests/integration/commands/check.test.ts tests/integration/commands/prepare.test.ts`
Expected: All PASS (these exercise the exact same behavior through the extracted helpers).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with no unused-import errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/args.ts src/commands/check.ts src/commands/prepare.ts tests/unit/commands/args.test.ts
git commit -m "refactor: extract shared issue-ref/model/timeout helpers for analyze"
```

---

### Task 2: Define the backlog report domain types

**Files:**
- Create: `src/domain/backlog.ts`
- Test: `tests/unit/domain/backlog.test.ts`

**Interfaces:**
- Consumes: `RepositoryRef` from `src/domain/contracts.js`; `ReadinessReport` type from `src/readiness/readiness-service.js` (used structurally in the report; do not import it into the schema — keep the schema self-contained with plain fields).
- Produces (later tasks rely on):
  - `BacklogClassification = "READY" | "NEEDS_REFINEMENT" | "BLOCKED" | "AMBIGUOUS" | "SKIPPED"`
  - `ScreenDecision` (the deterministic screen output) and `HeuristicScreenResult` types (see Task 3 for the shape).
  - `BacklogReport` interface + `BacklogReportSchema` (zod) + `parseBacklogReport(input): BacklogReport` that throws on invalid shape. Shape below.

```ts
// src/domain/backlog.ts
import { z } from "zod";
import type { RepositoryRef } from "./contracts.js";

export type ScreenClassification =
  | "READY"
  | "NEEDS_REFINEMENT"
  | "BLOCKED"
  | "AMBIGUOUS"
  | "CANDIDATE"
  | "SKIPPED";

export type BacklogClassification =
  | "READY"
  | "NEEDS_REFINEMENT"
  | "BLOCKED"
  | "AMBIGUOUS"
  | "SKIPPED";

export const BacklogReportSchema = z.object({
  repository: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  epicRef: z.number().int().positive().nullable(),
  requestedRefs: z.array(z.number().int().positive()),
  generatedAt: z.string().min(1),
  analysisId: z.string().min(1),
  scope: z.object({
    totalIssues: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  issues: z.array(
    z.object({
      issueNumber: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      classification: z.enum([
        "READY",
        "NEEDS_REFINEMENT",
        "BLOCKED",
        "AMBIGUOUS",
        "SKIPPED",
      ]),
      screen: z.object({
        classification: z.enum([
          "READY",
          "NEEDS_REFINEMENT",
          "BLOCKED",
          "AMBIGUOUS",
          "CANDIDATE",
          "SKIPPED",
        ]),
        reasons: z.array(z.string()),
      }),
      readiness: z
        .object({
          analysisId: z.string().min(1),
          status: z.enum(["READY", "NEEDS_REFINEMENT"]),
        })
        .nullable(),
    }),
  ),
  executable: z.array(z.number().int().positive()),
  needsWork: z.array(z.number().int().positive()),
  summary: z.object({
    ready: z.number().int().nonnegative(),
    needsRefinement: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  refinerSessions: z.number().int().nonnegative(),
});
export type BacklogReport = z.infer<typeof BacklogReportSchema>;

export function parseBacklogReport(input: unknown): BacklogReport {
  return BacklogReportSchema.parse(input);
}
```

Also export the `ScreenDecision` and `HeuristicScreenResult` types from `src/domain/backlog.ts`:

```ts
export interface ScreenDecision {
  classification: ScreenClassification;
  reasons: string[];
}

export interface HeuristicScreenResult extends ScreenDecision {}
```

(These are intentionally minimal; Task 3 consumes `ScreenDecision`.)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/domain/backlog.test.ts`. Test that `parseBacklogReport` accepts a fully populated valid report and rejects malformed input (missing `summary`, wrong classification enum, negative counts), and that valid `BacklogReport` instances round-trip through JSON. Provide one `validReport()` factory used across the analysis tests:

```ts
import { describe, expect, it } from "vitest";
import { parseBacklogReport } from "../../../src/domain/backlog.js";

function validReport() {
  return {
    repository: { owner: "acme", repo: "widgets" },
    epicRef: 28,
    requestedRefs: [28, 101, 102],
    generatedAt: "2026-08-20T00:00:00.000Z",
    analysisId: "analyze-test-1",
    scope: { totalIssues: 3, analyzed: 2, unresolved: 1 },
    issues: [
      {
        issueNumber: 101,
        title: "Add token refresh",
        url: "https://github.com/acme/widgets/issues/101",
        classification: "READY",
        screen: { classification: "READY", reasons: ["has execution contract"] },
        readiness: null,
      },
      {
        issueNumber: 102,
        title: "OAuth callback",
        url: "https://github.com/acme/widgets/issues/102",
        classification: "NEEDS_REFINEMENT",
        screen: { classification: "NEEDS_REFINEMENT", reasons: ["missing acceptance criteria"] },
        readiness: null,
      },
    ],
    executable: [101],
    needsWork: [102],
    summary: { ready: 1, needsRefinement: 1, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 1 },
    refinerSessions: 0,
  };
}

describe("parseBacklogReport", () => {
  it("accepts a valid report", () => {
    expect(parseBacklogReport(validReport()).summary.ready).toBe(1);
  });
  it("round-trips through JSON", () => {
    const parsed = parseBacklogReport(JSON.parse(JSON.stringify(validReport())));
    expect(parsed.executable).toEqual([101]);
  });
  it("rejects an unknown classification", () => {
    const bad = validReport();
    bad.issues[0].classification = "BOGUS";
    expect(() => parseBacklogReport(bad)).toThrow();
  });
  it("rejects a negative count", () => {
    const bad = validReport();
    bad.scope.totalIssues = -1;
    expect(() => parseBacklogReport(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/domain/backlog.test.ts`
Expected: FAIL — module `src/domain/backlog.js` not found.

- [ ] **Step 3: Create `src/domain/backlog.ts`** as specified in **Interfaces**.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/domain/backlog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/backlog.ts tests/unit/domain/backlog.test.ts
git commit -m "feat(domain): add M2 backlog report types"
```

---

### Task 3: Deterministic heuristic screen

**Files:**
- Create: `src/analysis/heuristic-screen.ts`
- Test: `tests/unit/analysis/heuristic-screen.test.ts`

**Interfaces:**
- Consumes: `GitHubIssue` from `src/github/github-adapter.js`; `ScreenDecision`, screen constants from `src/domain/backlog.js`.
- Produces (the analyst relies on): `screenIssue(input: ScreenInput): ScreenDecision`, plus exported refs to the marker constants so tests and the analyst can reuse them.

```ts
// src/analysis/heuristic-screen.ts
import type { GitHubIssue } from "../github/github-adapter.js";
import type { ScreenDecision } from "../domain/backlog.js";

export const REFINEMENT_START = "<!-- autopilot-refinement:start -->";
export const REFINEMENT_END = "<!-- autopilot-refinement:end -->";

/** A referenced issue whose satisfaction the screen checks (resolved by the analyst). */
export interface ScreenDependency {
  issue: number;
  satisfied: boolean;
}

/** Pure screen input. The analyst resolves dependency states before calling. */
export interface ScreenInput {
  issue: GitHubIssue;
  dependencies: ScreenDependency[];
}

/**
 * Deterministic heuristic classification of one issue body as a
 * fast, no-Pi pre-filter. The result is advisory for the analyst's refiner
 * banding; the deterministic readiness gate remains authoritative for any
 * issue a refiner actually creates a contract for.
 */
export function screenIssue(input: ScreenInput): ScreenDecision { ... }
```

**Deterministic rules** (evaluated in order; first match wins):

1. **`SKIPPED`** — should not normally reach the screen (unresolvable entries are filtered before this), but guard: if `input.issue` is empty-bodied and has no title, return `SKIPPED`.
2. **`BLOCKED`** — if any `ScreenDependency` is `satisfied === false` AND the body contains an explicit dependency marker, specifically either:
   - the managed refinement section's `### Dependencies` item rendered as `- #<n> (unsatisfied)` (see `refinement-section.ts` rendering), OR
   - a line matching `(?:depends? on|dependency:)\s*#?\s*(\d+)` at line start.
   Requires that the referenced number appears in `dependencies` with `satisfied === false`. Reason: `blocked by unsatisfied dependency #<n>`.
3. **`AMBIGUOUS`** — if the body contains an unresolved-decision phrase (case-insensitive): `"which behavior"`, `"either ... or"`, `"not sure whether"`, `"choose one"`, `"tbd:"`, `"open question"`. Reason: `product ambiguity signal detected`.
4. **`READY`** — if the body contains BOTH `REFINEMENT_START` and `REFINEMENT_END` markers. Reason: `has managed execution contract`.
5. **`CANDIDATE`** — if the body has some specification signal but no full contract: it contains at least one `- [ ]` acceptance-criteria marker AND at least one objective-ish statement (a non-empty line under a heading matching `/(?:#+\s*)?(?:goal|objective|summary)/i` OR the body has > 0 words in the first 200 chars and contains `##`). Reason: `partially specified — candidate for refiner`.
6. **`NEEDS_REFINEMENT`** — otherwise. Reason: `lacks objective and acceptance criteria`.

The ordering matters and is testable: a body that is both AMBIGUOUS and BLOCKED → BLOCKED; a body with a full contract AND an ambiguity phrase → READY wins only if the ambiguity check doesn't fire — but rule order makes AMBIGUOUS (3) beat READY (4). **Edge decision:** a managed contract is trusted at the screen level (READY) and only a refiner under `--deep` re-runs the gate on it. This matches "screen READY only when a valid execution contract is already present."

Case-insensitivity: apply `.toLowerCase()` on a copy of the body for phrase matching.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/analysis/heuristic-screen.test.ts`. Cover every classification branch with a distinct fixture body. Use this helper:

```ts
import { describe, expect, it } from "vitest";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import { screenIssue, REFINEMENT_START, REFINEMENT_END } from "../../../src/analysis/heuristic-screen.js";

function issue(body: string): GitHubIssue {
  return {
    number: 42,
    nodeId: "I_42",
    title: "Some task",
    body,
    updatedAt: "2026-08-20T00:00:00Z",
    state: "open",
    htmlUrl: "https://github.com/acme/widgets/issues/42",
  };
}
```

Tests (write the assertion code; the exact bodies are given):

```ts
const CONTRACT_BODY = `${REFINEMENT_START}
## Autonomous execution contract

### Goal
Implement x.

### Acceptance criteria
- [ ] **ac1** It works

${REFINEMENT_END}
`;

describe("screenIssue", () => {
  it("classifies a full managed contract as READY", () => {
    const d = screenIssue({ issue: issue(CONTRACT_BODY), dependencies: [] });
    expect(d.classification).toBe("READY");
    expect(d.reasons).toContain("has managed execution contract");
  });

  it("classifies an unsatisfied explicit dependency as BLOCKED", () => {
    const body = "Depends on: #12\n\n## Acceptance criteria\n- [ ] x works";
    const d = screenIssue({
      issue: issue(body),
      dependencies: [{ issue: 12, satisfied: false }],
    });
    expect(d.classification).toBe("BLOCKED");
  });

  it("does NOT treat a bare #n reference as a dependency", () => {
    const body = "See #12 for background.\n\n## Acceptance criteria\n- [ ] x works";
    const d = screenIssue({
      issue: issue(body),
      dependencies: [{ issue: 12, satisfied: false }],
    });
    expect(d.classification).not.toBe("BLOCKED");
  });

  it("classifies an unresolved-decision phrase as AMBIGUOUS", () => {
    const d = screenIssue({ issue: issue("Which behavior should win here?"), dependencies: [] });
    expect(d.classification).toBe("AMBIGUOUS");
  });

  it("classifies a partially specified body as CANDIDATE", () => {
    const body = "## Goal\nImplement login\n\n## Acceptance criteria\n- [ ] user can log in";
    const d = screenIssue({ issue: issue(body), dependencies: [] });
    expect(d.classification).toBe("CANDIDATE");
  });

  it("classifies a body missing everything as NEEDS_REFINEMENT", () => {
    const d = screenIssue({ issue: issue("Just a vague note."), dependencies: [] });
    expect(d.classification).toBe("NEEDS_REFINEMENT");
  });

  it("prefers BLOCKED over AMBIGUOUS", () => {
    const body = "Depends on: #12\n\nWhich behavior should win?";
    const d = screenIssue({
      issue: issue(body),
      dependencies: [{ issue: 12, satisfied: false }],
    });
    expect(d.classification).toBe("BLOCKED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/analysis/heuristic-screen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `screenIssue`** following the deterministic rules exactly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/analysis/heuristic-screen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/heuristic-screen.ts tests/unit/analysis/heuristic-screen.test.ts
git commit -m "feat(analysis): add deterministic heuristic issue screen"
```

---

### Task 4: Resolve an epic body (or explicit list) to an issue set

**Files:**
- Create: `src/analysis/issue-set.ts`
- Test: `tests/unit/analysis/issue-set.test.ts`

**Interfaces:**
- Consumes: `GitHubPort`, `GitHubIssue` from `src/github/github-adapter.js`.
- Produces (the analyst relies on):
  - `isEpicBody(body: string): boolean` — heuristic: body contains a task checklist with `- [ ]` items AND at least one of the items references an issue (`#\d+` or `owner/repo#\d+`).
  - `collectEpicIssueRefs(body: string): { issues: number[]; unresolved: number[] }` — scan each Markdown checklist line (`- [ ]`), extract a trailing issue reference; lines with a reference → `issues`; checklist lines without a reference → collected as outline indexes into `unresolved` (store the 1-based line index of the bullet, or for determinism a `lines: number[]` array of 1-based line numbers that were prose-only bullets).
  - `resolveIssueSet(refs: number[], epicRef: number | null, github: GitHubPort, repository: RepositoryRef): Promise<ResolvedIssueSet>`

```ts
// src/analysis/issue-set.ts
import type { GitHubPort, GitHubIssue } from "../github/github-adapter.js";
import type { RepositoryRef } from "../domain/contracts.js";

export interface ResolvedIssueSet {
  /** Issues actually fetched and analyzed. */
  issues: GitHubIssue[];
  /** Input refs we could not fetch (e.g. requested number absent on origin). */
  missing: number[];
  /** 1-based line numbers of checklist bullets that were prose-only (epic parse). */
  unresolvedProseLines: number[];
}
```

**Reference extraction:** A checklist line matches a Markdown checkbox prefix `^-\s*\[[ xX]\]\s+`. Strip that prefix and consider the remainder. Extract issue references from the remainder with two ordered passes (only the FIRST reference on a line is the task, but collect all so de-dupe can happen upstream):
1. Qualified refs first: global match `/([^/\s]+)\/([^/\s]+)#(\d+)/g`.
2. Bare refs second: global match `/#(\d+)\b/g` on a copy where steps-1 matches have already been removed (so the `<owner>/<repo>#n` prefix never double-counts). This correctly captures GitHub-style `##102` (the regex finds `#102` after skipping the leading `#`).
A line is *resolved* if it yields at least one reference; its FIRST reference is the task number contributed. Lines with a `- [ ]` prefix but no reference are prose-only → record their **1-based line number** in `unresolvedProseLines`.

Epic vs explicit-list input is normalized by the analyst: for an epic ref, it calls `collectEpicIssueRefs` + fetches each; for an explicit list it fetches each directly (unresolved list empty).

`resolveIssueSet` fetches each issue via `github.getIssue(n)`. Missing (throwing `GitHubError`) → push to `missing` and continue; never abort the whole pass.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/analysis/issue-set.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import {
  collectEpicIssueRefs,
  isEpicBody,
  resolveIssueSet,
} from "../../../src/analysis/issue-set.js";

const repo = { owner: "acme", repo: "widgets" };

function makeIssue(n: number): GitHubIssue {
  return {
    number: n,
    nodeId: `I_${n}`,
    title: `Task ${n}`,
    body: "body",
    updatedAt: "2026-08-20T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${n}`,
  };
}

class FakeGitHub implements GitHubPort {
  readonly calls: number[] = [];
  constructor(private readonly issues: GitHubIssue[]) {}
  async getIssue(number: number): Promise<GitHubIssue> {
    this.calls.push(number);
    const found = this.issues.find((i) => i.number === number);
    if (!found) throw new Error(`issue #${number} not found`);
    return found;
  }
  async updateIssueBody(): Promise<GitHubIssue> { throw new Error("must not be called"); }
  async createIssueComment(): Promise<void> { throw new Error("must not be called"); }
  async findPullRequestByHead(): Promise<null> { return null; }
  async createPullRequest(): Promise<never> { throw new Error("must not be called"); }
  async findIssueCommentByMarker(): Promise<null> { return null; }
}

describe("collectEpicIssueRefs", () => {
  it("extracts bare and qualified refs from checklist lines", () => {
    const body = [
      "- [ ] **Task** Implement the widget (#101)",
      "- [ ] Cross-cutting concern (acme/widgets#102)",
      "- [ ] ##102",
      "- [ ] Refactor the parser",
    ].join("\n");
    const { issues, unresolvedProseLines } = collectEpicIssueRefs(body);
    expect(issues).toEqual([101, 102, 102]);
    expect(unresolvedProseLines).toEqual([4]);
  });
  it("returns empty when there are no checklist items", () => {
    expect(collectEpicIssueRefs("No checklist here")).toEqual({ issues: [], unresolvedProseLines: [] });
  });
  it("detects an epic body", () => {
    expect(isEpicBody("- [ ] #1\n- [ ] #2")).toBe(true);
    expect(isEpicBody("Just prose")).toBe(false);
  });
});

describe("resolveIssueSet", () => {
  it("fetches the requested issues and records missing ones", async () => {
    const github = new FakeGitHub([makeIssue(101), makeIssue(102)] as GitHubIssue[]);
    const set = await resolveIssueSet([101, 102, 999], 28, github, repo);
    expect(set.issues.map((i) => i.number)).toEqual([101, 102]);
    expect(set.missing).toEqual([999]);
    expect(set.unresolvedProseLines).toEqual([]);
    expect(github.calls).toEqual([101, 102, 999]);
  });
});
```

Note: the `issues` array for `collectEpicIssueRefs` intentionally reports every extracted reference (including repeats) so the analyst can de-dupe; `unresolvedProseLines` are 1-based line numbers. Adjust the assertions if your regex yields a different exact shape, but the test above pins the intended contract.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/analysis/issue-set.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `issue-set.ts`**

Implement `isEpicBody`, `collectEpicIssueRefs`, and `resolveIssueSet` per the contract. For `resolveIssueSet`, use a local try/catch around each `github.getIssue` so one missing issue does not abort the pass; swallow the error and record in `missing`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/analysis/issue-set.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/issue-set.ts tests/unit/analysis/issue-set.test.ts
git commit -m "feat(analysis): resolve epic body and explicit lists to issue sets"
```

---

### Task 5: Backlog analyst orchestration + report persistence

**Files:**
- Create: `src/analysis/backlog-analyst.ts`
- Test: `tests/unit/analysis/backlog-analyst.test.ts`

**Interfaces:**
- Consumes: from Task 1 `resolveRefinerModel` only for the refiner model used per candidate (or accept a resolved `ResolvedRoleModel`); from Task 2 `BacklogReport`, `parseBacklogReport`; from Task 3 `screenIssue`, `ScreenDependency`; from Task 4 `resolveIssueSet`, `collectEpicIssueRefs`, `isEpicBody`; M1 pieces `ReadinessService`, `ArtifactStore`, `AppPaths`, `GitHubPort`, `RepositoryContext`, `RepositoryRef`.
- Produces (the `analyze` command relies on):
  - `BacklogAnalyst` class with ctor deps `{ repository, config, github, readiness, artifacts, paths, refinerModel, refinerTimeoutMs, analysisId?, now? }` where `readiness` is the M1 `ReadinessService` (or a structural `{ check(n): Promise<ReadinessReport> }`).
  - `analyzeIssues(args: { epicRef: number | null; requestedRefs: number[]; deep?: boolean }): Promise<BacklogReport>`

**Orchestration logic:**

```ts
async analyzeIssues({ epicRef, requestedRefs, deep }) {
  const refs = requestedRefs;
  const repo = this.deps.repository.repository;
  const analysisId = this.deps.analysisId ?? `analyze-${Date.now()}`;

  let totalRefs = refs;
  let unresolvedCount = 0;
  if (epicRef !== null) {
    const epic = await this.deps.github.getIssue(epicRef);
    const { issues: epicIssueRefs, unresolvedProseLines } = collectEpicIssueRefs(epic.body);
    // Keep requested order but append epic-discovered refs, de-duping.
    const merged: number[] = [];
    for (const n of [...refs, ...epicIssueRefs]) if (!merged.includes(n)) merged.push(n);
    totalRefs = merged;
    unresolvedCount = unresolvedProseLines.length;
  }

  const set = await resolveIssueSet(totalRefs, epicRef, this.deps.github, repo);

  const issuesRows = [];
  let refinerSessions = 0;
  const executable: number[] = [];
  const needsWork: number[] = [];

  for (const issue of set.issues) {
    // Resolve dependency satisfaction for the screen: find `#n` refs in the
    // body that ALSO appear in our set or the epic body as explicit deps, then
    // look up their state. For M2, treat only refs explicitly marked
    // "depends on"/dependency marker as material (matching the screen rules);
    // others are left out of `dependencies` so the screen won't misfire.
    const screenDeps = await this.resolveScreenDependencies(issue);
    const screen = screenIssue({ issue, dependencies: screenDeps });

    // Refiner banding
    const shouldRefine = deep || screen.classification === "CANDIDATE";
    let classification: BacklogClassification;
    let readiness: null | { analysisId: string; status: "READY" | "NEEDS_REFINEMENT" } = null;

    if (screen.classification === "SKIPPED") {
      classification = "SKIPPED";
    } else if (shouldRefine) {
      refinerSessions += 1;
      const report = await this.deps.readiness.check(issue.number);
      readiness = { analysisId: report.analysisId, status: report.status };
      classification = mapReadinessToClassification(report.status, screen.classification);
    } else {
      classification = mapScreenToClassification(screen.classification);
    }

    issuesRows.push({
      issueNumber: issue.number,
      title: issue.title,
      url: issue.htmlUrl,
      classification,
      screen: { classification: screen.classification, reasons: screen.reasons },
      readiness,
    });

    if (classification === "READY") executable.push(issue.number);
    else if (classification !== "SKIPPED") needsWork.push(issue.number);
  }

  const totalIssues = totalRefs.length;
  const analyzed = issuesRows.filter((r) => r.classification !== "SKIPPED").length;

  const report: BacklogReport = {
    repository: repo,
    epicRef: epicRef ?? null,
    requestedRefs: totalRefs,
    generatedAt: this.deps.now ? this.deps.now() : new Date().toISOString(),
    analysisId,
    scope: { totalIssues, analyzed, unresolved: unresolvedCount + set.missing.length },
    issues: issuesRows,
    executable,
    needsWork,
    summary: summarize(issuesRows).withUnresolved(unresolvedCount + set.missing.length),
    refinerSessions,
  };

  await this.deps.artifacts.writeJson(analysisId, "backlog-report.json", report);
  return parseBacklogReport(report);
}
```

Helper functions (module-private in `backlog-analyst.ts`):

```ts
function mapScreenToClassification(screen: BacklogClassification): BacklogClassification {
  return screen; // READY->READY, NEEDS_REFINEMENT->NEEDS_REFINEMENT, BLOCKED, AMBIGUOUS, SKIPPED->SKIPPED
}

function mapReadinessToClassification(
  status: "READY" | "NEEDS_REFINEMENT",
  screenClassification: BacklogClassification,
): BacklogClassification {
  return status; // the gate is authoritative within its two outcomes
}

export function summarizeReports(rows: { classification: BacklogClassification }[]) {
  const summary = { ready: 0, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 };
  for (const r of rows) summary[r.classification] += 1;
  return summary;
}
```

`resolveScreenDependencies(issue: GitHubIssue): Promise<ScreenDependency[]>`: scan the body for explicit dependency markers (`Depends on: #n` / `dependency: #n` at line start, or the managed-section `- #n (unsatisfied)`), resolve each referenced issue via `this.deps.github.getIssue`, and add `{ issue: n, satisfied: issue.state === "closed" }`. Failures to fetch a dependency → treat as `satisfied: false` (conservative → BLOCKED). This mirrors the screen's rule 2 data needs. Export this so the command can reuse it if needed.

**Persistence:** write the report via `ArtifactStore.writeJson(analysisId, "backlog-report.json", report)` and return the parsed report. The `debug`/prompt of the analysisId is covered in Task 6's human render.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/analysis/backlog-analyst.test.ts`. Build a `FakeGitHub` exposing several issues (one with a full contract → READY without refiner; one partially specified → CANDIDATE → refiner → READY; one missing everything → NEEDS_REFINEMENT; one with an open explicit dependency → BLOCKED; one unresolved-decision → AMBIGUOUS) and a `FakeRefinerRunner`/`FakeRefiner` that returns deterministic `RefinerResult`s keyed by issue number. Assert:

- `BACKLOG` uses an epic body referencing the issues and `requestedRefs` non-deep; `refinerSessions` equals the count of CANDIDATE issues only.
- `--deep` (deep: true) runs a refiner for every analyzable issue → `refinerSessions` equals analyzed count.
- `executable` contains READY issues only; `needsWork` contains the rest.
- `analysisId` matches the injected value.
- A `BacklogReport` JSON artifact named `backlog-report.json` was written for `analysisId`.
- Zero mutation calls on `FakeGitHub` (mutating methods throw).

Use the `validReport()`-style factory from Task 2 only as a type reference; construct your own detailed report via the analyst and assert on its fields. Provide a contract body using the `REFINEMENT_START`/`REFINEMENT_END` from `heuristic-screen.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/analysis/backlog-analyst.test.ts`
Expected: FAIL — module `src/analysis/backlog-analyst.js` not found.

- [ ] **Step 3: Implement `backlog-analyst.ts`** per the orchestration logic.

Ensure `ReadinessService` is passed in via ctor (not constructed inside), so tests can inject the M1 `ReadinessService` with a fake refiner runner — mirroring `check.test.ts`'s `createReadiness` seam.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/analysis/backlog-analyst.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite for the analysis module + typecheck**

Run: `npx vitest run tests/unit/analysis tests/unit/domain && npm run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/backlog-analyst.ts tests/unit/analysis/backlog-analyst.test.ts
git commit -m "feat(analysis): orchestrate the backlog analyst pass"
```

---

### Task 6: `analyze` command + CLI registration

**Files:**
- Create: `src/commands/analyze.ts`
- Modify: `src/cli.ts` (register the command)
- Test: `tests/integration/commands/analyze.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveIssueRefs`, `resolveRefinerModel`, `resolveRefinerTimeout`; Task 5 `BacklogAnalyst`; M1 `CheckCommandDeps`-style deps; `appPaths`, `ArtifactStore`, `PiRunner`, `GitHubAdapter`, `loadRepositoryConfig`, `ResolvedRoleModel`, `AutopilotConfig`, `RepositoryContext`, `GitHubPort`, `ReadinessService`.
- Produces: `registerAnalyzeCommand(program: Command, deps: AnalyzeCommandDeps = {})` and `AnalyzeCommandDeps`.

```ts
// src/commands/analyze.ts
import { Command } from "commander";
// ... imports

export interface AnalyzeCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  createGitHub?: (ctx: RepositoryContext, runner: ProcessRunner) => Promise<GitHubPort>;
  /** Test seam: construct the backlog analyst from resolved inputs. */
  createAnalyst?: (deps: {
    repository: RepositoryContext;
    config: AutopilotConfig;
    github: GitHubPort;
    readiness: Pick<ReadinessService, "check">;
    refinerModel: ResolvedRoleModel;
    refinerTimeoutMs: number;
    analysisId: () => string;
    now: () => string;
  }) => Pick<BacklogAnalyst, "analyzeIssues">;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface AnalyzeOptions {
  json?: boolean;
  deep?: boolean;
  model?: string;
  thinking?: string;
  refinerTimeout?: number;
  minReady?: number;
}
```

**Command definition:**

```ts
program
  .command("analyze")
  .description("Analyze an epic (or explicit issue set) for backlog readiness (read-only)")
  .argument("<ref>", "issue/epic number, or owner/repo#number matching the local origin")
  .argument("[moreRefs...]", "additional issue references in an explicit set")
  .option("--json", "emit the backlog report as machine-readable JSON")
  .option("--deep", "run a full refiner session and readiness gate on every issue")
  .option("--model <model>", "override the refiner model")
  .option("--thinking <level>", "override the refiner thinking level")
  .option("--refiner-timeout <minutes>", "override the refiner session timeout in minutes")
  .option("--min-ready <n>", "require at least this many READY issues; exit non-zero otherwise")
  .action(async (ref: string, moreRefs: string[], opts: AnalyzeOptions) => { ... });
```

**Wiring (`runAnalyze`):**
- Resolve repo context, load config, build GitHub port, `appPaths`, refiner model/timeout (via the Task 1 helpers using `...args` with `opts.refinerTimeout` as the explicit minutes, and `opts.model`/`opts.thinking`).
- Default `analysisId = () => \`analyze-${Date.now()}\`` and `now = () => new Date().toISOString()` (both injectable).
- Build `ReadinessService` exactly as `check.ts` does (same `createReadiness` seam semantics → but `analyze` needs the real `ReadinessService` too). Build `BacklogAnalyst`.
- Resolve refs via `resolveIssueRefs([ref, ...moreRefs], ctx)`.
- `epicRef`: if exactly one bare ref and it is an epic (call `isEpicBody` on `github.getIssue(n)`) → treat as epic; else treat all as an explicit set and `epicRef = null`. **Decision:** when a single ref is given and its body parses as an epic (has checklist with issue refs), treat it as an epic; otherwise (single non-epic ref, or multiple refs) treat as an explicit set with `epicRef = null`. This is deterministic and documents the A-then-B input rules. `requestedRefs` passed to the analyst is the explicit `[ref]` (for multi) or `[]` plus the epic-discovered set (for epic mode).
- Call `analyst.analyzeIssues({ epicRef, requestedRefs, deep: opts.deep === true })`.
- `--json` → print `JSON.stringify(report, null, 2)`.
- Human render → concise table + `executable`/`needsWork`/`summary` + a line noting the persisted `analysisId` (so the user can `autopilot inspect <analysisId>`, though `inspect` reads run records; for M2 just print `analysisId` and note the artifact path).
- Exit code (executability contract): `0` when `report.executable.length > 0` AND `report.summary.needsRefinement === 0` (regardless of BLOCKED/AMBIGUOUS/SKIPPED counts — those are normal triage outcomes, not errors); `2` when `report.executable.length === 0` OR `report.summary.needsRefinement > 0`, OR `--min-ready N` is given and `report.executable.length < N`; `1` on argument/infrastructure error. `--min-ready` must be a positive integer, else exit `1` (argument error).

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/commands/analyze.test.ts`, mirroring `check.test.ts`'s harness (real git fixture repo + `.pi/autopilot.yaml`, injected `FakeGitHub`, `FakeRefinerRunner`). Introduce a `FakeGitHub` that holds a **map** of issues (so an epic + its children can all be resolved) and a `FakeRefiner` returning a `READY` refiner result for candidate issues:

```ts
class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];
  constructor(private readonly issues: Map<number, GitHubIssue>) {}
  async getIssue(number: number): Promise<GitHubIssue> {
    const found = this.issues.get(number);
    if (!found) throw new Error(`issue #${number} not found`);
    return { ...found, number };
  }
  async updateIssueBody(): Promise<GitHubIssue> { this.mutationCalls.push("updateIssueBody"); throw new Error("must not be called"); }
  async createIssueComment(): Promise<void> { this.mutationCalls.push("createIssueComment"); throw new Error("must not be called"); }
  async findPullRequestByHead(): Promise<null> { return null; }
  async createPullRequest(): Promise<never> { this.mutationCalls.push("createPullRequest"); throw new Error("must not be called"); }
  async findIssueCommentByMarker(): Promise<null> { return null; }
}
```

Tests:
- `analyze <epic>` where epic #28's body has a checklist referencing #101 (full contract → READY) and #102 (partially specified → CANDIDATE → refiner), plus a prose bullet. Assert: exit code `0`, `--json` report has `summary.ready === 1`, `summary.needsRefinement === 0` (the candidate became READY via the refiner/gate), `refinerSessions === 1`, `executable` contains `[101, 102]`, `unresolved === 1`, and `github.mutationCalls` is `[]`.
- `analyze 28 29 30` explicit list: `--json`, no epic parse (each ref treated as an issue; a ref that is actually an epic body is still analyzed as itself). Assert two issues classified per their bodies, `epicRef` is `null` in the report.
- `--deep` forces a refiner on every analyzable issue (assert `refinerSessions` equals the analyzable count, and both READY-by-contract and NEEDS_REFINEMENT issues get one).
- `--min-ready 2` where only 1 is ready → exit code `2`.
- Backlog-report artifact written: after a run with injected `analysisId: () => "analyze-test-1"`, read `artifactStore.readJson("analyze-test-1", "backlog-report.json")` and assert `summary.ready`.

Provide the harness with a temporary `dataDir` (`mkdtempSync`) so artifact reads work, and expose the `ArtifactStore`/`AppPaths` for that assert.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/commands/analyze.test.ts`
Expected: FAIL — module `src/commands/analyze.js` not found (or command not registered).

- [ ] **Step 3: Register the command in `cli.ts`**

Add `import type { AnalyzeCommandDeps } from "./commands/analyze.js"; import { registerAnalyzeCommand } from "./commands/analyze.js";`, add `AnalyzeCommandDeps` to the `CliDeps` intersection type, and call `registerAnalyzeCommand(program, deps);` after `registerPrepareCommand`.

- [ ] **Step 4: Implement `src/commands/analyze.ts`** per the wiring.

- [ ] **Step 5: Run the integration tests to verify they pass**

Run: `npx vitest run tests/integration/commands/analyze.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: All PASS. (`npm test` must still be 319+ passing; the new tests add to it.)

- [ ] **Step 7: Commit**

```bash
git add src/commands/analyze.ts src/cli.ts tests/integration/commands/analyze.test.ts
git commit -m "feat: add autopilot analyze backlog analyst command"
```

---

### Task 7: Final flow-proof, acceptance verification, and spec-cross-check

This task has no production code; it verifies the milestone end-to-end and closes any gaps against the spec's §9 acceptance criteria.

**Files:**
- Modify: `README.md` (add `analyze` to the command list and a short M2 paragraph)
- Test (verification only, no new commit fixtures): run the acceptance flows listed.

- [ ] **Step 1: Re-read the M2 spec §9 acceptance criteria** and map each to an existing test. The acceptance table below is the checklist:

| Spec §9 criterion | Verified by |
|---|---|
| 1. `analyze <epic>` enumerates referenced tasks, de-dupes, analyzes resolvable ones, lists unresolvable prose as SKIPPED | `issue-set.test.ts` (collect + dedupe) + `analyze.test.ts` (unresolved count) |
| 2. `analyze <list>` analyzes the explicit set | `analyze.test.ts` explicit-list test |
| 3. heuristic screen classifies deterministically, zero Pi for non-candidates | `heuristic-screen.test.ts` (all branches) + `backlog-analyst.test.ts` (`refinerSessions` only for CANDIDATE) |
| 4. refiner only for candidates by default; every issue under `--deep` | `backlog-analyst.test.ts` + `analyze.test.ts` `--deep` test |
| 5. same deterministic readiness gate as M1 | reuses `ReadinessService.check`/`computeReadinessGaps`; `backlog-analyst.test.ts` asserts gate outcome |
| 6. read-only (no GitHub mutation, no workspace) | every analyzer test asserts `github.mutationCalls` is `[]` |
| 7. durable `BacklogReport` with `executable`/`needsWork`/`summary`, inspectable | `backlog-analyst.test.ts` writes `backlog-report.json`; `analyze.test.ts` reads it back |
| 8. `--json`, exit codes, `--min-ready` | `analyze.test.ts` exit-code + min-ready tests |
| 9. full M1 suite green + typecheck/build | Task 6 Step 6 |

- [ ] **Step 2: Fix any gaps** — if any row above points to a test that does not yet exist or a behavior not yet covered, add the missing test in the appropriate existing file rather than leaving a hole.

- [ ] **Step 3: Add `analyze` to the README command list and an M2 paragraph.** Find the M1 command list in the README and add `autopilot analyze <ref>` with the short description "assess backlog readiness across an epic or explicit issue set (read-only)". Add a brief M2 note under the milestone section.

- [ ] **Step 4: Run the full verification gates**

Run: `npm run typecheck && npm run build && npm test`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the M2 backlog analyst command (analyze)"
```

---

## Self-Review Notes

**Spec coverage:** Every §9 acceptance criterion maps to a task in the table above. §8 deferred items (bulk apply, GitHub readiness markers, auto-discovery/selection, concurrency, epic semantic analysis) are all intentionally NOT implemented — no task touches `updateIssueBody` outside `prepare`, no scheduler exists, no concurrency, analysis is sequential.

**Placeholder scan:** All steps include concrete code or explicit behavior; no "TBD"/"add validation"/"implement later".

**Type consistency:** `ScreenDecision`/`HeuristicScreenResult`/`ScreenClassification` are defined once (Task 2/3). `resolveIssueRefs` de-dupes preserving order. `analyzeIssues({ epicRef, requestedRefs, deep })` signature is defined in Task 5 and consumed identically in Task 6. `BacklogReport` field names (`executable`, `needsWork`, `summary`, `refinerSessions`, `scope.unresolved`) are consistent across Tasks 2, 3, 5, 6.

One deliberate design decision locked in Task 3 rule ordering: AMBIGUOUS beats READY so a contract with an unresolved-decision phrase is surfaced as ambiguous (the refiner under `--deep` re-gates it). This is a judgment call consistent with the spec's "don't silently change product scope."
