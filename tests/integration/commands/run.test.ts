import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import type { RunCommandDeps } from "../../../src/commands/run.js";
import type {
  ImplementerResult,
  ReviewerResult,
  Role,
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

const ISSUE: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
};

class FakeGitHub implements GitHubPort {
  issue: GitHubIssue;
  pulls = new Map<string, PullRequestRef>();
  comments: IssueCommentRef[] = [];
  nextPrNumber = 100;
  nextCommentId = 1;

  constructor(issue: GitHubIssue) {
    this.issue = issue;
  }

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
  }

  async updateIssueBody(_number: number, body: string): Promise<GitHubIssue> {
    throw new Error(`must not be called (body=${body})`);
  }

  async createIssueComment(_number: number, body: string): Promise<void> {
    this.comments.push({ id: this.nextCommentId++, body });
  }

  async findPullRequestByHead(head: string): Promise<PullRequestRef | null> {
    return this.pulls.get(head) ?? null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const number = this.nextPrNumber++;
    const pr: PullRequestRef = {
      number,
      url: `https://github.com/acme/widgets/pull/${number}`,
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
  onRun?: (request: PiRunRequest) => void;

  script(role: Role, entries: AnyRoleResult[]): void {
    this.queues.set(role, [...entries]);
  }

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    this.onRun?.(request);
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
      sessionDir: request.sessionDir,
    };
  }
}

function taskSnapshotRefiner(repoName: string): AnyRoleResult {
  return {
    outcome: "READY",
    taskDraft: {
      schemaVersion: 1,
      repository: { owner: "acme", repo: repoName },
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

function refinerNeedsRefinement(repoName: string): AnyRoleResult {
  const ready = taskSnapshotRefiner(repoName);
  return {
    outcome: "NEEDS_REFINEMENT",
    taskDraft: { ...ready.taskDraft, acceptanceCriteria: [] },
    missingInformation: ["acceptance criteria"],
    dependencies: [],
    ambiguities: [],
    suggestions: ["add acceptance criteria"],
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

function reviewerApproved(): ReviewerResult {
  return {
    outcome: "APPROVED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
    findings: [],
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
async function createFixtureRepo(
  repoName: string,
): Promise<{ root: string; remote: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), "ap-run-cmd-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-run-cmd-repo-"));
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
  tempDirs.push(path.join(path.dirname(root), ".pi-autopilot-worktrees", repoName));
  return { root, remote };
}

function makeHarness(
  repoName: string,
  root: string,
): {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  github: FakeGitHub;
  pi: ScriptedPiRunner;
  run: (args: string[]) => Promise<unknown>;
} {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-run-cmd-data-"));
  tempDirs.push(dataDir);
  const github = new FakeGitHub({ ...ISSUE });
  const pi = new ScriptedPiRunner();

  const repositoryContext: RepositoryContext = {
    root,
    repository: { owner: "acme", repo: repoName },
    originUrl: `git@github.com:acme/${repoName}.git`,
    currentBranch: "main",
    isClean: true,
  };

  const deps: RunCommandDeps = {
    cwd: root,
    processRunner: new ProcessRunner(),
    dataDir,
    createRepositoryContext: async () => repositoryContext,
    createGitHub: async () => github,
    createPi: () => pi,
    idFactory: () => "run-cmd-test-1",
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, github, pi, run };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot run", () => {
  it("rejects an invalid issue reference with exit code 1", async () => {
    const { root } = await createFixtureRepo("run-cmd-invalid-ref");
    const harness = makeHarness("run-cmd-invalid-ref", root);

    await harness.run(["run", "not-a-valid-ref"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("invalid issue reference");
  });

  it("rejects a qualified issue reference that does not match the origin", async () => {
    const { root } = await createFixtureRepo("run-cmd-mismatched-ref");
    const harness = makeHarness("run-cmd-mismatched-ref", root);

    await harness.run(["run", "other/repo#42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("origin");
  });

  it("rejects an invalid thinking level with exit code 1", async () => {
    const { root } = await createFixtureRepo("run-cmd-invalid-thinking");
    const harness = makeHarness("run-cmd-invalid-thinking", root);

    await harness.run(["run", "42", "--thinking", "turbo"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("thinking");
  });

  it("rejects an invalid per-role thinking level with exit code 1", async () => {
    const { root } = await createFixtureRepo("run-cmd-invalid-role-thinking");
    const harness = makeHarness("run-cmd-invalid-role-thinking", root);

    await harness.run(["run", "42", "--implementer-thinking", "turbo"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("thinking");
  });

  it("applies a per-role model override on top of the global override", async () => {
    const { root } = await createFixtureRepo("run-cmd-overrides");
    const harness = makeHarness("run-cmd-overrides", root);
    harness.pi.script("refiner", [taskSnapshotRefiner("run-cmd-overrides")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);

    await harness.run([
      "run",
      "42",
      "--model",
      "openai/gpt-5.2",
      "--thinking",
      "high",
      "--implementer-model",
      "anthropic/claude-opus-4",
      "--implementer-thinking",
      "max",
    ]);

    expect(harness.exitCodes).toEqual([0]);
    const implementerRequests = harness.pi.requests.filter(
      (r) => r.role === "implementer",
    );
    const reviewerRequests = harness.pi.requests.filter((r) => r.role === "reviewer");
    // The per-role override wins for the implementer...
    expect(implementerRequests[0]!.model).toEqual({
      model: "anthropic/claude-opus-4",
      thinking: "max",
      source: "cli",
    });
    // ...while the global override still applies to a role with no
    // dedicated override (reviewer).
    expect(reviewerRequests[0]!.model).toEqual({
      model: "openai/gpt-5.2",
      thinking: "high",
      source: "cli",
    });
  });

  it("prints implementer session visibility during the implementation stage", async () => {
    const { root } = await createFixtureRepo("run-cmd-progress");
    const harness = makeHarness("run-cmd-progress", root);
    harness.pi.script("refiner", [taskSnapshotRefiner("run-cmd-progress")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.onRun = (request) => {
      if (request.role !== "implementer") return;
      mkdirSync(request.sessionDir, { recursive: true });
      writeFileSync(
        path.join(request.sessionDir, "progress.jsonl"),
        [
          JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I'll read the evaluator references first." }] } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "minerva/semantic/model.py" } }] } }),
        ].join("\n") + "\n",
        "utf8",
      );
    };

    await harness.run(["run", "42"]);

    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Implementer session:");
    expect(output).toContain("implementer-1/session");
    expect(output).toContain("[implementer] I'll read the evaluator references first.");
    expect(output).toContain("[implementer] tool: read minerva/semantic/model.py");
  });

  it("exits 0 for PR_OPEN", async () => {
    const { root } = await createFixtureRepo("run-cmd-pr-open");
    const harness = makeHarness("run-cmd-pr-open", root);
    harness.pi.script("refiner", [taskSnapshotRefiner("run-cmd-pr-open")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);

    await harness.run(["run", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Stage: PR_OPEN");
  });

  it("emits running-status progress lines without ANSI when piped", async () => {
    const { root } = await createFixtureRepo("run-cmd-progress-status");
    const harness = makeHarness("run-cmd-progress-status", root);
    harness.pi.script("refiner", [taskSnapshotRefiner("run-cmd-progress-status")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);

    await harness.run(["run", "42"]);

    const output = harness.stdoutLines.join("\n");
    expect(harness.exitCodes).toEqual([0]);
    expect(output).toContain("→ running issue acme/run-cmd-progress-status#42");
    expect(output).toContain("run completed (PR_OPEN)");
    // Phase transitions surface as committed lines while piping.
    expect(output).toContain("→ phase: IMPLEMENTATION");
    expect(output).toContain("→ phase: INDEPENDENT_REVIEW");
    expect(output).not.toContain("\u001b[");
  });

  it("exits 2 for NEEDS_REFINEMENT", async () => {
    const { root } = await createFixtureRepo("run-cmd-needs-refinement");
    const harness = makeHarness("run-cmd-needs-refinement", root);
    harness.pi.script("refiner", [refinerNeedsRefinement("run-cmd-needs-refinement")]);

    await harness.run(["run", "42"]);

    expect(harness.exitCodes).toEqual([2]);
    expect(harness.stdoutLines.join("\n")).toContain("Stage: NEEDS_REFINEMENT");
  });

  it("exits 2 for BLOCKED", async () => {
    const { root } = await createFixtureRepo("run-cmd-blocked");
    const harness = makeHarness("run-cmd-blocked", root);
    harness.pi.script("refiner", [taskSnapshotRefiner("run-cmd-blocked")]);
    harness.pi.script("implementer", [
      { outcome: "BLOCKED", reason: "missing credentials", unresolvedProblems: [] },
    ]);

    await harness.run(["run", "42"]);

    expect(harness.exitCodes).toEqual([2]);
    expect(harness.stdoutLines.join("\n")).toContain("Stage: BLOCKED");
  });

  it("exits 1 on a thrown error", async () => {
    const { root } = await createFixtureRepo("run-cmd-error");
    const harness = makeHarness("run-cmd-error", root);
    // No refiner response scripted at all: the readiness check's Pi call
    // throws "no scripted response left for role refiner".

    await harness.run(["run", "42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("autopilot run:");
  });
});
