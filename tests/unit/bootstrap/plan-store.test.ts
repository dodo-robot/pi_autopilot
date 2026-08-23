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
