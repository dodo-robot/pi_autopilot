import { describe, expect, it } from "vitest";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import { buildReconcilerPrompt } from "../../../src/reconciliation/prompt.js";

function issue(number: number, title: string, body: string): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-18T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

const repository = { owner: "acme", repo: "widgets" };
const epic = issue(12, "Authentication overhaul", "- [ ] #15 OAuth callback");
const issues = [issue(15, "OAuth callback", "Handle the GitHub OAuth callback")];

const epicWithBody = issue(
  28,
  "Dashboard epic",
  "Ship the dashboard epic with SSO support\n\n- [ ] #101 Build gadget",
);

describe("buildReconcilerPrompt", () => {
  it("includes the epic number and title", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("#12");
    expect(prompt).toContain("Authentication overhaul");
  });

  it("includes the epic's state and body", () => {
    const prompt = buildReconcilerPrompt({
      repository,
      epic: epicWithBody,
      issues,
      requirementDocs: [],
    });
    expect(prompt).toContain("open");
    expect(prompt).toContain("Ship the dashboard epic with SSO support");
  });

  it("includes every issue's number, title, and body", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("#15");
    expect(prompt).toContain("OAuth callback");
    expect(prompt).toContain("Handle the GitHub OAuth callback");
  });

  it("includes every requirement document's path and content", () => {
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues,
      requirementDocs: [{ path: "requirements.md", content: "REQ-AUTH-001: users can log in" }],
    });
    expect(prompt).toContain("requirements.md");
    expect(prompt).toContain("REQ-AUTH-001: users can log in");
  });

  it("notes when no requirement documents are configured", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("no requirement documents configured");
  });

  it("notes when the epic has no checklist issues", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues: [], requirementDocs: [] });
    expect(prompt).toContain("epic has no checklist issues");
  });

  it("instructs the model to propose SPLIT_ISSUE for an oversized issue with a mechanical split, and NEEDS_HUMAN when the split itself is a product call", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("oversized");
    expect(prompt).toContain("SPLIT_ISSUE");
    expect(prompt).toContain("NEEDS_HUMAN");
    expect(prompt).toContain("product");
  });

  it("includes prior requirement IDs when a prior report is given", () => {
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues,
      requirementDocs: [],
      priorReport: { coverage: [{ requirementId: "REQ-AUTH-004", description: "GitHub login" }] },
    });
    expect(prompt).toContain("REQ-AUTH-004");
    expect(prompt).toContain("Reuse these IDs");
  });

  it("includes the REMOVE_DEPENDENCY patch shape in the output contract", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain('"type": "REMOVE_DEPENDENCY"');
    expect(prompt).toContain('"dependsOn"');
  });

  it("instructs the reconciler never to propose REMOVE_DEPENDENCY against a free-text dependency line", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain("REMOVE_DEPENDENCY");
    expect(prompt).toContain("free-text");
  });

  it("includes the SPLIT_ISSUE patch shape with children in the output contract", () => {
    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs: [] });
    expect(prompt).toContain('"type": "SPLIT_ISSUE"');
    expect(prompt).toContain('"children"');
  });
});
