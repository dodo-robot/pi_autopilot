import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import type { CliDeps } from "../../../src/cli.js";
import type {
  ImplementerResult,
  ReviewerResult,
  Role,
  VerifierResult,
} from "../../../src/domain/contracts.js";
import type {
  CreatePullRequestInput,
  GitHubIssue,
  GitHubPort,
  IssueCommentRef,
  PullRequestRef,
} from "../../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import type { RunPiRunner } from "../../../src/workflow/run-service.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - "true"
  verify:
    - "test -f .verify-ok"
`;

const REPO_NAME = "operator-cmd-fixture";

const ISSUE: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: `https://github.com/acme/${REPO_NAME}/issues/42`,
};

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

  async closeIssue(number: number): Promise<void> {
    const issue = this.issues?.get(number) ?? this.issue;
    if (issue !== undefined) {
      this.issues?.set(number, { ...issue, state: "closed" });
      this.issue = { ...this.issue, state: "closed" };
    }
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

type AnyRoleResult = PiExecution["result"];

/** Scripted, per-role Pi fake; records every request for override assertions. */
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
    const markerPath = path.join(request.worktree, ".verify-ok");
    if (request.role === "implementer" && result.outcome === "COMPLETED") {
      writeFileSync(
        path.join(request.worktree, `feature-${String(this.requests.length)}.txt`),
        "feature\n",
        "utf8",
      );
      writeFileSync(markerPath, "ok\n", "utf8");
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

function taskSnapshotRefiner(): AnyRoleResult {
  return {
    outcome: "READY",
    taskDraft: {
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
    },
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  };
}

function implementerCompleted(
  overrides: Partial<Extract<ImplementerResult, { outcome: "COMPLETED" }>> = {},
): ImplementerResult {
  return {
    outcome: "COMPLETED",
    summary: "Implemented the change.",
    changedPaths: ["feature.txt"],
    commandsAttempted: ["true"],
    unresolvedProblems: [],
    evidenceLocations: [],
    ...overrides,
  };
}

function implementerBlocked(reason = "cannot proceed"): ImplementerResult {
  return { outcome: "BLOCKED", reason, unresolvedProblems: [reason] };
}

function reviewerApproved(): ReviewerResult {
  return {
    outcome: "APPROVED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
    findings: [],
  };
}

function verifierVerified(): VerifierResult {
  return {
    outcome: "VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
  };
}

let tempDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
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
}

/** Create a bare remote plus a primary clone with one commit, pushed to origin. */
async function createFixtureRepo(): Promise<{ root: string; remote: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), "ap-opcmd-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-opcmd-repo-"));
  tempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", remote]);

  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), MINIMAL_YAML, "utf8");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["push", "origin", "main"]);
  tempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", REPO_NAME));
  return { root, remote };
}

function makeHarness(root: string): {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  github: FakeGitHub;
  pi: ScriptedPiRunner;
  dataDir: string;
  run: (args: string[]) => Promise<unknown>;
} {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-opcmd-data-"));
  tempDirs.push(dataDir);
  const github = new FakeGitHub({ ...ISSUE });
  const pi = new ScriptedPiRunner();

  const repositoryContext: RepositoryContext = {
    root,
    repository: { owner: "acme", repo: REPO_NAME },
    originUrl: `git@github.com:acme/${REPO_NAME}.git`,
    currentBranch: "main",
    isClean: true,
  };

  const deps: CliDeps = {
    cwd: root,
    processRunner: new ProcessRunner(),
    dataDir,
    createRepositoryContext: async () => repositoryContext,
    createGitHub: async () => github,
    createPi: () => pi,
    idFactory: () => "run-opcmd-test-1",
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, github, pi, dataDir, run };
}

/** Run an issue through `run` to BLOCKED (implementer reports BLOCKED) and return the run id. */
async function seedBlockedRun(
  harness: ReturnType<typeof makeHarness>,
): Promise<string> {
  harness.pi.script("refiner", [taskSnapshotRefiner()]);
  harness.pi.script("implementer", [implementerBlocked("missing credentials")]);

  await harness.run(["run", "42"]);
  const output = harness.stdoutLines.join("\n");
  const match = /Run: (\S+)/.exec(output);
  if (match === null) throw new Error(`could not find run id in output: ${output}`);
  return match[1]!;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot status", () => {
  it("reports the current stage and the next valid action for a BLOCKED run", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);

    await harness.run(["status", runId]);

    expect(harness.exitCodes.at(-1)).toBe(0);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Stage: BLOCKED");
    expect(output).toContain("resume");
    expect(output).toContain("abandon");
  });

  it("reports a terminal run has no next action", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    harness.pi.script("refiner", [taskSnapshotRefiner()]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);
    await harness.run(["run", "42"]);
    const runId = /Run: (\S+)/.exec(harness.stdoutLines.join("\n"))![1]!;
    harness.stdoutLines.length = 0;

    await harness.run(["status", runId]);

    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Stage: PR_OPEN");
    expect(output).toContain("no further action");
  });

  it("supports --json output", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);
    harness.stdoutLines.length = 0;

    await harness.run(["status", runId, "--json"]);

    const parsed = JSON.parse(harness.stdoutLines.join("\n")) as {
      stage: string;
      runId: string;
    };
    expect(parsed.stage).toBe("BLOCKED");
    expect(parsed.runId).toBe(runId);
  });

  it("exits with a nonzero code for an unknown run id", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);

    await harness.run(["status", "no-such-run"]);

    expect(harness.exitCodes).toEqual([1]);
  });
});

describe("autopilot inspect", () => {
  it("reports snapshot, transition history, and model usage, redacting secrets", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);
    harness.stdoutLines.length = 0;

    await harness.run(["inspect", runId, "--json"]);

    const parsed = JSON.parse(harness.stdoutLines.join("\n")) as {
      runId: string;
      stage: string;
      snapshot: { objective: string } | null;
      transitions: { from: string; to: string }[];
      attempts: { role: string; model: string }[];
    };
    expect(parsed.runId).toBe(runId);
    expect(parsed.stage).toBe("BLOCKED");
    expect(parsed.snapshot?.objective).toBe("Implement token refresh validation");
    expect(parsed.transitions.map((t) => t.to)).toContain("BLOCKED");
    expect(parsed.attempts.length).toBeGreaterThan(0);
    expect(parsed.attempts[0]!.role).toBe("implementer");
  });

  it("redacts a secret-shaped value embedded in captured artifact content", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);

    // Simulate a captured verification artifact that happens to contain a
    // leaked GitHub token in its output, exactly as real command stdout
    // capture could.
    const { ArtifactStore } = await import("../../../src/persistence/artifact-store.js");
    const { appPaths } = await import("../../../src/platform/paths.js");
    const artifacts = new ArtifactStore(appPaths(harness.dataDir));
    await artifacts.writeJson(runId, "verification-1.json", {
      passed: false,
      treeHash: "deadbeef",
      policyHash: "policy",
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
          error: "auth failed with token ghp_abcdefghijklmnopqrstuvwxyz0123",
        },
      ],
      startedAt: "2026-08-18T00:00:00Z",
      finishedAt: "2026-08-18T00:00:01Z",
    });
    harness.stdoutLines.length = 0;

    await harness.run(["inspect", runId, "--json"]);

    const output = harness.stdoutLines.join("\n");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(output).toContain("[REDACTED]");
  });

  it("exits with a nonzero code for an unknown run id", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);

    await harness.run(["inspect", "no-such-run"]);

    expect(harness.exitCodes).toEqual([1]);
  });
});

describe("autopilot resume", () => {
  it("requires a BLOCKED run and launches a fresh attempt in the preserved workspace", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);

    harness.pi.script("implementer", [implementerCompleted({ summary: "Resumed." })]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;

    await harness.run(["resume", runId]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Stage: PR_OPEN");
    // Exactly two implementer sessions total ran across start()+resume():
    // the original BLOCKED attempt and the fresh resumed one.
    const implementerRequests = harness.pi.requests.filter((r) => r.role === "implementer");
    expect(implementerRequests).toHaveLength(2);
  });

  it("rejects resuming a run that is not BLOCKED", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    harness.pi.script("refiner", [taskSnapshotRefiner()]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);
    await harness.run(["run", "42"]);
    const runId = /Run: (\S+)/.exec(harness.stdoutLines.join("\n"))![1]!;
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;

    await harness.run(["resume", runId]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("not BLOCKED");
  });

  it("applies a model override on resume", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);

    harness.pi.script("implementer", [implementerCompleted({ summary: "Resumed." })]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);

    await harness.run(["resume", runId, "--model", "openai/gpt-5.2", "--thinking", "high"]);

    const implementerRequests = harness.pi.requests.filter((r) => r.role === "implementer");
    expect(implementerRequests[1]!.model).toEqual({
      model: "openai/gpt-5.2",
      thinking: "high",
      source: "cli",
    });
  });
});

describe("autopilot abandon", () => {
  it("marks the run CANCELLED without deleting the worktree or branch", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;

    await harness.run(["abandon", runId]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Stage: CANCELLED");

    const worktreePath = path.join(
      path.dirname(root),
      ".pi-autopilot-worktrees",
      REPO_NAME,
      runId,
    );
    const { existsSync } = await import("node:fs");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("rejects abandoning an already-terminal run", async () => {
    const { root } = await createFixtureRepo();
    const harness = makeHarness(root);
    const runId = await seedBlockedRun(harness);
    await harness.run(["abandon", runId]);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;

    await harness.run(["abandon", runId]);

    expect(harness.exitCodes).toEqual([1]);
  });
});
