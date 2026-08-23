# Reconcile `apply-safe` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `autopilot reconcile-apply <analysisId>` — a store-then-apply command that consumes a stored reconciliation report and applies its deterministic `auto-safe` patches (ENRICH_ISSUE / ADD_DEPENDENCY / CREATE_ISSUE) to GitHub, with per-patch idempotent re-validation, an interactive approval prompt, a staleness guard, and a durable audit artifact.

**Architecture:** A dedicated `ApplyService` revalidates each `auto-safe` patch against the target's current GitHub state (idempotency derived from issue bodies, not a ledger), partitions patches into a stable order (CREATE → ENRICH → ADD), and applies writes in interactive (per-patch `y/n/a/q` prompt) or unattended (`--yes`) mode. A new CLI command wires it like `reconcile.ts`. Declines are recorded in the apply-artifact but never fed back into a future `reconcile` (steering is explicitly out of scope).

**Tech Stack:** TypeScript (ESM), node:commander, zod, vitest, Octokit-backed `GitHubAdapter` (`GitHubPort`), `ArtifactStore`, `PiRunner` (not used by apply), the existing managed-section upsert + unified-diff helpers in `src/readiness/refinement-section.ts`, and the dependency-marker grammar in `src/analysis/dependency-markers.ts`.

**Spec:** `docs/superpowers/specs/2026-08-23-reconcile-apply-safe-design.md`

## Global Constraints

- Language: TypeScript ESM, Node 22.5+. No new runtime dependencies. Command is wired into `src/cli.ts` like every other command.
- Patch application order is fixed: `CREATE_ISSUE` → `ENRICH_ISSUE` → `ADD_DEPENDENCY`. `requires-approval` patches (`MARK_STALE` / `NEEDS_HUMAN`) are written **only** by an explicit per-patch `y` in interactive mode; `--yes` and "apply-all-remaining" never approve them.
- Idempotency is derived purely from re-checking the target's current GitHub state. No apply-state ledger.
- The `auto-safe` classification comes from the existing deterministic `classifyPatch` (`src/reconciliation/patch-policy.ts`). Never LLM-decided.
- Concurrent edits are never clobbered: applied bodies are computed from *freshly-fetched* current bodies, not the stored report's snapshot.
- Exit codes: `0` clean; `1` hard error; `2` partial (write failed, user declined, or aborted). Matches the repo convention.
- All output passes through the existing redaction path (`src/commands/redact.ts`) wherever secrets could surface.
- Verification commands: `npm run typecheck`, `npm test`, `npm run build`. Run the specific new tests during each task.
- New config key: `reconciliation.reportStaleAfterHours` (default `168`); negative/null disables the staleness guard.

---

### Task 1: Domain types — `ApplyOutcome` / `ApplyEntry` / `ApplyReport`

**Files:**
- Create: `src/domain/apply.ts`
- Test: `tests/unit/domain/apply.test.ts`

**Interfaces:**
- Consumes: `BacklogPatchType`, `PatchPolicy`, `ReconciledPatch` from `src/domain/reconciliation.ts`; `RepositoryRef` from `src/domain/contracts.ts`.
- Produces: `ApplyOutcome`, `ApplyEntry`, `ApplyReport` (used by Task 5 `ApplyService`).

- [ ] **Step 1: Write the failing schema test**

Create `tests/unit/domain/apply.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApplyReportSchema } from "../../../src/domain/apply.js";

describe("ApplyReportSchema", () => {
  it("parses a report with applied, skipped, and failed entries", () => {
    const report = {
      repository: { owner: "acme", repo: "widgets" },
      analysisId: "reconcile-1-12",
      appliedAt: "2026-08-23T00:00:00.000Z",
      staleness: { staleAgeHours: 0.5, guardApplied: true, overriddenByForce: false },
      entries: [
        {
          patchType: "CREATE_ISSUE",
          targetIssue: null,
          policy: "auto-safe",
          outcome: { status: "applied" },
          detail: "created 'New widget'",
          appliedIssueNumber: 30,
        },
        {
          patchType: "ENRICH_ISSUE",
          targetIssue: 15,
          policy: "auto-safe",
          outcome: { status: "skipped", skippedBy: "idempotent" },
          detail: "already reflects enrichment",
        },
        {
          patchType: "MARK_STALE",
          targetIssue: 16,
          policy: "requires-approval",
          outcome: { status: "skipped", skippedBy: "requires-approval" },
          detail: "superseded",
        },
        {
          patchType: "ADD_DEPENDENCY",
          targetIssue: 15,
          policy: "auto-safe",
          outcome: { status: "failed", error: "github 409" },
          detail: "#15 depends on #16",
        },
        {
          patchType: "ENRICH_ISSUE",
          targetIssue: 18,
          policy: "auto-safe",
          outcome: { status: "skipped", skippedBy: "user" },
          detail: "declined",
          declineReason: "not worth the churn",
        },
      ],
      summary: {
        applied: 1,
        skippedRequiresApproval: 1,
        skippedIdempotent: 1,
        skippedUser: 1,
        failed: 1,
        previewed: 0,
      },
    };

    const parsed = ApplyReportSchema.parse(report);
    expect(parsed.entries).toHaveLength(5);
    expect(parsed.entries[0]).toMatchObject({
      patchType: "CREATE_ISSUE",
      appliedIssueNumber: 30,
    });
    expect(parsed.entries[1].outcome).toEqual({ status: "skipped", skippedBy: "idempotent" });
    expect(parsed.entries[4]).toMatchObject({ outcome: { status: "skipped", skippedBy: "user" }, declineReason: "not worth the churn" });
  });

  it("rejects an entry with an unknown outcome status", () => {
    const bad = {
      repository: { owner: "acme", repo: "widgets" },
      analysisId: "reconcile-1-12",
      appliedAt: "2026-08-23T00:00:00.000Z",
      staleness: { staleAgeHours: 0.5, guardApplied: true, overriddenByForce: false },
      entries: [{ patchType: "KEEP", targetIssue: 15, policy: "requires-approval", outcome: { status: "bogus" }, detail: "x" }],
      summary: { applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0, skippedUser: 0, failed: 0, previewed: 0 },
    };
    expect(() => ApplyReportSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/domain/apply.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/apply.js'`.

- [ ] **Step 3: Implement the schema**

Create `src/domain/apply.ts`:

```ts
import { z } from "zod";
import type { BacklogPatchType, PatchPolicy } from "./reconciliation.js";
import type { RepositoryRef } from "./contracts.js";

/** Per-patch application outcome. `declineReason` is set only on a
 * `skippedBy: "user"` outcome when the human supplied a note. */
export const ApplyOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied") }),
  z.object({
    status: z.literal("skipped"),
    skippedBy: z.enum([
      "requires-approval",
      "idempotent",
      "user",
      "failed-to-fetch",
    ]),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);
export type ApplyOutcome = z.infer<typeof ApplyOutcomeSchema>;

export const ApplyEntrySchema = z.object({
  patchType: z.custom<BacklogPatchType>(),
  targetIssue: z.number().int().positive().nullable(),
  policy: z.custom<PatchPolicy>(),
  outcome: ApplyOutcomeSchema,
  detail: z.string(),
  appliedIssueNumber: z.number().int().positive().optional(),
  declineReason: z.string().optional(),
});
export type ApplyEntry = z.infer<typeof ApplyEntrySchema>;

export const ApplyReportSchema = z.object({
  repository: z.custom<RepositoryRef>(),
  analysisId: z.string().min(1),
  appliedAt: z.string().min(1),
  aborted: z.boolean().default(false),
  staleness: z.object({
    staleAgeHours: z.number(),
    guardApplied: z.boolean(),
    overriddenByForce: z.boolean(),
  }),
  entries: z.array(ApplyEntrySchema),
  summary: z.object({
    applied: z.number().int(),
    skippedRequiresApproval: z.number().int(),
    skippedIdempotent: z.number().int(),
    skippedUser: z.number().int(),
    failed: z.number().int(),
    previewed: z.number().int(),
  }),
});
export type ApplyReport = z.infer<typeof ApplyReportSchema>;
```

Note: `z.custom<BacklogPatchType>()` is a lightweight pass-through; the type is already enforced upstream by `ReconciledPatch` from the zod-validated `BacklogPatchSchema`. Keep it consistent with how `BacklogPatchType` flows through the rest of `src/domain/reconciliation.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/domain/apply.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/apply.ts tests/unit/domain/apply.test.ts
git commit -m "feat(reconcile-apply): add ApplyReport domain schemas"
```

---

### Task 2: Dependency-line renderer

**Files:**
- Create: `src/reconciliation/apply-dependency.ts`
- Test: `tests/unit/reconciliation/apply-dependency.test.ts`

**Interfaces:**
- Consumes: `existingDependencyNumbers` logic from `src/reconciliation/idempotency.ts`'s helper (re-implemented locally); the `MANAGED_DEPENDENCY_PATTERN` grammar from `src/analysis/dependency-markers.ts`.
- Produces: `renderDependencyLine(dependsOn: number): string`, `appendDependencyToBody(body: string, dependsOn: number): string`, `bodyAlreadyDependsOn(body: string, dependsOn: number): boolean` (used by Task 5).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/reconciliation/apply-dependency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  appendDependencyToBody,
  bodyAlreadyDependsOn,
  renderDependencyLine,
} from "../../../src/reconciliation/apply-dependency.js";

describe("renderDependencyLine", () => {
  it("renders the managed dependency-marker line", () => {
    expect(renderDependencyLine(16)).toBe("- #16 (unsatisfied)");
  });
});

describe("appendDependencyToBody", () => {
  it("appends the dependency line, separating from existing content", () => {
    const body = "Do the oauth thing.";
    expect(appendDependencyToBody(body, 16)).toBe(
      "Do the oauth thing.\n\nDepends on:\n- #16 (unsatisfied)",
    );
  });

  it("preserves existing content and keeps the dependency grammar at line start", () => {
    const body = "Body here.";
    const out = appendDependencyToBody(body, 7);
    expect(out).toBe("Body here.\n\nDepends on:\n- #7 (unsatisfied)");
    // the rendered dependency must satisfy the downstream BLOCKED/screen
    // grammar: extend dependency-markers LINE_DEPENDENCY_PATTERN matches
    // a line that starts with `- #7 (unsatisfied)`.
    expect(out).toContain("- #7 (unsatisfied)");
  });
});

describe("bodyAlreadyDependsOn", () => {
  it("detects an existing managed dependency marker", () => {
    const body = "goal\n\nDepends on:\n- #16 (unsatisfied)";
    expect(bodyAlreadyDependsOn(body, 16)).toBe(true);
    expect(bodyAlreadyDependsOn(body, 15)).toBe(false);
  });

  it("detects an explicit line-start dependency", () => {
    const body = "depends on: #12\nmore";
    expect(bodyAlreadyDependsOn(body, 12)).toBe(true);
  });
});
```

Note: the second `appendDependencyToBody` test above asserts the exact
rendered output. When implementing `appendDependencyToBody` in Step 3,
make the implementation produce exactly `Body here.\n\nDepends on:\n- #7 (unsatisfied)`
so it matches this assertion, and confirm the `- #7 (unsatisfied)` line is
recognized by both `MANAGED_DEPENDENCY_PATTERN` (managed marker) and the
`- #<n> (unsatisfied)` line-start grammar used by the deterministic
`BLOCKED` screen. The two grammars must agree so reconciliation's own
idempotency pass (`bodyAlreadyDependsOn`) sees the dependency on a later
run.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/apply-dependency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/reconciliation/apply-dependency.ts`:

```ts
import {
  dependencyNumberFromMatch,
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
} from "../analysis/dependency-markers.js";

/** The dependency line grammar downstream `BLOCKED`/screen logic reads. */
export function renderDependencyLine(dependsOn: number): string {
  return `- #${dependsOn} (unsatisfied)`;
}

/** True when `body` already marks `dependsOn` per the shared grammar. */
export function bodyAlreadyDependsOn(body: string, dependsOn: number): boolean {
  for (const pattern of [MANAGED_DEPENDENCY_PATTERN, LINE_DEPENDENCY_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      if (dependencyNumberFromMatch(match) === dependsOn) return true;
    }
  }
  return false;
}

/**
 * Append an unsatisfied dependency to an issue body, preserving all other
 * content. The dependency is folded under a `Depends on:` block using the
 * managed dependency-marker grammar so the deterministic screen recognises
 * it and reconciliation's own idempotency pass (`bodyAlreadyDependsOn`)
 * sees it on a later run.
 */
export function appendDependencyToBody(
  body: string,
  dependsOn: number,
): string {
  const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n\n";
  const block = `Depends on:\n${renderDependencyLine(dependsOn)}`;
  return `${body}${separator}${block}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/apply-dependency.test.ts`
Expected: PASS. If the `appendDependencyToBody` second test asserts a stricter shape, make the implementation match that exact shape.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/apply-dependency.ts tests/unit/reconciliation/apply-dependency.test.ts
git commit -m "feat(reconcile-apply): add dependency-line renderer"
```

---

### Task 3: Preview rendering + interactive prompt helper

**Files:**
- Create: `src/reconciliation/apply-preview.ts`
- Test: `tests/unit/reconciliation/apply-preview.test.ts`

**Interfaces:**
- Consumes: `ReconciledPatch` from `src/domain/reconciliation.ts`; `renderUnifiedDiff` + `RenderUnifiedDiff` from `src/readiness/refinement-section.ts`; `renderReconciliationSection` from `src/reconciliation/managed-section.ts`; `renderDependencyLine` from `apply-dependency.ts` (Task 2).
- Produces: `renderEnrichPreview(currentBody, patch)`, `renderDependencyPreview(currentBody, dependsOn)`, `renderCreatePreview(patch)`, `confirmMenu(prompt, writeOut?, readLine?) => Promise<MenuAnswer>`; `type MenuAnswer = "apply" | "skip" | "all" | "abort"`.
  Used by Task 5.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reconciliation/apply-preview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApplyEntry } from "../../../src/domain/apply.js"; // used for type only
import { confirmMenu } from "../../../src/reconciliation/apply-preview.js";

describe("confirmMenu", () => {
  it("maps y to apply, n to skip, a to all, q to abort", async () => {
    const inputs = ["y", "n", "a", "q", "n"];
    const read = (): Promise<string> => Promise.resolve(inputs.shift() ?? "");
    const abort: string[] = [];
    const write = (s: string): void => { abort.push(s); };
    expect(await confirmMenu("apply #15? ", write, read)).toBe("apply");
    expect(await confirmMenu("apply #16? ", write, read)).toBe("skip");
    expect(await confirmMenu("apply #17? ", write, read)).toBe("all");
    expect(await confirmMenu("apply #18? ", write, read)).toBe("abort");
    expect(abort).toHaveLength(4);
  });

  it("treats blank/empty input as skip (a stray Enter never applies)", async () => {
    const read = async (): Promise<string> => "";
    expect(await confirmMenu("x? ", () => {}, read)).toBe("skip");
  });

  it("is case-insensitive and accepts the word forms", async () => {
    const read = async (): Promise<string> => "APPLY";
    expect(await confirmMenu("x? ", () => {}, read)).toBe("apply");
  });

  it("loops until a valid answer", async () => {
    const inputs = ["zz", "\n", "Y"];
    const read = async (): Promise<string> => inputs.shift() ?? "";
    const writes: string[] = [];
    expect(await confirmMenu("? ", (s) => { writes.push(s); }, read)).toBe("apply");
    // wrote the invalid-input retry prompt at least once
    expect(writes.some((s) => s.includes("apply") || s.includes("skip"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/reconciliation/apply-preview.ts`:

```ts
import type { ReconciledPatch } from "../domain/reconciliation.js";
import { renderReconciliationSection } from "./managed-section.js";
import { renderDependencyLine } from "./apply-dependency.js";
import { renderUnifiedDiff } from "../readiness/refinement-section.js";

export type MenuAnswer = "apply" | "skip" | "all" | "abort";

/** Render the diff of an ENRICH_ISSUE against the issue's current body. */
export function renderEnrichPreview(
  currentBody: string,
  patch: Extract<ReconciledPatch, { type: "ENRICH_ISSUE" }>,
): string {
  const proposed = renderReconciliationSection(patch.patch);
  return renderUnifiedDiff(currentBody, proposed);
}

/** Render the one dependency line an ADD_DEPENDENCY will insert. */
export function renderDependencyPreview(
  dependsOn: number,
): string {
  return `${renderDependencyLine(dependsOn)}`;
}

/** Render a compact human summary for a CREATE_ISSUE. */
export function renderCreatePreview(
  patch: Extract<ReconciledPatch, { type: "CREATE_ISSUE" }>,
): string {
  const enrichment = patch.spec.enrichment;
  const goal = enrichment.goal.trim();
  return `title: ${patch.spec.title}\n${goal === "" ? "(no goal)" : goal}`;
}

/**
 * Prompt for one of apply / skip / all / abort. Injected write/read for
 * tests; default reads/writes from process stdio. Blank input defaults to
 * "skip" so a stray Enter never writes.
 */
export async function confirmMenu(
  prompt: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  readLine: () => Promise<string> = () =>
    new Promise((resolve) => {
      process.stdin.once("data", (data) => resolve(data.toString()));
    }),
): Promise<MenuAnswer> {
  for (;;) {
    write(prompt);
    const raw = (await readLine()).trim().toLowerCase();
    if (raw === "y") return "apply";
    if (raw === "n") return "skip";
    if (raw === "a") return "all";
    if (raw === "q") return "abort";
    if (raw === "") return "skip"; // default: skip, never apply
    write("invalid answer; [y] apply / [n] skip / [a] all / [q] abort\n");
  }
}
```

For the real (non-injected) `confirmMenu`, prefer using `createInterface` from `node:readline/promises` over raw `process.stdin.once`, so repeated prompts each read one line. Implement the default `readLine` with `readline/promises`:

```ts
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
const rl = createInterface({ input, output });
const defaultReadLine = () => rl.question("");
```

Wire `defaultReadLine` as the `confirmMenu` default after first use; `rl.close()` after the batch completes (the CLI/Task 5 owns closing the readline instance — see Task 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/apply-preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/apply-preview.ts tests/unit/reconciliation/apply-preview.test.ts
git commit -m "feat(reconcile-apply): add preview rendering and confirm menu"
```

---

### Task 4: Config — `reportStaleAfterHours`

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/unit/config/schema.test.ts` (add a case)

**Interfaces:**
- Produces: `config.reconciliation.reportStaleAfterHours: number` (default `168`). Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Append to the `schema.test.ts` suites a case asserting the default `reportStaleAfterHours`:

```ts
it("defaults reportStaleAfterHours to 168, and classifies invalid values", () => {
  const base = {
    version: 1,
    workspace: { baseBranch: "main", requireCleanCheckout: true },
    commands: { verify: ["npm test"] },
    reconciliation: {},
  };
  const cfg = AutopilotConfigSchema.parse(base);
  expect(cfg.reconciliation.reportStaleAfterHours).toBe(168);

  const negative = AutopilotConfigSchema.parse({
    ...base,
    reconciliation: { reportStaleAfterHours: -1 },
  });
  expect(negative.reconciliation.reportStaleAfterHours).toBe(-1);

  expect(() =>
    AutopilotConfigSchema.parse({
      ...base,
      reconciliation: { reportStaleAfterHours: "ten" },
    }),
  ).toThrow();
});
```

Match the existing `AutopilotConfigSchema` import alias in `tests/unit/config/schema.test.ts` (verify the actual import in that file before writing the test).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config/schema.test.ts -t "reportStaleAfterHours"`
Expected: FAIL — property does not exist / default not applied.

- [ ] **Step 3: Implement**

In `src/config/schema.ts`, update the `reconciliation` object:

```ts
reconciliation: z
  .object({
    requirementsPaths: z.array(z.string()).optional(),
    reportStaleAfterHours: z.number().int().default(168),
  })
  .prefault({}),
```

This uses the existing `.prefault({})` pattern: `reportStaleAfterHours` defaults to `168` when the `reconciliation` key is present, and the `prefault({})` supplies `{}` when `reconciliation` is absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/unit/config/schema.test.ts
git commit -m "feat(reconcile-apply): add reportStaleAfterHours reconcile config"
```

---

### Task 5: `ApplyService` — the apply pipeline

**Files:**
- Create: `src/reconciliation/apply-service.ts`
- Test: `tests/unit/reconciliation/apply-service.test.ts`

**Interfaces:**
- Consumes:
  - `GitHubPort`, `GitHubIssue` from `src/github/github-adapter.ts`.
  - `ArtifactStore.readJson` for `reconciliation-report.json`.
  - `ReconciliationReport`, `ReconciledPatch` from `src/reconciliation/reconciliation-service.ts` / `src/domain/reconciliation.ts`.
  - `classifyPatch` / `AUTO_SAFE` semantics via `ReconciledPatch.policy`.
  - `bodyAlreadyDependsOn`, `appendDependencyToBody`, `renderDependencyLine` from `apply-dependency.ts` (Task 2).
  - `renderEnrichPreview`, `renderCreatePreview`, `renderDependencyPreview`, `confirmMenu`, `MenuAnswer` from `apply-preview.ts` (Task 3).
  - `upsertReconciliationSection` from `managed-section.ts`.
  - `renderReconciliationSection` from `managed-section.ts`.
  - `REPORT_ARTIFACT`, `ReconciliationReport` from `reconciliation-service.ts` (export the constant or re-declare `"reconciliation-report.json"`).
- Produces: `ApplyService`, `ApplyServiceDeps`, `ApplyOptions`, and `ApplyService.apply(analysisId, opts): Promise<ApplyReport>`. Consumed by Task 6.

- [ ] **Step 1: Write the failing tests (core behaviors)**

Create `tests/unit/reconciliation/apply-service.test.ts`. It defines a `FakeGitHub implements GitHubPort` with in-memory issues, `updateIssueBody`/`createIssue` recording, settable fetch errors, and a file-backed `ArtifactStore` in a temp dir. Key fixtures: a stored `ReconciliationReport` (written via `artifacts.writeJson(analysisId, "reconciliation-report.json", report)`) with one CREATE_ISSUE, one ENRICH_ISSUE, one ADD_DEPENDENCY, one MARK_STALE, one NEEDS_HUMAN.

Core tests:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ApplyService, ApplyOptions } from "../../../src/reconciliation/apply-service.js";
import { ReconciliationReport } from "../../../src/reconciliation/reconciliation-service.js";
import { upsertReconciliationSection } from "../../../src/reconciliation/managed-section.js";
```

Implement the FakeGitHub (mirror the style in `tests/unit/reconciliation/reconciliation-service.test.ts`), with these methods at minimum:

```ts
class FakeGitHub implements GitHubPort {
  readonly created: Array<{ title: string; body: string; labels: string[] }> = [];
  readonly updated: Array<{ number: number; body: string }> = [];
  issues = new Map<number, GitHubIssue>();
  failFetchFor = new Set<number>();

  async getIssue(number: number): Promise<GitHubIssue> {
    if (this.failFetchFor.has(number)) throw new Error(`fetch fail ${number}`);
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`missing #${number}`);
    return issue;
  }
  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    this.updated.push({ number, body });
    const issue = this.issues.get(number)!;
    const next = { ...issue, body };
    this.issues.set(number, next);
    return next;
  }
  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<GitHubIssue> {
    this.created.push(input);
    const number = Math.max(0, ...this.issues.keys()) + 1;
    const issue = { number, nodeId: `I_${number}`, title: input.title, body: input.body, updatedAt: "2026-08-23T00:00:00Z", state: "open", htmlUrl: `https://github.com/acme/widgets/issues/${number}` };
    this.issues.set(number, issue);
    return issue;
  }
  async getIssueCommentByMarker... { return null; }
  async ensureLabel(...) {}
  // createIssueComment, findPullRequestByHead, findIssueCommentByMarker, createPullRequest: no-op/throw-not-called
}
```

Then the test bodies:

```ts
describe("ApplyService.apply", () => {
  let tmp: string;
  let artifacts: ArtifactStore;
  let github: FakeGitHub;
  const opts: ApplyOptions = { yes: true, force: false }; // unattended by default in tests

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "apply-svc-"));
    const paths = appPaths(tmp);
    artifacts = new ArtifactStore(paths);
    github = new FakeGitHub();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const epic = (): GitHubIssue => makeIssue(12, "Epic", "- [ ] #15 OAuth\n");
  const issue15 = (): GitHubIssue => makeIssue(15, "OAuth callback", "Handles OAuth");

  it("applies auto-safe patches in CREATE then ENRICH then ADD order", async () => {
    github.issues.set(12, epic());
    github.issues.set(15, issue15());
    const report: ReconciliationReport = {
      repository: { owner: "acme", repo: "widgets" },
      epicRef: 12,
      requirementsPaths: [],
      generatedAt: new Date().toISOString(),
      analysisId: "reconcile-1-12",
      coverage: [],
      patches: [
        { type: "KEEP", issue: 15, reason: "fine", policy: "requires-approval" },
        { type: "ADD_DEPENDENCY", issue: 15, dependsOn: 16, reason: "needs #16", policy: "auto-safe" },
        { type: "MARK_STALE", issue: 16, reason: "superseded", policy: "requires-approval" },
        { type: "ENRICH_ISSUE", issue: 15, patch: { goal: "Add OAuth refresh", sourceRequirements: [], acceptanceCriteria: ["refresh"], constraints: [], nonGoals: [], validation: [], relevantAreas: [] }, reason: "missing criteria", policy: "auto-safe" },
        { type: "CREATE_ISSUE", epic: 12, spec: { title: "New widget", enrichment: { goal: "Create new widget", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } }, reason: "missing", policy: "auto-safe" },
      ],
      summary: { requirementsCovered: 0, requirementsPartial: 0, requirementsMissing: 0, requirementsTotal: 0, patchCounts: {} },
    };
    await artifacts.writeJson(report.analysisId, "reconciliation-report.json", report);

    const svc = new ApplyService({ github, artifacts, repository: { owner: "acme", repo: "widgets" }, now: () => "2026-08-23T00:00:00.000Z", confirmMenu: async () => "apply" });
    const result = await svc.apply("reconcile-1-12", opts);

    // CREATE first (created issue #17, linked into epic #12 checklist),
    // then ENRICH of #15, then ADD dependency #16 to #15.
    const firstWrite = github.updated[0]!;
    expect(firstWrite.number).toBe(12); // epic checklist linkback
    expect(firstWrite.body).toContain("- [ ] #17 New widget");
    expect(github.created[0]!.title).toBe("New widget");

    const enrichWrite = github.updated.find((u) => u.number === 15 && u.body.includes("autopilot-reconciliation"));
    expect(enrichWrite).toBeDefined();
    expect(enrichWrite!.body).toContain("Add OAuth refresh");

    const depWrite = github.updated.find((u) => u.number === 15 && u.body.includes("Depends on:"));
    expect(depWrite).toBeDefined();

    expect(result.summary.applied).toBe(3);
    expect(result.entries.find((e) => e.patchType === "MARK_STALE")!.outcome).toEqual({ status: "skipped", skippedBy: "requires-approval" });
  });

  it("skips an auto-safe patch whose target already reflects the change", async () => {
    github.issues.set(15, makeIssue(15, "OAuth", upsertReconciliationSection("Handles OAuth", { goal: "Add OAuth refresh", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] })));
    const report: ReconciliationReport = {
      repository: { owner: "acme", repo: "widgets" }, epicRef: 12, requirementsPaths: [],
      generatedAt: new Date().toISOString(), analysisId: "reconcile-1-12", coverage: [],
      patches: [
        { type: "ENRICH_ISSUE", issue: 15, patch: { goal: "Add OAuth refresh", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] }, reason: "x", policy: "auto-safe" },
      ],
      summary: { requirementsCovered: 0, requirementsPartial: 0, requirementsMissing: 0, requirementsTotal: 0, patchCounts: {} },
    };
    await artifacts.writeJson("reconcile-1-12", "reconciliation-report.json", report);
    const svc = new ApplyService({ github, artifacts, repository: { owner: "acme", repo: "widgets" }, now: () => "2026-08-23T00:00:00.000Z", confirmMenu: async () => "apply" });
    const result = await svc.apply("reconcile-1-12", opts);
    expect(result.entries[0]!.outcome).toEqual({ status: "skipped", skippedBy: "idempotent" });
    expect(github.updated.length).toBe(0);
  });

  it("continues-on-error and records failed patches (exit 2 semantics)", async () => {
    github.issues.set(12, epic());
    github.issues.set(15, issue15());
    github.failFetchFor.add(15); // make ENRICH target unfetchable later — instead use a throwing write
    // Simpler: subclass FakeGitHub to throw on the 3rd write.
    // (see throwOnWriteN below)
  });
});
```

For the continue-on-error test, extend FakeGitHub with an injectable "throw on the Nth successful body update":

```ts
class FakeGitHubWithFail extends FakeGitHub {
  writeErrors = 0;
  throwOnUpdateIndex: number[] = [];
  async updateIssueBody(...args) {
    if (this.throwOnUpdateIndex.includes(this.updated.length)) throw new Error("github 409");
    return super.updateIssueBody(...args);
  }
}
```

Assert (index 1, the ENRICH write) fails: the run continues, ADD still applies, `result.entries` contains one `failed`, `result.summary.failed === 1`, and later patches are still attempted.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts`
Expected: FAIL — module `apply-service.js` not found.

- [ ] **Step 3: Implement `ApplyService`**

Create `src/reconciliation/apply-service.ts`:

```ts
import type { GitHubPort } from "../github/github-adapter.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { ReconciledPatch } from "../domain/reconciliation.js";
import type { ReconciliationReport } from "./reconciliation-service.js";
import type { ApplyEntry, ApplyReport } from "../domain/apply.js";
import { appendDependencyToBody, bodyAlreadyDependsOn } from "./apply-dependency.js";
import { upsertReconciliationSection } from "./managed-section.js";
import { RefinementSectionError } from "../readiness/refinement-section.js";
import { collectEpicIssueRefs } from "../analysis/issue-set.js";
import { renderReconciliationSection } from "./managed-section.js";
import { renderCreatePreview, renderDependencyPreview, renderEnrichPreview, confirmMenu, type MenuAnswer } from "./apply-preview.js";

const REPORT_ARTIFACT = "reconciliation-report.json";
const APPLY_ARTIFACT = "reconciliation-apply.json";
const DEFAULT_STALE_HOURS = 168; // 7 days

export interface ApplyOptions {
  yes: boolean;     // unattended: apply auto-safe, skip requires-approval
  force?: boolean;  // bypass the staleness guard
}

export interface ApplyServiceDeps {
  github: GitHubPort;
  artifacts: ArtifactStore;
  repository: RepositoryRef;
  /** Staleness window in hours. Undefined → default 168. Negative/null disables the guard. */
  reportStaleAfterHours?: number;
  /** Interactive menu. Only consulted when `opts.yes` is falsy. */
  confirmMenu?: (prompt: string) => Promise<MenuAnswer>;
  /** Receives rendered preview text before a patch is offered/prompted. */
  onPreview?: (text: string) => void;
  now?: () => string;
}

/** Returned by the interactive decision step. */
type Decision = "apply" | "skip-user" | "all" | "abort";

export class ApplyService {
  private readonly now: () => string;
  private readonly confirm: (prompt: string) => Promise<MenuAnswer>;
  private readonly onPreview: (text: string) => void;

  constructor(private readonly deps: ApplyServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.confirm = deps.confirmMenu ?? (
      (prompt: string) => confirmMenu(prompt),
    );
    this.onPreview = deps.onPreview ?? (() => {}); // no-op; CLI injects a reporter
  }

  async apply(analysisId: string, opts: ApplyOptions): Promise<ApplyReport> {
    const report = await this.deps.artifacts.readJson<
      ReconciliationReport
    >(analysisId, REPORT_ARTIFACT);

    const staleAgeHours =
      (Date.parse(this.now()) - Date.parse(report.generatedAt)) /
      (60 * 60 * 1000);
    const windowHours = this.stalenessWindowHours(); // null => disabled
    const guardActive = windowHours !== null && windowHours > 0;
    const stale = guardActive && staleAgeHours > windowHours;
    if (stale && opts.force !== true) {
      throw new Error(
        `stored report for ${analysisId} is ${Math.round(staleAgeHours)}h` +
          ` old (> ${windowHours}h); re-run reconcile or pass --force`,
      );
    }

    // Stable order: CREATE_ISSUE, ENRICH_ISSUE, ADD_DEPENDENCY, then the
    // requires-approval set (KEEP / MARK_STALE / NEEDS_HUMAN).
    const rank: Record<string, number> = {
      CREATE_ISSUE: 0,
      ENRICH_ISSUE: 1,
      ADD_DEPENDENCY: 2,
    };
    const sorted = [...report.patches].sort(
      (a, b) => (rank[a.type] ?? 10) - (rank[b.type] ?? 10),
    );

    const entries: ApplyEntry[] = [];
    const summary = emptySummary();
    let allRemaining = false;
    let aborted = false;

    for (const patch of sorted) {
      // auto-safe types are the only ones this milestone ever writes. When
      // apply-all-remaining is active, requires-approval is skipped without
      // prompting.
      if (allRemaining && patch.policy === "requires-approval") {
        recordEntry(entries, summary, skipEntry(patch, "requires-approval"));
        continue;
      }

      // Phase 1: prepare — fetch current state, detect idempotent skip, and
      // build the preview from the FRESH body. No writes, no prompting yet.
      const prepared = await this.prepare(patch);
      if (prepared.skip !== undefined) {
        recordEntry(entries, summary, prepared.skip);
        continue;
      }

      // Phase 2: decide.
      let decision: Decision;
      if (opts.yes) {
        decision = patch.policy === "auto-safe" ? "apply" : "skip-user";
      } else {
        this.onPreview(prepared.previewText);
        summary.previewed += 1;
        const answer = await this.confirm(this.promptLabel(patch));
        decision =
          answer === "apply" ? "apply" :
          answer === "skip" ? "skip-user" :
          answer === "all" ? "all" : "abort";
      }

      if (decision === "abort") { aborted = true; break; }
      if (decision === "all") allRemaining = true; // fall through -> apply now
      if (decision === "skip-user") {
        recordEntry(entries, summary, skipEntry(patch, "user"));
        continue;
      }

      // Phase 3: write (decision is "apply" or "all").
      const entry = await this.write(prepared);
      recordEntry(entries, summary, entry);
    }

    const result: ApplyReport = {
      repository: this.deps.repository,
      analysisId,
      appliedAt: this.now(),
      aborted,
      staleness: {
        staleAgeHours,
        guardApplied: guardActive,
        overriddenByForce: stale && opts.force === true,
      },
      entries,
      summary,
    };

    await this.deps.artifacts.writeJson(analysisId, APPLY_ARTIFACT, result);
    return result;
  }

  private stalenessWindowHours(): number | null {
    const v = this.deps.reportStaleAfterHours;
    if (v === undefined) return DEFAULT_STALE_HOURS;
    if (v === null || v < 0) return null;
    return v;
  }

  private promptLabel(patch: ReconciledPatch): string {
    return `apply ${patch.type}${patch.issue !== undefined && patch.issue !== null ? " #" + patch.issue : ""}? [y] apply / [n] skip / [a] all / [q] abort `;
  }

  /** Returns an idempotent-skip entry, or a prepared apply step. */
  private async prepare(
    patch: ReconciledPatch & { previewText?: string },
  ): Promise<Prepared> {
    switch (patch.type) {
      case "CREATE_ISSUE":
        return this.prepareCreate(patch);
      case "ENRICH_ISSUE":
        return this.prepareEnrich(patch);
      case "ADD_DEPENDENCY":
        return this.prepareDependency(patch);
      default:
        // KEEP / MARK_STALE / NEEDS_HUMAN: no GitHub write in this
        // milestone. They are only ever skipped (requires-approval); even a
        // per-patch `y` in interactive mode records an acknowledged skip,
        // never a mutation.
        return { skip: skipEntry(patch, "requires-approval") };
    }
  }

  private async prepareCreate(
    patch: Extract<ReconciledPatch, { type: "CREATE_ISSUE" }>,
  ): Promise<Prepared> {
    const base = skipEntry(patch, "idempotent");
    const wantTitle = patch.spec.title.trim().toLowerCase();
    if (patch.epic !== null) {
      const epic = await this.deps.github.getIssue(patch.epic);
      for (const ref of collectEpicIssueRefs(epic.body).issues) {
        try {
          const existing = await this.deps.github.getIssue(ref);
          if (existing.title.trim().toLowerCase() === wantTitle) {
            return {
              skip: { ...base, detail: `already exists as #${ref}` },
            };
          }
        } catch {
          // ref may be stale/broken; ignore and continue the duplicate scan
        }
      }
    }
    return {
      previewText: renderCreatePreview(patch),
      write: () => this.writeCreate(patch),
    };
  }

  private async prepareEnrich(
    patch: Extract<ReconciledPatch, { type: "ENRICH_ISSUE" }>,
  ): Promise<Prepared> {
    let current: GitHubIssue;
    try {
      current = await this.deps.github.getIssue(patch.issue);
    } catch {
      return { skip: skipEntry(patch, "failed-to-fetch") };
    }
    let proposed: string;
    try {
      proposed = upsertReconciliationSection(current.body, patch.patch);
    } catch (error) {
      if (error instanceof RefinementSectionError) {
        return {
          skip: {
            ...skipEntry(patch, "idempotent"),
            detail: `body has ambiguous managed-section markers: ${error.message}`,
          },
        };
      }
      throw error;
    }
    if (proposed === current.body) {
      return { skip: { ...skipEntry(patch, "idempotent"), detail: "already reflects the proposed enrichment" } };
    }
    return {
      previewText: renderEnrichPreview(current.body, patch),
      write: () => this.deps.github.updateIssueBody(patch.issue, proposed),
    };
  }

  private async prepareDependency(
    patch: Extract<ReconciledPatch, { type: "ADD_DEPENDENCY" }>,
  ): Promise<Prepared> {
    let current: GitHubIssue;
    try {
      current = await this.deps.github.getIssue(patch.issue);
    } catch {
      return { skip: skipEntry(patch, "failed-to-fetch") };
    }
    if (bodyAlreadyDependsOn(current.body, patch.dependsOn)) {
      return {
        skip: { ...skipEntry(patch, "idempotent"), detail: `already depends on #${patch.dependsOn}` },
      };
    }
    return {
      previewText: renderDependencyPreview(patch.dependsOn),
      write: () => this.deps.github.updateIssueBody(patch.issue, appendDependencyToBody(current.body, patch.dependsOn)),
    };
  }

  /** Execute a prepared write, catching recoverable errors into `failed`. */
  private async write(prepared: Prepared): Promise<ApplyEntry> {
    try {
      const detail = await prepared.write!();
      return { ...prepared.entryBase!, outcome: { status: "applied" }, detail };
    } catch (error) {
      return {
        ...prepared.entryBase!,
        outcome: {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async writeCreate(
    patch: Extract<ReconciledPatch, { type: "CREATE_ISSUE" }>,
  ): Promise<string> {
    const created = await this.deps.github.createIssue({
      title: patch.spec.title,
      body: renderReconciliationSection(patch.spec.enrichment),
      labels: ["task"],
    });
    if (patch.epic !== null) {
      const epic = await this.deps.github.getIssue(patch.epic);
      if (!collectEpicIssueRefs(epic.body).issues.includes(created.number)) {
        const separator = epic.body.endsWith("\n") ? "" : "\n";
        await this.deps.github.updateIssueBody(
          patch.epic,
          `${epic.body}${separator}- [ ] #${created.number} ${created.title}`,
        );
      }
    }
    return `created #${created.number} "${created.title}"`;
  }
}

interface Prepared {
  /** When set, the patch is skipped without offering/prompting. */
  skip?: ApplyEntry;
  /** Preview text to show before prompting (interactive). */
  previewText?: string;
  /** Performs the GitHub write and returns a human detail string. */
  write?: () => Promise<string>;
  /** Base entry (patchType/targetIssue/policy) to stamp the outcome onto. */
  entryBase?: ApplyEntry;
}

function emptySummary(): ApplyReport["summary"] {
  return { applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0, skippedUser: 0, failed: 0, previewed: 0 };
}

function skipEntry(
  patch: ReconciledPatch,
  skippedBy: "requires-approval" | "idempotent" | "user" | "failed-to-fetch",
  detail = patch.reason,
): ApplyEntry {
  return {
    patchType: patch.type,
    targetIssue: patch.issue ?? null,
    policy: patch.policy,
    outcome: { status: "skipped", skippedBy },
    detail,
  };
}

function recordEntry(
  entries: ApplyEntry[],
  summary: ApplyReport["summary"],
  entry: ApplyEntry,
): void {
  entries.push(entry);
  switch (entry.outcome.status) {
    case "applied": summary.applied += 1; break;
    case "skipped":
      if (entry.outcome.skippedBy === "requires-approval") summary.skippedRequiresApproval += 1;
      else if (entry.outcome.skippedBy === "idempotent") summary.skippedIdempotent += 1;
      else if (entry.outcome.skippedBy === "user") summary.skippedUser += 1;
      break;
    case "failed": summary.failed += 1; break;
  }
}
```

Notes on the implementation above:

- **Two-phase apply (`prepare` → `write`)** is the core pattern. `prepare`
  fetches the target's *current* state, computes the idempotent-skip
  outcome, and renders the preview from that fresh body (ENRICH uses the
  unified diff via `renderEnrichPreview`; ADD uses `renderDependencyPreview`;
  CREATE uses `renderCreatePreview`). `write` then performs the GitHub write
  from the same prepared state. This avoids double-fetching and guarantees
  the preview a human approves reflects what is actually written.
- **Continue-on-error** is centralized in `write()`: a thrown write error
  becomes `outcome: failed`, the loop continues to the next patch, and the
  report summaries it. A hard error *before* the loop (report not found,
  stale without `--force`) still throws → CLI exit `1`.
- **`requires-approval` invariant:** `prepare` returns a
  `skip(requires-approval)` for `KEEP` / `MARK_STALE` / `NEEDS_HUMAN`. They
  are never offered for a write. In interactive mode they are still shown in
  the loop but `prepare` returns a skip, so an explicit `y` cannot mutate
  GitHub; `--yes` and apply-all-remaining skip them too. (If the acceptance
  criteria in §13.2 require interactive per-patch *acknowledgement* of
  `requires-approval` rather than silent skip, record a
  `skip(user, detail)` after prompting — but no GitHub write either way.)
- Import the two `render*Preview`/`renderCreatePreview` builders from
  `apply-preview.ts` (Task 3) — they are pure functions over already-fetched
  data.
- `policy` is present on every `ReconciledPatch`; `skipEntry` reads it
  directly.
- `GitHubIssue` is imported where `prepare`/`write` reference it; add it to
  the import line if the linter flags an unused-import in the scaffold.


- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts`
Expected: PASS. Add any missing fixtures (e.g. `makeIssue`, `throwOnWriteIndex`) to round out the suite. Ensure the `apply`, `skip(idempotent)`, `skip(requires-approval)`, `skip(user)`, `failed`, and abort cases all have coverage per spec §12.

- [ ] **Step 5: Write the apply-artifact for audit**

In `apply()`, after assembling the report, persist it as a durable artifact keyed to the same analysisId:

```ts
await this.deps.artifacts.writeJson(analysisId, APPLY_ARTIFACT, report);
```

The artifact records per-patch outcomes including declines (`skippedBy: "user"`), satisfying spec §6 Step 5 / §13.6. Extend the test suite with an assertion that `artifacts.readJson(analysisId, "reconciliation-apply.json")` returns the same `ApplyReport`.

- [ ] **Step 6: Run the full new-unit suite + repository gates**

Run: `npx vitest run tests/unit/reconciliation/ tests/unit/domain/apply.test.ts`
Then: `npm run typecheck`, `npm run build`
Expected: PASS / typecheck clean / build clean.

- [ ] **Step 7: Commit**

```bash
git add src/reconciliation/apply-service.ts tests/unit/reconciliation/apply-service.test.ts
git commit -m "feat(reconcile-apply): add ApplyService with staleness guard and idempotent apply"
```

---

### Task 6: CLI command — `reconcile-apply`

**Files:**
- Create: `src/commands/reconcile-apply.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/commands/reconcile-apply.test.ts`

**Interfaces:**
- Consumes: `ApplyService`, `ApplyOptions`, `ApplyReport` from Task 5; the CLI wiring pattern from `src/commands/reconcile.ts`; `resolveRepositoryContext`, `loadRepositoryConfig`, `ArtifactStore`, `appPaths`.
- Produces: `registerReconcileApplyCommand(program, deps)` registered in `src/cli.ts` at line ~60.

- [ ] **Step 1: Write the failing CLI test**

Create `tests/unit/commands/reconcile-apply.test.ts`, following the exact DI style of `reconcile.test.ts` (an `createApplyService` dep + a capture of `setExitCode`). Test at minimum:

- exits `0` on a fully-applied `ApplyReport`,
- exits `2` when the report `summary.failed > 0` (or entries contain a failed outcome),
- exits `1` when the service throws (e.g. report not found),
- passes `--yes` and `--force` through to the service,
- `--json` emits the `ApplyReport` on stdout.

Sketch:

```ts
import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerReconcileApplyCommand } from "../../../src/commands/reconcile-apply.js";
import type { ApplyReport } from "../../../src/domain/apply.js";

const APPLIED: ApplyReport = {
  repository: { owner: "acme", repo: "widgets" },
  analysisId: "reconcile-1-12",
  appliedAt: "2026-08-23T00:00:00.000Z",
  staleness: { staleAgeHours: 0.5, guardApplied: true, overriddenByForce: false },
  entries: [],
  summary: { applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0, skippedUser: 0, failed: 0, previewed: 0 },
};

function makeCommand(overrides: {
  report?: ApplyReport;
  error?: Error;
  stderr?: string;
  exit?: number;
} = {}) {
  const program = new Command();
  const stdout: string[] = [];
  let exitCode: number | undefined;
  registerReconcileApplyCommand(program, {
    cwd: "/tmp/fake-repo",
    createApplyService: async (deps) => {
      if (overrides.error) throw overrides.error;
      return {
        apply: async (analysisId: string, opts) => {
          if (overrides.exit === 1) throw new Error("not found");
          return overrides.report ?? APPLIED;
        },
      };
    },
    stdout: (s: string) => { stdout.push(s); },
    setExitCode: (c: number) => { exitCode = c; },
    isTTY: false,
  });
  return { program, stdout, exitCode: () => exitCode };
}
```

Drive with `program.parse(["reconcile-apply", "reconcile-1-12", "--yes", "--json"])`. Assert the `createApplyService` receives `{ yes: true, force: false }` and the JSON report is on stdout, and that a failed summary yields exit `2`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/commands/reconcile-apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `src/commands/reconcile-apply.ts`:

```ts
import { Command } from "commander";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { appPaths } from "../platform/paths.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";
import { ApplyService } from "../reconciliation/apply-service.js";
import type { ApplyOptions, ApplyReport } from "../reconciliation/apply-service.js";

export interface ReconcileApplyCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  createGitHub?: (ctx: RepositoryContext, runner: ProcessRunner) => Promise<GitHubPort>;
  createApplyService?: (deps: {
    github: GitHubPort;
    artifacts: ArtifactStore;
    repository: RepositoryContext["repository"];
    reportStaleAfterHours?: number;
  }) => Pick<ApplyService, "apply">;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  isTTY?: boolean;
}
```

Implement `runReconcileApply` mirroring `runReconcile` in `reconcile.ts`:

- Resolve repository context and record `owner/repo`.
- `loadRepositoryConfig`, compute `reportStaleAfterHours = config.reconciliation.reportStaleAfterHours`.
- Build `GitHubAdapter` (or injected), `ArtifactStore(appPaths(deps.dataDir))`.
- Build the `ApplyService` (or injected `createApplyService`).
- Reporter: `opts.json ? null : createReporter(stdout, deps.isTTY)`.
- Call `apply(analysisId, { yes, force })`.
- Emit human summary lines (one per entry in report order: `✓ applied` / `→ skipped (<by>)` / `✗ failed`) or `--json` output.
- Map exit code: `applyReport.summary.failed > 0 || entries.some(applied && possibly not all)` → `2`; else `0`. The precise `0`/`2` rule from spec §4.1: exit `2` when `summary.failed > 0`, or `skippedUser > 0`, or an abort occurred; otherwise `0`. (Abort surfaces as a `skippedUser>0` and/or partial state; a hard throw from an abort can also be caught by setting exit `2`.)
- On thrown error → `stderr`, exit `1`.

The `registerReconcileApplyCommand` sets:

```ts
program
  .command("reconcile-apply")
  .description("Apply a stored reconciliation report's auto-safe patches to GitHub (interactive by default; use --yes unattended)")
  .argument("<analysisId>", "analysis id of a stored reconciliation report (the id echoed by `autopilot reconcile --json`)")
  .option("--yes", "apply auto-safe patches without prompting (required for any writes in a non-TTY); skips requires-approval")
  .option("--force", "bypass the staleness guard")
  .option("--json", "emit the ApplyReport as JSON")
  .action(async (analysisId: string, opts: ReconcileApplyOptions) => {
    const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
    const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
    const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
    try {
      const reporter = opts.json === true ? null : createReporter(stdout, deps.isTTY);
      try {
        const result = await runReconcileApply(analysisId, opts, deps, reporter);
        if (opts.json === true) {
          stdout(JSON.stringify(result.report, null, 2));
        } else {
          printApplySummary(result.report, stdout);
          reporter?.line(
            `apply-safe: ${result.report.summary.applied} applied, ` +
              `${result.report.summary.failed} failed, ` +
              `${result.report.summary.skippedRequiresApproval} requires-approval, ` +
              `${result.report.summary.skippedIdempotent} already-satisfied`,
          );
        }
        // Exit 2 on partial (failed, user-declined, or aborted); 0 otherwise.
        const partial =
          result.report.summary.failed > 0 ||
          result.report.summary.skippedUser > 0 ||
          result.report.aborted === true;
        setExitCode(partial ? 2 : 0);
      } finally {
        reporter?.close();
      }
    } catch (error) {
      stderr(
        `autopilot reconcile-apply: ${error instanceof Error ? error.message : String(error)}`,
      );
      setExitCode(1);
    }
  });
```

```ts
interface ReconcileApplyOptions {
  json?: boolean;
  yes?: boolean;
  force?: boolean;
}

async function runReconcileApply(
  analysisId: string,
  opts: ReconcileApplyOptions,
  deps: ReconcileApplyCommandDeps,
  reporter: Reporter | null,
): Promise<{ report: ApplyReport }> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const config = await loadRepositoryConfig(ctx.root);
  const github = deps.createGitHub !== undefined
    ? await deps.createGitHub(ctx, runner)
    : await GitHubAdapter.create(ctx.root, runner);

  const paths = appPaths(deps.dataDir);
  const artifacts = new ArtifactStore(paths);
  const service =
    deps.createApplyService !== undefined
      ? deps.createApplyService({
          github,
          artifacts,
          repository: ctx.repository,
          reportStaleAfterHours: config.reconciliation.reportStaleAfterHours,
        })
      : new ApplyService({
          github,
          artifacts,
          repository: ctx.repository,
          reportStaleAfterHours: config.reconciliation.reportStaleAfterHours,
          onPreview: (text) => reporter?.line(text),
          confirmMenu: confirmMenu,
        });

  reporter?.line(`→ applying ${analysisId} on ${ctx.repository.owner}/${ctx.repository.repo}`);
  const report = await service.apply(analysisId, { yes: opts.yes === true, force: opts.force === true });
  return { report };
}

function printApplySummary(report: ApplyReport, stdout: (t: string) => void): void {
  for (const entry of report.entries) {
    const target = entry.targetIssue === null ? "" : `#${entry.targetIssue} `;
    if (entry.outcome.status === "applied") {
      stdout(`  ✓ ${target}${entry.detail}`);
    } else if (entry.outcome.status === "failed") {
      stdout(`  ✗ ${target}${entry.detail} (${entry.outcome.error})`);
    } else {
      stdout(`  → ${target}skipped (${entry.outcome.skippedBy})`);
    }
  }
}
```

Notes:
- Import the plain exported `confirmMenu` from `apply-preview.ts` (Task 3);
  the real CLI passes it so a real TTY gets the `readline/promises` reader. The injected `createApplyService` path in tests
  supplies its own `confirmMenu` override or a fake service, so the command
  does not depend on real stdio in unit tests.
- The `partial` exit rule (`failed > 0 || skippedUser > 0 || aborted` → `2`)
  exactly matches spec §4.1. `aborted` is included in `ApplyReport` (Task 1)
  and set by the service when `q` is chosen, so an abort-with-nothing-applied
  reliably yields exit `2`, distinct from a clean `0`.

- [ ] **Step 4: Register in `src/cli.ts`**

Add the import and call next to the other commands:

```ts
import { registerReconcileApplyCommand } from "./commands/reconcile-apply.js";
// ...
registerReconcileApplyCommand(program, deps);
```

Place it after `registerReconcileCommand(program, deps);` at line ~59.

- [ ] **Step 5: Run the CLI test + gates**

Run: `npx vitest run tests/unit/commands/reconcile-apply.test.ts`
Then `npm run typecheck`, `npm test`, `npm run build`.
Expected: PASS / typecheck clean / full suite green / build clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/reconcile-apply.ts src/cli.ts tests/unit/commands/reconcile-apply.test.ts
git commit -m "feat(reconcile-apply): add reconcile-apply CLI command"
```

---

### Task 7: CLI e2e + redaction + MILESTONES note

**Files:**
- Test: `tests/unit/commands/reconcile-apply.test.ts` (extend) and/or a `tests/e2e` harness addition under the fake-Pi + fake-GitHub acceptance suite.
- Modify: `docs/MILESTONES.md` — move `apply-safe` from the "Backlog — missing features" list into a proper milestone section.

- [ ] **Step 1: Extend the CLI e2e for reconcile-apply**

Mirror how `reconcile` is covered in the acceptance suite (search `tests/e2e` or the fake-Pi harness). Add a test that, given a fake GitHub with a stored report, runs `reconcile-apply <analysisId> --yes --json` and asserts:
- exactly the auto-safe patches are written (no `MARK_STALE`/`NEEDS_HUMAN` write),
- non-TTY without `--yes` performs **zero** writes (preview-only),
- stdout JSON parses as `ApplyReport`.

Reuse the fake-Pi scenario harness only if the e2e requires a Pi session; `reconcile-apply` does **not** run a Pi session, so a stored report fixture + fake GitHub suffices — confirm the e2e setup can inject a pre-seeded `ArtifactStore` report.

- [ ] **Step 2: Redaction check**

Ensure any `ApplyReport`/preview that could carry GitHub bodies passes through the existing redaction (`src/commands/redact.ts`) before printing. Extend the redaction helper coverage if `renderEnrichPreview`/`renderCreatePreview` output isn't already routed through it in the CLI's human summary. Add a test that a secret-shaped value in a body (`ghp_…`) does not appear in `--json` or human output when redaction is applied.

- [ ] **Step 3: Update MILESTONES.md**

Move the `Reconciliation apply-safe mode` block out of the "Backlog — missing features" grouping into a dated milestone section documenting what shipped, and record the deferred items (reconciler steering, `apply-all`, remaining patch types, label policy) at the top of the missing-features list.

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. Verify `git status` shows only the intended files.

- [ ] **Step 5: Commit**

```bash
git add tests/ docs/MILESTONES.md
git commit -m "chore(reconcile-apply): e2e coverage, redaction, milestone status"
```

---

## Self-review

### Spec coverage (mapped to tasks)

- §4 CLI interface (`reconcile-apply <analysisId> --yes/--force/--json`) → Task 6.
- §4.1 exit codes (0/1/2 incl. abort/decline) → Task 6 (exit mapping), Task 5 (service throws/outcomes).
- §5 domain types → Task 1.
- §6 apply pipeline (load+guard, partition, revalidate, apply, continue-on-error) → Task 5; §6 Step 4 write mechanics (CREATE→ENRICH→ADD, dependency grammar, linkback) → Task 5 + Task 2.
- §7 preview + prompt (`y/n/a/q`, default skip, requires-approval only per `y`) → Task 3 + Task 5.
- §8 non-interactive / `--yes` (preview-only never writes) → Task 5 (`yes`/menu) + Task 7 (e2e zero-write).
- §9 config `reportStaleAfterHours` (default 168; neg/null disables; `--force`) → Task 4 + Task 5 (guard) + Task 6 (`--force`).
- §10 module layout → Tasks 1-6.
- §11 error handling → Task 5 + Task 6.
- §12 testing → Tasks 1-7.
- §13 acceptance criteria → Tasks 5-7.
- Declines recorded, not steered (out of scope) → Task 5 (skip-user entries) + Task 7 (no steering wiring). Explicitly **not** implemented.
- Explicitly deferred: `apply-all`, `SPLIT_ISSUE`/`MERGE_DUPLICATE`/`REMOVE_DEPENDENCY`/`MARK_READY`, label policy, concurrent application → no tasks (correctly absent).

### Placeholder scan

Two intentional fixups to call out that are **NOT** placeholders in the final plan but were flagged during drafting:
- Task 2 Step 1's `appendDependencyToBody` assertion is pinned to the exact
  renderer output (`Body here.\n\nDepends on:\n- #7 (unsatisfied)`); the
  implementer makes the renderer match that string exactly — no placeholder.

These are in-plan annotations, not unfinished sections; the engineer resolves them inline.

### Type consistency cross-check

- `ApplyReport`/`ApplyEntry`/`ApplyOutcome` (Task 1, incl. `aborted: boolean`) are the return type of `apply()` (Task 5) and what `reconcile-apply` serializes + uses for the exit `2` rule (Task 6). ✓
- `renderDependencyLine` / `appendDependencyToBody` / `bodyAlreadyDependsOn` (Task 2) are imported identically by Task 3 (preview) and Task 5 (apply). ✓
- `confirmMenu` returns `MenuAnswer = "apply" | "skip" | "all" | "abort"` (Task 3); Task 5's `decide` phase consumes it and maps to `Decision`, and Task 5/6 both import the plain `confirmMenu` export (no `defaultConfirmMenu` alias). ✓
- `renderEnrichPreview` / `renderDependencyPreview` / `renderCreatePreview` (Task 3) are called from Task 5's `prepare*` helpers over the freshly-fetched body; the `onPreview` dep (`ApplyServiceDeps`) delivers the text to the CLI reporter. ✓
- `upsertReconciliationSection` / `renderReconciliationSection` (existing) used in both Task 3 previews and Task 5 `prepareEnrich` / `writeCreate`. `collectEpicIssueRefs` (existing) used in Task 5 `prepareCreate`/`writeCreate` for title-duplicate scan and checklist linkback. ✓
- `config.reconciliation.reportStaleAfterHours` (Task 4) consumed by `ApplyServiceDeps.reportStaleAfterHours` (Task 5) and wired by the CLI `runReconcileApply` (Task 6). ✓
- `ApplyOptions` (`yes`, `force`) flows from CLI `--yes`/`--force` (Task 6) into `apply(analysisId, opts)` (Task 5). ✓
