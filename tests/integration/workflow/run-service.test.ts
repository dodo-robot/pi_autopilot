import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { RunStore } from "../../../src/persistence/run-store.js";
import { PiRunError } from "../../../src/pi/pi-runner.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { RunService, RunServiceError } from "../../../src/workflow/run-service.js";
import type { RunPiRunner, RunServiceDeps } from "../../../src/workflow/run-service.js";
import { WorkspaceError } from "../../../src/workspace/workspace-manager.js";
import { GitHubError } from "../../../src/github/github-adapter.js";

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

/**
 * Create a bare remote plus a primary clone with one commit, pushed to
 * origin. `verifyCommand` defaults to the standard `.verify-ok` marker
 * check; pass a different command for a fixture whose verification
 * failures must produce distinct evidence (e.g. a distinct exit code per
 * attempt) rather than an identical failure every time.
 */
async function createFixtureRepo(
  repoName: string,
  verifyCommand = "test -f .verify-ok",
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
    - "${verifyCommand}"
`;
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), yaml, "utf8");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  if (verifyCommand === "node verify.mjs") {
    // Exit with the value in `.attempt-count` (written by ScriptedPiRunner
    // per implementer attempt), so consecutive verification failures
    // produce distinct exit codes instead of an identical one.
    writeFileSync(
      path.join(root, "verify.mjs"),
      "import { readFileSync } from 'node:fs';\n" +
        "process.exitCode = Number(readFileSync('.attempt-count', 'utf8'));\n",
      "utf8",
    );
  }
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

  async updateIssueBody(_number: number, body: string): Promise<GitHubIssue> {
    this.updateIssueBodyCalls.push(body);
    throw new Error("must not be called in M1");
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
      // A distinct, monotonically increasing counter per call, consumed by
      // fixtures whose verify command derives its exit code from it (so
      // consecutive failures produce distinct budget fingerprints instead
      // of an identical one).
      writeFileSync(
        path.join(request.worktree, ".attempt-count"),
        String(this.requests.length),
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

function verifierVerified(): VerifierResult {
  return {
    outcome: "VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
  };
}

function verifierNotVerified(note = "no evidence in diff"): VerifierResult {
  return {
    outcome: "NOT_VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: false, notes: note }],
    findings: [
      { criterionId: "ac1", evidence: note, notes: `unresolved: ${note}` },
    ],
  };
}

function verifierProductAmbiguity(reason = "ambiguous acceptance criteria"): VerifierResult {
  return { outcome: "PRODUCT_AMBIGUITY", reason };
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

async function makeHarness(repoName: string, verifyCommand?: string): Promise<Harness> {
  const { root } = await createFixtureRepo(repoName, verifyCommand);
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
    harness.pi.script("verifier", [verifierVerified()]);

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
      "ACCEPTANCE_VERIFICATION",
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

  it("runs a verifier session after reviewer approval, before publication", async () => {
    const harness = await makeHarness("run-fixture-verifier-happy");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-happy")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);

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
      "ACCEPTANCE_VERIFICATION",
      "PUBLICATION",
      "PR_OPEN",
    ]);

    // The verifier is independent: its own session, no reviewer/implementer
    // transcript leaking into its prompt.
    const reviewerRequests = harness.pi.requests.filter((r) => r.role === "reviewer");
    const verifierRequests = harness.pi.requests.filter((r) => r.role === "verifier");
    expect(verifierRequests).toHaveLength(1);
    expect(verifierRequests[0]!.sessionDir).not.toBe(reviewerRequests[0]!.sessionDir);
    expect(verifierRequests[0]!.prompt).not.toContain("APPROVED");

    runStore.close();
  });

  it("loops back through implementation on verifier NOT_VERIFIED, then publishes once verified", async () => {
    const harness = await makeHarness("run-fixture-verifier-not-verified");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-not-verified")]);
    harness.pi.script("implementer", [
      implementerCompleted(),
      implementerCompleted({ summary: "Addressed verifier findings." }),
    ]);
    harness.pi.script("reviewer", [reviewerApproved(), reviewerApproved()]);
    harness.pi.script("verifier", [verifierNotVerified(), verifierVerified()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("PR_OPEN");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions.filter((s) => s === "ACCEPTANCE_VERIFICATION")).toHaveLength(2);
    expect(transitions.filter((s) => s === "CORRECTION")).toHaveLength(1);
    expect(harness.pi.requests.filter((r) => r.role === "verifier")).toHaveLength(2);
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(2);
    runStore.close();
  });

  it("blocks after two acceptance-verification correction cycles are exhausted", async () => {
    const harness = await makeHarness("run-fixture-verifier-exhausted");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-exhausted")]);
    harness.pi.script("implementer", [
      implementerCompleted(),
      implementerCompleted({ summary: "Correction 1." }),
      implementerCompleted({ summary: "Correction 2." }),
    ]);
    harness.pi.script("reviewer", [
      reviewerApproved(),
      reviewerApproved(),
      reviewerApproved(),
    ]);
    harness.pi.script("verifier", [
      verifierNotVerified("issue A"),
      verifierNotVerified("issue B"),
      verifierNotVerified("issue C"),
    ]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(summary.runId).map((t) => t.to);
    expect(transitions.filter((s) => s === "CORRECTION")).toHaveLength(2);
    expect(transitions.at(-1)).toBe("BLOCKED");
    expect(harness.github.pulls.size).toBe(0);
    runStore.close();
  });

  it("reaches NEEDS_REFINEMENT on verifier PRODUCT_AMBIGUITY", async () => {
    const harness = await makeHarness("run-fixture-verifier-ambiguous");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-verifier-ambiguous")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierProductAmbiguity()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("NEEDS_REFINEMENT");
    expect(summary.reason).toBe("ambiguous acceptance criteria");
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
    harness.pi.script("verifier", [verifierVerified()]);

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
      "ACCEPTANCE_VERIFICATION",
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
    harness.pi.script("verifier", [verifierVerified()]);

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

  it("blocks after three distinct verification failures exhaust the implementation attempt budget", async () => {
    // The verify command's exit code is read from a counter file the
    // implementer bumps every attempt, so each failure's exit code (and
    // therefore its budget fingerprint) is DISTINCT. This proves the
    // implementation attempt budget itself (not the repeated-failure
    // fast-block) is what ends the run: without a VERIFICATION branch in
    // BudgetTracker this would retry forever (each call would eventually
    // throw "no scripted response left for role implementer").
    const harness = await makeHarness(
      "run-fixture-verify-attempts-exhausted",
      "node verify.mjs",
    );
    harness.pi.script("refiner", [
      taskSnapshotRefiner("run-fixture-verify-attempts-exhausted"),
    ]);
    harness.pi.script("implementer", [
      { result: implementerCompleted({ summary: "Attempt 1." }), passVerification: false },
      { result: implementerCompleted({ summary: "Attempt 2." }), passVerification: false },
      { result: implementerCompleted({ summary: "Attempt 3." }), passVerification: false },
    ]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);

    expect(summary.stage).toBe("BLOCKED");
    expect(summary.reason).toContain("implementation attempts exhausted");
    // Exactly three implementer attempts ran (the budget, not a repeated
    // fingerprint, stopped the run) and no reviewer session was ever launched.
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(3);
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toEqual([]);
    expect(harness.github.pulls.size).toBe(0);
  });

  it("rejects starting a run when an active run already exists for the issue", async () => {
    const harness = await makeHarness("run-fixture-active-run");
    // Seed a run already sitting in a non-terminal stage (IMPLEMENTATION) for
    // this issue directly through the store, exactly as a real in-progress
    // run would leave it. start() must reject before doing any work.
    const runStore = harness.openRunStore();
    const existing = runStore.createRun({
      id: "run-existing",
      repository: { owner: "acme", repo: "run-fixture-active-run" },
      issueNumber: 42,
    });
    runStore.transition(existing.id, "PREFLIGHT", "READINESS_CHECK", null);
    runStore.transition(existing.id, "READINESS_CHECK", "WORKSPACE_CREATION", null);
    runStore.transition(existing.id, "WORKSPACE_CREATION", "IMPLEMENTATION", null);
    runStore.close();

    const service = new RunService(harness.deps);

    await expect(service.start(42)).rejects.toThrow(RunServiceError);
    await expect(service.start(42)).rejects.toThrow(/active run already exists/);
    // No new session was launched for the rejected attempt.
    expect(harness.pi.requests).toEqual([]);
  });

  it("transitions a run to FAILED when readiness fails with a non-PiRunError exception", async () => {
    const harness = await makeHarness("run-fixture-github-error");
    const failingGithub: typeof harness.github = harness.github;
    failingGithub.getIssue = async () => {
      throw new GitHubError("GitHub API rate limit exceeded");
    };

    const service = new RunService(harness.deps);

    await expect(service.start(42)).rejects.toThrow(GitHubError);

    const runStore = harness.openRunStore();
    const active = runStore.getActiveRunForIssue("acme", "run-fixture-github-error", 42);
    expect(active).toBeNull();
    const runs = runStore.listNonterminalRuns();
    expect(runs).toEqual([]);
    runStore.close();

    // The issue must be runnable again: a fresh start() call is not rejected
    // as "active" (the failed run reached the terminal FAILED stage).
    harness.github.getIssue = async () => ({ ...ISSUE });
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-github-error")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);
    const retryDeps: RunServiceDeps = { ...harness.deps, idFactory: () => "run-test-2" };
    const retryService = new RunService(retryDeps);
    const retry = await retryService.start(42);
    expect(retry.stage).toBe("PR_OPEN");
  });

  it("transitions a run to FAILED when workspace creation throws a non-PiRunError exception", async () => {
    const harness = await makeHarness("run-fixture-workspace-error");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-workspace-error")]);

    const brokenProcessRunner: ProcessRunner = {
      run: async (request) => {
        if (request.args.includes("worktree") && request.args.includes("add")) {
          throw new WorkspaceError("failed to create git worktree");
        }
        return harness.deps.processRunner!.run(request);
      },
    };
    const deps: RunServiceDeps = { ...harness.deps, processRunner: brokenProcessRunner };

    const service = new RunService(deps);

    await expect(service.start(42)).rejects.toThrow(WorkspaceError);

    const runStore = harness.openRunStore();
    const active = runStore.getActiveRunForIssue("acme", "run-fixture-workspace-error", 42);
    expect(active).toBeNull();
    runStore.close();
  });
});

describe("RunService.resume", () => {
  it("launches a fresh correction session in the preserved workspace and reaches PR_OPEN", async () => {
    const harness = await makeHarness("run-fixture-resume");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-resume")]);
    harness.pi.script("implementer", [
      implementerBlocked("missing credentials"),
    ]);

    const service = new RunService(harness.deps);
    const blocked = await service.start(42);
    expect(blocked.stage).toBe("BLOCKED");

    // Resume with a fresh implementer response that completes the work.
    harness.pi.script("implementer", [implementerCompleted({ summary: "Resumed and finished." })]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);

    const resumed = await service.resume(blocked.runId);

    expect(resumed.stage).toBe("PR_OPEN");
    const runStore = harness.openRunStore();
    const transitions = runStore.transitions(blocked.runId).map((t) => t.to);
    // The original BLOCKED transition is preserved in history, followed by
    // the resumed correction cycle through to publication.
    expect(transitions).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "BLOCKED",
      "IMPLEMENTATION",
      "VERIFICATION",
      "INDEPENDENT_REVIEW",
      "ACCEPTANCE_VERIFICATION",
      "PUBLICATION",
      "PR_OPEN",
    ]);
    // A fresh implementer session ran with no prior-transcript reference:
    // exactly one implementer request was issued for the resumed attempt,
    // and it does not reference the original BLOCKED session's directories.
    const implementerRequests = harness.pi.requests.filter((r) => r.role === "implementer");
    expect(implementerRequests).toHaveLength(2);
    expect(implementerRequests[1]!.sessionDir).not.toBe(implementerRequests[0]!.sessionDir);
    runStore.close();
  });

  it("rejects resuming a run that is not BLOCKED", async () => {
    const harness = await makeHarness("run-fixture-resume-not-blocked");
    harness.pi.script("refiner", [taskSnapshotRefiner("run-fixture-resume-not-blocked")]);
    harness.pi.script("implementer", [implementerCompleted()]);
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);

    const service = new RunService(harness.deps);
    const summary = await service.start(42);
    expect(summary.stage).toBe("PR_OPEN");

    await expect(service.resume(summary.runId)).rejects.toThrow(RunServiceError);
    await expect(service.resume(summary.runId)).rejects.toThrow(/not BLOCKED/);
  });

  it("rejects resuming an unknown run id", async () => {
    const harness = await makeHarness("run-fixture-resume-unknown");
    const service = new RunService(harness.deps);

    await expect(service.resume("no-such-run")).rejects.toThrow(RunServiceError);
    await expect(service.resume("no-such-run")).rejects.toThrow(/no run found/);
  });

  it("resumes a FAILED run at INDEPENDENT_REVIEW by re-verifying and launching a reviewer without a new implementer attempt", async () => {
    const harness = await makeHarness("run-fixture-resume-failed-review");
    harness.pi.script("refiner", [
      taskSnapshotRefiner("run-fixture-resume-failed-review"),
    ]);
    harness.pi.script("implementer", [implementerCompleted()]);
    // The reviewer session dies abnormally (PiRunError) after the run reached
    // INDEPENDENT_REVIEW; runFailClosed persists FAILED with resumeAt set to
    // the current stage (INDEPENDENT_REVIEW). Nothing is recorded for the
    // reviewer attempt (launchReviewer throws before recordAttempt).
    const service = new RunService(harness.deps);
    const throwingPi: RunPiRunner = {
      run: async (request) => {
        if (request.role === "reviewer") {
          throw new PiRunError("reviewer session exited with code 2", "reviewer", {
            stdout: "",
            stderr: "",
            resultPath: path.join(request.diagnosticsDir, "result.json"),
          });
        }
        return harness.pi.run(request);
      },
    };
    const failingDeps: RunServiceDeps = { ...harness.deps, createPi: () => throwingPi };
    const failingService = new RunService(failingDeps);
    const failed = await failingService.start(42);

    expect(failed.stage).toBe("FAILED");
    const runStore = harness.openRunStore();
    expect(runStore.getRun(failed.runId)!.resumeAt).toBe("INDEPENDENT_REVIEW");
    // Original run reached INDEPENDENT_REVIEW and recorded one implementer
    // attempt (no implementer result artifact for COMPLETED outcomes).
    expect(runStore.listAttempts(failed.runId).map((a) => a.role)).toEqual([
      "implementer",
    ]);
    runStore.close();

    // Resume at the preserved INDEPENDENT_REVIEW stage: re-run verification
    // on the existing work (still passing), then launch a fresh reviewer
    // that approves. No new implementer session may be started.
    harness.pi.script("reviewer", [reviewerApproved()]);
    harness.pi.script("verifier", [verifierVerified()]);
    const resumedService = new RunService(harness.deps);
    const resumed = await resumedService.resume(failed.runId);

    expect(resumed.stage).toBe("PR_OPEN");
    const runStore2 = harness.openRunStore();
    const attempts = runStore2.listAttempts(failed.runId).map((a) => a.role);
    // No second implementer attempt; exactly one reviewer and one verifier
    // attempt recorded on the resumed run.
    expect(attempts).toEqual(["implementer", "reviewer", "verifier"]);
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(1);
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toHaveLength(1);
    expect(harness.pi.requests.filter((r) => r.role === "verifier")).toHaveLength(1);
    expect(runStore2.transitions(failed.runId).map((t) => t.to)).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "VERIFICATION",
      "INDEPENDENT_REVIEW",
      "FAILED",
      "VERIFICATION",
      "INDEPENDENT_REVIEW",
      "ACCEPTANCE_VERIFICATION",
      "PUBLICATION",
      "PR_OPEN",
    ]);
    runStore2.close();
  });

  it("resumes a FAILED run at VERIFICATION by re-verifying and, on verification failure, recording a second implementer attempt (the correction path) rather than launching a reviewer", async () => {
    const harness = await makeHarness("run-fixture-resume-failed-verification");
    harness.pi.script("refiner", [
      taskSnapshotRefiner("run-fixture-resume-failed-verification"),
    ]);
    // The first implementer completes but leaves no `.verify-ok` marker, so
    // the resumed verification (re-run against the preserved worktree) fails
    // deterministically once the process runner no longer throws.
    harness.pi.script("implementer", [
      { result: implementerCompleted(), passVerification: false },
    ]);

    // On the FIRST run the verify command’s process runner throws (a
    // transient verification-infrastructure error). runFailClosed persists
    // FAILED from the current stage, which is VERIFICATION, so resumeAt is
    // recorded as VERIFICATION; the non-PiRunError propagates and start()
    // rejects.
    const brokenVerificationRunner: ProcessRunner = {
      run: async (request) => {
        if (request.args.includes(".verify-ok")) {
          throw new WorkspaceError("verify infrastructure unavailable");
        }
        return harness.deps.processRunner!.run(request);
      },
    };
    const failingDeps: RunServiceDeps = {
      ...harness.deps,
      processRunner: brokenVerificationRunner,
    };
    const failingService = new RunService(failingDeps);

    await expect(failingService.start(42)).rejects.toThrow();

    const runStore = harness.openRunStore();
    const failed = runStore.getMostRecentRunForIssue("acme", "run-fixture-resume-failed-verification", 42)!;
    expect(failed.stage).toBe("FAILED");
    expect(failed.resumeAt).toBe("VERIFICATION");
    // One implementer attempt was recorded on the original run.
    expect(runStore.listAttempts(failed.id).map((a) => a.role)).toEqual(["implementer"]);
    runStore.close();

    // Resume at the preserved VERIFICATION stage with the real process
    // runner: the `-f .verify-ok` check now exits nonzero (no marker), so
    // verification fails and the verification-correction path launches a
    // SECOND implementer session — never a reviewer.
    harness.pi.script("implementer", [
      implementerBlocked("verification not resolved"),
    ]);
    const resumedService = new RunService(harness.deps);
    const resumed = await resumedService.resume(failed.id);

    expect(resumed.stage).toBe("BLOCKED");
    expect(resumed.reason).toBe("verification not resolved");

    const runStore2 = harness.openRunStore();
    const attempts = runStore2.listAttempts(failed.id);
    // Exactly two implementer attempts (the second from the verification-
    // correction path) and no reviewer attempt ever recorded.
    expect(attempts.map((a) => a.role)).toEqual(["implementer", "implementer"]);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(harness.pi.requests.filter((r) => r.role === "implementer")).toHaveLength(2);
    expect(harness.pi.requests.filter((r) => r.role === "reviewer")).toEqual([]);
    // The second implementer session is the verification-correction session,
    // not a fresh base implementer run.
    const implementerRequests = harness.pi.requests.filter((r) => r.role === "implementer");
    expect(implementerRequests[1]!.prompt).toContain("previous verification run failed");
    expect(runStore2.transitions(failed.id).map((t) => t.to)).toEqual([
      "READINESS_CHECK",
      "WORKSPACE_CREATION",
      "IMPLEMENTATION",
      "VERIFICATION",
      "FAILED",
      "VERIFICATION",
      "IMPLEMENTATION",
      "BLOCKED",
    ]);
    runStore2.close();
  });
});
