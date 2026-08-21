# Brainstormer Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `brainstormer` role to `autopilot prepare` that triggers when the refiner returns `NEEDS_REFINEMENT` or `PRODUCT_AMBIGUITY`, asks the operator 2-3 tailored intent questions, and feeds the answers to a second refiner pass.

**Architecture:** A new `"brainstormer"` entry is added to the `Role` union and registered in `PiRunner`. A new `ReadinessService.brainstorm()` method runs the brainstormer Pi session. `prepare.ts` inserts the brainstorm phase between the first refiner pass and the existing narrow clarification loop.

**Tech Stack:** TypeScript, Zod, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-brainstormer-role-design.md`

## Global Constraints

- TypeScript strict mode — no `any`, no type assertions (`as`).
- All new exports must be named exports (no default exports).
- Test files live under `tests/` mirroring `src/` structure; integration tests under `tests/integration/`, unit tests under `tests/unit/`.
- Run tests with `npx vitest run`; run type-check with `npx tsc --noEmit`.
- Each task ends with a passing `npx vitest run` and clean `npx tsc --noEmit`.
- Never modify files outside the scope of a task.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `src/domain/contracts.ts` | Modify | Add `"brainstormer"` to `RoleSchema`; add `BrainstormerResultSchema` and `BrainstormerResult` type |
| `src/pi/pi-runner.ts` | Modify | Register `brainstormer` in `ROLE_SCHEMAS` and `ROLE_TOOLS` |
| `src/readiness/brainstormer-prompt.ts` | Create | Build the brainstormer prompt string from issue + refiner gaps |
| `src/readiness/readiness-service.ts` | Modify | Add `brainstorm()` method; add optional `brainstorm` seam to `ReadinessServiceDeps` |
| `src/commands/prepare.ts` | Modify | Insert brainstorm phase between pass-1 and clarification loop; add `runBrainstormer` seam to `PrepareCommandDeps` |
| `tests/unit/readiness/brainstormer-prompt.test.ts` | Create | Unit tests for prompt content and shape |
| `tests/unit/readiness/readiness-service.test.ts` | Modify | Tests for `ReadinessService.brainstorm()` |
| `tests/integration/commands/prepare.test.ts` | Modify | Integration tests for the brainstorm phase in the prepare flow |

---

## Task 1: Extend `domain/contracts.ts` with the brainstormer schema

**Files:**
- Modify: `src/domain/contracts.ts`

**Interfaces:**
- Produces:
  - `BrainstormerResultSchema` — Zod schema, exported
  - `BrainstormerResult` — TypeScript type, exported
  - `RoleSchema` now includes `"brainstormer"`
  - `Role` type now includes `"brainstormer"`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/domain/brainstormer-contracts.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { BrainstormerResultSchema, RoleSchema } from "../../../src/domain/contracts.js";

describe("BrainstormerResultSchema", () => {
  it("accepts a valid result with one question", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [{ id: "q1", text: "What is the real goal?" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid result with three questions", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [
        { id: "q1", text: "What is the real goal?" },
        { id: "q2", text: "What does done look like?" },
        { id: "q3", text: "Any constraints I should know?" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero questions", () => {
    const result = BrainstormerResultSchema.safeParse({ questions: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than three questions", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [
        { id: "q1", text: "A" },
        { id: "q2", text: "B" },
        { id: "q3", text: "C" },
        { id: "q4", text: "D" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a question with an empty id", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [{ id: "", text: "What is the goal?" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a question with empty text", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [{ id: "q1", text: "" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("RoleSchema", () => {
  it("accepts brainstormer as a valid role", () => {
    const result = RoleSchema.safeParse("brainstormer");
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /path/to/pi_autopilot
npx vitest run tests/unit/domain/brainstormer-contracts.test.ts
```

Expected: FAIL — `BrainstormerResultSchema` not found.

- [ ] **Step 3: Add the schema to `src/domain/contracts.ts`**

After the existing `ReviewerResultSchema` block (around line 191), add:

```typescript
export const BrainstormerResultSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(3),
});
export type BrainstormerResult = z.infer<typeof BrainstormerResultSchema>;
```

Change the `RoleSchema` line from:

```typescript
export const RoleSchema = z.enum(["refiner", "implementer", "reviewer"]);
```

to:

```typescript
export const RoleSchema = z.enum(["refiner", "implementer", "reviewer", "brainstormer"]);
```

Also add `BrainstormerResultSchema` to the `RoleResultSchema` union at the bottom of the file:

```typescript
// Before:
export const RoleResultSchema = z.union([
  RefinerResultSchema,
  ImplementerResultSchema,
  ReviewerResultSchema,
]);

// After:
export const RoleResultSchema = z.union([
  RefinerResultSchema,
  ImplementerResultSchema,
  ReviewerResultSchema,
  BrainstormerResultSchema,
]);
```

- [ ] **Step 4: Run tests and type-check**

```bash
npx vitest run tests/unit/domain/brainstormer-contracts.test.ts
npx tsc --noEmit
```

Expected: all tests PASS, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/contracts.ts tests/unit/domain/brainstormer-contracts.test.ts
git commit -m "feat: add BrainstormerResultSchema and brainstormer role to contracts"
```

---

## Task 2: Register `brainstormer` in `PiRunner`

**Files:**
- Modify: `src/pi/pi-runner.ts`

**Interfaces:**
- Consumes: `BrainstormerResultSchema` from `src/domain/contracts.ts`
- Produces: `pi.run({ role: "brainstormer", ... })` now accepted without TS error; brainstormer gets read-only tools

- [ ] **Step 1: Write the failing test**

There is no isolated unit test for `PiRunner` itself (it spawns processes), so the type-check is the verification gate here. Confirm that a call with `role: "brainstormer"` currently produces a TS error:

```bash
npx tsc --noEmit
```

If you see an error like `Type '"brainstormer"' is not assignable to type 'Role'`, that is the expected failure.

If the type check already passes (because `RoleSchema` was updated in Task 1 and `ROLE_SCHEMAS`/`ROLE_TOOLS` use `Record<Role, ...>`), skip to Step 3 and verify the runtime lookup is wired.

- [ ] **Step 2: Update `ROLE_SCHEMAS` and `ROLE_TOOLS` in `src/pi/pi-runner.ts`**

Import `BrainstormerResultSchema` at the top of the file alongside the existing imports:

```typescript
import {
  BrainstormerResultSchema,
  ImplementerResultSchema,
  RefinerResultSchema,
  ReviewerResultSchema,
} from "../domain/contracts.js";
```

Add the brainstormer entries to both maps:

```typescript
const ROLE_SCHEMAS: Record<Role, z.ZodType> = {
  refiner: RefinerResultSchema,
  implementer: ImplementerResultSchema,
  reviewer: ReviewerResultSchema,
  brainstormer: BrainstormerResultSchema,
};

const ROLE_TOOLS: Record<Role, string[]> = {
  refiner: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
  brainstormer: READ_ONLY_TOOLS,
};
```

- [ ] **Step 3: Type-check and run full suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: no TS errors, all 457 existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pi/pi-runner.ts
git commit -m "feat: register brainstormer role in PiRunner"
```

---

## Task 3: Create `brainstormer-prompt.ts`

**Files:**
- Create: `src/readiness/brainstormer-prompt.ts`
- Create: `tests/unit/readiness/brainstormer-prompt.test.ts`

**Interfaces:**
- Consumes: `RepositoryRef`, `Ambiguity` from `src/domain/contracts.ts`; `GitHubIssue` from `src/github/github-adapter.ts`
- Produces:
  ```typescript
  interface BrainstormerPromptInput {
    repository: RepositoryRef;
    issue: GitHubIssue;
    refinerGaps: {
      missingInformation: string[];
      ambiguities: Ambiguity[];
      suggestions: string[];
    };
  }
  export function buildBrainstormerPrompt(input: BrainstormerPromptInput): string
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/readiness/brainstormer-prompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import type { RepositoryRef, Ambiguity } from "../../../src/domain/contracts.js";
import { buildBrainstormerPrompt } from "../../../src/readiness/brainstormer-prompt.js";

const repository: RepositoryRef = { owner: "acme", repo: "widgets" };

const issue: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
};

describe("buildBrainstormerPrompt", () => {
  it("includes the repository reference", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    expect(prompt).toContain("acme/widgets");
  });

  it("includes the issue number and title", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    expect(prompt).toContain("#42");
    expect(prompt).toContain("Add token refresh validation");
  });

  it("includes the issue body", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    expect(prompt).toContain("Refresh tokens must be rejected when expired.");
  });

  it("includes missing information items when present", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: {
        missingInformation: ["What is the expected UX for expired sessions?"],
        ambiguities: [],
        suggestions: [],
      },
    });
    expect(prompt).toContain("What is the expected UX for expired sessions?");
  });

  it("includes ambiguity descriptions when present", () => {
    const ambiguity: Ambiguity = {
      type: "PRODUCT",
      description: "Should expired tokens return 401 or 403?",
    };
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: {
        missingInformation: [],
        ambiguities: [ambiguity],
        suggestions: [],
      },
    });
    expect(prompt).toContain("Should expired tokens return 401 or 403?");
  });

  it("instructs the brainstormer to submit 1-3 questions via submit_result", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    expect(prompt).toContain("submit_result");
    expect(prompt).toMatch(/1.{0,10}3|three|2-3/i);
  });

  it("forbids the brainstormer from drafting the execution contract", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    expect(prompt).toMatch(/do not draft|not draft|never draft/i);
  });

  it("instructs the brainstormer to inspect repo guidance files", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    expect(prompt).toMatch(/AGENTS\.md|CLAUDE\.md|README/);
  });

  it("omits the gap sections when all gap arrays are empty", () => {
    const prompt = buildBrainstormerPrompt({
      repository,
      issue,
      refinerGaps: { missingInformation: [], ambiguities: [], suggestions: [] },
    });
    // The prompt should not have a dangling empty section header
    expect(prompt).not.toMatch(/Missing information\s*\n\s*\n/);
    expect(prompt).not.toMatch(/Ambiguities\s*\n\s*\n/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/readiness/brainstormer-prompt.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/readiness/brainstormer-prompt.ts`**

```typescript
import type { Ambiguity, RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue } from "../github/github-adapter.js";

export interface BrainstormerPromptInput {
  repository: RepositoryRef;
  issue: GitHubIssue;
  refinerGaps: {
    missingInformation: string[];
    ambiguities: Ambiguity[];
    suggestions: string[];
  };
}

/**
 * Build the prompt for a bounded brainstormer session. The brainstormer
 * reads the issue and the refiner's gap report, then produces 1-3 open-ended
 * intent questions for the operator via submit_result.
 */
export function buildBrainstormerPrompt(input: BrainstormerPromptInput): string {
  const { repository, issue, refinerGaps } = input;
  const body = issue.body.length > 0 ? issue.body : "(empty issue body)";

  const missingSection =
    refinerGaps.missingInformation.length > 0
      ? `\nMissing information identified by the refiner\n---------------------------------------------\n${refinerGaps.missingInformation.map((item) => `- ${item}`).join("\n")}`
      : "";

  const ambiguitySection =
    refinerGaps.ambiguities.length > 0
      ? `\nAmbiguities identified by the refiner\n--------------------------------------\n${refinerGaps.ambiguities.map((a) => `- [${a.type}] ${a.description}`).join("\n")}`
      : "";

  const suggestionsSection =
    refinerGaps.suggestions.length > 0
      ? `\nSuggestions from the refiner\n----------------------------\n${refinerGaps.suggestions.map((s) => `- ${s}`).join("\n")}`
      : "";

  return `You are the Brainstormer role of an autonomous software development orchestrator.

Your job is to help an operator clarify the intent behind a GitHub issue before an implementer agent works on it. The issue has been analyzed by a Refiner and found to be insufficiently specified. Your task is to ask the operator 1-3 open-ended questions that surface the most important gaps in intent, scope, and success criteria.

Inspect the repository's guidance files (AGENTS.md, CLAUDE.md, README*) using the read, grep, find, and ls tools so your questions reflect the actual codebase context. Never ask questions that could be answered by reading the repository yourself.

Rules
-----
- Produce exactly 1-3 questions. Never more, never fewer.
- Focus on intent, scope, and success criteria — the "why" and "what does done look like" level. Do not ask about structural gaps (missing acceptance criteria format, validation command syntax) — those are handled separately.
- Do not draft the execution contract. Do not propose acceptance criteria, objectives, or validation commands. Your only output is questions for the operator.
- Each question must be self-contained and answerable without the operator needing to read the issue again.
- Ask only questions whose answers would materially change what gets built.

Output contract
---------------
Call submit_result exactly once with a JSON string matching this shape:

{
  "questions": [
    { "id": "q1", "text": "..." },
    { "id": "q2", "text": "..." }
  ]
}

Array length must be between 1 and 3 (inclusive).

Input
-----
Repository: ${repository.owner}/${repository.repo}
Issue: #${issue.number} — ${issue.title}

Issue body
----------
${body}${missingSection}${ambiguitySection}${suggestionsSection}`;
}
```

- [ ] **Step 4: Run tests and type-check**

```bash
npx vitest run tests/unit/readiness/brainstormer-prompt.test.ts
npx tsc --noEmit
```

Expected: all tests PASS, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/readiness/brainstormer-prompt.ts tests/unit/readiness/brainstormer-prompt.test.ts
git commit -m "feat: add brainstormer-prompt builder"
```

---

## Task 4: Add `brainstorm()` to `ReadinessService`

**Files:**
- Modify: `src/readiness/readiness-service.ts`
- Modify: `tests/unit/readiness/readiness-service.test.ts`

**Interfaces:**
- Consumes:
  - `buildBrainstormerPrompt(input: BrainstormerPromptInput): string` from `src/readiness/brainstormer-prompt.ts`
  - `BrainstormerResult`, `BrainstormerResultSchema` from `src/domain/contracts.ts`
  - `ReadinessReport` (already defined in this file)
- Produces:
  ```typescript
  // Added to ReadinessServiceDeps:
  brainstorm?: (issueNumber: number, report: ReadinessReport) => Promise<BrainstormerResult>;

  // New public method on ReadinessService:
  async brainstorm(issueNumber: number, report: ReadinessReport): Promise<BrainstormerResult>
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/readiness/readiness-service.test.ts` (after the existing test blocks):

```typescript
import type { BrainstormerResult } from "../../../src/domain/contracts.js";

// Add this describe block at the end of the file:
describe("ReadinessService.brainstorm", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function makeBrainstormerService(
    brainstormResult: BrainstormerResult,
    piRequests: PiRunRequest[] = [],
  ): ReadinessService {
    tempDir = mkdtempSync(path.join(tmpdir(), "ap-brainstorm-"));
    const fakePi: RefinerRunner = {
      run: async (request) => {
        piRequests.push(request);
        return {
          result: brainstormResult,
          exitCode: 0,
          durationMs: 1,
          stdout: "",
          stderr: "",
          resultPath: path.join(request.diagnosticsDir, "result.json"),
          sessionDir: request.sessionDir,
        };
      },
    };
    return new ReadinessService({
      repository,
      config,
      github: {
        getIssue: async () => issue,
        updateIssueBody: async () => issue,
        createIssueComment: async () => undefined,
        findPullRequestByHead: async () => null,
        createPullRequest: async () => { throw new Error("unexpected"); },
        findIssueCommentByMarker: async () => null,
        updateIssueComment: async () => undefined,
        deleteIssueComment: async () => undefined,
      } satisfies GitHubPort,
      pi: fakePi,
      artifacts: new ArtifactStore(appPaths(tempDir)),
      paths: appPaths(tempDir),
      refinerModel,
      analysisId: () => "brainstorm-test-42",
      now: () => "2026-08-18T00:00:00.000Z",
    });
  }

  function makeReport(
    outcome: "NEEDS_REFINEMENT" | "PRODUCT_AMBIGUITY",
  ): ReadinessReport {
    return {
      status: "NEEDS_REFINEMENT",
      outcome,
      repository: { owner: "acme", repo: "widgets" },
      issueNumber: 42,
      sourceBodyHash: "abc123",
      gaps: [],
      missingInformation: ["What is the expected UX for expired sessions?"],
      suggestions: ["Describe the UX for expired sessions"],
      ambiguities: [],
      dependencies: [],
      draft: {
        schemaVersion: 1,
        repository: { owner: "acme", repo: "widgets" },
        issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
        objective: "",
        context: "",
        expectedBehavior: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        dependencies: [],
        canonicalReferences: [],
        sourceBodyHash: "abc123",
      },
      snapshot: null,
      refinerModel,
      analysisId: "brainstorm-test-42",
      createdAt: "2026-08-18T00:00:00.000Z",
    };
  }

  it("returns questions from the brainstormer Pi session", async () => {
    const brainstormResult: BrainstormerResult = {
      questions: [
        { id: "q1", text: "What is the real goal?" },
        { id: "q2", text: "What does done look like?" },
      ],
    };
    const service = makeBrainstormerService(brainstormResult);
    const report = makeReport("NEEDS_REFINEMENT");

    const result = await service.brainstorm(42, report);

    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toEqual({ id: "q1", text: "What is the real goal?" });
  });

  it("passes role 'brainstormer' to the Pi runner", async () => {
    const piRequests: PiRunRequest[] = [];
    const service = makeBrainstormerService(
      { questions: [{ id: "q1", text: "What is the goal?" }] },
      piRequests,
    );
    const report = makeReport("NEEDS_REFINEMENT");

    await service.brainstorm(42, report);

    expect(piRequests[0]?.role).toBe("brainstormer");
  });

  it("uses the injected brainstorm seam when provided in deps", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ap-brainstorm-seam-"));
    const seamResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "Seam question?" }],
    };
    const service = new ReadinessService({
      repository,
      config,
      github: {
        getIssue: async () => issue,
        updateIssueBody: async () => issue,
        createIssueComment: async () => undefined,
        findPullRequestByHead: async () => null,
        createPullRequest: async () => { throw new Error("unexpected"); },
        findIssueCommentByMarker: async () => null,
        updateIssueComment: async () => undefined,
        deleteIssueComment: async () => undefined,
      } satisfies GitHubPort,
      pi: { run: async () => { throw new Error("pi.run must not be called"); } },
      artifacts: new ArtifactStore(appPaths(tempDir)),
      paths: appPaths(tempDir),
      refinerModel,
      brainstorm: async () => seamResult,
    });

    const report = makeReport("PRODUCT_AMBIGUITY");
    const result = await service.brainstorm(42, report);

    expect(result.questions[0]?.text).toBe("Seam question?");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/readiness/readiness-service.test.ts
```

Expected: FAIL — `service.brainstorm` is not a function.

- [ ] **Step 3: Update `ReadinessServiceDeps` and add `brainstorm()` to `ReadinessService`**

In `src/readiness/readiness-service.ts`, add the import:

```typescript
import {
  buildBrainstormerPrompt,
} from "./brainstormer-prompt.js";
import type {
  BrainstormerResult,
} from "../domain/contracts.js";
```

Add the optional seam to `ReadinessServiceDeps`:

```typescript
export interface ReadinessServiceDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  github: GitHubPort;
  pi: RefinerRunner;
  artifacts: ArtifactStore;
  paths: AppPaths;
  refinerModel: ResolvedRoleModel;
  refinerTimeoutMs?: number;
  analysisId?: (issueNumber: number) => string;
  now?: () => string;
  /** Test seam: bypass the Pi session entirely. */
  brainstorm?: (issueNumber: number, report: ReadinessReport) => Promise<BrainstormerResult>;
}
```

Add the `brainstorm()` method to `ReadinessService`, after the existing `check()` method:

```typescript
/**
 * Runs a bounded brainstormer session to surface operator-facing intent
 * questions for an underspecified issue. Returns the validated question list.
 * Persists the result as a diagnostic artifact.
 */
async brainstorm(
  issueNumber: number,
  report: ReadinessReport,
): Promise<BrainstormerResult> {
  if (this.deps.brainstorm !== undefined) {
    return this.deps.brainstorm(issueNumber, report);
  }

  const issue = await this.deps.github.getIssue(issueNumber);
  const analysisId = this.analysisId(issueNumber);
  const analysisDir = this.deps.paths.runDir(analysisId);

  const prompt = buildBrainstormerPrompt({
    repository: this.deps.repository.repository,
    issue,
    refinerGaps: {
      missingInformation: report.missingInformation,
      ambiguities: report.ambiguities,
      suggestions: report.suggestions,
    },
  });

  const execution = await this.deps.pi.run({
    role: "brainstormer",
    model: this.deps.refinerModel,
    prompt,
    worktree: this.deps.repository.root,
    allowedCommands: [],
    protectedPaths: this.deps.config.agentPolicy.protectedPaths,
    sessionDir: path.join(analysisDir, "brainstormer-session"),
    diagnosticsDir: path.join(analysisDir, "brainstormer-diagnostics"),
    env: safeProcessEnv(),
    timeoutMs: this.refinerTimeoutMs,
  });

  const result = execution.result as BrainstormerResult;
  await this.deps.artifacts.writeJson(
    analysisId,
    "brainstormer-result.json",
    result,
  );
  return result;
}
```

- [ ] **Step 4: Run tests and type-check**

```bash
npx vitest run tests/unit/readiness/readiness-service.test.ts
npx tsc --noEmit
```

Expected: all tests PASS, no TS errors.

- [ ] **Step 5: Run the full suite**

```bash
npx vitest run
```

Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/readiness/readiness-service.ts src/readiness/brainstormer-prompt.ts tests/unit/readiness/readiness-service.test.ts
git commit -m "feat: add ReadinessService.brainstorm() method"
```

---

## Task 5: Wire the brainstorm phase into `prepare.ts`

**Files:**
- Modify: `src/commands/prepare.ts`
- Modify: `tests/integration/commands/prepare.test.ts`

**Interfaces:**
- Consumes:
  - `ReadinessService.brainstorm(issueNumber, report): Promise<BrainstormerResult>` (Task 4)
  - `BrainstormerResult` from `src/domain/contracts.ts`
  - `ReadinessReport` — already imported
- Produces: The `runBrainstormer` injectable seam on `PrepareCommandDeps`; the brainstorm phase in `runPrepare`

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/integration/commands/prepare.test.ts` — a new `describe` block after the existing ones:

```typescript
import type { BrainstormerResult } from "../../../src/domain/contracts.js";
import type { ReadinessReport } from "../../../src/readiness/readiness-service.js";

// Helper used only in the brainstorm tests — builds a NEEDS_REFINEMENT report.
function needsRefinementResult(): RefinerResult {
  return {
    outcome: "NEEDS_REFINEMENT",
    taskDraft: {
      ...completeDraft(),
      sourceBodyHash: sha256(ISSUE_BODY),
    },
    missingInformation: ["What is the expected UX for expired sessions?"],
    dependencies: [],
    ambiguities: [],
    suggestions: ["Describe the UX for expired sessions"],
  };
}

function productAmbiguityResult(): RefinerResult {
  return {
    outcome: "PRODUCT_AMBIGUITY",
    taskDraft: {
      ...completeDraft(),
      sourceBodyHash: sha256(ISSUE_BODY),
    },
    missingInformation: [],
    dependencies: [],
    ambiguities: [{ type: "PRODUCT", description: "Return 401 or 403?" }],
  };
}

function readyResult(): RefinerResult {
  const draft = completeDraft();
  return {
    outcome: "READY",
    taskDraft: { ...draft, sourceBodyHash: sha256(ISSUE_BODY) },
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  };
}

// Build a harness that also injects a runBrainstormer seam.
function makeBrainstormHarness(
  root: string,
  refinerResults: RefinerResult[],
  github: FakeGitHub,
  confirm: (prompt: string) => Promise<boolean>,
  brainstormResult: BrainstormerResult,
  answer?: (prompt: string) => Promise<string>,
) {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-"));
  tempDirs.push(dataDir);
  let refinerIndex = 0;

  const deps: PrepareCommandDeps = {
    cwd: root,
    dataDir,
    createGitHub: async () => github,
    createReadiness: (d) =>
      new ReadinessService({
        repository: d.repository,
        config: d.config,
        github: d.github,
        pi: {
          run: async (request) => {
            const current =
              refinerResults[refinerIndex] ??
              refinerResults[refinerResults.length - 1]!;
            refinerIndex += 1;
            return {
              result: current,
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
              sessionDir: request.sessionDir,
            };
          },
        },
        artifacts: new ArtifactStore(appPaths(dataDir)),
        paths: appPaths(dataDir),
        refinerModel: d.refinerModel,
        refinerTimeoutMs: d.refinerTimeoutMs,
        analysisId: () => "prepare-bs-test-42",
        now: () => "2026-08-18T00:00:00.000Z",
        brainstorm: async () => brainstormResult,
      }),
    confirm,
    answer,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, run };
}

describe("prepare — brainstorm phase", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-root-"));
    tempDirs.push(root);
    writeFileSync(path.join(root, ".pi"), "");
    writeFileSync(path.join(root, ".pi/autopilot.yaml"), MINIMAL_YAML);
    mkdirSync(path.join(root, ".git"), { recursive: true });
    writeFileSync(path.join(root, ".git/config"), `[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n`);
    writeFileSync(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  });

  it("triggers the brainstorm phase when refiner pass-1 returns NEEDS_REFINEMENT", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [
        { id: "q1", text: "What is the real goal?" },
        { id: "q2", text: "What does done look like to you?" },
      ],
    };
    const answersGiven: string[] = [];
    const { exitCodes, run } = makeBrainstormHarness(
      root,
      [needsRefinementResult(), readyResult()],
      github,
      async () => true,
      brainstormResult,
      async (prompt) => {
        answersGiven.push(prompt);
        return "Some answer";
      },
    );

    await run(["prepare", "42"]);

    expect(exitCodes).toEqual([0]);
    // Both brainstorm questions must have been presented to the operator
    expect(answersGiven.some((p) => p.includes("What is the real goal?"))).toBe(true);
    expect(answersGiven.some((p) => p.includes("What does done look like to you?"))).toBe(true);
  });

  it("triggers the brainstorm phase when refiner pass-1 returns PRODUCT_AMBIGUITY", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "Which status code is correct?" }],
    };
    const answersGiven: string[] = [];
    const { exitCodes, run } = makeBrainstormHarness(
      root,
      [productAmbiguityResult(), readyResult()],
      github,
      async () => true,
      brainstormResult,
      async (prompt) => {
        answersGiven.push(prompt);
        return "Use 401";
      },
    );

    await run(["prepare", "42"]);

    expect(exitCodes).toEqual([0]);
    expect(answersGiven.some((p) => p.includes("Which status code is correct?"))).toBe(true);
  });

  it("feeds brainstorm answers to the refiner as clarifications (pass 2)", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "What is the real goal?" }],
    };
    let pass2PromptSeen = "";
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-pass2-"));
    tempDirs.push(dataDir);
    let refinerIndex = 0;
    const refinerResults = [needsRefinementResult(), readyResult()];
    const refinerRequests: PiRunRequest[] = [];

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => {
              refinerRequests.push(request);
              const current =
                refinerResults[refinerIndex] ??
                refinerResults[refinerResults.length - 1]!;
              refinerIndex += 1;
              if (refinerIndex === 2) pass2PromptSeen = request.prompt;
              return {
                result: current,
                exitCode: 0,
                durationMs: 1,
                stdout: "",
                stderr: "",
                resultPath: path.join(request.diagnosticsDir, "result.json"),
                sessionDir: request.sessionDir,
              };
            },
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => `bs-pass2-${String(refinerIndex)}`,
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => brainstormResult,
        }),
      confirm: async () => true,
      answer: async () => "The real goal is to prevent replay attacks",
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "42"]);

    expect(pass2PromptSeen).toContain("The real goal is to prevent replay attacks");
    expect(pass2PromptSeen).toContain("What is the real goal?");
  });

  it("skips the brainstorm phase when refiner pass-1 returns READY", async () => {
    const github = new FakeGitHub(issue);
    let brainstormCalled = false;
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-skip-"));
    tempDirs.push(dataDir);

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => ({
              result: readyResult(),
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
              sessionDir: request.sessionDir,
            }),
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => "bs-skip-42",
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => {
            brainstormCalled = true;
            return { questions: [{ id: "q1", text: "Skipped?" }] };
          },
        }),
      confirm: async () => true,
      answer: async () => "",
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "42"]);

    expect(brainstormCalled).toBe(false);
  });

  it("skips the brainstorm phase in --json mode", async () => {
    const github = new FakeGitHub(issue);
    let brainstormCalled = false;
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-json-"));
    tempDirs.push(dataDir);

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => ({
              result: needsRefinementResult(),
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
              sessionDir: request.sessionDir,
            }),
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => "bs-json-42",
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => {
            brainstormCalled = true;
            return { questions: [{ id: "q1", text: "Should not appear?" }] };
          },
        }),
      confirm: async () => true,
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "--json", "42"]);

    expect(brainstormCalled).toBe(false);
  });

  it("returns cancelled when operator types 'cancel' during brainstorm Q&A", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "What is the real goal?" }],
    };
    const exitCodes: number[] = [];
    const stdoutLines: string[] = [];
    const { run } = makeBrainstormHarness(
      root,
      [needsRefinementResult()],
      github,
      async () => true,
      brainstormResult,
      async () => "cancel",
    );

    const harness = makeBrainstormHarness(
      root,
      [needsRefinementResult()],
      github,
      async () => true,
      brainstormResult,
      async () => "cancel",
    );

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Cancelled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/integration/commands/prepare.test.ts
```

Expected: new tests FAIL — brainstorm phase does not exist yet.

- [ ] **Step 3: Add the `runBrainstormer` seam to `PrepareCommandDeps` in `prepare.ts`**

In `src/commands/prepare.ts`, add the import for `BrainstormerResult`:

```typescript
import type { BrainstormerResult } from "../domain/contracts.js";
```

Add the optional seam to `PrepareCommandDeps`:

```typescript
export interface PrepareCommandDeps extends CheckCommandDeps {
  confirm?: (prompt: string) => Promise<boolean>;
  answer?: (prompt: string) => Promise<string>;
  /** Test seam: bypass the brainstormer Pi session. */
  runBrainstormer?: (
    issue: GitHubIssue,
    report: ReadinessReport,
  ) => Promise<Array<{ id: string; text: string }>>;
}
```

- [ ] **Step 4: Insert the brainstorm phase in `runPrepare`**

In `src/commands/prepare.ts`, inside `runPrepare`, locate the block that starts:

```typescript
  if (opts.json !== true) {
    const askAnswer = deps.answer ?? defaultAnswer;
    const answers: Array<{ question: string; answer: string }> = [];
    while (report.status !== "READY") {
```

Insert the brainstorm phase immediately **before** the `if (opts.json !== true)` block:

```typescript
  // Brainstorm phase: trigger on NEEDS_REFINEMENT or PRODUCT_AMBIGUITY (pass 1 only).
  if (
    opts.json !== true &&
    report.status !== "READY" &&
    (report.outcome === "NEEDS_REFINEMENT" || report.outcome === "PRODUCT_AMBIGUITY")
  ) {
    const brainstormFn =
      deps.runBrainstormer !== undefined
        ? async (_issue: GitHubIssue, _report: ReadinessReport) =>
            deps.runBrainstormer!(_issue, _report)
        : async (_issue: GitHubIssue, _report: ReadinessReport) =>
            readiness.brainstorm(number, _report).then((r: BrainstormerResult) => r.questions);

    reporter?.setSpinner(`brainstorming ${ref}`);
    const questions = await brainstormFn(issue, report);
    reporter?.stopSpinner({
      commit: `brainstorm complete (${String(questions.length)} question${questions.length === 1 ? "" : "s"})`,
    });

    const askAnswer = deps.answer ?? defaultAnswer;
    const brainstormAnswers: Array<{ question: string; answer: string }> = [];
    for (const q of questions) {
      reporter?.stopSpinner();
      const answer = await askAnswer(`${q.text}\n\nAnswer (or 'cancel'): `);
      if (answer.trim().toLowerCase() === "cancel") {
        return {
          repository: report.repository,
          issueNumber: number,
          applied: false,
          reason: "cancelled",
          updatedAt: issue.updatedAt,
          source,
          ...(reused !== null ? { reusedFrom: reused.analysisId } : {}),
        };
      }
      brainstormAnswers.push({ question: q.text, answer: answer.trim() });
    }

    reporter?.setSpinner(`refining ${ref} (brainstorm pass)`);
    report = await refine(brainstormAnswers);
    reporter?.stopSpinner({ commit: `refinement complete for ${ref} (pass 2)` });
  }
```

Also update the type of `readiness` used inside `runPrepare`. The existing `readiness` variable is typed as `Pick<ReadinessService, "check">` — extend it to `Pick<ReadinessService, "check" | "brainstorm">`:

```typescript
// In the createReadiness default path:
const readiness: Pick<ReadinessService, "check" | "brainstorm"> =
  deps.createReadiness !== undefined
    ? deps.createReadiness({ repository: ctx, config, github, refinerModel, refinerTimeoutMs })
    : new ReadinessService({ ... });
```

And update `CheckCommandDeps.createReadiness` return type accordingly, OR keep it as `Pick<ReadinessService, "check">` and cast in `runPrepare`. The cleanest approach: when `deps.runBrainstormer` is provided, skip calling `readiness.brainstorm` entirely (the seam replaces it). When not provided, call `readiness.brainstorm` — and `readiness` must be a full `ReadinessService` in that code path. Add a runtime assertion or type narrowing.

The simplest implementation without changing `CheckCommandDeps`: always use `deps.runBrainstormer` if provided, and cast `readiness as ReadinessService` otherwise (since the default construction always produces a real `ReadinessService`):

```typescript
    const brainstormFn = async (
      _issue: GitHubIssue,
      _report: ReadinessReport,
    ): Promise<Array<{ id: string; text: string }>> => {
      if (deps.runBrainstormer !== undefined) {
        return deps.runBrainstormer(_issue, _report);
      }
      const svc = readiness as ReadinessService;
      const result = await svc.brainstorm(number, _report);
      return result.questions;
    };
```

Import `ReadinessService` (the class, not just the type) at the top of `prepare.ts`:

```typescript
import { ReadinessService } from "../readiness/readiness-service.js";
```

- [ ] **Step 5: Run tests and type-check**

```bash
npx vitest run tests/integration/commands/prepare.test.ts
npx tsc --noEmit
```

Expected: all tests (existing + new) PASS, no TS errors.

- [ ] **Step 6: Run the full suite**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/prepare.ts tests/integration/commands/prepare.test.ts
git commit -m "feat: wire brainstorm phase into autopilot prepare"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 Trigger on `NEEDS_REFINEMENT` | Task 5 (integration test: "triggers...NEEDS_REFINEMENT") |
| §2 Trigger on `PRODUCT_AMBIGUITY` | Task 5 (integration test: "triggers...PRODUCT_AMBIGUITY") |
| §2 Skip when pass-1 is READY | Task 5 (integration test: "skips...READY") |
| §2 Skip in `--json` mode | Task 5 (integration test: "skips...--json mode") |
| §3 Flow (brainstorm → operator Q&A → refiner pass 2) | Task 5 (integration test: "feeds brainstorm answers...pass 2") |
| §4.1 Tool allowlist (read-only) | Task 2 (`ROLE_TOOLS` entry) |
| §4.2 Output schema (1-3 questions) | Task 1 (`BrainstormerResultSchema`) |
| §4.3 Prompt content | Task 3 (`buildBrainstormerPrompt` + unit tests) |
| §4.4 Timeout (reuses refinerTimeoutMs) | Task 4 (`brainstorm()` passes `this.refinerTimeoutMs`) |
| §5.2 `runBrainstormer` seam on `PrepareCommandDeps` | Task 5 |
| §5.3 Cancel during brainstorm Q&A | Task 5 (integration test: "returns cancelled") |
| §6 `brainstorm()` method on `ReadinessService` | Task 4 |
| §6 Optional `brainstorm` seam on `ReadinessServiceDeps` | Task 4 |
| §6 Persist `brainstormer-result.json` artifact | Task 4 (implementation) |
| §7 `BrainstormerResultSchema` in contracts | Task 1 |
| §7 `"brainstormer"` added to `RoleSchema` | Task 1 |
| §8 `pi-runner.ts` entries | Task 2 |
| §9 `brainstormer-prompt.ts` | Task 3 |
| §11 Fast path untouched | No task needed — fast path has no `report.outcome` check |
| §11 Existing clarification loop still runs as fallback | Task 5 — brainstorm runs before the loop, not replacing it |
| §11 `check` command untouched | No task needed |

All spec sections covered. No gaps found.
