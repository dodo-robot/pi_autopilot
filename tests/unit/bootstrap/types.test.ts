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
