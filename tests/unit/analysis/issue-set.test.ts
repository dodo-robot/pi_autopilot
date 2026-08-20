import { describe, expect, it, vi } from "vitest";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import {
  collectEpicIssueRefs,
  isEpicBody,
  resolveIssueSet,
} from "../../../src/analysis/issue-set.js";

const repo = { owner: "acme", repo: "widgets" };

function makeIssue(n: number): GitHubIssue {
  return {
    number: n,
    nodeId: `I_${n}`,
    title: `Task ${n}`,
    body: "body",
    updatedAt: "2026-08-20T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${n}`,
  };
}

class FakeGitHub implements GitHubPort {
  readonly calls: number[] = [];
  constructor(private readonly issues: GitHubIssue[]) {}
  async getIssue(number: number): Promise<GitHubIssue> {
    this.calls.push(number);
    const found = this.issues.find((i) => i.number === number);
    if (!found) throw new Error(`issue #${number} not found`);
    return found;
  }
  async updateIssueBody(): Promise<GitHubIssue> { throw new Error("must not be called"); }
  async createIssueComment(): Promise<void> { throw new Error("must not be called"); }
  async findPullRequestByHead(): Promise<null> { return null; }
  async createPullRequest(): Promise<never> { throw new Error("must not be called"); }
  async findIssueCommentByMarker(): Promise<null> { return null; }
}

describe("collectEpicIssueRefs", () => {
  it("extracts bare and qualified refs from checklist lines", () => {
    const body = [
      "- [ ] **Task** Implement the widget (#101)",
      "- [ ] Cross-cutting concern (acme/widgets#102)",
      "- [ ] ##102",
      "- [ ] Refactor the parser",
    ].join("\n");
    const { issues, unresolvedProseLines } = collectEpicIssueRefs(body);
    expect(issues).toEqual([101, 102, 102]);
    expect(unresolvedProseLines).toEqual([4]);
  });
  it("returns empty when there are no checklist items", () => {
    expect(collectEpicIssueRefs("No checklist here")).toEqual({ issues: [], unresolvedProseLines: [] });
  });
  it("detects an epic body", () => {
    expect(isEpicBody("- [ ] #1\n- [ ] #2")).toBe(true);
    expect(isEpicBody("Just prose")).toBe(false);
  });
  it("detects an epic body even when the reference is not on the first line", () => {
    expect(isEpicBody("- [ ] prose line\n- [ ] #1")).toBe(true);
  });
});

describe("resolveIssueSet", () => {
  it("fetches the requested issues and records missing ones", async () => {
    const github = new FakeGitHub([makeIssue(101), makeIssue(102)] as GitHubIssue[]);
    const set = await resolveIssueSet([101, 102, 999], 28, github, repo);
    expect(set.issues.map((i) => i.number)).toEqual([101, 102]);
    expect(set.missing).toEqual([999]);
    expect(set.unresolvedProseLines).toEqual([]);
    expect(github.calls).toEqual([101, 102, 999]);
  });
});
