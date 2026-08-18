import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskSnapshot, ReviewerResult } from "../../../src/domain/contracts.js";
import type {
  CreatePullRequestInput,
  GitHubPort,
  IssueCommentRef,
  PullRequestRef,
} from "../../../src/github/github-adapter.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { RunStore } from "../../../src/persistence/run-store.js";
import type { VerificationEvidence } from "../../../src/verification/verification-runner.js";
import { WorkspaceManager } from "../../../src/workspace/workspace-manager.js";
import type { WorkspacePolicy } from "../../../src/workspace/workspace-manager.js";
import { Publisher } from "../../../src/publication/publisher.js";

let tempDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const runner = new ProcessRunner();
  const result = await runner.run({
    command: "git",
    args,
    cwd,
    timeoutMs: 30_000,
    env: safeProcessEnv(),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** Create a bare remote plus a primary clone with one commit, pushed to origin. */
async function createFixtureRepo(): Promise<{ root: string; remote: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), "ap-pub-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-pub-repo-"));
  tempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", remote]);
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["push", "origin", "main"]);
  tempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", "pub-widgets"));
  return { root, remote };
}

function repositoryContext(root: string): RepositoryContext {
  return {
    root,
    repository: { owner: "acme", repo: "pub-widgets" },
    originUrl: "git@github.com:acme/pub-widgets.git",
    currentBranch: "main",
    isClean: true,
  };
}

function defaultPolicy(overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy {
  return {
    baseBranch: "main",
    branchPrefix: "autopilot/",
    requireCleanCheckout: true,
    retainBlockedWorktree: true,
    ...overrides,
  };
}

function makeWorkspaceManager(root: string): WorkspaceManager {
  return new WorkspaceManager({
    processRunner: new ProcessRunner(),
    repository: repositoryContext(root),
    policy: defaultPolicy(),
  });
}

function makeStore(): RunStore {
  const dir = mkdtempSync(path.join(tmpdir(), "ap-pub-store-"));
  tempDirs.push(dir);
  return new RunStore(path.join(dir, "autopilot.db"));
}

function taskSnapshot(): TaskSnapshot {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "pub-widgets" },
    issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
    objective: "Implement token refresh validation",
    context: "The auth module owns session refresh.",
    expectedBehavior: ["Expired refresh tokens are rejected"],
    acceptanceCriteria: [
      { id: "ac1", text: "A refresh with an expired token returns 401" },
    ],
    constraints: [],
    nonGoals: [],
    validation: ["npm test"],
    dependencies: [],
    canonicalReferences: [],
    sourceBodyHash: "abc123",
  };
}

function approvedReview(): ReviewerResult {
  return {
    outcome: "APPROVED",
    criteriaResults: [
      { criterionId: "ac1", passed: true, notes: "Verified by test." },
    ],
    findings: [],
  };
}

function changesRequestedReview(): ReviewerResult {
  return {
    outcome: "CHANGES_REQUESTED",
    criteriaResults: [
      { criterionId: "ac1", passed: false, notes: "Not verified." },
    ],
    findings: [
      {
        severity: "critical",
        criterionId: "ac1",
        path: "src/auth.ts",
        line: 10,
        evidence: "missing check",
        requestedChange: "add expiry check",
      },
    ],
  };
}

function passingVerification(treeHash: string): VerificationEvidence {
  return {
    passed: true,
    treeHash,
    policyHash: "policy-hash",
    commands: [
      {
        command: "npm test",
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        startedAt: "2026-08-18T00:00:00Z",
        finishedAt: "2026-08-18T00:00:01Z",
        stdoutArtifact: null,
        stderrArtifact: null,
      },
    ],
    startedAt: "2026-08-18T00:00:00Z",
    finishedAt: "2026-08-18T00:00:01Z",
  };
}

function failingVerification(treeHash: string): VerificationEvidence {
  return {
    ...passingVerification(treeHash),
    passed: false,
    commands: [
      {
        command: "npm test",
        exitCode: 1,
        timedOut: false,
        durationMs: 10,
        startedAt: "2026-08-18T00:00:00Z",
        finishedAt: "2026-08-18T00:00:01Z",
        stdoutArtifact: null,
        stderrArtifact: null,
      },
    ],
  };
}

/** Deterministic in-memory fake for the GitHub port, tracking mutation calls. */
class FakeGitHub implements GitHubPort {
  pulls = new Map<string, PullRequestRef>();
  comments: IssueCommentRef[] = [];
  nextPrNumber = 100;
  nextCommentId = 1;

  createIssueComment = vi.fn(async (_issueNumber: number, body: string) => {
    this.comments.push({ id: this.nextCommentId++, body });
  });
  createPullRequest = vi.fn(async (input: CreatePullRequestInput) => {
    const number = this.nextPrNumber++;
    const pr: PullRequestRef = {
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
      head: input.head,
      state: "open",
    };
    this.pulls.set(input.head, pr);
    return pr;
  });

  getIssue = vi.fn(async (): Promise<never> => {
    throw new Error("must not be called");
  });
  updateIssueBody = vi.fn(async (): Promise<never> => {
    throw new Error("issue body/closure calls are forbidden in M1");
  });

  async findPullRequestByHead(head: string): Promise<PullRequestRef | null> {
    return this.pulls.get(head) ?? null;
  }

  async findIssueCommentByMarker(
    _issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null> {
    return this.comments.find((c) => c.body.includes(marker)) ?? null;
  }
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("Publisher", () => {
  it("rejects publication when the staged tree no longer matches the verified tree hash", async () => {
    const { root } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-1",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");

    const store = makeStore();
    const github = new FakeGitHub();
    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    await expect(
      publisher.publish({
        runId: "pub-run-1",
        issueNumber: 42,
        workspace,
        taskSnapshot: taskSnapshot(),
        review: approvedReview(),
        verification: passingVerification("wrong-tree-hash"),
        implementationSummary: "Added expiry check.",
        config: { baseBranch: "main", draftPr: false },
      }),
    ).rejects.toThrow("tree changed after verification");

    store.close();
  });

  it("rejects publication when review is not APPROVED", async () => {
    const { root } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-2",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    const github = new FakeGitHub();
    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    await expect(
      publisher.publish({
        runId: "pub-run-2",
        issueNumber: 42,
        workspace,
        taskSnapshot: taskSnapshot(),
        review: changesRequestedReview(),
        verification: passingVerification(treeHash),
        implementationSummary: "Added expiry check.",
        config: { baseBranch: "main", draftPr: false },
      }),
    ).rejects.toThrow(/approved/i);

    store.close();
  });

  it("rejects publication when verification did not pass", async () => {
    const { root } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-3",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    const github = new FakeGitHub();
    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    await expect(
      publisher.publish({
        runId: "pub-run-3",
        issueNumber: 42,
        workspace,
        taskSnapshot: taskSnapshot(),
        review: approvedReview(),
        verification: failingVerification(treeHash),
        implementationSummary: "Added expiry check.",
        config: { baseBranch: "main", draftPr: false },
      }),
    ).rejects.toThrow(/verification/i);

    store.close();
  });

  it("commits via the WorkspaceManager, pushes the branch, opens a PR, and posts one issue comment", async () => {
    const { root, remote } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-4",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    store.createRun({
      id: "pub-run-4",
      repository: { owner: "acme", repo: "pub-widgets" },
      issueNumber: 42,
    });
    const github = new FakeGitHub();
    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    const result = await publisher.publish({
      runId: "pub-run-4",
      issueNumber: 42,
      workspace,
      taskSnapshot: taskSnapshot(),
      review: approvedReview(),
      verification: passingVerification(treeHash),
      implementationSummary: "Added expiry check.",
      config: { baseBranch: "main", draftPr: false },
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe(workspace.branch);
    expect(result.pullRequest.number).toBeGreaterThan(0);
    expect(result.pullRequest.head).toBe(workspace.branch);
    expect(result.comment.id).toBeGreaterThan(0);

    // Pushed to the real remote (never force-pushed).
    const remoteBranches = await git(remote, ["branch", "--list", workspace.branch]);
    expect(remoteBranches).toContain(workspace.branch);
    const remoteLog = await git(remote, ["log", "-1", "--pretty=%B", workspace.branch]);
    expect(remoteLog).toContain("Refs #42");

    // Exactly one PR and one issue comment.
    expect(github.createPullRequest).toHaveBeenCalledTimes(1);
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
    const [issueNumber, commentBody] = github.createIssueComment.mock.calls[0]!;
    expect(issueNumber).toBe(42);
    expect(commentBody).toContain("pub-run-4");
    expect(commentBody).toContain(result.pullRequest.url);
    expect(commentBody).toContain(result.comment.marker);

    // PR body carries objective, acceptance criteria, verification, review, and run id.
    const prInput = github.createPullRequest.mock.calls[0]![0] as CreatePullRequestInput;
    expect(prInput.title).toContain("Implement token refresh validation");
    expect(prInput.base).toBe("main");
    expect(prInput.draft).toBe(false);
    expect(prInput.body).toContain("Implement token refresh validation");
    expect(prInput.body).toContain("A refresh with an expired token returns 401");
    expect(prInput.body).toContain("npm test");
    expect(prInput.body).toContain("Added expiry check.");
    expect(prInput.body).toContain("APPROVED");
    expect(prInput.body).toContain("pub-run-4");

    // Publication record persisted with commit + PR + comment identity.
    const record = store.getPublication("pub-run-4");
    expect(record).toMatchObject({
      runId: "pub-run-4",
      commitSha: result.commitSha,
      branch: workspace.branch,
      prNumber: result.pullRequest.number,
      prUrl: result.pullRequest.url,
      commentId: result.comment.id,
    });
    expect(record?.commentMarker).toBe(result.comment.marker);

    // No issue-closure or merge-shaped calls: updateIssueBody was never called.
    expect(github.updateIssueBody).not.toHaveBeenCalled();

    store.close();
  });

  it("reconciles an existing open PR by head branch instead of creating a duplicate", async () => {
    const { root, remote } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-5",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    store.createRun({
      id: "pub-run-5",
      repository: { owner: "acme", repo: "pub-widgets" },
      issueNumber: 42,
    });
    const github = new FakeGitHub();
    const existingPr: PullRequestRef = {
      number: 55,
      url: "https://github.com/acme/widgets/pull/55",
      head: workspace.branch,
      state: "open",
    };
    github.pulls.set(workspace.branch, existingPr);

    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    const result = await publisher.publish({
      runId: "pub-run-5",
      issueNumber: 42,
      workspace,
      taskSnapshot: taskSnapshot(),
      review: approvedReview(),
      verification: passingVerification(treeHash),
      implementationSummary: "Added expiry check.",
      config: { baseBranch: "main", draftPr: false },
    });

    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(result.pullRequest).toEqual(existingPr);
    const record = store.getPublication("pub-run-5");
    expect(record?.prNumber).toBe(55);
    expect(record?.prUrl).toBe(existingPr.url);

    // Still pushed the branch even though the PR already existed.
    const remoteBranches = await git(remote, ["branch", "--list", workspace.branch]);
    expect(remoteBranches).toContain(workspace.branch);

    store.close();
  });

  it("does not post a duplicate issue comment on a resumed/retried publication", async () => {
    const { root } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-6",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    store.createRun({
      id: "pub-run-6",
      repository: { owner: "acme", repo: "pub-widgets" },
      issueNumber: 42,
    });
    const github = new FakeGitHub();
    // Seed a pre-existing PR and a pre-existing comment carrying this run's marker,
    // simulating an interrupted publication that already made both mutations.
    const existingPr: PullRequestRef = {
      number: 77,
      url: "https://github.com/acme/widgets/pull/77",
      head: workspace.branch,
      state: "open",
    };
    github.pulls.set(workspace.branch, existingPr);
    github.comments.push({
      id: 999,
      body: `Published PR ${existingPr.url}\n\n<!-- autopilot-run:pub-run-6 -->`,
    });

    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: new ProcessRunner(),
    });

    const result = await publisher.publish({
      runId: "pub-run-6",
      issueNumber: 42,
      workspace,
      taskSnapshot: taskSnapshot(),
      review: approvedReview(),
      verification: passingVerification(treeHash),
      implementationSummary: "Added expiry check.",
      config: { baseBranch: "main", draftPr: false },
    });

    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(result.comment.id).toBe(999);

    store.close();
  });

  it("never force-pushes and never calls issue-closure or merge-shaped operations", async () => {
    const { root } = await createFixtureRepo();
    const workspaceManager = makeWorkspaceManager(root);
    const workspace = await workspaceManager.create({
      runId: "pub-run-7",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const treeHash = await workspaceManager.treeHash(workspace);

    const store = makeStore();
    store.createRun({
      id: "pub-run-7",
      repository: { owner: "acme", repo: "pub-widgets" },
      issueNumber: 42,
    });
    const github = new FakeGitHub();

    const recordingRunner = new ProcessRunner();
    const seenArgs: string[][] = [];
    const originalRun = recordingRunner.run.bind(recordingRunner);
    recordingRunner.run = (async (request: Parameters<typeof originalRun>[0]) => {
      seenArgs.push([request.command, ...request.args]);
      return originalRun(request);
    }) as typeof recordingRunner.run;

    const publisher = new Publisher({
      github,
      workspaceManager,
      runStore: store,
      processRunner: recordingRunner,
    });

    await publisher.publish({
      runId: "pub-run-7",
      issueNumber: 42,
      workspace,
      taskSnapshot: taskSnapshot(),
      review: approvedReview(),
      verification: passingVerification(treeHash),
      implementationSummary: "Added expiry check.",
      config: { baseBranch: "main", draftPr: false },
    });

    const pushCalls = seenArgs.filter((args) => args[0] === "git" && args[1] === "push");
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toEqual(["git", "push", "--set-upstream", "origin", workspace.branch]);
    for (const call of pushCalls) {
      expect(call).not.toContain("--force");
      expect(call).not.toContain("-f");
    }
    expect(github.updateIssueBody).not.toHaveBeenCalled();

    store.close();
  });
});
