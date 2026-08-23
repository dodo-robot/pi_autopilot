import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CreatePullRequestInput,
  GitHubIssue,
  GitHubPort,
  IssueCommentRef,
  PullRequestRef,
} from "../../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { RunStore } from "../../../src/persistence/run-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { WorkspaceManager } from "../../../src/workspace/workspace-manager.js";
import type { Workspace, WorkspacePolicy } from "../../../src/workspace/workspace-manager.js";
import { RecoveryService } from "../../../src/workflow/recovery-service.js";
import { RunService } from "../../../src/workflow/run-service.js";
import type { RunPiRunner } from "../../../src/workflow/run-service.js";
import { sha256 } from "../../../src/readiness/readiness-service.js";
import type {
  ImplementerResult,
  ReviewerResult,
  Role,
  TaskSnapshot,
} from "../../../src/domain/contracts.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";

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

const REPO_NAME = "recovery-fixture";

/** Create a bare remote plus a primary clone with one commit, pushed to origin. */
async function createFixtureRepo(): Promise<{ root: string; remote: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), "ap-recovery-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-recovery-repo-"));
  tempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", remote]);
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, ".pi", "autopilot.yaml"),
    `version: 1\ncommands:\n  setup:\n    - "true"\n  verify:\n    - "true"\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["push", "origin", "main"]);
  tempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", REPO_NAME));
  return { root, remote };
}

function repositoryContext(root: string): RepositoryContext {
  return {
    root,
    repository: { owner: "acme", repo: REPO_NAME },
    originUrl: `git@github.com:acme/${REPO_NAME}.git`,
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

const ISSUE: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/recovery-fixture/issues/42",
};

/** Deterministic in-memory fake for the GitHub port; records mutation calls. */
class FakeGitHub implements GitHubPort {
  issue: GitHubIssue;
  pulls = new Map<string, PullRequestRef>();
  comments: IssueCommentRef[] = [];
  createPullRequestCalls: CreatePullRequestInput[] = [];
  nextPrNumber = 100;
  nextCommentId = 1;

  constructor(issue: GitHubIssue) {
    this.issue = issue;
  }

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
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

  async updateIssueBody(): Promise<GitHubIssue> {
    throw new Error("must not be called");
  }

  async createIssueComment(_number: number, body: string): Promise<void> {
    this.comments.push({ id: this.nextCommentId++, body });
  }

  async findPullRequestByHead(head: string): Promise<PullRequestRef | null> {
    return this.pulls.get(head) ?? null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    this.createPullRequestCalls.push(input);
    const number = this.nextPrNumber++;
    const pr: PullRequestRef = {
      number,
      url: `https://github.com/acme/${REPO_NAME}/pull/${number}`,
      head: input.head,
      state: "open",
    };
    this.pulls.set(input.head, pr);
    return pr;
  }

  async findIssueCommentByMarker(
    _issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null> {
    return this.comments.find((c) => c.body.includes(marker)) ?? null;
  }
}

function taskSnapshot(): TaskSnapshot {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: REPO_NAME },
    issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
    objective: "Implement token refresh validation",
    context: "The auth module owns session refresh.",
    expectedBehavior: ["Expired refresh tokens are rejected"],
    acceptanceCriteria: [
      { id: "ac1", text: "A refresh with an expired token returns 401" },
    ],
    constraints: [],
    nonGoals: [],
    validation: ["true"],
    dependencies: [],
    canonicalReferences: [],
    sourceBodyHash: "stale-hash",
  };
}

interface Harness {
  root: string;
  dataDir: string;
  runStore: RunStore;
  artifacts: ArtifactStore;
  workspaceManager: WorkspaceManager;
  github: FakeGitHub;
  processRunner: ProcessRunner;
  repository: RepositoryContext;
  service: RecoveryService;
  /** Seed a run at the given stage with a real workspace and a persisted task snapshot. */
  seedRun: (id: string, stage: "IMPLEMENTATION" | "VERIFICATION" | "PUBLICATION" | "PUBLICATION_PR_CREATED") => Promise<Workspace>;
}

async function makeHarness(): Promise<Harness> {
  const { root } = await createFixtureRepo();
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-recovery-data-"));
  tempDirs.push(dataDir);
  const paths = appPaths(dataDir);
  const artifacts = new ArtifactStore(paths);
  const runStore = new RunStore(paths.dbPath);
  const github = new FakeGitHub({ ...ISSUE });
  const processRunner = new ProcessRunner();
  const repository = repositoryContext(root);
  const workspaceManager = new WorkspaceManager({
    processRunner,
    repository,
    policy: defaultPolicy(),
  });

  const service = new RecoveryService({
    runStore,
    artifacts,
    paths,
    workspaceManager,
    github,
    processRunner,
    repository,
    baseBranch: "main",
  });

  const seedRun = async (
    id: string,
    stage: "IMPLEMENTATION" | "VERIFICATION" | "PUBLICATION" | "PUBLICATION_PR_CREATED",
  ): Promise<Workspace> => {
    const run = runStore.createRun({
      id,
      repository: { owner: "acme", repo: REPO_NAME },
      issueNumber: 42,
    });
    const snapshot = taskSnapshot();
    const ref = await artifacts.writeJson(id, "task-snapshot.json", snapshot);
    runStore.setTaskSnapshotRef(id, ref.relative);

    const workspace = await workspaceManager.create({
      runId: id,
      issueNumber: 42,
      title: snapshot.objective,
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");

    runStore.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
    runStore.transition(run.id, "READINESS_CHECK", "WORKSPACE_CREATION", null);
    runStore.transition(run.id, "WORKSPACE_CREATION", "IMPLEMENTATION", null);
    if (stage === "IMPLEMENTATION") return workspace;

    runStore.transition(run.id, "IMPLEMENTATION", "VERIFICATION", null);
    if (stage === "VERIFICATION") return workspace;

    runStore.transition(run.id, "VERIFICATION", "INDEPENDENT_REVIEW", null);
    runStore.transition(run.id, "INDEPENDENT_REVIEW", "PUBLICATION", null);
    if (stage === "PUBLICATION") return workspace;

    // PUBLICATION_PR_CREATED: simulate an interruption AFTER the PR was
    // created and recorded, but before the run reached PR_OPEN (e.g. the
    // process died between recordPublication and the final transition).
    const treeHash = await workspaceManager.treeHash(workspace);
    const commitSha = await workspaceManager.commit(workspace, {
      issueNumber: 42,
      message: snapshot.objective,
      expectedTreeHash: treeHash,
    });
    runStore.recordPublication(id, { branch: workspace.branch, commitSha });
    await processRunner.run({
      command: "git",
      args: ["push", "--set-upstream", "origin", workspace.branch],
      cwd: workspace.path,
      timeoutMs: 30_000,
      env: safeProcessEnv(),
    });
    const pr = await github.createPullRequest({
      title: snapshot.objective,
      body: "body",
      head: workspace.branch,
      base: "main",
      draft: false,
    });
    runStore.recordPublication(id, {
      branch: workspace.branch,
      prNumber: pr.number,
      prUrl: pr.url,
    });
    // Reset the call log so a test asserting "createPullRequest was not
    // called AGAIN during reconciliation" is unambiguous.
    github.createPullRequestCalls = [];
    return workspace;
  };

  return {
    root,
    dataDir,
    runStore,
    artifacts,
    workspaceManager,
    github,
    processRunner,
    repository,
    service,
    seedRun,
  };
}

type AnyRoleResult = PiExecution["result"];

/** Scripted, per-role Pi fake; records every request for assertions. */
class ScriptedPiRunner implements RunPiRunner {
  readonly requests: PiRunRequest[] = [];
  private readonly queues = new Map<Role, AnyRoleResult[]>();

  script(role: Role, entries: AnyRoleResult[]): void {
    this.queues.set(role, [...entries]);
  }

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    const queue = this.queues.get(request.role);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`no scripted response left for role ${request.role}`);
    }
    const result = queue.shift()!;
    if (request.role === "implementer" && result.outcome === "COMPLETED") {
      writeFileSync(
        path.join(request.worktree, `resume-change-${String(this.requests.length)}.txt`),
        "change\n",
        "utf8",
      );
    }
    return {
      result,
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
      resultPath: path.join(request.diagnosticsDir, "result.json"),
    };
  }
}

function reviewerApproved(): ReviewerResult {
  return {
    outcome: "APPROVED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
    findings: [],
  };
}

function implementerCompleted(summary: string): ImplementerResult {
  return {
    outcome: "COMPLETED",
    summary,
    changedPaths: ["feature.txt"],
    commandsAttempted: ["true"],
    unresolvedProblems: [],
    evidenceLocations: [],
  };
}

/**
 * Seed a run that reached BLOCKED after one recorded implementer attempt
 * (e.g. a failed setup or an implementer BLOCKED outcome), so a resume
 * test can prove attempt counters continue from 1, not reset to 0.
 */
async function seedBlockedRun(harness: Harness): Promise<{ id: string; workspace: Workspace }> {
  const id = "run-blocked-for-resume";
  const run = harness.runStore.createRun({
    id,
    repository: { owner: "acme", repo: REPO_NAME },
    issueNumber: 42,
  });
  // Use a snapshot whose sourceBodyHash/updatedAt match the harness's fixed
  // ISSUE, so a real resumed publish (unlike reconcile, which never
  // publishes) does not trip the "source issue changed materially" guard.
  const snapshot: TaskSnapshot = {
    ...taskSnapshot(),
    issue: { number: 42, nodeId: "I_42", updatedAt: ISSUE.updatedAt },
    sourceBodyHash: sha256(ISSUE.body),
  };
  const ref = await harness.artifacts.writeJson(id, "task-snapshot.json", snapshot);
  harness.runStore.setTaskSnapshotRef(id, ref.relative);

  const workspace = await harness.workspaceManager.create({
    runId: id,
    issueNumber: 42,
    title: snapshot.objective,
    baseBranch: "main",
  });

  harness.runStore.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
  harness.runStore.transition(run.id, "READINESS_CHECK", "WORKSPACE_CREATION", null);
  harness.runStore.transition(run.id, "WORKSPACE_CREATION", "IMPLEMENTATION", null);
  harness.runStore.recordAttempt({
    runId: id,
    role: "implementer",
    attemptNumber: 1,
    model: "anthropic/claude-sonnet-4",
    thinking: "medium",
  });
  const blockedRef = await harness.artifacts.writeJson(id, "implementer-result-1.json", {
    outcome: "BLOCKED",
    reason: "missing credentials",
    unresolvedProblems: ["missing credentials"],
  });
  harness.runStore.transition(run.id, "IMPLEMENTATION", "BLOCKED", blockedRef.relative);

  return { id, workspace };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("RecoveryService.reconcile", () => {
  it("recommends reusing the existing PR when interrupted after PR creation, without creating a new one", async () => {
    const harness = await makeHarness();
    await harness.seedRun("run-pr-created", "PUBLICATION_PR_CREATED");

    const recovery = await harness.service.reconcile("run-pr-created");

    expect(recovery.actions).toContainEqual({ type: "REUSE_EXISTING_PR", number: 100 });
    expect(harness.github.createPullRequestCalls).toEqual([]);
    harness.runStore.close();
  });

  it("recommends retrying the push when a commit exists locally but the branch never reached the remote", async () => {
    const harness = await makeHarness();
    const workspace = await harness.seedRun("run-push-interrupted", "PUBLICATION");
    const treeHash = await harness.workspaceManager.treeHash(workspace);
    const commitSha = await harness.workspaceManager.commit(workspace, {
      issueNumber: 42,
      message: "Implement token refresh validation",
      expectedTreeHash: treeHash,
    });
    // Matches the real Publisher: the commit SHA is durably recorded
    // immediately after committing, before the push is attempted. This
    // simulates an interruption between commit and push.
    harness.runStore.recordPublication("run-push-interrupted", {
      branch: workspace.branch,
      commitSha,
    });

    const recovery = await harness.service.reconcile("run-push-interrupted");

    expect(recovery.actions).toContainEqual({ type: "RETRY_PUSH", branch: workspace.branch });
    expect(harness.github.createPullRequestCalls).toEqual([]);
    harness.runStore.close();
  });

  it("preserves the workspace and recommends REUSE_VERIFICATION when the current tree still matches recorded verification evidence", async () => {
    const harness = await harnessWithVerificationEvidence();

    const recovery = await harness.service.reconcile(harness.runId);

    expect(recovery.actions).toContainEqual({
      type: "REUSE_VERIFICATION",
      treeHash: harness.treeHash,
    });
    expect(recovery.actions).toContainEqual({ type: "PRESERVE_WORKSPACE" });
    harness.runStore.close();
  });

  it("never reuses verification evidence when the worktree has since drifted from the recorded tree hash", async () => {
    const harness = await harnessWithVerificationEvidence();
    // Drift the tree after verification evidence was recorded.
    writeFileSync(path.join(harness.workspace.path, "drift.txt"), "drift\n", "utf8");

    const recovery = await harness.service.reconcile(harness.runId);

    expect(recovery.actions).not.toContainEqual(
      expect.objectContaining({ type: "REUSE_VERIFICATION" }),
    );
    harness.runStore.close();
  });

  it("never automatically restarts an uncertain agent stage: interrupted mid-IMPLEMENTATION produces no auto-retry action", async () => {
    const harness = await makeHarness();
    await harness.seedRun("run-impl-interrupted", "IMPLEMENTATION");

    const recovery = await harness.service.reconcile("run-impl-interrupted");

    // The run must still report its actual persisted stage, and no action
    // may claim the stage succeeded or instruct an automatic restart.
    expect(recovery.stage).toBe("IMPLEMENTATION");
    expect(recovery.actions).not.toContainEqual(
      expect.objectContaining({ type: "RETRY_PUSH" }),
    );
    expect(recovery.actions).not.toContainEqual(
      expect.objectContaining({ type: "REUSE_EXISTING_PR" }),
    );
    expect(recovery.actions).not.toContainEqual(
      expect.objectContaining({ type: "REUSE_VERIFICATION" }),
    );
    expect(recovery.actions).toContainEqual({ type: "PRESERVE_WORKSPACE" });
    harness.runStore.close();
  });

  it("queries the remote branch via git ls-remote rather than assuming the local push status", async () => {
    const harness = await makeHarness();
    const workspace = await harness.seedRun("run-remote-check", "PUBLICATION");
    const treeHash = await harness.workspaceManager.treeHash(workspace);
    const commitSha = await harness.workspaceManager.commit(workspace, {
      issueNumber: 42,
      message: "Implement token refresh validation",
      expectedTreeHash: treeHash,
    });
    harness.runStore.recordPublication("run-remote-check", {
      branch: workspace.branch,
      commitSha,
    });
    await harness.processRunner.run({
      command: "git",
      args: ["push", "--set-upstream", "origin", workspace.branch],
      cwd: workspace.path,
      timeoutMs: 30_000,
      env: safeProcessEnv(),
    });

    const recovery = await harness.service.reconcile("run-remote-check");

    // The branch WAS pushed (confirmed via a real ls-remote query, not an
    // assumption), so the recommendation must not be to retry the push, even
    // though a durable local commit-SHA record exists (the condition that
    // would otherwise trigger RETRY_PUSH without the remote check).
    expect(recovery.actions).not.toContainEqual(
      expect.objectContaining({ type: "RETRY_PUSH" }),
    );
    harness.runStore.close();
  });

  it("reports a missing worktree explicitly rather than silently proceeding", async () => {
    const harness = await makeHarness();
    const workspace = await harness.seedRun("run-worktree-gone", "IMPLEMENTATION");
    rmSync(workspace.path, { recursive: true, force: true });

    const recovery = await harness.service.reconcile("run-worktree-gone");

    expect(recovery.actions).toContainEqual({ type: "WORKSPACE_MISSING" });
    harness.runStore.close();
  });
});

/** Harness for the two REUSE_VERIFICATION tests, sharing seeded verification evidence. */
async function harnessWithVerificationEvidence(): Promise<
  Harness & { runId: string; workspace: Workspace; treeHash: string }
> {
  const harness = await makeHarness();
  const runId = "run-verify-evidence";
  const workspace = await harness.seedRun(runId, "VERIFICATION");
  const treeHash = await harness.workspaceManager.treeHash(workspace);
  await harness.artifacts.writeJson(runId, "verification-1.json", {
    passed: true,
    treeHash,
    policyHash: "policy-hash",
    commands: [],
    startedAt: "2026-08-18T00:00:00Z",
    finishedAt: "2026-08-18T00:01:00Z",
  });
  return { ...harness, runId, workspace, treeHash };
}

describe("RecoveryService.abandon", () => {
  it("marks the run CANCELLED via compare-and-set without deleting the worktree or branch", async () => {
    const harness = await makeHarness();
    const workspace = await harness.seedRun("run-abandon", "IMPLEMENTATION");

    const result = await harness.service.abandon("run-abandon");

    expect(result.stage).toBe("CANCELLED");
    const status = await harness.workspaceManager.inspect(workspace);
    expect(status.exists).toBe(true);
    const branches = await git(harness.root, ["branch", "--list", workspace.branch]);
    expect(branches).not.toBe("");
    harness.runStore.close();
  });

  it("rejects abandoning a run already in a terminal stage", async () => {
    const harness = await makeHarness();
    await harness.seedRun("run-terminal", "IMPLEMENTATION");
    await harness.service.abandon("run-terminal");

    await expect(harness.service.abandon("run-terminal")).rejects.toThrow();
    harness.runStore.close();
  });
});

describe("RecoveryService.resume", () => {
  it("launches a fresh session in the preserved workspace, continuing attempt counters and preserving the snapshot", async () => {
    const harness = await makeHarness();
    const { id: runId, workspace } = await seedBlockedRun(harness);

    const pi = new ScriptedPiRunner();
    pi.script("implementer", [implementerCompleted("Resumed.")]);
    pi.script("reviewer", [reviewerApproved()]);

    const runService = new RunService({
      cwd: harness.root,
      dataDir: harness.dataDir,
      processRunner: harness.processRunner,
      createRepositoryContext: async () => harness.repository,
      createGitHub: async () => harness.github,
      createPi: () => pi,
    });
    const service = new RecoveryService({
      runStore: harness.runStore,
      artifacts: harness.artifacts,
      paths: appPaths(harness.dataDir),
      workspaceManager: harness.workspaceManager,
      github: harness.github,
      processRunner: harness.processRunner,
      repository: harness.repository,
      baseBranch: "main",
      runService,
    });

    const summary = await service.resume(runId);

    expect(summary.stage).toBe("PR_OPEN");

    // The fresh session launched in the SAME preserved workspace path
    // (never a new/relocated worktree).
    const implementerRequests = pi.requests.filter((r) => r.role === "implementer");
    expect(implementerRequests).toHaveLength(1);
    expect(implementerRequests[0]!.worktree).toBe(workspace.path);

    // Attempt counters continue rather than resetting: the pre-existing
    // attempt (attemptNumber 1, recorded before BLOCKED) plus exactly one
    // new implementer attempt and one new reviewer attempt.
    const attempts = harness.runStore.listAttempts(runId);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(attempts[0]!.role).toBe("implementer");
    expect(attempts[1]!.role).toBe("implementer");
    expect(attempts[2]!.role).toBe("reviewer");

    // The original frozen snapshot is preserved (never regenerated).
    const run = harness.runStore.getRun(runId);
    const snapshot = await harness.artifacts.readJson<TaskSnapshot>(
      runId,
      run!.taskSnapshotRef!,
    );
    expect(snapshot.objective).toBe("Implement token refresh validation");

    harness.runStore.close();
  });

  it("rejects resuming a run that is not BLOCKED", async () => {
    const harness = await makeHarness();
    await harness.seedRun("run-not-blocked", "IMPLEMENTATION");

    const pi = new ScriptedPiRunner();
    const runService = new RunService({
      cwd: harness.root,
      dataDir: harness.dataDir,
      processRunner: harness.processRunner,
      createRepositoryContext: async () => harness.repository,
      createGitHub: async () => harness.github,
      createPi: () => pi,
    });
    const service = new RecoveryService({
      runStore: harness.runStore,
      artifacts: harness.artifacts,
      paths: appPaths(harness.dataDir),
      workspaceManager: harness.workspaceManager,
      github: harness.github,
      processRunner: harness.processRunner,
      repository: harness.repository,
      baseBranch: "main",
      runService,
    });

    await expect(service.resume("run-not-blocked")).rejects.toThrow(/not BLOCKED/);
    expect(pi.requests).toHaveLength(0);
    harness.runStore.close();
  });

  it("rejects resuming when constructed without a runService dependency", async () => {
    const harness = await makeHarness();
    const { id: runId } = await seedBlockedRun(harness);

    // harness.service was constructed by makeHarness() without a
    // runService (only reconcile/abandon need one); resume must fail
    // fast with a clear error rather than throwing an unrelated TypeError.
    await expect(harness.service.resume(runId)).rejects.toThrow(/without a runService/);
    harness.runStore.close();
  });
});
