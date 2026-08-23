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
