import { describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import { buildRefinerPrompt } from "../../../src/readiness/prompt.js";

const config: AutopilotConfig = {
  version: 1,
  workspace: {
    baseBranch: "main",
    branchPrefix: "autopilot/",
    requireCleanCheckout: true,
    retainBlockedWorktree: true,
  },
  commands: { setup: ["npm ci"], verify: ["npm test", "npm run typecheck"] },
  agents: {},
  agentPolicy: {
    allowedCommands: ["npm"],
    protectedPaths: [],
    allowNetwork: false,
  },
  budgets: {
    implementation: { timeoutMinutes: 60, maxAttempts: 3 },
    review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
  },
  publication: { draftPr: false, issueComment: "concise", autoMerge: false },
};

const issue: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.\n\n## Acceptance criteria\n- [ ] A refresh with an expired token returns 401",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
};

function prompt(): string {
  return buildRefinerPrompt({
    repository: { owner: "acme", repo: "widgets" },
    issue,
    config,
    sourceBodyHash: "abc123",
  });
}

describe("buildRefinerPrompt", () => {
  it("includes repository identity, issue identity, body, and source hash", () => {
    const text = prompt();
    expect(text).toContain("acme/widgets");
    expect(text).toContain("#42");
    expect(text).toContain("abc123");
    expect(text).toContain("Refresh tokens must be rejected when expired.");
  });

  it("instructs the refiner about the structured output contract", () => {
    const text = prompt();
    expect(text).toContain("submit_result");
    expect(text).toContain("acceptanceCriteria");
    expect(text).toContain("taskDraft");
    expect(text).toContain("PRODUCT_AMBIGUITY");
    expect(text).toContain("ENGINEERING");
  });

  it("lists configured verification commands", () => {
    const text = prompt();
    expect(text).toContain("- npm test");
    expect(text).toContain("- npm run typecheck");
  });

  it("requires automated validation and rejects manual-only checks", () => {
    const text = prompt();
    expect(text).toMatch(/manual-only/i);
    expect(text).toMatch(/automated check/i);
  });

  it("tells the refiner to preserve the source body hash", () => {
    expect(prompt()).toContain('"sourceBodyHash": "abc123"');
  });

  it("includes operator clarifications when provided", () => {
    const text = buildRefinerPrompt({
      repository: { owner: "acme", repo: "widgets" },
      issue,
      config,
      sourceBodyHash: "abc123",
      clarifications: [
        {
          question: "What should happen when the session is expired?",
          answer: "Redirect to login",
        },
      ],
    });

    expect(text).toContain("Operator clarifications collected during this prepare session");
    expect(text).toContain("Q: What should happen when the session is expired?");
    expect(text).toContain("A: Redirect to login");
  });
});
