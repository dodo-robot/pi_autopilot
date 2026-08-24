import { describe, expect, it, vi } from "vitest";
import type {
  ProcessRequest,
  ProcessResult,
} from "../../../src/platform/process-runner.js";
import {
  GitHubAdapter,
  GitHubError,
  type OctokitLike,
} from "../../../src/github/github-adapter.js";

interface CannedResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** Deterministic stand-in for git and gh subprocesses. */
class FakeRunner {
  readonly calls: string[] = [];

  constructor(private readonly responses: Record<string, CannedResult>) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const key = [request.command, ...request.args].join(" ");
    this.calls.push(key);
    const entry = this.responses[key];
    if (entry === undefined) {
      throw new Error(`unexpected command: ${key}`);
    }
    return {
      exitCode: entry.exitCode ?? 0,
      signal: null,
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
      durationMs: 1,
      timedOut: false,
    };
  }
}

function gitRunner(overrides: Record<string, CannedResult> = {}): FakeRunner {
  return new FakeRunner({
    "git rev-parse --show-toplevel": { stdout: "/tmp/repo" },
    "git remote get-url origin": { stdout: "git@github.com:acme/widgets.git" },
    "git status --porcelain": { stdout: "" },
    "git branch --show-current": { stdout: "main" },
    ...overrides,
  });
}

function makeOctokit(): {
  octokit: OctokitLike;
} {
  const issueData = {
    number: 42,
    node_id: "I_42",
    title: "Add token refresh",
    body: "Original body",
    updated_at: "2026-08-18T00:00:00Z",
    state: "open",
    html_url: "https://github.com/acme/widgets/issues/42",
  };
  const updatedIssue = { ...issueData, body: "New body" };
  const openPull = {
    number: 101,
    html_url: "https://github.com/acme/widgets/pull/101",
    state: "open",
    head: { ref: "autopilot/42-token-refresh" },
  };
  const createdPull = {
    number: 102,
    html_url: "https://github.com/acme/widgets/pull/102",
    state: "open",
    head: { ref: "autopilot/42-token-refresh" },
  };
  const octokit = {
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({ data: issueData }),
        update: vi.fn().mockResolvedValue({ data: updatedIssue }),
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        listComments: vi.fn(),
        createComment: vi.fn().mockResolvedValue({ data: { id: 11, body: "ok" } }),
        listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [{ name: "bug" }, { name: "agent:ready" }] }),
        addLabels: vi.fn().mockResolvedValue({ data: [] }),
        removeLabel: vi.fn().mockResolvedValue({ data: [] }),
      },
      pulls: {
        list: vi.fn(),
        create: vi.fn().mockResolvedValue({ data: createdPull }),
      },
    },
  };
  return { octokit: octokit as unknown as OctokitLike };
}

describe("GitHubAdapter", () => {
  async function makeAdapter(
    octokit: OctokitLike,
    overrides: Record<string, CannedResult> = {},
  ): Promise<{ github: GitHubAdapter; runner: FakeRunner }> {
    const runner = gitRunner(overrides);
    const github = await GitHubAdapter.create("/tmp/repo", runner, {
      octokit,
    });
    return { github, runner };
  }

  it("fetches and maps an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await expect(github.getIssue(42)).resolves.toMatchObject({
      number: 42,
      nodeId: "I_42",
      title: "Add token refresh",
      body: "Original body",
      updatedAt: "2026-08-18T00:00:00Z",
      state: "open",
      htmlUrl: "https://github.com/acme/widgets/issues/42",
    });
    expect(octokit.rest.issues.get).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
    });
  });

  it("finds an issue by normalized title across live repository state", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 41,
          node_id: "I_41",
          title: "Other",
          body: "",
          updated_at: "2026-08-18T00:00:00Z",
          state: "open",
          html_url: "https://github.com/acme/widgets/issues/41",
        },
        {
          number: 42,
          node_id: "I_42",
          title: "Add token refresh",
          body: "Original body",
          updated_at: "2026-08-18T00:00:00Z",
          state: "open",
          html_url: "https://github.com/acme/widgets/issues/42",
        },
      ],
    });
    const { github } = await makeAdapter(octokit);
    await expect(github.findIssueByTitle(" add TOKEN refresh ")).resolves.toMatchObject({
      number: 42,
      title: "Add token refresh",
    });
    expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      state: "all",
      per_page: 100,
      page: 1,
    });
  });

  it("stops paging as soon as an exact normalized issue-title match is found", async () => {
    const { octokit } = makeOctokit();
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      node_id: `I_${index + 1}`,
      title: index === 49 ? "Add token refresh" : `Other ${index}`,
      body: "",
      updated_at: "2026-08-18T00:00:00Z",
      state: "open",
      html_url: `https://github.com/acme/widgets/issues/${index + 1}`,
    }));
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: fullPage });
    const { github } = await makeAdapter(octokit);

    await expect(github.findIssueByTitle(" add TOKEN refresh ")).resolves.toMatchObject({
      number: 50,
    });
    expect(octokit.rest.issues.listForRepo).toHaveBeenCalledTimes(1);
  });

  it("returns null when no issue title matches", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.listForRepo.mockResolvedValue({ data: [] });
    const { github } = await makeAdapter(octokit);
    await expect(github.findIssueByTitle("missing")).resolves.toBeNull();
  });

  it("does not match pull requests when finding issues by title", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 42,
          node_id: "PR_42",
          title: "Add token refresh",
          body: "PR body",
          updated_at: "2026-08-18T00:00:00Z",
          state: "open",
          html_url: "https://github.com/acme/widgets/pull/42",
          pull_request: {},
        },
      ],
    });
    const { github } = await makeAdapter(octokit);
    await expect(github.findIssueByTitle("Add token refresh")).resolves.toBeNull();
  });

  it("updates the issue body and returns the updated issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await expect(github.updateIssueBody(42, "New body")).resolves.toMatchObject({
      body: "New body",
    });
    expect(octokit.rest.issues.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      body: "New body",
    });
  });

  it("closes an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await github.closeIssue(42);
    expect(octokit.rest.issues.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      state: "closed",
    });
  });

  it("wraps a failure to close an issue in GitHubError", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.update.mockRejectedValueOnce(new Error("boom"));
    const { github } = await makeAdapter(octokit);
    await expect(github.closeIssue(42)).rejects.toThrow("failed to close issue #42");
  });

  it("creates an issue comment", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await github.createIssueComment(42, "hello");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      body: "hello",
    });
  });

  it("finds an open pull request by head branch", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.pulls.list.mockResolvedValue({
      data: [
        {
          number: 101,
          html_url: "https://github.com/acme/widgets/pull/101",
          state: "open",
          head: { ref: "autopilot/42-token-refresh" },
        },
      ],
    });
    const { github } = await makeAdapter(octokit);
    await expect(
      github.findPullRequestByHead("autopilot/42-token-refresh"),
    ).resolves.toEqual({
      number: 101,
      url: "https://github.com/acme/widgets/pull/101",
      head: "autopilot/42-token-refresh",
      state: "open",
    });
    expect(octokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      state: "open",
      head: "autopilot/42-token-refresh",
      per_page: 100,
      page: 1,
    });
  });

  it("returns null when no pull request matches the head", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    const { github } = await makeAdapter(octokit);
    await expect(
      github.findPullRequestByHead("autopilot/42-token-refresh"),
    ).resolves.toBeNull();
  });

  it("paginates pull requests until a page is not full", async () => {
    const { octokit } = makeOctokit();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      number: 1000 + i,
      html_url: `https://github.com/acme/widgets/pull/${1000 + i}`,
      state: "open",
      head: { ref: `other/${i}` },
    }));
    octokit.rest.pulls.list
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({
        data: [
          {
            number: 1100,
            html_url: "https://github.com/acme/widgets/pull/1100",
            state: "open",
            head: { ref: "autopilot/42-token-refresh" },
          },
        ],
      });
    const { github } = await makeAdapter(octokit);
    await expect(
      github.findPullRequestByHead("autopilot/42-token-refresh"),
    ).resolves.toMatchObject({ number: 1100 });
    expect(octokit.rest.pulls.list).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.list).toHaveBeenLastCalledWith({
      owner: "acme",
      repo: "widgets",
      state: "open",
      head: "autopilot/42-token-refresh",
      per_page: 100,
      page: 2,
    });
  });

  it("creates a pull request", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapter(octokit);
    await expect(
      github.createPullRequest({
        title: "Add token refresh",
        body: "PR body",
        head: "autopilot/42-token-refresh",
        base: "main",
        draft: false,
      }),
    ).resolves.toEqual({
      number: 102,
      url: "https://github.com/acme/widgets/pull/102",
      head: "autopilot/42-token-refresh",
      state: "open",
    });
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      title: "Add token refresh",
      body: "PR body",
      head: "autopilot/42-token-refresh",
      base: "main",
      draft: false,
    });
  });

  it("finds an issue comment containing the marker across pages", async () => {
    const { octokit } = makeOctokit();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i,
      body: `comment ${i}`,
    }));
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({
        data: [
          { id: 2100, body: "Run: <!-- autopilot-run:run-abc --> done" },
        ],
      });
    const { github } = await makeAdapter(octokit);
    await expect(
      github.findIssueCommentByMarker(42, "autopilot-run:run-abc"),
    ).resolves.toEqual({
      id: 2100,
      body: "Run: <!-- autopilot-run:run-abc --> done",
    });
    expect(octokit.rest.issues.listComments).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(octokit.rest.issues.listComments).toHaveBeenNthCalledWith(2, {
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      per_page: 100,
      page: 2,
    });
  });

  it("returns null when no comment contains the marker", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 1, body: "no marker here" }],
    });
    const { github } = await makeAdapter(octokit);
    await expect(
      github.findIssueCommentByMarker(42, "autopilot-run:run-abc"),
    ).resolves.toBeNull();
  });

  it("obtains the token from gh auth token when no octokit is injected", async () => {
    const runner = gitRunner({ "gh auth token": { stdout: "ghs_test_token" } });
    const github = await GitHubAdapter.create("/tmp/repo", runner, {});
    expect(runner.calls).toContain("gh auth token");
    expect(github).toBeInstanceOf(GitHubAdapter);
  });

  it("fails when gh is not authenticated", async () => {
    const runner = gitRunner({
      "gh auth token": { exitCode: 1, stderr: "Please run gh auth login." },
    });
    await expect(GitHubAdapter.create("/tmp/repo", runner, {})).rejects.toThrow(
      /gh is not authenticated/,
    );
  });

  it("wraps API failures in GitHubError", async () => {
    const { octokit } = makeOctokit();
    octokit.rest.issues.get.mockRejectedValue(new Error("boom"));
    const { github } = await makeAdapter(octokit);
    await expect(github.getIssue(42)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("GitHubAdapter label methods", () => {
  async function makeAdapterLabel(
    octokit: OctokitLike,
    overrides: Record<string, CannedResult> = {},
  ): Promise<{ github: GitHubAdapter; runner: FakeRunner }> {
    const runner = gitRunner(overrides);
    const github = await GitHubAdapter.create("/tmp/repo", runner, {
      octokit,
    });
    return { github, runner };
  }

  it("lists labels on an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapterLabel(octokit);
    const labels = await github.listLabels(42);
    expect(labels).toEqual(["bug", "agent:ready"]);
    expect(octokit.rest.issues.listLabelsOnIssue).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
    });
  });

  it("adds a label to an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapterLabel(octokit);
    await github.addLabel(42, "agent:in-progress");
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      labels: ["agent:in-progress"],
    });
  });

  it("removes a label from an issue", async () => {
    const { octokit } = makeOctokit();
    const { github } = await makeAdapterLabel(octokit);
    await github.removeLabel(42, "agent:ready");
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      name: "agent:ready",
    });
  });

  it("treats a 404 on remove as success (label already absent)", async () => {
    const { octokit } = makeOctokit();
    (octokit.rest.issues.removeLabel as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const { github } = await makeAdapterLabel(octokit);
    await expect(github.removeLabel(42, "agent:ready")).resolves.toBeUndefined();
  });

  it("wraps a non-404 remove failure in GitHubError", async () => {
    const { octokit } = makeOctokit();
    (octokit.rest.issues.removeLabel as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );
    const { github } = await makeAdapterLabel(octokit);
    await expect(github.removeLabel(42, "agent:ready")).rejects.toBeInstanceOf(GitHubError);
  });
});
