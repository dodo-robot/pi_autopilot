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
