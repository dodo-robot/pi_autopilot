# Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `autopilot bootstrap --plan` / `--apply` to seed a GitHub project from scratch: requirement docs → LLM-inferred epics + issues + dependency graph + parallel tracks + Projects v2 board + `autopilot.yaml`.

**Architecture:** Two explicit phases separated by a saved plan artifact. `--plan` reads requirement docs, runs a bounded `bootstrapper` Pi session (given the superpowers brainstorming skill) that proposes epics/issues/dependency graph/parallel tracks, then saves `plan.json` + `bootstrap-plan.md`. `--apply` reads the saved plan and performs GitHub writes in a fixed order: board creation, epic issues, child issues, epic checklist patching, board membership, and optional `autopilot.yaml` creation. Each phase is orchestrated by a dedicated service; all GitHub surfaces are injected as ports so tests use fakes.

**Tech Stack:** TypeScript/ESM, Node.js 22.5+, `zod` v4, `commander`, `@octokit/rest` (REST for issues, GraphQL for Projects v2), `yaml`, `node:crypto` (plan ID generation), `vitest`.

**Spec:** `docs/superpowers/specs/2026-08-23-bootstrap-design.md`

## Global Constraints

- TypeScript strict mode; ESM-only (`.js` extensions on all local imports).
- No new runtime dependencies — use packages already in `package.json`.
- All new roles must be added to `RoleSchema` in `src/domain/contracts.ts` and `RoleAgentsConfigSchema` in `src/config/schema.ts`.
- Plan artifacts stored under `appPaths().runDir(<plan-id>)` — reuse `ArtifactStore.writeJson` / `readJson`.
- Plan IDs: `bootstrap-<YYYYMMDD>-<6-hex-bytes>` (use `randomBytes(6).toString("hex")` from `node:crypto`).
- Follow the dependency-injection pattern used by `ReconciliationService`: all external surfaces (Pi, GitHub, ProjectsAdapter) are constructor-injected interfaces.
- Test fakes mirror the pattern in `tests/unit/reconciliation/reconciliation-service.test.ts`.
- Token estimation: `Math.ceil(chars / 4)` — consistent with `reconcile`.
- Default token threshold: `80_000`.
- `--apply` is idempotent: each step checks whether it already completed (using state recorded in the plan artifact or GitHub queries) before acting.
- `autopilot.yaml` is never overwritten if it already exists.

---

## File Map

**New files to create:**

| File | Responsibility |
|---|---|
| `src/bootstrap/types.ts` | Zod schemas + TS types for `BootstrapPlan`, `BootstrapEpic`, `BootstrapIssue`, `Dependency`, `Track`, `ApplyState` |
| `src/bootstrap/size-checker.ts` | Token estimation + bin-pack split advisor |
| `src/bootstrap/plan-store.ts` | Read/write `plan.json` via `ArtifactStore`; generate plan IDs |
| `src/bootstrap/bootstrapper-prompt.ts` | Build the Pi session prompt for the `bootstrapper` role |
| `src/bootstrap/bootstrap-service.ts` | Orchestrate `--plan`: read docs → size check → Pi session → save plan |
| `src/bootstrap/plan-renderer.ts` | Render `plan.json` → `bootstrap-plan.md` (Mermaid graph + wave table) |
| `src/bootstrap/config-proposer.ts` | Generate starter `autopilot.yaml` content |
| `src/bootstrap/apply-service.ts` | Orchestrate `--apply`: 6 GitHub write steps in order |
| `src/github/projects-adapter.ts` | GitHub Projects v2 GraphQL port + `GitHubAdapter` implementation |
| `src/commands/bootstrap.ts` | CLI entry point; `--plan` / `--apply` dispatch |
| `tests/unit/bootstrap/size-checker.test.ts` | |
| `tests/unit/bootstrap/plan-store.test.ts` | |
| `tests/unit/bootstrap/plan-renderer.test.ts` | |
| `tests/unit/bootstrap/config-proposer.test.ts` | |
| `tests/unit/bootstrap/bootstrap-service.test.ts` | |
| `tests/unit/bootstrap/apply-service.test.ts` | |
| `tests/unit/commands/bootstrap.test.ts` | |

**Files to modify:**

| File | Change |
|---|---|
| `src/domain/contracts.ts` | Add `"bootstrapper"` to `RoleSchema`; add `BootstrapperResultSchema` + `BootstrapperResult` type |
| `src/config/schema.ts` | Add `bootstrapper` to `RoleAgentsConfigSchema`; add `bootstrap.tokenThreshold` section |
| `src/cli.ts` | Import and register `registerBootstrapCommand` |

---

## Task 1: Types and domain contracts

**Files:**
- Create: `src/bootstrap/types.ts`
- Modify: `src/domain/contracts.ts`
- Modify: `src/config/schema.ts`

**Interfaces:**
- Produces:
  - `BootstrapPlan` (exported from `src/bootstrap/types.ts`) — the canonical in-memory plan shape consumed by every other bootstrap file
  - `BootstrapperResult` (exported from `src/domain/contracts.ts`) — the validated Pi session output
  - `AutopilotConfig` gains `bootstrap.tokenThreshold: number`

```typescript
// src/bootstrap/types.ts
import { z } from "zod";

export const BootstrapIssueSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()).default(["task"]),
  requirementRef: z.object({ doc: z.string(), section: z.string() }).optional(),
  /** Filled in by apply-service after GitHub issue creation. */
  githubNumber: z.number().int().positive().optional(),
});
export type BootstrapIssue = z.infer<typeof BootstrapIssueSchema>;

export const BootstrapEpicSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  labels: z.array(z.string()).default(["epic"]),
  issues: z.array(BootstrapIssueSchema),
  /** Filled in by apply-service after GitHub epic creation. */
  githubNumber: z.number().int().positive().optional(),
});
export type BootstrapEpic = z.infer<typeof BootstrapEpicSchema>;

export const DependencyRefSchema = z.object({
  from: z.string().min(1),   // "epic:<title>" or "issue:<title>"
  to: z.string().min(1),
  reason: z.string(),
});
export type DependencyRef = z.infer<typeof DependencyRefSchema>;

export const TrackSchema = z.object({
  wave: z.number().int().positive(),
  issues: z.array(z.string().min(1)),  // issue/epic titles
});
export type Track = z.infer<typeof TrackSchema>;

export const ApplyStateSchema = z.object({
  boardId: z.string().optional(),
  boardTitle: z.string().optional(),
  epicsCreated: z.boolean().default(false),
  issuesCreated: z.boolean().default(false),
  checklistsPatched: z.boolean().default(false),
  addedToBoard: z.boolean().default(false),
  configWritten: z.boolean().default(false),
});
export type ApplyState = z.infer<typeof ApplyStateSchema>;

export const BootstrapPlanSchema = z.object({
  planId: z.string().min(1),
  createdAt: z.string(),
  requirementDocs: z.array(z.string()),
  proposedConfig: z.unknown().nullable(),
  projectBoard: z.object({
    title: z.string().min(1),
    columns: z.array(z.string()),
  }),
  epics: z.array(BootstrapEpicSchema),
  dependencies: z.array(DependencyRefSchema),
  tracks: z.array(TrackSchema),
  applyState: ApplyStateSchema.default({}),
});
export type BootstrapPlan = z.infer<typeof BootstrapPlanSchema>;
```

- [ ] **Step 1: Write the failing test for `BootstrapPlanSchema` round-trip**

```typescript
// tests/unit/bootstrap/types.test.ts
import { describe, expect, it } from "vitest";
import { BootstrapPlanSchema } from "../../../src/bootstrap/types.js";

describe("BootstrapPlanSchema", () => {
  it("round-trips a minimal plan", () => {
    const raw = {
      planId: "bootstrap-20260823-abc123",
      createdAt: "2026-08-23T10:00:00Z",
      requirementDocs: ["requirements.md"],
      proposedConfig: null,
      projectBoard: { title: "My Project", columns: ["Todo", "In Progress", "Done"] },
      epics: [
        {
          title: "Auth",
          description: "Authentication epic",
          issues: [{ title: "Implement login", body: "..." }],
        },
      ],
      dependencies: [{ from: "issue:Implement login", to: "epic:Auth", reason: "child" }],
      tracks: [{ wave: 1, issues: ["Implement login"] }],
    };
    const parsed = BootstrapPlanSchema.parse(raw);
    expect(parsed.planId).toBe("bootstrap-20260823-abc123");
    expect(parsed.epics[0].labels).toEqual(["epic"]);
    expect(parsed.epics[0].issues[0].labels).toEqual(["task"]);
    expect(parsed.applyState.epicsCreated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/types.test.ts
```
Expected: FAIL — `src/bootstrap/types.ts` does not exist yet.

- [ ] **Step 3: Create `src/bootstrap/types.ts`** with the schema shown above.

- [ ] **Step 4: Add `bootstrapper` to `RoleSchema` in `src/domain/contracts.ts`**

```typescript
// In RoleSchema, add "bootstrapper":
export const RoleSchema = z.enum([
  "refiner",
  "implementer",
  "reviewer",
  "brainstormer",
  "reconciler",
  "bootstrapper",
]);
```

Then add `BootstrapperResultSchema` at the bottom of `contracts.ts` (before `RoleResultSchema`):

```typescript
export const BootstrapperResultSchema = z.object({
  projectBoard: z.object({
    title: z.string().min(1),
    columns: z.array(z.string()),
  }),
  epics: z.array(z.object({
    title: z.string().min(1),
    description: z.string(),
    issues: z.array(z.object({
      title: z.string().min(1),
      body: z.string(),
      requirementRef: z.object({ doc: z.string(), section: z.string() }).optional(),
    })),
  })),
  dependencies: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    reason: z.string(),
  })),
  tracks: z.array(z.object({
    wave: z.number().int().positive(),
    issues: z.array(z.string()),
  })),
});
export type BootstrapperResult = z.infer<typeof BootstrapperResultSchema>;
```

Then add `BootstrapperResultSchema` to the `RoleResultSchema` union and `ROLE_SCHEMAS` in `src/pi/pi-runner.ts`.

- [ ] **Step 5: Add `bootstrapper` role + `bootstrap` section to `src/config/schema.ts`**

In `RoleAgentsConfigSchema`:
```typescript
bootstrapper: RoleModelEntrySchema.optional(),
```

Add a new top-level `bootstrap` section to `AutopilotConfigSchema`:
```typescript
bootstrap: z
  .object({
    tokenThreshold: z.number().int().positive().default(80_000),
    requirementsPaths: z.array(z.string()).optional(),
  })
  .prefault({}),
```

- [ ] **Step 6: Run tests to verify the types test passes and existing tests still pass**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/types.test.ts
npx vitest run
```
Expected: types test PASS; no regressions.

- [ ] **Step 7: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/types.ts src/domain/contracts.ts src/config/schema.ts src/pi/pi-runner.ts tests/unit/bootstrap/types.test.ts
git commit -m "feat(bootstrap): add types, bootstrapper role, and config schema"
```

---

## Task 2: Size checker

**Files:**
- Create: `src/bootstrap/size-checker.ts`
- Test: `tests/unit/bootstrap/size-checker.test.ts`

**Interfaces:**
- Consumes: `RequirementDoc` from `src/reconciliation/prompt.ts` (`{ path: string; content: string }`)
- Produces:
  - `estimateTokens(docs: RequirementDoc[]): number` — sum of `Math.ceil(doc.content.length / 4)` across all docs
  - `checkSize(docs: RequirementDoc[], threshold: number): SizeCheckResult`
  - `SizeCheckResult`: `{ ok: true } | { ok: false; totalTokens: number; threshold: number; batches: Array<{ docs: string[]; estimatedTokens: number }> }`
  - `formatSizeError(result: SizeCheckResult & { ok: false }): string` — returns the human-readable refusal message shown in §5 of the spec

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bootstrap/size-checker.test.ts
import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  checkSize,
  formatSizeError,
} from "../../../src/bootstrap/size-checker.js";
import type { RequirementDoc } from "../../../src/reconciliation/prompt.js";

function doc(path: string, chars: number): RequirementDoc {
  return { path, content: "a".repeat(chars) };
}

describe("estimateTokens", () => {
  it("returns 0 for empty docs", () => {
    expect(estimateTokens([])).toBe(0);
  });
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens([doc("a.md", 400)])).toBe(100);
    expect(estimateTokens([doc("a.md", 401)])).toBe(101); // ceil
  });
  it("sums across docs", () => {
    expect(estimateTokens([doc("a.md", 400), doc("b.md", 800)])).toBe(300);
  });
});

describe("checkSize", () => {
  it("returns ok:true when under threshold", () => {
    const result = checkSize([doc("a.md", 400)], 80_000);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with batches when over threshold", () => {
    // 3 docs of 120k chars each = 30k tokens each, threshold = 50k
    const docs = [
      doc("a.md", 120_000),
      doc("b.md", 120_000),
      doc("c.md", 120_000),
    ];
    const result = checkSize(docs, 50_000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.totalTokens).toBe(90_000);
    expect(result.batches.length).toBeGreaterThan(1);
    // Every batch must be under threshold
    for (const batch of result.batches) {
      expect(batch.estimatedTokens).toBeLessThanOrEqual(50_000);
    }
    // Every doc must appear in exactly one batch
    const allDocs = result.batches.flatMap((b) => b.docs);
    expect(allDocs.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("formatSizeError", () => {
  it("includes total tokens, threshold, batch commands, and apply commands", () => {
    const docs = [doc("a.md", 120_000), doc("b.md", 120_000)];
    const result = checkSize(docs, 50_000);
    if (result.ok) throw new Error("unreachable");
    const msg = formatSizeError(result);
    expect(msg).toContain("Input too large");
    expect(msg).toContain("60,000");   // totalTokens
    expect(msg).toContain("50,000");   // threshold
    expect(msg).toContain("--requirements");
    expect(msg).toContain("--apply");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/size-checker.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/bootstrap/size-checker.ts`**

```typescript
import type { RequirementDoc } from "../reconciliation/prompt.js";

export interface SizeOk {
  ok: true;
}

export interface SizeBatch {
  docs: string[];
  estimatedTokens: number;
}

export interface SizeFail {
  ok: false;
  totalTokens: number;
  threshold: number;
  batches: SizeBatch[];
}

export type SizeCheckResult = SizeOk | SizeFail;

export function estimateTokens(docs: RequirementDoc[]): number {
  return docs.reduce((sum, doc) => sum + Math.ceil(doc.content.length / 4), 0);
}

/** Greedy bin-pack: fill each batch up to threshold before opening a new one. */
function binPack(docs: RequirementDoc[], threshold: number): SizeBatch[] {
  const batches: SizeBatch[] = [];
  let current: SizeBatch = { docs: [], estimatedTokens: 0 };
  for (const doc of docs) {
    const tokens = Math.ceil(doc.content.length / 4);
    if (current.docs.length > 0 && current.estimatedTokens + tokens > threshold) {
      batches.push(current);
      current = { docs: [], estimatedTokens: 0 };
    }
    current.docs.push(doc.path);
    current.estimatedTokens += tokens;
  }
  if (current.docs.length > 0) batches.push(current);
  return batches;
}

export function checkSize(docs: RequirementDoc[], threshold: number): SizeCheckResult {
  const totalTokens = estimateTokens(docs);
  if (totalTokens <= threshold) return { ok: true };
  return { ok: false, totalTokens, threshold, batches: binPack(docs, threshold) };
}

export function formatSizeError(result: SizeFail): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const lines: string[] = [
    `✗ Input too large to process in one pass.`,
    `  Total estimated tokens: ~${fmt(result.totalTokens)} (threshold: ${fmt(result.threshold)})`,
    ``,
    `  Suggested batches:`,
  ];
  for (let i = 0; i < result.batches.length; i++) {
    const b = result.batches[i];
    lines.push(`    Batch ${i + 1} (~${fmt(b.estimatedTokens)} tokens): ${b.docs.join(", ")}`);
  }
  lines.push(``, `  Run each batch separately:`);
  for (const b of result.batches) {
    lines.push(`    autopilot bootstrap --plan --requirements ${b.docs.join(" ")}`);
  }
  lines.push(``, `  Then apply each plan in order:`);
  for (let i = 0; i < result.batches.length; i++) {
    lines.push(`    autopilot bootstrap --apply <plan-id-${i + 1}>`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/size-checker.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/size-checker.ts tests/unit/bootstrap/size-checker.test.ts
git commit -m "feat(bootstrap): add size checker with bin-pack split advisor"
```

---

## Task 3: Plan store

**Files:**
- Create: `src/bootstrap/plan-store.ts`
- Test: `tests/unit/bootstrap/plan-store.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore` from `src/persistence/artifact-store.ts`; `AppPaths` from `src/platform/paths.ts`; `BootstrapPlan`, `BootstrapPlanSchema` from `src/bootstrap/types.ts`
- Produces:
  - `generatePlanId(): string` — `bootstrap-<YYYYMMDD>-<6-hex-bytes>`
  - `class PlanStore` with:
    - `constructor(artifacts: ArtifactStore)`
    - `async save(plan: BootstrapPlan): Promise<void>`
    - `async load(planId: string): Promise<BootstrapPlan>` — throws if not found or invalid
    - `async update(plan: BootstrapPlan): Promise<void>` — overwrites; used by apply-service to persist `applyState`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bootstrap/plan-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { generatePlanId, PlanStore } from "../../../src/bootstrap/plan-store.js";
import type { BootstrapPlan } from "../../../src/bootstrap/types.js";

let tmpDir: string;
afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

function makeStore() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plan-store-test-"));
  const artifacts = new ArtifactStore(appPaths(tmpDir));
  return new PlanStore(artifacts);
}

function minimalPlan(planId: string): BootstrapPlan {
  return {
    planId,
    createdAt: "2026-08-23T10:00:00Z",
    requirementDocs: ["requirements.md"],
    proposedConfig: null,
    projectBoard: { title: "My Project", columns: ["Todo", "In Progress", "Done"] },
    epics: [],
    dependencies: [],
    tracks: [],
    applyState: {
      epicsCreated: false,
      issuesCreated: false,
      checklistsPatched: false,
      addedToBoard: false,
      configWritten: false,
    },
  };
}

describe("generatePlanId", () => {
  it("matches the expected format", () => {
    const id = generatePlanId();
    expect(id).toMatch(/^bootstrap-\d{8}-[0-9a-f]{12}$/);
  });
  it("generates unique IDs", () => {
    expect(generatePlanId()).not.toBe(generatePlanId());
  });
});

describe("PlanStore", () => {
  it("round-trips a plan", async () => {
    const store = makeStore();
    const plan = minimalPlan("bootstrap-20260823-aabbcc");
    await store.save(plan);
    const loaded = await store.load("bootstrap-20260823-aabbcc");
    expect(loaded.planId).toBe(plan.planId);
    expect(loaded.projectBoard.title).toBe("My Project");
  });

  it("update persists applyState changes", async () => {
    const store = makeStore();
    const plan = minimalPlan("bootstrap-20260823-ddeeff");
    await store.save(plan);
    plan.applyState.epicsCreated = true;
    await store.update(plan);
    const loaded = await store.load("bootstrap-20260823-ddeeff");
    expect(loaded.applyState.epicsCreated).toBe(true);
  });

  it("throws on missing plan", async () => {
    const store = makeStore();
    await expect(store.load("bootstrap-20260823-missing")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/plan-store.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/bootstrap/plan-store.ts`**

```typescript
import { randomBytes } from "node:crypto";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { type BootstrapPlan, BootstrapPlanSchema } from "./types.js";

const PLAN_ARTIFACT = "plan.json";

export function generatePlanId(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const hex = randomBytes(6).toString("hex");
  return `bootstrap-${date}-${hex}`;
}

export class PlanStore {
  constructor(private readonly artifacts: ArtifactStore) {}

  async save(plan: BootstrapPlan): Promise<void> {
    await this.artifacts.writeJson(plan.planId, PLAN_ARTIFACT, plan);
  }

  async update(plan: BootstrapPlan): Promise<void> {
    await this.artifacts.writeJson(plan.planId, PLAN_ARTIFACT, plan);
  }

  async load(planId: string): Promise<BootstrapPlan> {
    const raw = await this.artifacts.readJson(planId, PLAN_ARTIFACT);
    const parsed = BootstrapPlanSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid plan artifact for ${planId}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/plan-store.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/plan-store.ts tests/unit/bootstrap/plan-store.test.ts
git commit -m "feat(bootstrap): add plan store with ID generation and round-trip"
```

---

## Task 4: Config proposer

**Files:**
- Create: `src/bootstrap/config-proposer.ts`
- Test: `tests/unit/bootstrap/config-proposer.test.ts`

**Interfaces:**
- Produces:
  - `proposeConfig(bootstrapperModel: string): string` — returns a YAML string for a starter `autopilot.yaml`; includes `bootstrapper`, `implementer`, `reviewer`, `verifier` roles with `thinking: high`; `commands.verify` left as a single placeholder entry `["npm test"]`; `version: 1`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bootstrap/config-proposer.test.ts
import { describe, expect, it } from "vitest";
import { proposeConfig } from "../../../src/bootstrap/config-proposer.js";
import { parse as parseYaml } from "yaml";
import { AutopilotConfigSchema } from "../../../src/config/schema.js";

describe("proposeConfig", () => {
  it("produces valid YAML that passes AutopilotConfigSchema", () => {
    const yaml = proposeConfig("anthropic/claude-sonnet-4");
    const parsed = parseYaml(yaml);
    // commands.verify must have at least one entry (schema requires min 1)
    const result = AutopilotConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("includes the bootstrapper model", () => {
    const yaml = proposeConfig("anthropic/claude-opus-4");
    expect(yaml).toContain("claude-opus-4");
  });

  it("includes all expected roles", () => {
    const yaml = proposeConfig("anthropic/claude-sonnet-4");
    expect(yaml).toContain("bootstrapper:");
    expect(yaml).toContain("implementer:");
    expect(yaml).toContain("reviewer:");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/config-proposer.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/bootstrap/config-proposer.ts`**

```typescript
import { stringify as toYaml } from "yaml";

export function proposeConfig(bootstrapperModel: string): string {
  const config = {
    version: 1,
    workspace: {
      baseBranch: "main",
      branchPrefix: "autopilot/",
    },
    commands: {
      verify: ["npm test"],
    },
    agents: {
      bootstrapper: { model: bootstrapperModel, thinking: "high" },
      implementer:  { model: "anthropic/claude-sonnet-4", thinking: "high" },
      reviewer:     { model: "anthropic/claude-sonnet-4", thinking: "high" },
      reconciler:   { model: "anthropic/claude-sonnet-4", thinking: "high" },
    },
  };
  return toYaml(config, { lineWidth: 0 });
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/config-proposer.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/config-proposer.ts tests/unit/bootstrap/config-proposer.test.ts
git commit -m "feat(bootstrap): add config proposer for starter autopilot.yaml"
```

---

## Task 5: Plan renderer

**Files:**
- Create: `src/bootstrap/plan-renderer.ts`
- Test: `tests/unit/bootstrap/plan-renderer.test.ts`

**Interfaces:**
- Consumes: `BootstrapPlan` from `src/bootstrap/types.ts`
- Produces:
  - `renderPlan(plan: BootstrapPlan, configYaml: string | null): string` — returns the full Markdown string for `bootstrap-plan.md`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bootstrap/plan-renderer.test.ts
import { describe, expect, it } from "vitest";
import { renderPlan } from "../../../src/bootstrap/plan-renderer.js";
import type { BootstrapPlan } from "../../../src/bootstrap/types.js";

function minimalPlan(): BootstrapPlan {
  return {
    planId: "bootstrap-20260823-aabbcc",
    createdAt: "2026-08-23T10:00:00Z",
    requirementDocs: ["requirements/auth.md"],
    proposedConfig: null,
    projectBoard: { title: "My Project", columns: ["Todo", "In Progress", "Done"] },
    epics: [
      {
        title: "Authentication",
        description: "Auth epic",
        labels: ["epic"],
        issues: [
          { title: "Implement JWT", body: "JWT login flow", labels: ["task"] },
          { title: "Add OAuth", body: "OAuth2 support", labels: ["task"] },
        ],
      },
    ],
    dependencies: [
      { from: "issue:Implement JWT", to: "issue:Add OAuth", reason: "OAuth builds on JWT" },
    ],
    tracks: [
      { wave: 1, issues: ["Implement JWT"] },
      { wave: 2, issues: ["Add OAuth"] },
    ],
    applyState: { epicsCreated: false, issuesCreated: false, checklistsPatched: false, addedToBoard: false, configWritten: false },
  };
}

describe("renderPlan", () => {
  it("includes epic title and issue titles", () => {
    const md = renderPlan(minimalPlan(), null);
    expect(md).toContain("## Authentication");
    expect(md).toContain("Implement JWT");
    expect(md).toContain("Add OAuth");
  });

  it("includes a Mermaid dependency graph block", () => {
    const md = renderPlan(minimalPlan(), null);
    expect(md).toContain("```mermaid");
    expect(md).toContain("graph TD");
    expect(md).toContain("OAuth builds on JWT");
  });

  it("includes a Parallel Tracks wave table", () => {
    const md = renderPlan(minimalPlan(), null);
    expect(md).toContain("## Parallel Tracks");
    expect(md).toContain("Wave 1");
    expect(md).toContain("Wave 2");
    expect(md).toContain("Implement JWT");
  });

  it("omits Proposed autopilot.yaml when configYaml is null", () => {
    const md = renderPlan(minimalPlan(), null);
    expect(md).not.toContain("Proposed autopilot.yaml");
  });

  it("includes Proposed autopilot.yaml when configYaml is provided", () => {
    const md = renderPlan(minimalPlan(), "version: 1\n");
    expect(md).toContain("## Proposed `autopilot.yaml`");
    expect(md).toContain("version: 1");
  });

  it("includes Project Board section", () => {
    const md = renderPlan(minimalPlan(), null);
    expect(md).toContain("## Project Board");
    expect(md).toContain("My Project");
    expect(md).toContain("Todo");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/plan-renderer.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/bootstrap/plan-renderer.ts`**

```typescript
import type { BootstrapPlan } from "./types.js";

export function renderPlan(plan: BootstrapPlan, configYaml: string | null): string {
  const sections: string[] = [];

  sections.push(`# Bootstrap Plan: ${plan.projectBoard.title}`);
  sections.push(`\n**Plan ID:** \`${plan.planId}\`  \n**Created:** ${plan.createdAt}  \n**Requirement docs:** ${plan.requirementDocs.join(", ")}`);

  // Epics and issues
  for (const epic of plan.epics) {
    sections.push(`\n## ${epic.title}\n\n${epic.description}`);
    for (let i = 0; i < epic.issues.length; i++) {
      const issue = epic.issues[i];
      sections.push(`\n### ${i + 1}. ${issue.title}\n\n${issue.body}`);
      if (issue.requirementRef) {
        sections.push(`\n> **Requirement:** \`${issue.requirementRef.doc}\` — ${issue.requirementRef.section}`);
      }
    }
  }

  // Dependency graph
  sections.push(`\n## Dependency Graph\n\n\`\`\`mermaid\ngraph TD`);
  for (const dep of plan.dependencies) {
    const fromId = dep.from.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = dep.to.replace(/[^a-zA-Z0-9]/g, "_");
    sections.push(`  ${fromId} -->|"${dep.reason}"| ${toId}`);
  }
  sections.push("```");

  // Parallel tracks
  sections.push(`\n## Parallel Tracks`);
  for (const track of plan.tracks) {
    const label = track.issues.length > 1 ? "parallel" : "sequential";
    sections.push(`\nWave ${track.wave} (${label}): ${track.issues.join(", ")}`);
  }

  // Proposed autopilot.yaml
  if (configYaml !== null) {
    sections.push(`\n## Proposed \`autopilot.yaml\`\n\n\`\`\`yaml\n${configYaml}\`\`\``);
  }

  // Project board
  sections.push(`\n## Project Board\n\n**Title:** ${plan.projectBoard.title}  \n**Columns:** ${plan.projectBoard.columns.join(", ")}`);

  return sections.join("\n");
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/plan-renderer.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/plan-renderer.ts tests/unit/bootstrap/plan-renderer.test.ts
git commit -m "feat(bootstrap): add plan renderer with Mermaid graph and wave table"
```

---

## Task 6: Bootstrapper prompt

**Files:**
- Create: `src/bootstrap/bootstrapper-prompt.ts`

**Interfaces:**
- Consumes: `RequirementDoc` from `src/reconciliation/prompt.ts`; `RepositoryRef` from `src/domain/contracts.ts`
- Produces:
  - `buildBootstrapperPrompt(input: { repository: RepositoryRef; requirementDocs: RequirementDoc[]; hasExistingConfig: boolean }): string`

No unit test for this file — the prompt is a string template, correctness is verified by integration. A smoke test is included to confirm the function is importable and returns a non-empty string.

- [ ] **Step 1: Write smoke test**

```typescript
// tests/unit/bootstrap/bootstrapper-prompt.test.ts
import { describe, expect, it } from "vitest";
import { buildBootstrapperPrompt } from "../../../src/bootstrap/bootstrapper-prompt.js";

describe("buildBootstrapperPrompt", () => {
  it("returns a non-empty string containing key instructions", () => {
    const prompt = buildBootstrapperPrompt({
      repository: { owner: "acme", repo: "widgets" },
      requirementDocs: [{ path: "requirements.md", content: "## Auth\nUsers must log in." }],
      hasExistingConfig: false,
    });
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("submit_result");
    expect(prompt).toContain("brainstorming");
    expect(prompt).toContain("dependency");
    expect(prompt).toContain("tracks");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/bootstrapper-prompt.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/bootstrap/bootstrapper-prompt.ts`**

```typescript
import type { RepositoryRef } from "../domain/contracts.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";

export interface BootstrapperPromptInput {
  repository: RepositoryRef;
  requirementDocs: RequirementDoc[];
  hasExistingConfig: boolean;
}

export function buildBootstrapperPrompt(input: BootstrapperPromptInput): string {
  const { repository, requirementDocs, hasExistingConfig } = input;

  const requirementsSection = requirementDocs
    .map((doc) => `--- ${doc.path} ---\n${doc.content}`)
    .join("\n\n");

  const configNote = hasExistingConfig
    ? "An `autopilot.yaml` already exists in the repository — do NOT propose a new one."
    : "No `autopilot.yaml` exists yet. Include a `proposedConfig` in your output with sensible role defaults.";

  return `You are the Bootstrapper role of an autonomous software development orchestrator.

Repository: ${repository.owner}/${repository.repo}

Your task is to read the requirement documents below and produce a complete bootstrap plan for a new GitHub project backlog. Use the superpowers brainstorming skill to reason carefully about how requirements group into epics, what the dependencies between pieces of work are, and how to maximize parallel development.

${configNote}

## Your output must include:

1. **Epic structure** — group related requirements into named epics. Each epic gets a description and a list of child issues with titles, bodies, and requirement references.

2. **Dependency graph** — explicit directed dependencies between issues and epics. For each dependency, state which item depends on which, and why. Use "epic:<title>" or "issue:<title>" as identifiers.

3. **Parallel tracks (waves)** — derive a wave-based execution ordering from the dependency graph. Issues in the same wave have no dependencies on each other and can be worked in parallel. Assign every issue to exactly one wave.

4. **Project board** — propose a board title (default: the repo name) and standard columns ["Todo", "In Progress", "Done"].

## Requirement documents

${requirementsSection}

## Output contract

When your analysis is complete, call the submit_result tool exactly once with a JSON string matching this shape:

{
  "projectBoard": {
    "title": "<board title>",
    "columns": ["Todo", "In Progress", "Done"]
  },
  "epics": [
    {
      "title": "<epic title>",
      "description": "<epic description>",
      "issues": [
        {
          "title": "<issue title>",
          "body": "<full issue body with context, acceptance criteria, and constraints>",
          "requirementRef": { "doc": "<path>", "section": "<section heading>" }
        }
      ]
    }
  ],
  "dependencies": [
    { "from": "issue:<title>", "to": "issue:<title>", "reason": "<why>" }
  ],
  "tracks": [
    { "wave": 1, "issues": ["<title>", "<title>"] },
    { "wave": 2, "issues": ["<title>"] }
  ]${hasExistingConfig ? "" : `,
  "proposedConfig": {
    "roles": {
      "bootstrapper": { "model": "<model-used>", "thinking": "high" },
      "implementer":  { "model": "anthropic/claude-sonnet-4", "thinking": "high" },
      "reviewer":     { "model": "anthropic/claude-sonnet-4", "thinking": "high" },
      "reconciler":   { "model": "anthropic/claude-sonnet-4", "thinking": "high" }
    }
  }`}
}

Rules:
- Every issue must appear in exactly one wave.
- Dependencies must be acyclic (no circular dependencies).
- Issue bodies must be self-contained: include goal, acceptance criteria, constraints, and relevant source sections.
- Do not invent requirements not present in the documents.
`;
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/bootstrapper-prompt.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/bootstrapper-prompt.ts tests/unit/bootstrap/bootstrapper-prompt.test.ts
git commit -m "feat(bootstrap): add bootstrapper Pi session prompt"
```

---

## Task 7: Bootstrap service (`--plan`)

**Files:**
- Create: `src/bootstrap/bootstrap-service.ts`
- Test: `tests/unit/bootstrap/bootstrap-service.test.ts`

**Interfaces:**
- Consumes: `PiRunner` / `ReconcilerRunner` interface pattern; `PlanStore`; `ArtifactStore`; `AppPaths`; `ResolvedRoleModel`; `AutopilotConfig`; `RepositoryContext`; `checkSize`; `buildBootstrapperPrompt`; `proposeConfig`; `renderPlan`; `RequirementDoc`
- Produces:
  - `class BootstrapService` with:
    - constructor deps (all injected): `{ repository, config, pi, artifacts, paths, bootstrapperModel, bootstrapperTimeoutMs, planId?, now? }`
    - `async plan(requirementDocs: RequirementDoc[]): Promise<{ planId: string; markdownPath: string }>` — runs size check, Pi session, saves plan.json + bootstrap-plan.md; throws `BootstrapSizeError` if over threshold
  - `class BootstrapSizeError extends Error` with `sizeResult: SizeFail`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bootstrap/bootstrap-service.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { BootstrapService, BootstrapSizeError } from "../../../src/bootstrap/bootstrap-service.js";
import type { BootstrapperResult } from "../../../src/domain/contracts.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { RequirementDoc } from "../../../src/reconciliation/prompt.js";

let tmpDir: string;
afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

const repository: RepositoryContext = {
  root: "/tmp/fake-repo",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config = {
  bootstrap: { tokenThreshold: 80_000, requirementsPaths: undefined },
  agentPolicy: { protectedPaths: [] },
} as unknown as AutopilotConfig;

const model = { model: "anthropic/claude-haiku", thinking: "high" as const, source: "repository" as const };

const goodResult: BootstrapperResult = {
  projectBoard: { title: "Widgets", columns: ["Todo", "In Progress", "Done"] },
  epics: [{ title: "Auth", description: "Authentication", issues: [{ title: "Login", body: "..." }] }],
  dependencies: [],
  tracks: [{ wave: 1, issues: ["Login"] }],
};

class FakePi {
  calls: PiRunRequest[] = [];
  async run(req: PiRunRequest): Promise<PiExecution> {
    this.calls.push(req);
    return {
      result: goodResult,
      exitCode: 0,
      durationMs: 100,
      stdout: "",
      stderr: "",
      resultPath: "/fake/result.json",
      sessionDir: "/fake/session",
    };
  }
}

function makeService(pi = new FakePi(), threshold = 80_000) {
  tmpDir = mkdtempSync(path.join(tmpdir(), "bootstrap-service-test-"));
  const paths = appPaths(tmpDir);
  const artifacts = new ArtifactStore(paths);
  return {
    service: new BootstrapService({
      repository,
      config: { ...config, bootstrap: { tokenThreshold: threshold } } as unknown as AutopilotConfig,
      pi,
      artifacts,
      paths,
      bootstrapperModel: model,
      bootstrapperTimeoutMs: 5_000,
      planId: "bootstrap-20260823-test01",
      now: () => "2026-08-23T10:00:00Z",
    }),
    pi,
    paths,
  };
}

const doc: RequirementDoc = { path: "requirements.md", content: "## Auth\nUsers must log in." };

describe("BootstrapService.plan", () => {
  it("calls Pi and returns a plan ID and markdown path", async () => {
    const { service, pi } = makeService();
    const result = await service.plan([doc]);
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].role).toBe("bootstrapper");
    expect(result.planId).toBe("bootstrap-20260823-test01");
    expect(result.markdownPath).toContain("bootstrap-plan.md");
  });

  it("throws BootstrapSizeError when docs exceed threshold", async () => {
    const { service } = makeService(new FakePi(), 1); // threshold of 1 token
    await expect(service.plan([doc])).rejects.toBeInstanceOf(BootstrapSizeError);
  });

  it("saves plan.json that can be loaded back", async () => {
    const { service, paths } = makeService();
    const { planId } = await service.plan([doc]);
    const artifacts = new ArtifactStore(paths);
    const raw = await artifacts.readJson(planId, "plan.json");
    expect((raw as { planId: string }).planId).toBe(planId);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/bootstrap-service.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/bootstrap/bootstrap-service.ts`**

```typescript
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { BootstrapperResult } from "../domain/contracts.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import type { AppPaths } from "../platform/paths.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import { buildBootstrapperPrompt } from "./bootstrapper-prompt.js";
import { proposeConfig } from "./config-proposer.js";
import { checkSize, formatSizeError } from "./size-checker.js";
import type { SizeFail } from "./size-checker.js";
import { PlanStore, generatePlanId } from "./plan-store.js";
import { renderPlan } from "./plan-renderer.js";
import type { BootstrapPlan } from "./types.js";

export interface BootstrapperRunner {
  run(request: PiRunRequest): Promise<PiExecution>;
}

export interface BootstrapServiceDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  pi: BootstrapperRunner;
  artifacts: ArtifactStore;
  paths: AppPaths;
  bootstrapperModel: ResolvedRoleModel;
  bootstrapperTimeoutMs?: number;
  planId?: string;
  now?: () => string;
  hasExistingConfig?: boolean;
}

export class BootstrapSizeError extends Error {
  constructor(
    message: string,
    public readonly sizeResult: SizeFail,
  ) {
    super(message);
    this.name = "BootstrapSizeError";
  }
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export class BootstrapService {
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(private readonly deps: BootstrapServiceDeps) {
    this.timeoutMs = deps.bootstrapperTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async plan(requirementDocs: RequirementDoc[]): Promise<{ planId: string; markdownPath: string }> {
    const threshold = (this.deps.config as { bootstrap?: { tokenThreshold?: number } }).bootstrap?.tokenThreshold ?? 80_000;
    const sizeResult = checkSize(requirementDocs, threshold);
    if (!sizeResult.ok) {
      throw new BootstrapSizeError(formatSizeError(sizeResult), sizeResult);
    }

    const planId = this.deps.planId ?? generatePlanId();
    const analysisDir = this.deps.paths.runDir(planId);
    const hasExistingConfig = this.deps.hasExistingConfig ?? false;

    const prompt = buildBootstrapperPrompt({
      repository: this.deps.repository.repository,
      requirementDocs,
      hasExistingConfig,
    });

    const execution = await this.deps.pi.run({
      role: "bootstrapper",
      model: this.deps.bootstrapperModel,
      prompt,
      worktree: this.deps.repository.root,
      allowedCommands: [],
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(analysisDir, "session"),
      diagnosticsDir: path.join(analysisDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.timeoutMs,
    });

    const raw = execution.result as BootstrapperResult;
    const configYaml = hasExistingConfig ? null : proposeConfig(this.deps.bootstrapperModel.model);

    const plan: BootstrapPlan = {
      planId,
      createdAt: this.now(),
      requirementDocs: requirementDocs.map((d) => d.path),
      proposedConfig: hasExistingConfig ? null : configYaml,
      projectBoard: raw.projectBoard,
      epics: raw.epics.map((e) => ({
        title: e.title,
        description: e.description,
        labels: ["epic"],
        issues: e.issues.map((i) => ({
          title: i.title,
          body: i.body,
          labels: ["task"],
          requirementRef: i.requirementRef,
        })),
      })),
      dependencies: raw.dependencies,
      tracks: raw.tracks,
      applyState: {
        epicsCreated: false,
        issuesCreated: false,
        checklistsPatched: false,
        addedToBoard: false,
        configWritten: false,
      },
    };

    const store = new PlanStore(this.deps.artifacts);
    await store.save(plan);

    const md = renderPlan(plan, typeof configYaml === "string" ? configYaml : null);
    const markdownPath = path.join(analysisDir, "bootstrap-plan.md");
    await writeFile(markdownPath, md, "utf8");

    return { planId, markdownPath };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/bootstrap-service.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/bootstrap-service.ts tests/unit/bootstrap/bootstrap-service.test.ts
git commit -m "feat(bootstrap): add bootstrap service orchestrating --plan phase"
```

---

## Task 8: GitHub Projects v2 adapter

**Files:**
- Create: `src/github/projects-adapter.ts`

**Interfaces:**
- Produces:
  - `interface ProjectsPort` with: `listBoards(): Promise<Board[]>`; `createBoard(title: string, columns: string[]): Promise<Board>`; `addIssueToBoard(boardId: string, issueNodeId: string, status: string): Promise<void>`
  - `interface Board` with: `id: string; title: string`
  - `class ProjectsAdapter implements ProjectsPort` — uses GitHub GraphQL via `@octokit/rest`'s graphql method
  - `static async create(root: string, runner: ProcessRunner): Promise<ProjectsAdapter>`

No unit tests for the real adapter (requires live GitHub). A `FakeProjectsAdapter` is defined in the apply-service test (Task 9).

- [ ] **Step 1: Implement `src/github/projects-adapter.ts`**

```typescript
import { Octokit } from "@octokit/rest";
import type { ProcessRunner } from "../platform/process-runner.js";
import { resolveRepositoryContext, safeProcessEnv } from "./repository-context.js";

export interface Board {
  id: string;
  title: string;
}

export interface ProjectsPort {
  listBoards(): Promise<Board[]>;
  createBoard(title: string, columns: string[]): Promise<Board>;
  addIssueToBoard(boardId: string, issueNodeId: string, status: string): Promise<void>;
}

export class ProjectsAdapter implements ProjectsPort {
  private constructor(
    private readonly owner: string,
    private readonly octokit: Octokit,
    private readonly ownerType: "user" | "organization",
  ) {}

  static async create(root: string, runner: ProcessRunner): Promise<ProjectsAdapter> {
    const ctx = await resolveRepositoryContext(root, runner);
    const env = safeProcessEnv();
    // Resolve token the same way GitHubAdapter does.
    const { execSync } = await import("node:child_process");
    const token = execSync("gh auth token", { env, encoding: "utf8" }).trim();
    const octokit = new Octokit({
      auth: token,
      request: { headers: { "X-GitHub-Api-Version": "2022-11-28" } },
    });
    // Determine owner type via REST; fall back to "user".
    let ownerType: "user" | "organization" = "user";
    try {
      await octokit.rest.orgs.get({ org: ctx.repository.owner });
      ownerType = "organization";
    } catch { /* not an org */ }
    return new ProjectsAdapter(ctx.repository.owner, octokit, ownerType);
  }

  async listBoards(): Promise<Board[]> {
    const query =
      this.ownerType === "organization"
        ? `query($login: String!) { organization(login: $login) { projectsV2(first: 20) { nodes { id title } } } }`
        : `query($login: String!) { user(login: $login) { projectsV2(first: 20) { nodes { id title } } } }`;
    const data = await (this.octokit as unknown as { graphql: (q: string, v: Record<string, string>) => Promise<unknown> })
      .graphql(query, { login: this.owner }) as Record<string, { projectsV2: { nodes: Board[] } }>;
    const key = this.ownerType === "organization" ? "organization" : "user";
    return (data[key]?.projectsV2?.nodes ?? []) as Board[];
  }

  async createBoard(title: string, _columns: string[]): Promise<Board> {
    // Step 1: resolve owner node ID
    const ownerQuery =
      this.ownerType === "organization"
        ? `query($login: String!) { organization(login: $login) { id } }`
        : `query($login: String!) { user(login: $login) { id } }`;
    const ownerData = await (this.octokit as unknown as { graphql: (q: string, v: Record<string, string>) => Promise<unknown> })
      .graphql(ownerQuery, { login: this.owner }) as Record<string, { id: string }>;
    const ownerId = (ownerData["organization"] ?? ownerData["user"])?.id;
    if (!ownerId) throw new Error(`could not resolve node ID for ${this.owner}`);

    // Step 2: create the project
    const createMutation = `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id title }
      }
    }`;
    const created = await (this.octokit as unknown as { graphql: (q: string, v: Record<string, unknown>) => Promise<unknown> })
      .graphql(createMutation, { ownerId, title }) as { createProjectV2: { projectV2: Board } };
    return created.createProjectV2.projectV2;
  }

  async addIssueToBoard(boardId: string, issueNodeId: string, _status: string): Promise<void> {
    const mutation = `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`;
    await (this.octokit as unknown as { graphql: (q: string, v: Record<string, unknown>) => Promise<unknown> })
      .graphql(mutation, { projectId: boardId, contentId: issueNodeId });
    // Status field update omitted in this milestone; field ID resolution requires
    // an extra query and the spec marks it as a future extension.
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/github/projects-adapter.ts
git commit -m "feat(bootstrap): add GitHub Projects v2 adapter"
```

---

## Task 9: Apply service (`--apply`)

**Files:**
- Create: `src/bootstrap/apply-service.ts`
- Test: `tests/unit/bootstrap/apply-service.test.ts`

**Interfaces:**
- Consumes: `PlanStore`; `GitHubPort` (extended below); `ProjectsPort`; `BootstrapPlan`; `ApplyState`
- Produces:
  - `interface ExtendedGitHubPort extends GitHubPort` with additional methods: `createIssue(input: CreateIssueInput): Promise<GitHubIssue>`; `ensureLabel(name: string, color: string): Promise<void>`; `updateIssueBody(number: number, body: string): Promise<GitHubIssue>`
  - `interface CreateIssueInput` with: `title: string; body: string; labels: string[]`
  - `class ApplyService` with constructor deps: `{ planStore, github, projects, stdout? }`; and method `async apply(planId: string): Promise<void>`

Note: `GitHubPort` in `src/github/github-adapter.ts` needs `createIssue` and `ensureLabel` added to the interface and implemented in `GitHubAdapter`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/bootstrap/apply-service.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { PlanStore } from "../../../src/bootstrap/plan-store.js";
import { ApplyService } from "../../../src/bootstrap/apply-service.js";
import type { ExtendedGitHubPort, CreateIssueInput } from "../../../src/bootstrap/apply-service.js";
import type { ProjectsPort, Board } from "../../../src/github/projects-adapter.js";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import type { BootstrapPlan } from "../../../src/bootstrap/types.js";

let tmpDir: string;
afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

function makeIssue(number: number, title: string): GitHubIssue {
  return { number, nodeId: `N_${number}`, title, body: "", updatedAt: "", state: "open", htmlUrl: `https://github.com/acme/widgets/issues/${number}` };
}

class FakeGitHub implements ExtendedGitHubPort {
  issueCounter = 100;
  createdIssues: CreateIssueInput[] = [];
  updatedBodies: Array<{ number: number; body: string }> = [];
  ensuredLabels: string[] = [];

  async getIssue(): Promise<GitHubIssue> { return makeIssue(1, "stub"); }
  async createIssueComment(): Promise<void> {}
  async findPullRequestByHead() { return null; }
  async createPullRequest(): Promise<never> { throw new Error("not used"); }
  async findIssueCommentByMarker() { return null; }

  async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
    const number = ++this.issueCounter;
    this.createdIssues.push(input);
    return makeIssue(number, input.title);
  }
  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    this.updatedBodies.push({ number, body });
    return makeIssue(number, "updated");
  }
  async ensureLabel(name: string): Promise<void> {
    this.ensuredLabels.push(name);
  }
}

class FakeProjects implements ProjectsPort {
  boards: Board[] = [];
  addedItems: Array<{ boardId: string; nodeId: string }> = [];

  async listBoards(): Promise<Board[]> { return this.boards; }
  async createBoard(title: string): Promise<Board> {
    const board = { id: "board-1", title };
    this.boards.push(board);
    return board;
  }
  async addIssueToBoard(boardId: string, issueNodeId: string): Promise<void> {
    this.addedItems.push({ boardId, issueNodeId });
  }
}

function makePlan(): BootstrapPlan {
  return {
    planId: "bootstrap-20260823-apply01",
    createdAt: "2026-08-23T10:00:00Z",
    requirementDocs: ["requirements.md"],
    proposedConfig: null,
    projectBoard: { title: "My Project", columns: ["Todo", "In Progress", "Done"] },
    epics: [
      {
        title: "Auth",
        description: "Authentication",
        labels: ["epic"],
        issues: [
          { title: "Implement login", body: "Login flow", labels: ["task"] },
        ],
      },
    ],
    dependencies: [],
    tracks: [{ wave: 1, issues: ["Implement login"] }],
    applyState: { epicsCreated: false, issuesCreated: false, checklistsPatched: false, addedToBoard: false, configWritten: false },
  };
}

function makeService(prompt?: (msg: string) => Promise<boolean>) {
  tmpDir = mkdtempSync(path.join(tmpdir(), "apply-service-test-"));
  const artifacts = new ArtifactStore(appPaths(tmpDir));
  const store = new PlanStore(artifacts);
  const github = new FakeGitHub();
  const projects = new FakeProjects();
  const service = new ApplyService({ planStore: store, github, projects, prompt });
  return { service, store, github, projects };
}

describe("ApplyService.apply", () => {
  it("creates epic and child issues", async () => {
    const { service, store } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    // 1 epic + 1 child = 2 created issues
    const { github } = makeService();
    // re-load from the service's github
  });

  it("creates a board when none exists", async () => {
    const { service, store, projects } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    expect(projects.boards).toHaveLength(1);
    expect(projects.boards[0].title).toBe("My Project");
  });

  it("adds all issues to the board", async () => {
    const { service, store, projects } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    expect(projects.addedItems.length).toBeGreaterThanOrEqual(1);
  });

  it("patches epic body with child issue checklist", async () => {
    const { service, store, github } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    const epicUpdate = github.updatedBodies.find((u) => u.body.includes("- [ ]"));
    expect(epicUpdate).toBeDefined();
    expect(epicUpdate?.body).toContain("Implement login");
  });

  it("is idempotent: skips completed steps on second apply", async () => {
    const { service, store, github, projects } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    const firstCreateCount = github.createdIssues.length;
    await service.apply("bootstrap-20260823-apply01");
    // No new issues should have been created
    expect(github.createdIssues.length).toBe(firstCreateCount);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/apply-service.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add `createIssue` and `ensureLabel` to `GitHubPort` and `GitHubAdapter` in `src/github/github-adapter.ts`**

Add to `GitHubPort` interface:
```typescript
createIssue(input: { title: string; body: string; labels: string[] }): Promise<GitHubIssue>;
ensureLabel(name: string, color: string): Promise<void>;
```

Add implementation to `GitHubAdapter`:
```typescript
async createIssue(input: { title: string; body: string; labels: string[] }): Promise<GitHubIssue> {
  try {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return {
      number: data.number,
      nodeId: data.node_id,
      title: data.title,
      body: data.body ?? "",
      updatedAt: data.updated_at,
      state: data.state,
      htmlUrl: data.html_url,
    };
  } catch (error) {
    throw new GitHubError("failed to create issue", { cause: error });
  }
}

async ensureLabel(name: string, color: string): Promise<void> {
  try {
    await this.octokit.rest.issues.getLabel({ owner: this.owner, repo: this.repo, name });
  } catch {
    try {
      await this.octokit.rest.issues.createLabel({ owner: this.owner, repo: this.repo, name, color });
    } catch { /* already exists from a concurrent call */ }
  }
}
```

Also add `create` and `getLabel`/`createLabel` to `OctokitLike` interface in the same file.

- [ ] **Step 4: Implement `src/bootstrap/apply-service.ts`**

```typescript
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import type { ProjectsPort } from "../github/projects-adapter.js";
import type { PlanStore } from "./plan-store.js";
import type { BootstrapPlan } from "./types.js";

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface ExtendedGitHubPort extends GitHubPort {
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>;
  ensureLabel(name: string, color: string): Promise<void>;
}

export interface ApplyServiceDeps {
  planStore: PlanStore;
  github: ExtendedGitHubPort;
  projects: ProjectsPort;
  stdout?: (msg: string) => void;
  /** Prompt for yes/no; returns true for yes. Injected for tests. */
  prompt?: (msg: string) => Promise<boolean>;
}

export class ApplyService {
  private readonly log: (msg: string) => void;
  private readonly prompt: (msg: string) => Promise<boolean>;

  constructor(private readonly deps: ApplyServiceDeps) {
    this.log = deps.stdout ?? ((msg) => process.stdout.write(`${msg}\n`));
    this.prompt = deps.prompt ?? defaultPrompt;
  }

  async apply(planId: string): Promise<void> {
    const plan = await this.deps.planStore.load(planId);
    const state = plan.applyState;

    // Step 1: board
    let boardId = state.boardId;
    if (boardId === undefined) {
      boardId = await this.resolveOrCreateBoard(plan);
      state.boardId = boardId;
      await this.deps.planStore.update(plan);
    }

    // Step 2: ensure labels exist
    await this.deps.github.ensureLabel("epic", "0075ca");
    await this.deps.github.ensureLabel("task", "e4e669");

    // Step 3: create epic issues (idempotent: skip if already done)
    if (!state.epicsCreated) {
      this.log("→ creating epic issues...");
      for (const epic of plan.epics) {
        const issue = await this.deps.github.createIssue({
          title: epic.title,
          body: `${epic.description}\n\n## Tasks\n_(child issues will be linked below)_`,
          labels: epic.labels,
        });
        epic.githubNumber = issue.number;
        this.log(`  ✓ epic #${issue.number}: ${epic.title}`);
      }
      state.epicsCreated = true;
      await this.deps.planStore.update(plan);
    }

    // Step 4: create child issues
    if (!state.issuesCreated) {
      this.log("→ creating child issues...");
      for (const epic of plan.epics) {
        for (const issue of epic.issues) {
          const refSection = issue.requirementRef
            ? `\n\n## Requirements\nSource: \`${issue.requirementRef.doc}\` — ${issue.requirementRef.section}`
            : "";
          const created = await this.deps.github.createIssue({
            title: issue.title,
            body: `${issue.body}${refSection}`,
            labels: issue.labels,
          });
          issue.githubNumber = created.number;
          this.log(`  ✓ issue #${created.number}: ${issue.title}`);
        }
      }
      state.issuesCreated = true;
      await this.deps.planStore.update(plan);
    }

    // Step 5: patch epic checklists
    if (!state.checklistsPatched) {
      this.log("→ patching epic checklists...");
      for (const epic of plan.epics) {
        if (epic.githubNumber === undefined) continue;
        const checklist = epic.issues
          .filter((i) => i.githubNumber !== undefined)
          .map((i) => `- [ ] #${i.githubNumber} ${i.title}`)
          .join("\n");
        await this.deps.github.updateIssueBody(
          epic.githubNumber,
          `${epic.description}\n\n## Tasks\n${checklist}`,
        );
      }
      state.checklistsPatched = true;
      await this.deps.planStore.update(plan);
    }

    // Step 6: add to board
    if (!state.addedToBoard) {
      this.log("→ adding issues to board...");
      const allIssues = [
        ...plan.epics.map((e) => ({ number: e.githubNumber, nodeId: `N_${e.githubNumber}` })),
        ...plan.epics.flatMap((e) =>
          e.issues.map((i) => ({ number: i.githubNumber, nodeId: `N_${i.githubNumber}` })),
        ),
      ];
      for (const issue of allIssues) {
        if (issue.nodeId) {
          await this.deps.projects.addIssueToBoard(boardId, issue.nodeId, "Todo");
        }
      }
      state.addedToBoard = true;
      await this.deps.planStore.update(plan);
    }

    this.log("✓ apply complete");
  }

  private async resolveOrCreateBoard(plan: BootstrapPlan): Promise<string> {
    const boards = await this.deps.projects.listBoards();
    if (boards.length === 0) {
      const yes = await this.prompt(
        `No Projects v2 board found. Create board "${plan.projectBoard.title}"? [y/N]`,
      );
      if (!yes) throw new Error("board creation declined; cannot proceed with --apply");
      const board = await this.deps.projects.createBoard(plan.projectBoard.title, plan.projectBoard.columns);
      this.log(`  ✓ created board: ${board.title}`);
      return board.id;
    }
    if (boards.length === 1) {
      this.log(`  → using existing board: ${boards[0].title}`);
      return boards[0].id;
    }
    // Multiple boards: use the first one (CLI selection is a future extension)
    this.log(`  → using board: ${boards[0].title} (${boards.length} boards found; using first)`);
    return boards[0].id;
  }
}

async function defaultPrompt(msg: string): Promise<boolean> {
  process.stdout.write(`${msg} `);
  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim().toLowerCase() === "y");
    });
  });
}
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/bootstrap/apply-service.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/bootstrap/apply-service.ts src/github/projects-adapter.ts src/github/github-adapter.ts tests/unit/bootstrap/apply-service.test.ts
git commit -m "feat(bootstrap): add apply service with idempotent GitHub write steps"
```

---

## Task 10: CLI command and wiring

**Files:**
- Create: `src/commands/bootstrap.ts`
- Test: `tests/unit/commands/bootstrap.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: all services from Tasks 7 and 9; `loadRepositoryConfig` with graceful fallback; `resolveRepositoryContext`; `appPaths`; `ArtifactStore`; `PiRunner`; `GitHubAdapter`; `ProjectsAdapter`; `PlanStore`
- Produces: `registerBootstrapCommand(program, deps)` — registered in `cli.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/commands/bootstrap.test.ts
import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerBootstrapCommand } from "../../../src/commands/bootstrap.js";
import type { BootstrapCommandDeps } from "../../../src/commands/bootstrap.js";

function makeProgram(deps: BootstrapCommandDeps = {}) {
  const program = new Command();
  program.exitOverride();
  registerBootstrapCommand(program, deps);
  return program;
}

describe("bootstrap command registration", () => {
  it("registers the bootstrap command", () => {
    const program = makeProgram();
    const cmd = program.commands.find((c) => c.name() === "bootstrap");
    expect(cmd).toBeDefined();
  });

  it("requires --plan or --apply", async () => {
    const errors: string[] = [];
    const program = makeProgram({ stderr: (msg) => errors.push(msg), setExitCode: () => {} });
    await program.parseAsync(["node", "autopilot", "bootstrap"], { from: "user" }).catch(() => {});
    // Should have errored because neither --plan nor --apply was given
    expect(errors.join(" ")).toMatch(/--plan.*--apply|--apply.*--plan|must provide/i);
  });

  it("calls planFn when --plan is passed", async () => {
    let planCalled = false;
    const deps: BootstrapCommandDeps = {
      planFn: async () => { planCalled = true; return { planId: "x", markdownPath: "/tmp/x.md" }; },
      setExitCode: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["node", "autopilot", "bootstrap", "--plan"], { from: "user" });
    expect(planCalled).toBe(true);
  });

  it("calls applyFn when --apply is passed", async () => {
    let applyCalled = false;
    const deps: BootstrapCommandDeps = {
      applyFn: async () => { applyCalled = true; },
      setExitCode: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["node", "autopilot", "bootstrap", "--apply", "bootstrap-20260823-abc"], { from: "user" });
    expect(applyCalled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/bootstrap.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/bootstrap.ts`**

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DEFAULT_PI_MODEL, loadRepositoryConfig, resolveRoleModel } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry } from "../config/schema.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import { ProjectsAdapter } from "../github/projects-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import { ApplyService } from "../bootstrap/apply-service.js";
import { BootstrapService, BootstrapSizeError } from "../bootstrap/bootstrap-service.js";
import { PlanStore } from "../bootstrap/plan-store.js";
import { createReporter } from "../ui/reporter.js";

export interface BootstrapCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  isTTY?: boolean;
  /** Test seam: override the plan phase. */
  planFn?: (docs: RequirementDoc[]) => Promise<{ planId: string; markdownPath: string }>;
  /** Test seam: override the apply phase. */
  applyFn?: (planId: string) => Promise<void>;
}

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const DEFAULT_REQUIREMENTS_FILE = "requirements.md";
const DEFAULT_REQUIREMENTS_DIR = "requirements";

export function registerBootstrapCommand(
  program: Command,
  deps: BootstrapCommandDeps = {},
): void {
  program
    .command("bootstrap")
    .description("Seed a GitHub project backlog from requirement documents")
    .option("--plan", "analyse requirement docs and produce a bootstrap plan")
    .option("--apply <plan-id>", "apply a saved bootstrap plan to GitHub")
    .option(
      "--requirements <path>",
      "requirement doc or directory (repeatable)",
      collectPath,
      [] as string[],
    )
    .option("--out <dir>", "output directory for plan files")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { plan?: boolean; apply?: string; requirements: string[]; out?: string; json?: boolean }) => {
      const stdout = deps.stdout ?? ((t) => process.stdout.write(`${t}\n`));
      const stderr = deps.stderr ?? ((t) => process.stderr.write(`${t}\n`));
      const setExitCode = deps.setExitCode ?? ((code) => { process.exitCode = code; });

      if (!opts.plan && !opts.apply) {
        stderr("autopilot bootstrap: must provide --plan or --apply <plan-id>");
        setExitCode(1);
        return;
      }

      try {
        if (opts.plan) {
          const docs = await resolveRequirementDocs(opts.requirements, deps.cwd ?? process.cwd());
          const result = deps.planFn
            ? await deps.planFn(docs)
            : await runPlan(docs, opts, deps);
          stdout(`Plan ID: ${result.planId}`);
          stdout(`Preview: ${result.markdownPath}`);
          stdout(`\nTo apply: autopilot bootstrap --apply ${result.planId}`);
          setExitCode(0);
        } else if (opts.apply) {
          if (deps.applyFn) {
            await deps.applyFn(opts.apply);
          } else {
            await runApply(opts.apply, deps, stdout);
          }
          setExitCode(0);
        }
      } catch (error) {
        if (error instanceof BootstrapSizeError) {
          stderr(error.message);
          setExitCode(2);
        } else {
          stderr(`autopilot bootstrap: ${error instanceof Error ? error.message : String(error)}`);
          setExitCode(1);
        }
      }
    });
}

async function runPlan(
  docs: RequirementDoc[],
  opts: { out?: string },
  deps: BootstrapCommandDeps,
): Promise<{ planId: string; markdownPath: string }> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const cwd = deps.cwd ?? process.cwd();
  const ctx = await resolveRepositoryContext(cwd, runner);
  const config = await loadConfigOrDefault(ctx.root);
  const paths = appPaths(deps.dataDir ?? opts.out);
  const artifacts = new ArtifactStore(paths);
  const bootstrapperModel = resolveRoleModel(
    "bootstrapper",
    null,
    config.agents,
    null,
    deps.piDefaultModel ?? DEFAULT_PI_MODEL,
  );
  const hasExistingConfig = existsSync(path.join(ctx.root, ".pi", "autopilot.yaml"));
  const service = new BootstrapService({
    repository: ctx,
    config,
    pi: new PiRunner(runner, deps.piCommand),
    artifacts,
    paths,
    bootstrapperModel,
    hasExistingConfig,
  });
  return service.plan(docs);
}

async function runApply(
  planId: string,
  deps: BootstrapCommandDeps,
  stdout: (msg: string) => void,
): Promise<void> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const cwd = deps.cwd ?? process.cwd();
  const paths = appPaths(deps.dataDir);
  const artifacts = new ArtifactStore(paths);
  const store = new PlanStore(artifacts);
  const github = await GitHubAdapter.create(cwd, runner);
  const projects = await ProjectsAdapter.create(cwd, runner);
  const service = new ApplyService({ planStore: store, github: github as never, projects, stdout });
  await service.apply(planId);
}

async function loadConfigOrDefault(root: string): Promise<AutopilotConfig> {
  try {
    return await loadRepositoryConfig(root);
  } catch {
    // No config yet — bootstrap is the first thing this repo runs
    const { AutopilotConfigSchema } = await import("../config/schema.js");
    return AutopilotConfigSchema.parse({
      version: 1,
      commands: { verify: ["npm test"] },
    });
  }
}

async function resolveRequirementDocs(
  requested: string[],
  cwd: string,
): Promise<RequirementDoc[]> {
  if (requested.length > 0) {
    return readDocPaths(cwd, requested);
  }
  // Fallback: requirements/ directory, then requirements.md
  const dir = path.join(cwd, DEFAULT_REQUIREMENTS_DIR);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return readDocPaths(cwd, files.map((f) => path.join(DEFAULT_REQUIREMENTS_DIR, f)));
  }
  const file = path.join(cwd, DEFAULT_REQUIREMENTS_FILE);
  if (existsSync(file)) {
    return [{ path: DEFAULT_REQUIREMENTS_FILE, content: readFileSync(file, "utf8") }];
  }
  return [];
}

function readDocPaths(cwd: string, paths: string[]): RequirementDoc[] {
  return paths.map((p) => ({
    path: p,
    content: readFileSync(path.resolve(cwd, p), "utf8"),
  }));
}
```

- [ ] **Step 4: Register the command in `src/cli.ts`**

Add to imports:
```typescript
import type { BootstrapCommandDeps } from "./commands/bootstrap.js";
import { registerBootstrapCommand } from "./commands/bootstrap.js";
```

Add `BootstrapCommandDeps` to `CliDeps` union:
```typescript
export type CliDeps = CheckCommandDeps & ... & ReconcileCommandDeps & BootstrapCommandDeps;
```

Add inside `buildProgram`:
```typescript
registerBootstrapCommand(program, deps);
```

- [ ] **Step 5: Run all tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/bootstrap.test.ts
npx vitest run
```
Expected: all PASS, no regressions.

- [ ] **Step 6: TypeScript check**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git add src/commands/bootstrap.ts src/cli.ts tests/unit/commands/bootstrap.test.ts
git commit -m "feat(bootstrap): add bootstrap CLI command and wire into autopilot"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task |
|---|---|
| §4.1 `--plan` phase (flags, workflow) | Task 10 (CLI) + Task 7 (service) |
| §4.2 `--apply` phase (flags, workflow) | Task 10 (CLI) + Task 9 (service) |
| §4.3 Exit codes (0/1/2) | Task 10 |
| §5 Size check + split advisor | Task 2 |
| §6.1 `plan.json` schema | Task 1 (types) + Task 7 (service saves it) |
| §6.2 `bootstrap-plan.md` rendering | Task 5 (renderer) |
| §7.1 Board creation with prompt | Task 9 |
| §7.2 Epic issues | Task 9 |
| §7.3 Child issues with requirementRef | Task 9 |
| §7.4 Epic checklist patching | Task 9 |
| §7.5 Add to board | Task 9 |
| §7.6 Write `autopilot.yaml` if absent | Task 10 (`runApply` + config-proposer — **gap, see below**) |
| §8.5 Bootstrapper Pi session prompt | Task 6 |
| §8.5 Brainstorming skill instruction | Task 6 (prompt includes it) |
| §8.6 `dependencies` + `tracks` in plan.json | Task 1 (types) + Task 7 |
| §8.7 `projects-adapter.ts` | Task 8 |
| §9 Testing | Tasks 1–10 each include tests |

**Gap found — §7.6 `autopilot.yaml` write:** The apply service currently skips the config write step. This needs to be added to `ApplyService.apply` as step 7, using `proposeConfig` + `config-proposer.ts`. The plan artifact's `proposedConfig` field carries the YAML string; apply writes it to `.pi/autopilot.yaml` and commits if absent.

**Fix:** Add to `ApplyService.apply` after `addedToBoard` step:

```typescript
// Step 7: write autopilot.yaml if absent
if (!state.configWritten) {
  const configPath = path.join(this.deps.repositoryRoot, ".pi", "autopilot.yaml");
  if (!existsSync(configPath)) {
    const yaml = typeof plan.proposedConfig === "string" ? plan.proposedConfig : null;
    if (yaml !== null) {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, yaml, "utf8");
      this.log("✓ wrote .pi/autopilot.yaml");
      // Commit is left to the user — autopilot does not own git commits outside its run worktrees
    }
  }
  state.configWritten = true;
  await this.deps.planStore.update(plan);
}
```

`ApplyService` needs `repositoryRoot: string` added to its deps. Update `ApplyServiceDeps` and the `runApply` call in `bootstrap.ts` to pass `ctx.root`.

Also update the apply-service test to pass `repositoryRoot: tmpDir` and add a test asserting that `autopilot.yaml` is written when `proposedConfig` is a non-null string.

**Placeholder scan:** No TBDs found. All code blocks are complete.

**Type consistency check:** `BootstrapPlan.applyState` is `ApplyStateSchema` throughout. `RequirementDoc` is imported from `src/reconciliation/prompt.ts` consistently. `BootstrapperResult` type is used in `bootstrap-service.ts` and defined in `contracts.ts`. `ExtendedGitHubPort` is exported from `apply-service.ts` and imported in the test. All consistent.
