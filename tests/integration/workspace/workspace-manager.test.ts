import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import {
  WorkspaceError,
  WorkspaceManager,
} from "../../../src/workspace/workspace-manager.js";
import type { WorkspacePolicy } from "../../../src/workspace/workspace-manager.js";

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
  const remote = mkdtempSync(path.join(tmpdir(), "ap-ws-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-ws-repo-"));
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
  // Worktrees are created as siblings of `root`, under a repo-named
  // directory; register that path too so afterEach removes it.
  tempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", "widgets"));
  return { root, remote };
}

function repositoryContext(root: string): RepositoryContext {
  return {
    root,
    repository: { owner: "acme", repo: "widgets" },
    originUrl: "git@github.com:acme/widgets.git",
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

function makeManager(
  root: string,
  policyOverrides: Partial<WorkspacePolicy> = {},
): WorkspaceManager {
  return new WorkspaceManager({
    processRunner: new ProcessRunner(),
    repository: repositoryContext(root),
    policy: defaultPolicy(policyOverrides),
  });
}

afterEach(async () => {
  // Worktree metadata under the primary checkout's .git must be released
  // with `git worktree remove`/`prune` before the sibling directories are
  // deleted, otherwise stale administrative files remain in .git/worktrees.
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("WorkspaceManager", () => {
  it("creates a sibling worktree with a slugged branch name", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);

    const workspace = await manager.create({
      runId: "run-1",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });

    expect(workspace.branch).toBe("autopilot/42-token-refresh");
    expect(workspace.path).not.toBe(root);
    const expectedParent = path.join(
      path.dirname(root),
      ".pi-autopilot-worktrees",
      "widgets",
      "run-1",
    );
    expect(workspace.path).toBe(expectedParent);

    const branches = await git(root, ["worktree", "list", "--porcelain"]);
    expect(branches).toContain(workspace.path);
  });

  it("slugifies unusual titles into a bounded, hyphenated form", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);

    const workspace = await manager.create({
      runId: "run-2",
      issueNumber: 7,
      title: "  Fix!! the ***Login*** Flow (again) -- please  ",
      baseBranch: "main",
    });

    expect(workspace.branch.startsWith("autopilot/7-")).toBe(true);
    expect(workspace.branch).not.toMatch(/[^a-z0-9/-]/);
    expect(workspace.branch).not.toMatch(/--/);
    expect(workspace.branch.length).toBeLessThanOrEqual("autopilot/7-".length + 40);
  });

  it("refuses to create a workspace when the primary checkout is dirty", async () => {
    const { root } = await createFixtureRepo();
    writeFileSync(path.join(root, "README.md"), "dirty\n", "utf8");
    const manager = makeManager(root);

    await expect(
      manager.create({
        runId: "run-3",
        issueNumber: 1,
        title: "Dirty state",
        baseBranch: "main",
      }),
    ).rejects.toThrow(WorkspaceError);
    await expect(
      manager.create({
        runId: "run-3",
        issueNumber: 1,
        title: "Dirty state",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/dirty|clean/i);
  });

  it("allows a dirty checkout when cleanliness is not required", async () => {
    const { root } = await createFixtureRepo();
    writeFileSync(path.join(root, "README.md"), "dirty\n", "utf8");
    const manager = makeManager(root, { requireCleanCheckout: false });

    const workspace = await manager.create({
      runId: "run-3b",
      issueNumber: 2,
      title: "Allow dirty",
      baseBranch: "main",
    });
    expect(workspace.path).not.toBe(root);
  });

  it("rejects a base branch that does not match the protected base branch", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root, { baseBranch: "main" });

    await expect(
      manager.create({
        runId: "run-4",
        issueNumber: 3,
        title: "Wrong base",
        baseBranch: "develop",
      }),
    ).rejects.toThrow(WorkspaceError);
  });

  it("rejects creating a second workspace whose branch is already owned by another run", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);

    await manager.create({
      runId: "run-5",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });

    await expect(
      manager.create({
        runId: "run-6",
        issueNumber: 42,
        title: "Token refresh",
        baseBranch: "main",
      }),
    ).rejects.toThrow(WorkspaceError);
  });

  it("rejects creating a workspace at a path already registered to another run", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);

    const first = await manager.create({
      runId: "run-7",
      issueNumber: 10,
      title: "First",
      baseBranch: "main",
    });

    // Simulate a second attempt reusing the same run id (e.g. re-entrant call).
    await expect(
      manager.create({
        runId: "run-7",
        issueNumber: 11,
        title: "Second",
        baseBranch: "main",
      }),
    ).rejects.toThrow(WorkspaceError);
    expect(first.path).toContain("run-7");
  });

  it("inspects an existing workspace's path, branch, and cleanliness", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-8",
      issueNumber: 5,
      title: "Inspect me",
      baseBranch: "main",
    });

    const clean = await manager.inspect(workspace);
    expect(clean).toMatchObject({ exists: true, branch: workspace.branch, isClean: true });

    writeFileSync(path.join(workspace.path, "new-file.txt"), "hello\n", "utf8");
    const dirty = await manager.inspect(workspace);
    expect(dirty).toMatchObject({ exists: true, branch: workspace.branch, isClean: false });
  });

  it("reports a nonexistent workspace path as not existing", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const missing = {
      runId: "ghost",
      path: path.join(tmpdir(), "definitely-does-not-exist-ap-ws"),
      branch: "autopilot/ghost",
      baseBranch: "main",
    };

    const status = await manager.inspect(missing);
    expect(status.exists).toBe(false);
  });

  it("computes the staged tree hash without requiring a commit", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-9",
      issueNumber: 6,
      title: "Tree hash",
      baseBranch: "main",
    });

    const beforeHash = await manager.treeHash(workspace);
    expect(beforeHash).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(path.join(workspace.path, "new-file.txt"), "hello\n", "utf8");
    const afterHash = await manager.treeHash(workspace);
    expect(afterHash).toMatch(/^[0-9a-f]{40}$/);
    expect(afterHash).not.toBe(beforeHash);

    // Computing the hash must not itself create a commit.
    const log = await git(workspace.path, ["log", "--oneline"]);
    expect(log.split("\n")).toHaveLength(1);
  });

  it("commits staged changes only when they match the expected verified tree hash", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-10",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });

    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const verifiedTreeHash = await manager.treeHash(workspace);

    const commitSha = await manager.commit(workspace, {
      issueNumber: 42,
      message: "Add token refresh validation",
      expectedTreeHash: verifiedTreeHash,
    });

    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    const log = await git(workspace.path, ["log", "-1", "--pretty=%B"]);
    expect(log).toContain("Add token refresh validation");
    expect(log).toContain("Refs #42");

    const status = await git(workspace.path, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  it("refuses to commit when the staged tree no longer matches the verified tree hash", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-11",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });

    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const verifiedTreeHash = await manager.treeHash(workspace);

    // Tree drifts after verification.
    writeFileSync(path.join(workspace.path, "feature.txt"), "changed\n", "utf8");

    await expect(
      manager.commit(workspace, {
        issueNumber: 42,
        message: "Add token refresh validation",
        expectedTreeHash: verifiedTreeHash,
      }),
    ).rejects.toThrow(WorkspaceError);

    // Do not push under any circumstance.
    const remoteBranches = await git(root, ["ls-remote", "--heads", "origin"]);
    expect(remoteBranches).not.toContain(workspace.branch);
  });

  it("never pushes as part of commit", async () => {
    const { root, remote } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-12",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });
    writeFileSync(path.join(workspace.path, "feature.txt"), "feature\n", "utf8");
    const verifiedTreeHash = await manager.treeHash(workspace);

    await manager.commit(workspace, {
      issueNumber: 42,
      message: "Add token refresh validation",
      expectedTreeHash: verifiedTreeHash,
    });

    const remoteRefs = await git(remote, ["branch", "--list", workspace.branch]);
    expect(remoteRefs).toBe("");
  });

  it("removes a successful worktree and its branch", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-13",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });

    await manager.removeSuccessful(workspace);

    const status = await manager.inspect(workspace);
    expect(status.exists).toBe(false);

    const branchList = await git(root, ["branch", "--list", workspace.branch]);
    expect(branchList).toBe("");
  });

  it("preserves the worktree when the caller does not explicitly request cleanup (blocked/failed runs)", async () => {
    const { root } = await createFixtureRepo();
    const manager = makeManager(root);
    const workspace = await manager.create({
      runId: "run-14",
      issueNumber: 42,
      title: "Token refresh",
      baseBranch: "main",
    });

    // No cleanup call: simulates a blocked/failed run. The worktree must still be there.
    const status = await manager.inspect(workspace);
    expect(status.exists).toBe(true);

    const branchList = await git(root, ["branch", "--list", workspace.branch]);
    expect(branchList).not.toBe("");
  });
});
