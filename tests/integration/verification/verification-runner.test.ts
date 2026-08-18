import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import type { Workspace } from "../../../src/workspace/workspace-manager.js";
import { WorkspaceManager } from "../../../src/workspace/workspace-manager.js";
import { VerificationRunner } from "../../../src/verification/verification-runner.js";

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
async function createFixtureRepo(): Promise<{ root: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), "ap-verify-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-verify-repo-"));
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
  tempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", "verify-fixture"));
  return { root };
}

async function makeWorkspace(
  root: string,
  runId: string,
): Promise<{ workspace: Workspace; workspaceManager: WorkspaceManager }> {
  const workspaceManager = new WorkspaceManager({
    processRunner: new ProcessRunner(),
    repository: {
      root,
      repository: { owner: "acme", repo: "verify-fixture" },
      originUrl: "git@github.com:acme/verify-fixture.git",
      currentBranch: "main",
      isClean: true,
    },
    policy: {
      baseBranch: "main",
      branchPrefix: "autopilot/",
      requireCleanCheckout: true,
      retainBlockedWorktree: true,
    },
  });
  const workspace = await workspaceManager.create({
    runId,
    issueNumber: 42,
    title: "Verification",
    baseBranch: "main",
  });
  return { workspace, workspaceManager };
}

function makeStore(): { store: ArtifactStore; dataDir: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-verify-data-"));
  tempDirs.push(dataDir);
  return { store: new ArtifactStore(appPaths(dataDir)), dataDir };
}

afterEach(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("VerificationRunner", () => {
  it("runs verification commands in order and reports complete evidence, including a failure", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-1");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-1", {
      commands: ["node -e \"process.exit(0)\"", "node -e \"process.exit(1)\""],
      timeoutMs: 10_000,
    });

    expect(evidence.passed).toBe(false);
    expect(evidence.commands.map((item) => item.exitCode)).toEqual([0, 1]);
    expect(evidence.commands.map((item) => item.command)).toEqual([
      "node -e \"process.exit(0)\"",
      "node -e \"process.exit(1)\"",
    ]);
    expect(evidence.treeHash).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("passes only when every command exits zero and none time out", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-2");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-2", {
      commands: ["node -e \"process.exit(0)\"", "node -e \"process.exit(0)\""],
      timeoutMs: 10_000,
    });

    expect(evidence.passed).toBe(true);
    expect(evidence.commands.every((item) => item.exitCode === 0)).toBe(true);
    expect(evidence.commands.every((item) => !item.timedOut)).toBe(true);
  });

  it("continues verification after a failed command so evidence is complete", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-3");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-3", {
      commands: [
        "node -e \"process.exit(1)\"",
        "node -e \"process.exit(0)\"",
        "node -e \"process.exit(0)\"",
      ],
      timeoutMs: 10_000,
    });

    expect(evidence.commands).toHaveLength(3);
    expect(evidence.commands.map((item) => item.exitCode)).toEqual([1, 0, 0]);
    expect(evidence.passed).toBe(false);
  });

  it("marks a timed-out command as not passing and does not treat it as a zero exit", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-4");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-4", {
      commands: ["node -e \"setTimeout(() => {}, 60000)\""],
      timeoutMs: 300,
    });

    expect(evidence.passed).toBe(false);
    expect(evidence.commands[0]?.timedOut).toBe(true);
    expect(evidence.commands[0]?.exitCode).not.toBe(0);
  });

  it("persists bounded stdout and stderr per command as artifacts", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-5");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-5", {
      commands: ['node -e "console.log(\'hello-stdout\'); console.error(\'hello-stderr\')"'],
      timeoutMs: 10_000,
    });

    const first = evidence.commands[0];
    expect(first).toBeDefined();
    expect(first?.stdoutArtifact).toBeDefined();
    expect(first?.stderrArtifact).toBeDefined();

    const stdoutText = await store.readJson<string>(
      "verify-run-5",
      first!.stdoutArtifact!.relative,
    );
    const stderrText = await store.readJson<string>(
      "verify-run-5",
      first!.stderrArtifact!.relative,
    );
    expect(stdoutText).toContain("hello-stdout");
    expect(stderrText).toContain("hello-stderr");
  });

  it("uses an explicit clean environment (no ambient secrets leak through)", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-6");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    process.env.AP_TEST_SECRET_SHOULD_NOT_LEAK = "super-secret";
    try {
      const evidence = await runner.runVerification(workspace, "verify-run-6", {
        commands: [
          "node -e \"process.exit(process.env.AP_TEST_SECRET_SHOULD_NOT_LEAK ? 1 : 0)\"",
        ],
        timeoutMs: 10_000,
      });
      expect(evidence.commands[0]?.exitCode).toBe(0);
      expect(evidence.passed).toBe(true);
    } finally {
      delete process.env.AP_TEST_SECRET_SHOULD_NOT_LEAK;
    }
  });

  it("captures the tree hash after the final command, matching WorkspaceManager.treeHash", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-7");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-7", {
      commands: ["node -e \"process.exit(0)\""],
      timeoutMs: 10_000,
    });

    const expectedHash = await workspaceManager.treeHash(workspace);
    expect(evidence.treeHash).toBe(expectedHash);
  });

  it("includes a policy hash binding evidence to the configured commands", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-8");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidenceA = await runner.runVerification(workspace, "verify-run-8", {
      commands: ["node -e \"process.exit(0)\""],
      timeoutMs: 10_000,
    });
    const evidenceB = await runner.runVerification(workspace, "verify-run-8", {
      commands: ["node -e \"process.exit(0)\"", "node -e \"process.exit(0)\""],
      timeoutMs: 10_000,
    });

    expect(evidenceA.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceA.policyHash).not.toBe(evidenceB.policyHash);
  });

  it("records timestamps and durations for the run and each command", async () => {
    const { root } = await createFixtureRepo();
    const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-9");
    const { store } = makeStore();
    const runner = new VerificationRunner({
      processRunner: new ProcessRunner(),
      artifacts: store,
      workspaceManager,
    });

    const evidence = await runner.runVerification(workspace, "verify-run-9", {
      commands: ["node -e \"process.exit(0)\""],
      timeoutMs: 10_000,
    });

    expect(evidence.startedAt).toEqual(expect.any(String));
    expect(evidence.finishedAt).toEqual(expect.any(String));
    expect(evidence.commands[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  describe("runSetup", () => {
    it("runs setup commands once in order and succeeds when all exit zero", async () => {
      const { root } = await createFixtureRepo();
      const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-10");
      const { store } = makeStore();
      const runner = new VerificationRunner({
        processRunner: new ProcessRunner(),
        artifacts: store,
        workspaceManager,
      });

      const result = await runner.runSetup(workspace, "verify-run-10", {
        commands: ["node -e \"process.exit(0)\"", "node -e \"process.exit(0)\""],
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.commands.map((item) => item.exitCode)).toEqual([0, 0]);
    });

    it("stops after the first setup failure and does not run subsequent setup commands", async () => {
      const { root } = await createFixtureRepo();
      const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-11");
      const { store } = makeStore();
      const runner = new VerificationRunner({
        processRunner: new ProcessRunner(),
        artifacts: store,
        workspaceManager,
      });

      const result = await runner.runSetup(workspace, "verify-run-11", {
        commands: [
          "node -e \"process.exit(1)\"",
          "node -e \"require('node:fs').writeFileSync('should-not-exist.txt', 'x')\"",
        ],
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.exitCode).toBe(1);

      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(workspace.path, "should-not-exist.txt"))).toBe(
        false,
      );
    });

    it("returns passed=true when there are no configured setup commands", async () => {
      const { root } = await createFixtureRepo();
      const { workspace, workspaceManager } = await makeWorkspace(root, "verify-run-12");
      const { store } = makeStore();
      const runner = new VerificationRunner({
        processRunner: new ProcessRunner(),
        artifacts: store,
        workspaceManager,
      });

      const result = await runner.runSetup(workspace, "verify-run-12", {
        commands: [],
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.commands).toEqual([]);
    });
  });
});
