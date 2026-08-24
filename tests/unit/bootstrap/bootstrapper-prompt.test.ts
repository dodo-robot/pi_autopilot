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
    expect(prompt).toContain("ask_human");
    expect(prompt).toContain("human-in-the-loop");
  });
});
