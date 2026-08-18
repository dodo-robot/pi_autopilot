import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { RunStore } from "../../../src/persistence/run-store.js";
import { PiRunError } from "../../../src/pi/pi-runner.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { RunService } from "../../../src/workflow/run-service.js";
import type { RunPiRunner, RunServiceDeps } from "../../../src/workflow/run-service.js";

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
async function createFixtureRepo(
  repoName: string,
): Promise<{ root: string; remote: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), "ap-run-remote-"));
  tempDirs.push(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);

  const root = mkdtempSync(path.join(tmpdir(), "ap-run-repo-"));
  tempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", remote]);

  // Verification passes only once a `.verify-ok` marker file exists in the
  // worktree, so ScriptedPiRunner can control pass/fail per implementer
  // attempt by creating (or not creating) that file.
  const yaml = `version: 1
commands:
  setup:
    - "true"
  verify:
    - "test -f .verify-ok"
`;
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), yaml, "utf8");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["push", "origin", "main"]);
  tempDirs.push(
    path.join(path.dirname(root), ".pi-autopilot-worktrees", repoName),
  );
  return { root, remote };
}

const ISSUE: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
};

/** Deterministic in-memory fake for the GitHub port. */
class FakeGitHub implements GitHubPort {
  issue: GitHubIssue;
  pulls = new Map<string, PullRequestRef>();
  comments: IssueCommentRef[] = [];
  nextPrNumber = 100;
  nextCommentId = 1;
  updateIssueBodyCalls: string[] = [];

  constructor(issue: GitHubIssue) {
    this.issue = issue;
  }

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
  }

  async updateIssueBody(_number: number, body: string): Promise<GitHubIssue> {
    this.updateIssueBodyCalls.push(body);
    throw new Error("must not be called in M1");
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

interface ScriptedEntry {
  result: AnyRoleResult;
  /** When true (default for a COMPLETED implementer result), the worktree gets a change and the `.verify-ok` marker so verification passes. */
  passVerification?: boolean;
}

/**
 * Controllable fake Pi runner. Scenarios are scripted as an ordered queue
 * per role; each call to `run` for that role consumes the next scripted
 * response. Records every request so tests can assert the reviewer never
 * receives an implementer transcript and the implementer cannot publish.
 * A COMPLETED implementer response always writes a file change; whether
 * verification then passes is controlled by `passVerification` (defaults
 * to true), which creates or removes the `.verify-ok` marker the fixture
 * repo's verify command checks for.
 */
class ScriptedPiRunner {
  readonly requests: PiRunRequest[] = [];
  private readonly queues = new Map<Role, ScriptedEntry[]>();

  script(role: Role, entries: (AnyRoleResult | ScriptedEntry)[]): void {
    this.queues.set(
      role,
      entries.map((e) => ("result" in e ? e : { result: e })),
    );
  }

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    const queue = this.queues.get(request.role);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`no scripted response left for role ${request.role}`);
    }
    const entry = queue.shift()!;
    const { result } = entry;
    const markerPath = path.join(request.worktree, ".verify-ok");
    if (request.role === "implementer" && result.outcome === "COMPLETED") {
      writeFileSync(
        path.join(request.worktree, `feature-${String(this.requests.length)}.txt`),
        "feature\n",
        "utf8",
      );
      if (entry.passVerification !== false) {
        writeFileSync(markerPath, "ok\n", "utf8");
      } else {
        rmSync(markerPath, { force: true });
      }
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

function implementerFailed(reason = "unexpected error"): ImplementerResult {
  return { outcome: "FAILED", reason };
}

function reviewerApproved(): ReviewerResult {
  return {
    outcome: "APPROVED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
    findings: [],
  };
}

function reviewerChangesRequested(note = "needs work"): ReviewerResult {
  return {
    outcome: "CHANGES_REQUESTED",
    criteriaResults: [{ criterionId: "ac1", passed: false, notes: note }],
    findings: [
      {
        severity: "critical",
        criterionId: "ac1",
        path: "feature.txt",
        line: 1,
        evidence: note,
        requestedChange: `fix: ${note}`,
      },
    ],
  };
}

function reviewerProductAmbiguity(reason = "unclear product decision"): ReviewerResult {
  return { outcome: "PRODUCT_AMBIGUITY", reason };
}

function taskSnapshotRefiner(repoName: string): PiExecution["result"] {
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

function refinerNeedsRefinement(repoName: string): PiExecution["result"] {
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

interface Harness {
  root: string;
  dataDir: string;
  github: FakeGitHub;
  pi: ScriptedPiRunner;
  deps: RunServiceDeps;
  /** Opens a fresh RunStore handle onto the same on-disk DB the service used. */
  openRunStore: () => RunStore;
}

async function makeHarness(repoName: string): Promise<Harness> {
  const { root } = await createFixtureRepo(repoName);
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-run-data-"));
  tempDirs.push(dataDir);
  const paths = appPaths(dataDir);
  const artifacts = new ArtifactStore(paths);
  const github = new FakeGitHub({ ...ISSUE });
  const pi = new ScriptedPiRunner();

  const repositoryContext: RepositoryContext = {
    root,
    repository: { owner: "acme", repo: repoName },
    originUrl: `git@github.com:acme/${repoName}.git`,
    currentBranch: "main",
    isClean: true,
  };

  const deps: RunServiceDeps = {
    cwd: root,
    processRunner: new ProcessRunner(),
    dataDir,
    createRepositoryContext: async () => repositoryContext,
    createGitHub: async () => github,
    createPi: () => pi,
    idFactory: () => "run-test-1",
  };

  return {
    root,
    dataDir,
    github,
    pi,
    deps,
    openRunStore: () => new RunStore(paths.dbPath),
  };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("RunService", () => {
  it("runs the full happy path through PR_OPEN in exact stage order", async () => {
    const harness = await makeHarness("run-fixture");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("PR_OPEN");

    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "VERIFICATION",
      "INDEPENDENT_REVIEW",
      "PUBLICATION",
      "PR_OPEN",
    ]);

    // The implementer never receives publish-capable tools/results and the
    // orchestrator alone published: exactly one implementer request and one
    // reviewer request were issued, and the reviewer's prompt carries no
    // implementer transcript/session reference.
    const implementerRequests = harness.pi.requests.filter(
      (r) => r.role === "implementer",
    );
    const reviewerRequests = harness.pi.requests.filter(
      (r) => r.role === "reviewer",
    );
    expect(implementerRequests).toHaveLength(1);
    expect(reviewerRequests).toHaveLength(1);
    expect(reviewerRequests[0]!.sessionDir).not.toBe(
      implementerRequests[0]!.sessionDir,
    );
    expect(reviewerRequests[0]!.prompt).not.toContain(
      implementerRequests[0]!.prompt,
    );
    expect(reviewerRequests[0]!.prompt).not.toContain("summary");

    // Real PR opened, comment posted, no issue-body mutation.
    expect(harness.github.pulls.size).toBe(1);
    expect(harness.github.comments).toHaveLength(1);
    expect(harness.github.updateIssueBodyCalls).toEqual([]);

    runStore.close();
  });

  it("blocks at NEEDS_REFINEMENT when the deterministic readiness gate does not pass", async () => {
    const harness = await makeHarness("run-fixture-readiness");
    harness.pi.script("refiner", [refinerNeedsRefinement("run-fixture-readiness")]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("NEEDS_REFINEMENT");
    const runStore = harness.openRunStore();
    expect(runStore.transitions(summary.runId).map((t) => t.to)).toEqual([
      "READINESS_CHECK",
      "NEEDS_REFINEMENT",
    ]);
    // No workspace, no implementer/reviewer sessions, no GitHub mutation.
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toEqual([]);
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toEqual([]);
    expect(harness.github.pulls.size).toBe(0);
    runStore.close();
  });

  it("blocks the run when the implementer reports BLOCKED", async () => {
    const harness = await makeHarness("run-fixture-impl-blocked");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-impl-blocked")]);
    harness.pi.script("implementer", [implementerBlocked("missing credentials")]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    expect(summary.reason).toBe("missing credentials");
    const runStore = harness.openRunStore();
    expect(runStore.transitions(summary.runId).map((t) => t.to)).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "BLOCKED",
    ]);
    expect(harness.github.pulls.size).toBe(0);
    runStore.close();
  });

  it("blocks after verification fails and the budget is exhausted", async () => {
    const harness = await makeHarness("run-fixture-verify-exhausted");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verify-exhausted")]);
    // Two implementer attempts, both leaving verification failing (no marker).
    harness.pi.script("implementer", [
      { result: implementerCompleted(), passVerification: false },
      { result: implementerCompleted(), passVerification: false },
    ]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions[0]).toBe("READINESS_CHECK");
    expect(transitions.at(-1)).toBe("BLOCKED");
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toEqual([]);
    runStore.close();
  });

  it("recovers from one failed verification via a fresh correction session, then succeeds", async () => {
    const harness = await makeHarness("run-fixture-verify-recover");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verify-recover")]);
    harness.pi.script("implementer", [
      { result: implementerCompleted(), passVerification: false },
      { result: implementerCompleted({ summary: "Fixed it." }), passVerification: true },
    ]);
    harness.pi.script("reviewer", [reviewerApproved()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("PR_OPEN");
    const runStore = harness.openRunStore();
    expect(runStore.transitions(summary.runId).map((t) => t.to)).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "VERIFICATION",
      "IMPLEMENTATION",
      "VERIFICATION",
      "INDEPENDENT_REVIEW",
      "PUBLICATION",
      "PR_OPEN",
    ]);
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(2);
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toHaveLength(1);
    runStore.close();
  });

  it("blocks after two review correction cycles are exhausted", async () => {
    const harness = await makeHarness("run-fixture-review-exhausted");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-review-exhausted")]);
    harness.pi.script("implementer", [
      implementerCompleted(),
      implementerCompleted({ summary: "Correction 1." }),
      implementerCompleted({ summary: "Correction 2." }),
    ]);
    harness.pi.script("reviewer", [
      reviewerChangesRequested("issue A"),
      reviewerChangesRequested("issue B"),
      reviewerChangesRequested("issue C"),
    ]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    // Exactly two correction cycles run before the budget blocks the run.
    expect(transitions.filter((s) => s === "CORRECTION")).toHaveLength(2);
    expect(transitions.at(-1)).toBe("BLOCKED");
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toHaveLength(3);
    expect(harness.github.pulls.size).toBe(0);
    runStore.close();
  });

  it("blocks to NEEDS_REFINEMENT when the reviewer reports PRODUCT_AMBIGUITY", async () => {
    const harness = await makeHarness("run-fixture-product-ambiguity");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-product-ambiguity")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerProductAmbiguity("unclear rollback semantics")]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("NEEDS_REFINEMENT");
    expect(summary.reason).toBe("unclear rollback semantics");
    expect(harness.github.pulls.size).toBe(0);
  });

  it("fails the run when a role session produces malformed output", async () => {
    const harness = await makeHarness("run-fixture-malformed");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-malformed")]);
    // No implementer entries scripted at all: ScriptedPiRunner throws a plain
    // Error (not a PiRunError) to simulate the session-level failure surface;
    // exercise the real PiRunError path instead by using a runner that always
    // rejects with PiRunError for the implementer role.
    const throwingPi: RunPiRunner = {
      run: async (request) => {
        if (request.role === "implementer") {
          throw new PiRunError("implementer session exited with code 2", "implementer", {
            stdout: "",
            stderr: "",
            resultPath: path.join(request.diagnosticsDir, "result.json"),
          });
        }
        return harness.pi.run(request);
      },
    };
    const deps: RunServiceDeps = { ...harness.deps, createPi: () => throwingPi };

    const service = new RunService(deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("FAILED");
    expect(summary.reason).toContain("implementer session exited with code 2");
    const runStore = harness.openRunStore();
    expect(runStore.transitions(summary.runId).map((t) => t.to)).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "FAILED",
    ]);
    runStore.close();
  });

  it("blocks immediately on a repeated identical verification failure without waiting for the attempt budget", async () => {
    const harness = await makeHarness("run-fixture-repeated-failure");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-repeated-failure")]);
    // Both attempts leave verification failing with the exact same evidence
    // (no marker created either time), so the fingerprint repeats on the
    // second failure and BLOCK_REPEATED_FAILURE fires before any attempt
    // budget would otherwise be exhausted.
    harness.pi.script("implementer", [
      { result: implementerCompleted(), passVerification: false },
      { result: implementerCompleted(), passVerification: false },
      { result: implementerCompleted(), passVerification: false },
    ]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    expect(summary.reason).toContain("identical failure fingerprint");
    // Blocked after the second attempt (repeated fingerprint), not the third.
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(2);
  });

  it("blocks before publication when the source issue changed materially", async () => {
    const harness = await makeHarness("run-fixture-changed-issue");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-changed-issue")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);

    // Simulate a concurrent edit to the issue discovered only when the
    // orchestrator re-fetches it right before publication.
    const originalGetIssue = harness.github.getIssue.bind(harness.github);
    let callCount = 0;
    harness.github.getIssue = async () => {
      callCount += 1;
      const issue = await originalGetIssue();
      if (callCount > 1) {
        return { ...issue, updatedAt: "2026-08-19T00:00:00Z", body: "changed body" };
      }
      return issue;
    };

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    expect(harness.github.pulls.size).toBe(0);
    expect(harness.github.comments).toEqual([]);
  });
});
