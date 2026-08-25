# Reconciler Steering (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed human-declined apply patches (`skippedBy: "user"` in `reconciliation-apply.json`) into the next `reconcile <epic>` run's reconciler prompt, so the model stops re-proposing patches a human already declined.

**Architecture:** `ApplyService.apply()` writes a per-epic apply index pointer (`writeLatestApply`) next to the existing apply artifact. `ReconciliationService.reconcile()` reads that pointer, loads the referenced `reconciliation-apply.json`, extracts declines via a pure `extractDeclines()` helper, and passes them to `buildReconcilerPrompt` as a new `applySteering` input that renders an "Apply steering context" section plus a prompt rule. All reads are local artifacts; no new `GitHubPort` methods.

**Tech Stack:** TypeScript, Node.js 22 (ESM), Vitest, zod. TDD throughout.

**Spec:** `docs/superpowers/specs/2026-08-25-reconciler-steering-design.md`

## Global Constraints

- Repo commands: `cd revalbis-app` is NOT used — work in `/Users/andrea.dodero/pi_autopilot`. Test: `npx vitest run <file>`. Typecheck: `npm run typecheck`. Build: `npm run build`. Acceptance: `npm run build && npm run test:e2e`.
- Test command does NOT type-check (esbuild). After code changes run `npm run typecheck` and `npm run build` to catch type errors, and verify every test fake that implements changed interfaces still conforms.
- Strict TDD: write the failing test, watch it fail, then implement. Commit after each task's green.
- Signature/interface changes must be safe for all callers — grep before changing a public signature.
- Do NOT reorder or rename existing exports used elsewhere without grepping all callers.
- Comment style: match surrounding code (JSDoc on new public methods/types; inline comments only where they explain non-obvious decisions).

---

### Task 1: Per-epic apply index — path helper + ArtifactStore methods

**Files:**
- Modify: `src/platform/paths.ts` (add `latestApplyPath` to `AppPaths` interface + implementation)
- Modify: `src/persistence/artifact-store.ts` (add `LatestApply` interface, `writeLatestApply`, `readLatestApply`)
- Test: `tests/unit/persistence/artifact-store.test.ts` (new)
- Test: `tests/unit/platform/paths.test.ts` (new, only if one does not exist — check first; if the repo has no paths-test, fold the path check into the artifact-store test)

**Interfaces:**
- Consumes: `paths.runsDir`, the existing `POINTER_SEGMENT_PATTERN` and `assertSafeRunId` helpers in `paths.ts`; `randomBytes`, `mkdir`, `writeFile`, `rename`, `readFile` already imported in `artifact-store.ts`.
- Produces:
  - `AppPaths.latestApplyPath(owner: string, repo: string, epicNumber: number): string` — returns `<runsDir>/_latest/<owner>/<repo>/apply-epic-<epicNumber>.json`, validating `owner`/`repo` with `POINTER_SEGMENT_PATTERN` and `epicNumber` as a positive integer (mirror `issuePointerPath` exactly).
  - `interface LatestApply { analysisId: string; epicRef: number; repository: { owner: string; repo: string }; appliedAt: string; }`
  - `ArtifactStore.writeLatestApply(owner: string, repo: string, epicNumber: number, data: LatestApply): Promise<void>`
  - `ArtifactStore.readLatestApply(owner: string, repo: string, epicNumber: number): Promise<LatestApply | null>`

- [ ] **Step 1: Add the `latestApplyPath` helper to `src/platform/paths.ts`**

Add to the `AppPaths` interface (after the `issuePointerPath` doc line ~19):

```ts
  /**
   * Absolute path for an epic's latest-apply index pointer under
   * `runs/_latest/<owner>/<repo>/apply-epic-<N>.json`, distinct from the
   * per-issue readiness pointers (same directory, different filename).
   */
  latestApplyPath(owner: string, repo: string, epicNumber: number): string;
```

Add to the implementation object in `appPaths()` (next to `issuePointerPath`, ~line 71):

```ts
    latestApplyPath(owner: string, repo: string, epicNumber: number): string {
      for (const segment of [owner, repo]) {
        if (!POINTER_SEGMENT_PATTERN.test(segment)) {
          throw new Error(`unsafe pointer segment: ${JSON.stringify(segment)}`);
        }
      }
      if (!Number.isInteger(epicNumber) || epicNumber <= 0) {
        throw new Error(`unsafe epic number: ${JSON.stringify(epicNumber)}`);
      }
      return path.join(runsDir, "_latest", owner, repo, `apply-epic-${epicNumber}.json`);
    },
```

- [ ] **Step 2: Add the `LatestApply` type and store methods to `src/persistence/artifact-store.ts`**

Add the `LatestApply` interface near `LatestReadinessPointer` (~line 13):

```ts
/** Per-epic pointer to the latest reconciliation apply report. */
export interface LatestApply {
  analysisId: string;
  epicRef: number;
  repository: { owner: string; repo: string };
  appliedAt: string;
}
```

Add the two methods at the end of the class, mirroring `writeLatestReadiness`/`readLatestReadiness`:

```ts
  /**
   * Persist the per-epic latest-apply pointer. Overwrites any prior pointer
   * for the same epic. Written atomically via the same tmp+rename pattern.
   */
  async writeLatestApply(
    owner: string,
    repo: string,
    epicNumber: number,
    data: LatestApply,
  ): Promise<void> {
    const target = this.paths.latestApplyPath(owner, repo, epicNumber);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, target);
  }

  /**
   * Read the per-epic latest-apply pointer, or `null` when it does not
   * exist or fails to parse (tolerant: a corrupt pointer simply means "no
   * reusable apply index").
   */
  async readLatestApply(
    owner: string,
    repo: string,
    epicNumber: number,
  ): Promise<LatestApply | null> {
    const target = this.paths.latestApplyPath(owner, repo, epicNumber);
    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as LatestApply;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/persistence/artifact-store.test.ts`. Model the setup on `tests/unit/reconciliation/apply-service.test.ts` (mkdtemp + `appPaths(dataDir)` + `new ArtifactStore(paths)`, `rmSync` in `afterEach`):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";

const pointer = {
  analysisId: "reconcile-1-12",
  epicRef: 12,
  repository: { owner: "acme", repo: "widgets" },
  appliedAt: "2026-08-25T00:00:00.000Z",
};

describe("ArtifactStore latest-apply pointer", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a latest-apply pointer and points it at the newest apply per epic", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    dirs.push(dataDir);
    const store = new ArtifactStore(appPaths(dataDir));

    await store.writeLatestApply("acme", "widgets", 12, pointer);
    expect(await store.readLatestApply("acme", "widgets", 12)).toEqual(pointer);

    // A second write for the same epic replaces the pointer.
    const newer = { ...pointer, analysisId: "reconcile-2-12", appliedAt: "2026-08-25T01:00:00.000Z" };
    await store.writeLatestApply("acme", "widgets", 12, newer);
    expect(await store.readLatestApply("acme", "widgets", 12)).toEqual(newer);
  });

  it("returns null when the pointer was never written, and tolerates a corrupt pointer", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    dirs.push(dataDir);
    const store = new ArtifactStore(appPaths(dataDir));

    expect(await store.readLatestApply("acme", "widgets", 99)).toBeNull();

    // Corrupt the file on disk to emulate a torn write.
    await store.writeLatestApply("acme", "widgets", 12, pointer);
    const target = appPaths(dataDir).latestApplyPath("acme", "widgets", 12);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, "not json{{");
    expect(await store.readLatestApply("acme", "widgets", 12)).toBeNull();
  });

  it("rejects unsafe pointer segments and non-positive epic numbers", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    dirs.push(dataDir);
    const paths = appPaths(dataDir);
    expect(() => paths.latestApplyPath("..", "widgets", 12)).toThrow(/unsafe pointer segment/);
    expect(() => paths.latestApplyPath("acme", "widgets", 0)).toThrow(/unsafe epic number/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/unit/persistence/artifact-store.test.ts`
Expected: FAIL — `latestApplyPath`/`writeLatestApply` not defined (they do not exist until Steps 1-2 are applied; if you apply Steps 1-2 first, confirm the interface compiles). Note: apply Steps 1-2 implementation before running if editing order matters, but the test must be written first; run once with implementation present to prove it passes.

- [ ] **Step 5: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/platform/paths.ts src/persistence/artifact-store.ts tests/unit/persistence/artifact-store.test.ts
git commit -m "feat(reconciliation): add per-epic latest-apply index pointer
store methods (writeLatestApply/readLatestApply) plus the path helper"
```

---

### Task 2: `extractDeclines` pure helper + `DeclinedPatch` type

**Files:**
- Modify: `src/domain/apply.ts` (add `DeclinedPatch`)
- Create: `src/reconciliation/steering.ts` (`extractDeclines`)
- Test: `tests/unit/reconciliation/steering.test.ts` (new)

**Interfaces:**
- Consumes: `ApplyReport`, `ApplyEntry` from `../domain/apply.js`; `BacklogPatchType` from `../domain/reconciliation.js`.
- Produces:
  - `interface DeclinedPatch { patchType: BacklogPatchType; targetIssue: number; reason?: string; }` (exported from `src/domain/apply.ts`)
  - `extractDeclines(applyReport: ApplyReport): DeclinedPatch[]` (exported from `src/reconciliation/steering.ts`)

- [ ] **Step 1: Add `DeclinedPatch` to `src/domain/apply.ts`**

Add after `ApplyReport` type (~end of file):

```ts
/** A patch a human declined during reconcile-apply (outcome skipped by
 * user), trimmed to the steering signal fed into a future reconcile. */
export interface DeclinedPatch {
  patchType: BacklogPatchType;
  targetIssue: number;
  reason?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/reconciliation/steering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ApplyReport } from "../../../src/domain/apply.js";
import { extractDeclines } from "../../../src/reconciliation/steering.js";

const base: ApplyReport = {
  repository: { owner: "acme", repo: "widgets" },
  analysisId: "reconcile-1-12",
  appliedAt: "2026-08-25T00:00:00Z",
  staleness: { staleAgeHours: 1, guardApplied: true, overriddenByForce: false },
  entries: [],
  summary: {
    applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0,
    skippedUser: 0, failed: 0, previewed: 0,
  },
};

describe("extractDeclines", () => {
  it("returns only skipped-by-user entries with a target issue, carrying the declineReason", () => {
    const report: ApplyReport = {
      ...base,
      entries: [
        { patchType: "ENRICH_ISSUE", targetIssue: 7, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "enrich #7", declineReason: "waiting on product decision" },
        { patchType: "ADD_DEPENDENCY", targetIssue: 8, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "dep #8" },
        { patchType: "ENRICH_ISSUE", targetIssue: 9, policy: "auto-safe", outcome: { status: "applied" }, detail: "applied", appliedIssueNumber: 9 },
        { patchType: "ENRICH_ISSUE", targetIssue: 10, policy: "auto-safe", outcome: { status: "skipped", skippedBy: "idempotent" }, detail: "already" },
        { patchType: "REMOVE_DEPENDENCY", targetIssue: 11, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "requires-approval" }, detail: "gate" },
        { patchType: "ENRICH_ISSUE", targetIssue: 12, policy: "auto-safe", outcome: { status: "failed", error: "boom" }, detail: "failed" },
        { patchType: "NEEDS_HUMAN", targetIssue: 13, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "answered" },
      ],
    };
    expect(extractDeclines(report)).toEqual([
      { patchType: "ENRICH_ISSUE", targetIssue: 7, reason: "waiting on product decision" },
      { patchType: "ADD_DEPENDENCY", targetIssue: 8 },
      { patchType: "NEEDS_HUMAN", targetIssue: 13 },
    ]);
  });

  it("drops skipped-by-user entries whose targetIssue is null", () => {
    const report: ApplyReport = {
      ...base,
      entries: [
        { patchType: "NEEDS_HUMAN", targetIssue: null, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "no target" },
      ],
    };
    expect(extractDeclines(report)).toEqual([]);
  });

  it("returns an empty array for a report with no declines", () => {
    expect(extractDeclines(base)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/reconciliation/steering.test.ts`
Expected: FAIL — `extractDeclines` not exported.

- [ ] **Step 4: Write the minimal implementation**

Create `src/reconciliation/steering.ts`:

```ts
import type { ApplyReport, DeclinedPatch } from "../domain/apply.js";

/**
 * Reduce a completed apply report to the steering signal for a future
 * reconcile: the human-declined patches (`skippedBy: "user"`). Excludes
 * every other outcome (gates, idempotent skips, failures, applies) and
 * drops user-skips with no target issue. Pure — never touches GitHub or I/O.
 */
export function extractDeclines(applyReport: ApplyReport): DeclinedPatch[] {
  const declines: DeclinedPatch[] = [];
  for (const entry of applyReport.entries) {
    if (entry.outcome.status !== "skipped" || entry.outcome.skippedBy !== "user") {
      continue;
    }
    if (entry.targetIssue === null) continue;
    declines.push({
      patchType: entry.patchType,
      targetIssue: entry.targetIssue,
      ...(entry.declineReason !== undefined ? { reason: entry.declineReason } : {}),
    });
  }
  return declines;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/reconciliation/steering.test.ts`
Expected: PASS.

- [ ] **Step 6: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/domain/apply.ts src/reconciliation/steering.ts tests/unit/reconciliation/steering.test.ts
git commit -m "feat(reconciliation): extractDeclines pure helper + DeclinedPatch type"
```

---

### Task 3: Prompt `applySteering` input, section, and rule

**Files:**
- Modify: `src/reconciliation/prompt.ts`
- Test: `tests/unit/reconciliation/prompt.test.ts`

**Interfaces:**
- Consumes: `DeclinedPatch` from `../domain/apply.js`.
- Produces: `ReconcilerPromptInput.applySteering?: DeclinedPatch[]`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("buildReconcilerPrompt", ...)` in `tests/unit/reconciliation/prompt.test.ts`:

```ts
  it("renders an Apply steering context section when applySteering is non-empty", () => {
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues,
      requirementDocs: [],
      applySteering: [
        { patchType: "ENRICH_ISSUE", targetIssue: 7, reason: "waiting on product decision" },
        { patchType: "ADD_DEPENDENCY", targetIssue: 8 },
      ],
    });
    expect(prompt).toContain("Apply steering context");
    expect(prompt).toContain("ENRICH_ISSUE #7");
    expect(prompt).toContain("waiting on product decision");
    expect(prompt).toContain("#8");
  });

  it("omits the steering section and the rule when applySteering is empty or absent", () => {
    for (const input of [
      { repository, epic, issues, requirementDocs: [] },
      { repository, epic, issues, requirementDocs: [], applySteering: [] },
    ] as const) {
      const prompt = buildReconcilerPrompt(input);
      expect(prompt).not.toContain("Apply steering context");
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "steering" tests/unit/reconciliation/prompt.test.ts`
Expected: FAIL — `applySteering` not accepted / section absent.

- [ ] **Step 3: Implement `applySteering` in `buildReconcilerPrompt`**

In `src/reconciliation/prompt.ts`:

Add the import at the top:

```ts
import type { DeclinedPatch } from "../domain/apply.js";
```

Add the optional field to `ReconcilerPromptInput` (after `priorReport`):

```ts
  /** Declined patches from a prior reconcile-apply of this epic, so the
   * model does not re-propose patches a human already declined. */
  applySteering?: DeclinedPatch[];
```

In `buildReconcilerPrompt`, destructure `applySteering` out of `input` alongside the others, and add a rendered steering block (inject it just before the `return` template's final `${priorSection}`, i.e. after the `issuesSection`):

```ts
  const applySteeringSection =
    input.applySteering !== undefined && input.applySteering.length > 0
      ? `\n\nApply steering context\n-----------------------\nA prior reconcile-apply of this epic proposed patches that a human declined during apply. Do not re-propose a declined patch as-is; either KEEP the issue, propose a different patch, or — only if something has genuinely changed — propose the same patch again AND justify in its "reason" why the earlier decline no longer applies.\n${input.applySteering
          .map(
            (decline) =>
              `- ${decline.patchType} #${decline.targetIssue}${decline.reason !== undefined ? `: ${decline.reason}` : ""}`,
          )
          .join("\n")}`
      : "";
```

In the Rules list add the rule line after the existing "PRODUCT ambiguity … MUST produce a NEEDS_HUMAN patch" line:

```
- If the Apply steering context (below) lists a patch as declined, do not re-propose it unchanged; reconsider it, keep it, propose an alternative, or justify in its reason why circumstances changed.
```

Then replace the template tail `${priorSection}` with `${priorSection}${applySteeringSection}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "steering" tests/unit/reconciliation/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/prompt.ts tests/unit/reconciliation/prompt.test.ts
git commit -m "feat(reconciliation): prompt applySteering section + rule for declined patches"
```

---

### Task 4: ApplyService writes the per-epic apply index

**Files:**
- Modify: `src/reconciliation/apply-service.ts`
- Test: `tests/unit/reconciliation/apply-service.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore.writeLatestApply` from the `artifacts` dep and `report.epicRef`/`report.repository` from the loaded report (Task 1).
- Produces: no new public exports.

- [ ] **Step 1: Write the failing test**

In `tests/unit/reconciliation/apply-service.test.ts`, the `service()` helper builds an `ApplyService` with the real `ArtifactStore`? Verify: the helper uses `artifacts = new ArtifactStore(appPaths(tmp))` — yes, real store. The existing assertion loop reads back the apply artifact with `artifacts.readJson(analysisId, "reconciliation-apply.json")`. Add a new test that runs an apply over a report with one auto-safe patch and asserts the per-epic index was written:

```ts
  it("writes the per-epic latest-apply index pointer on apply", async () => {
    github.issues.set(12, epic());
    github.issues.set(15, issue15());
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        { type: "ENRICH_ISSUE", issue: 15, patch: enrichment("Add OAuth refresh"), reason: "missing criteria", policy: "auto-safe" },
      ]),
    );

    const result = await service().apply(analysisId, { yes: true, force: false });

    const pointer = await artifacts.readLatestApply("acme", "widgets", 12);
    expect(pointer).not.toBeNull();
    expect(pointer?.analysisId).toBe(analysisId);
    expect(pointer?.epicRef).toBe(12);
    expect(pointer?.repository).toEqual(repository);
    expect(pointer?.appliedAt).toBe(now);
    expect(result.summary.applied).toBe(1);
  });
```

Note: `baseReport`'s `repository` is `{ owner: "acme", repo: "widgets" }` (the module-level `repository` const) and the service is constructed with that same `repository`, so `pointer.repository` equals `repository`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run -t "per-epic latest-apply index" tests/unit/reconciliation/apply-service.test.ts`
Expected: FAIL — `readLatestApply` returns null (index never written).

- [ ] **Step 3: Implement the index write in `apply()`**

In `src/reconciliation/apply-service.ts`, inside `apply()`, immediately after the existing tail write:

```ts
    await this.deps.artifacts.writeJson(analysisId, APPLY_ARTIFACT, result);
    await this.deps.artifacts.writeLatestApply(
      report.repository.owner,
      report.repository.repo,
      report.epicRef,
      {
        analysisId,
        epicRef: report.epicRef,
        repository: report.repository,
        appliedAt: this.now(),
      },
    );
    return result;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run -t "per-epic latest-apply index" tests/unit/reconciliation/apply-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full apply-service suite**

Run: `npx vitest run tests/unit/reconciliation/apply-service.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/apply-service.ts tests/unit/reconciliation/apply-service.test.ts
git commit -m "feat(reconciliation): write the per-epic latest-apply index on apply"
```

---

### Task 5: ReconciliationService loads steering and passes it to the prompt

**Files:**
- Modify: `src/reconciliation/reconciliation-service.ts`
- Test: `tests/unit/reconciliation/reconciliation-service.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore.readLatestApply`, `ArtifactStore.readJson`, `APPLY_ARTIFACT` (exported from `./apply-service.js`), `extractDeclines`/`DeclinedPatch` (Task 2), prompt's `applySteering` input (Task 3).
- Produces: none (behavioral).

- [ ] **Step 1: Write the failing tests**

In `tests/unit/reconciliation/reconciliation-service.test.ts`, the existing `fakePi` ignores the prompt. Add a prompt-capturing fake and two tests:

```ts
  it("passes apply declines from the latest apply report into the reconciler prompt", async () => {
    const { service, artifacts } = makeService(capturePi());
    // Epic #12 has issue #15.
    // Write a prior apply report for epic #12 with a user decline, plus the index pointer.
    await artifacts.writeJson(
      "reconcile-test",
      "reconciliation-apply.json",
      {
        repository,
        analysisId: "reconcile-test",
        appliedAt: "2026-08-22T00:00:00Z",
        staleness: { staleAgeHours: 1, guardApplied: true, overriddenByForce: false },
        entries: [
          { patchType: "ENRICH_ISSUE", targetIssue: 15, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "enrich #15", declineReason: "waiting on product decision" },
        ],
        summary: { applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0, skippedUser: 1, failed: 0, previewed: 0 },
      },
    );
    await artifacts.writeLatestApply("acme", "widgets", 12, {
      analysisId: "reconcile-test",
      epicRef: 12,
      repository,
      appliedAt: "2026-08-22T00:00:00Z",
    });

    await service.reconcile(12, []);
    expect(capturedPrompt).toContain("Apply steering context");
    expect(capturedPrompt).toContain("ENRICH_ISSUE #15");
    expect(capturedPrompt).toContain("waiting on product decision");
  });

  it("builds the prompt without steering when no apply index exists for the epic", async () => {
    const { service } = makeService(capturePi());
    await service.reconcile(12, []);
    expect(capturedPrompt).not.toContain("Apply steering context");
  });
```

Add the `capturePi` helper and a `capturedPrompt` module-scope variable near the existing `fakePi` helper (~line 118):

```ts
let capturedPrompt: string;
function capturePi(): ReconcilerRunner {
  return {
    async run(request): Promise<PiExecution> {
      capturedPrompt = request.prompt;
      return {
        result: { coverage: [], patches: [] },
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        resultPath: "/tmp/result.json",
        sessionDir: "/tmp/session",
      };
    },
  };
}
```

(Reset `capturedPrompt = ""` in a `beforeEach` if present, or at the top of each test.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "steering" tests/unit/reconciliation/reconciliation-service.test.ts`
Expected: FAIL — `readLatestApply` is not called; prompt lacks the steering section.

- [ ] **Step 3: Wire the load in `reconcile()`**

In `src/reconciliation/reconciliation-service.ts`:

Add imports at the top:

```ts
import { APPLY_ARTIFACT } from "./apply-service.js";
import type { ApplyReport } from "../domain/apply.js";
import { extractDeclines } from "./steering.js";
```

Inside `reconcile()`, after the `resolveIssueSet` line and before the `const prompt = buildReconcilerPrompt(...)` line, insert the steering load:

```ts
    const repo = this.deps.repository.repository;
    const latestApply = await this.deps.artifacts.readLatestApply(
      repo.owner,
      repo.repo,
      epicRef,
    );
    let applySteering;
    if (latestApply !== null) {
      const applyReport = await this.deps.artifacts.readJson<ApplyReport>(
        latestApply.analysisId,
        APPLY_ARTIFACT,
      );
      applySteering = extractDeclines(applyReport);
    }
```

Then change the `buildReconcilerPrompt({ ... })` call to include `...(applySteering !== undefined && applySteering.length > 0 ? { applySteering } : {})`:

```ts
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues,
      requirementDocs,
      ...(applySteering !== undefined && applySteering.length > 0 ? { applySteering } : {}),
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "steering" tests/unit/reconciliation/reconciliation-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full reconciliation-service suite**

Run: `npx vitest run tests/unit/reconciliation/reconciliation-service.test.ts`
Expected: all pass.

- [ ] **Step 6: Run typecheck and the full suite**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: clean / all pass (verify the new `applySteering` spread type-checks against `ReconcilerPromptInput`).

- [ ] **Step 7: Commit**

```bash
git add src/reconciliation/reconciliation-service.ts tests/unit/reconciliation/reconciliation-service.test.ts
git commit -m "feat(reconciliation): load apply declines into the reconciler prompt"
```

---

### Task 6: Command-level integration — apply persists the index, reconcile reads it

**Files:**
- Test: `tests/unit/commands/reconcile-apply.test.ts` (assert the apply command surfaces the persisted index)
- Test: `tests/unit/commands/reconcile.test.ts` (assert a reconcile built over the persisted index loads steering)

**Interfaces:** Consumes Tasks 1-5 behavior through the real wiring: `reconcile-apply` uses `ApplyService` (Task 4 writes the index); `reconcile` uses `ReconciliationService` (Task 5 reads it).

- [ ] **Step 1: In `MakeCommand` for `reconcile-apply.test.ts`, expose the real `ArtifactStore`**

Inspect `tests/unit/commands/reconcile-apply.test.ts` — its `makeCommand` helper. Verify whether it passes a real `ArtifactStore` (with a temp `dataDir`) into `ReconcileApplyCommandDeps`. If it does, note the `dataDir` and construct an `ArtifactStore`/`appPaths` to read back the written index. If it injects a fake artifacts object, extend that fake to record `writeLatestApply` calls (same shape as the real method) and read them back in the assertion.

- [ ] **Step 2: Write the failing test**

Add to `tests/unit/commands/reconcile-apply.test.ts` a test that runs `reconcile-apply <analysisId>` with `--yes` over a stored report having one auto-safe patch, then asserts the per-epic index was persisted:

```ts
  it("persists the per-epic latest-apply index after applying", async () => {
    // ...existing deps to run the command over a stored report with one
    // auto-safe ENRICH_ISSUE patch for epic #12...
    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    const store = new ArtifactStore(appPaths(dataDir));
    const pointer = await store.readLatestApply("acme", "widgets", 12);
    expect(pointer).not.toBeNull();
    expect(pointer?.analysisId).toBe("reconcile-1-12");
    expect(pointer?.epicRef).toBe(12);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run -t "per-epic latest-apply index" tests/unit/commands/reconcile-apply.test.ts`
Expected: FAIL — pointer is null (Task 4's write is not yet in the command wiring, assuming you are running before Task 4 lands; after Task 4 it passes).

- [ ] **Step 4: Run the test to verify it passes**

After Task 4 (the `ApplyService` index write) is in place, re-run: `npx vitest run -t "per-epic latest-apply index" tests/unit/commands/reconcile-apply.test.ts`
Expected: PASS — proof that the real `reconcile-apply` command persists the index.

- [ ] **Step 5: Full regression + build**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: clean / all pass. Task 5 already proves the reconcile side reads the index into the prompt via `capturePi`; together Tasks 5+6 close the loop across both commands' real wiring.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/commands/reconcile-apply.test.ts
# only if reconcile.test.ts gained a steering assertion in Step 2's companion:
git add tests/unit/commands/reconcile.test.ts
  git commit -m "test(reconciliation): apply persists the index and reconcile reads it (command-level)"
```

---

## Self-Review

- **Spec §4 (per-epic index)** → Task 1 (path + store methods).
- **Spec §5 (`extractDeclines` + `DeclinedPatch`)** → Task 2.
- **Spec §6 (prompt `applySteering` + section + rule)** → Task 3.
- **Spec §7.1 (ApplyService writes index)** → Task 4.
- **Spec §7.2 (ReconciliationService loads)** → Task 5.
- **Spec §8 (testing incl. e2e)** → Tasks 1-6. The pure `extractDeclines` tests, store round-trip/tolerant-null tests, apply-service index assertion, reconciliation-service steering load, prompt rendering, and the CLI harness all map to the spec's §8 bullets.
- **Spec §10 (error handling)** — addressed: tolerant-null pointer read (Task 1 store method returns null), corrupt apply report throws on `readJson` (Task 5 uses the existing throwing `readJson`), no-pointer → no steering (Task 5 test).
- **Spec §11 acceptance criteria** — 1→Task 4, 2→Task 5, 3→Task 3, 4→Task 2, 5→Task 2 (exclusions tested), 6→Task 3 + Task 5, 7→Task 6 + full suite runs in each task.
- **Spec §8 (e2e bullet)** — Task 5 (`capturePi`) is the deterministic proof that a declining apply report + pointer produces a steering section in the prompt, and Task 6 proves the real `reconcile-apply` command persists the index. A separate compiled-CLI e2e that also echoes the reconciler prompt back was rejected during planning because the fake-pi executable does not surface the prompt it receives, so the service- and command-level tests are the honest, non-contrived home for this coverage.
- **Type consistency:** `DeclinedPatch` is defined in Task 2 (`src/domain/apply.ts`) and consumed by Task 3 (prompt) and Task 5 (extractDeclines) — same name and shape throughout. `APPLY_ARTIFACT` is imported in Task 5 from `./apply-service.js` (Task 4 already uses it); `readLatestApply`/`writeLatestApply` names are consistent between Task 1 (store) and Tasks 4/5 (consumers). `applySteering` field name is identical in the prompt input (Task 3) and the service call (Task 5). No placeholder steps; every code step includes its literal content.
