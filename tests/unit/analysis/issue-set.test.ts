import { describe, expect, it, vi } from "vitest";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import { GitHubError } from "../../../src/github/github-adapter.js";
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
    if (!found) {
      // A genuinely-missing issue surfaces as a 404 GitHubError.
      throw new GitHubError(`failed to fetch issue #${number}`, {
        cause: { status: 404 },
      });
    }
    return found;
  }
  async findIssueByTitle(title: string): Promise<GitHubIssue | null> {
    const desired = title.trim().toLowerCase();
    const source = this as { issues?: Map<number, GitHubIssue>; issue?: GitHubIssue };
    const issues = source.issues !== undefined
      ? [...source.issues.values()]
      : source.issue !== undefined
        ? [source.issue]
        : [];
    return issues.find((issue) => issue.title.trim().toLowerCase() === desired) ?? null;
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

  it("extracts GitHub issue-link bullets like `- [#174](url) Task 1: ...`", () => {
    // The shape used by real Minerva epics (e.g. engine-core epic #7).
    const body = [
      "## Sub-issues",
      "- [#174](https://github.com/acme/widgets/issues/174) Task 1: Define types",
      "- [#175](https://github.com/acme/widgets/issues/175) Task 2: Parser",
      "- [#176](https://github.com/acme/widgets/issues/176) Task 3: Evaluator",
    ].join("\n");
    const { issues, unresolvedProseLines } = collectEpicIssueRefs(body);
    expect(issues).toEqual([174, 175, 176]);
    expect(unresolvedProseLines).toEqual([]);
    expect(isEpicBody(body)).toBe(true);
  });

  it("extracts bare issue bullets like `- #42 Task x`", () => {
    const body = [
      "- #101 Do the thing",
      "- #102 another",
      "- A prose-only bullet with no reference",
    ].join("\n");
    const { issues, unresolvedProseLines } = collectEpicIssueRefs(body);
    expect(issues).toEqual([101, 102]);
    expect(unresolvedProseLines).toEqual([3]);
    expect(isEpicBody(body)).toBe(true);
  });

  it("does not treat a non-bullet paragraph mention of #n as a task ref", () => {
    const body =
      "Reference the existing design docs, see #174 for context.\nNo bullet here.";
    expect(collectEpicIssueRefs(body).issues).toEqual([]);
    expect(isEpicBody(body)).toBe(false);
  });

  it("records prose-only bullet lines as unresolved", () => {
    const body = [
      "- First task bullet (#201)",
      "- Some prose bullet with no issue reference",
    ].join("\n");
    const { issues, unresolvedProseLines } = collectEpicIssueRefs(body);
    expect(issues).toEqual([201]);
    expect(unresolvedProseLines).toEqual([2]);
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

  it("records a 404 GitHubError as missing", async () => {
    const github = new FakeGitHub([makeIssue(101)] as GitHubIssue[]);
    const set = await resolveIssueSet([101, 999], 28, github, repo);
    expect(set.issues.map((i) => i.number)).toEqual([101]);
    expect(set.missing).toEqual([999]);
  });

  it("propagates a non-404 GitHubError as an infrastructure failure", async () => {
    const github = {
      async getIssue(number: number): Promise<GitHubIssue> {
        if (number === 500) {
          throw new GitHubError("rate limit exceeded", {
            cause: { status: 403 },
          });
        }
        throw new GitHubError(`failed to fetch issue #${number}`, {
          cause: { status: 404 },
        });
      },
      findIssueByTitle: async () => null,
      updateIssueBody: async () => { throw new Error("must not be called"); },
      createIssueComment: async () => { throw new Error("must not be called"); },
      findPullRequestByHead: async () => null,
      createPullRequest: async () => { throw new Error("must not be called"); },
      findIssueCommentByMarker: async () => null,
    } satisfies GitHubPort;

    await expect(
      resolveIssueSet([1, 500], 28, github, repo),
    ).rejects.toThrow("rate limit exceeded");
  });

  it("propagates a plain (non-GitHubError) throw", async () => {
    const github = {
      async getIssue(): Promise<GitHubIssue> {
        throw new Error("network down");
      },
      findIssueByTitle: async () => null,
      updateIssueBody: async () => { throw new Error("must not be called"); },
      createIssueComment: async () => { throw new Error("must not be called"); },
      findPullRequestByHead: async () => null,
      createPullRequest: async () => { throw new Error("must not be called"); },
      findIssueCommentByMarker: async () => null,
    } satisfies GitHubPort;

    await expect(
      resolveIssueSet([1], 28, github, repo),
    ).rejects.toThrow("network down");
  });
});
