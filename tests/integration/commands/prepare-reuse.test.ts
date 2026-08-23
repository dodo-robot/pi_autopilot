import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import type { RefinerResult, TaskDraft } from "../../../src/domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { loadRepositoryConfig } from "../../../src/config/load-config.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReadinessService } from "../../../src/readiness/readiness-service.js";
import type { RefinerRunner } from "../../../src/readiness/readiness-service.js";
import { buildProgram } from "../../../src/cli.js";
import type { PrepareCommandDeps } from "../../../src/commands/prepare.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - npm ci
  verify:
    - npm test
`;

const ISSUE_BODY = "Original issue body text.\n\nMore context.";

const issue: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: ISSUE_BODY,
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
};

function completeDraft(): TaskDraft {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "widgets" },
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
    sourceBodyHash: "stale-hash",
  };
}

class FakeGitHub implements GitHubPort {
  readonly calls: string[] = [];
  issue: GitHubIssue;

  constructor(issue: GitHubIssue) {
    this.issue = issue;
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    this.calls.push("getIssue");
    return { ...this.issue, number };
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

  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    this.calls.push("updateIssueBody");
    this.issue = {
      ...this.issue,
      number,
      body,
      updatedAt: "2026-08-18T01:00:00Z",
    };
    return { ...this.issue };
  }

  async createIssueComment(): Promise<void> {
    this.calls.push("createIssueComment");
    throw new Error("must not be called");
  }

  async findPullRequestByHead(): Promise<null> {
    return null;
  }

  async createPullRequest(): Promise<never> {
    this.calls.push("createPullRequest");
    throw new Error("must not be called");
  }

  async findIssueCommentByMarker(): Promise<null> {
    return null;
  }
}

class FakeRefinerRunner implements RefinerRunner {
  requests: PiRunRequest[] = [];

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    const result = this.result();
    return {
      result,
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
      resultPath: path.join(request.diagnosticsDir, "result.json"),
    };
  }

  constructor(private readonly result: () => RefinerResult) {}
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
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

async function createFixtureRepo(yamlOverride?: string): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "ap-reuse-repo-"));
  tempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), yamlOverride ?? MINIMAL_YAML, "utf8");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

type Harness = {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  github: FakeGitHub;
  runner: FakeRefinerRunner;
  dataDir: string;
  run: (args: string[]) => Promise<unknown>;
  /** Simulate a prior `autopilot check` that produced a READY snapshot. */
  prepareReady: () => Promise<void>;
  /** Simulate a prior `autopilot check` that produced a NEEDS_REFINEMENT report. */
  prepareNonReady: () => Promise<void>;
};

function makeHarness(
  root: string,
  refinerResult: () => RefinerResult,
  github: FakeGitHub,
  confirm: (prompt: string) => Promise<boolean>,
): Harness {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-reuse-data-"));
  tempDirs.push(dataDir);
  const runner = new FakeRefinerRunner(refinerResult);

  const makeReadiness = (deps: {
    repository: RepositoryContext;
    config: unknown;
    github: GitHubPort;
    refinerModel: ResolvedRoleModel;
    refinerTimeoutMs: number;
  }) =>
    new ReadinessService({
      repository: deps.repository,
      config: deps.config as never,
      github: deps.github,
      pi: runner,
      artifacts: new ArtifactStore(appPaths(dataDir)),
      paths: appPaths(dataDir),
      refinerModel: deps.refinerModel,
      refinerTimeoutMs: deps.refinerTimeoutMs,
      analysisId: () => "prior-check-42",
      now: () => "2026-08-18T00:00:00.000Z",
    });

  const deps: PrepareCommandDeps = {
    cwd: root,
    dataDir,
    createGitHub: async () => github,
    createReadiness: makeReadiness as PrepareCommandDeps["createReadiness"],
    confirm,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return {
    exitCodes,
    stdoutLines,
    stderrLines,
    github,
    runner,
    dataDir,
    run,
    prepareReady: async () => {
      // Build a real ReadinessService bound to the same dataDir/runner so the
      // prior check writes the pointer + snapshot artifacts that `prepare` will
      // later look up.
      const config = await loadRepositoryConfig(root);
      const service = new ReadinessService({
        repository: {
          root,
          repository: { owner: "acme", repo: "widgets" },
          originUrl: "git@github.com:acme/widgets.git",
          currentBranch: "main",
          isClean: true,
        },
        config,
        github,
        pi: runner,
        artifacts: new ArtifactStore(appPaths(dataDir)),
        paths: appPaths(dataDir),
        refinerModel: { model: "m", thinking: "high", source: "repository" },
        analysisId: () => "prior-check-42",
        now: () => "2026-08-18T00:00:00.000Z",
      });
      await service.check(42);
    },
    prepareNonReady: async () => {
      // Build a real ReadinessService bound to the same dataDir/runner so a
      // NEEDS_REFINEMENT analysis writes a report (no pointer/snapshot) under
      // a KNOWN analysisId that `prepare --from-check` can later look up.
      const config = await loadRepositoryConfig(root);
      const service = new ReadinessService({
        repository: {
          root,
          repository: { owner: "acme", repo: "widgets" },
          originUrl: "git@github.com:acme/widgets.git",
          currentBranch: "main",
          isClean: true,
        },
        config,
        github,
        pi: runner,
        artifacts: new ArtifactStore(appPaths(dataDir)),
        paths: appPaths(dataDir),
        refinerModel: { model: "m", thinking: "high", source: "repository" },
        analysisId: () => "prior-check-needs-refinement",
        now: () => "2026-08-18T00:00:00.000Z",
      });
      await service.check(42);
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot prepare reuse", () => {
  const ready = (): RefinerResult => ({
    outcome: "READY",
    taskDraft: completeDraft(),
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  });

  it("reuses a prior READY check snapshot with zero refiner requests", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, ready, github, async () => true);

    // First, simulate a prior `autopilot check 42` that produced a READY snapshot.
    await harness.prepareReady();
    // The `check` itself should have issued exactly one refiner request.
    expect(harness.runner.requests).toHaveLength(1);

    await harness.run(["prepare", "42"]);

    // The fast path must not issue any further refiner request.
    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.exitCodes).toEqual([0]);
    const updateCalls = harness.github.calls.filter(
      (call) => call === "updateIssueBody",
    );
    expect(updateCalls).toHaveLength(1);
    expect(harness.github.issue.body).toContain(
      "Implement token refresh validation",
    );
  });

  it("reveals reuse in --json output via the source field", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, ready, github, async () => {
      throw new Error("--json must not prompt");
    });

    await harness.prepareReady();

    await harness.run(["prepare", "42", "--json"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.runner.requests).toHaveLength(1);
    const outcome = JSON.parse(harness.stdoutLines.join("\n"));
    expect(outcome.source).toBe("reused");
    expect(outcome.reusedFrom).toBe("prior-check-42");
  });

  it("falls back to a fresh refiner when the issue body changed after the check", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, ready, github, async () => true);

    await harness.prepareReady();
    expect(harness.runner.requests).toHaveLength(1);

    // Simulate an edit after the prior check.
    github.issue = {
      ...issue,
      body: "Changed body after the check.",
    };

    await harness.run(["prepare", "42"]);

    // The stale snapshot must be discarded and a fresh refiner launched.
    expect(harness.runner.requests).toHaveLength(2);
    expect(harness.exitCodes).toEqual([0]);
  });

  it("falls back to a fresh refiner when the issue updatedAt changed after the check", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, ready, github, async () => true);

    await harness.prepareReady();
    expect(harness.runner.requests).toHaveLength(1);

    github.issue = { ...issue, updatedAt: "2026-08-18T09:00:00Z" };

    await harness.run(["prepare", "42"]);

    expect(harness.runner.requests).toHaveLength(2);
    expect(harness.exitCodes).toEqual([0]);
  });

  it("reuses the snapshot named by --from-check", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, ready, github, async () => true);

    await harness.prepareReady();
    expect(harness.runner.requests).toHaveLength(1);

    await harness.run(["prepare", "42", "--from-check", "prior-check-42"]);

    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.exitCodes).toEqual([0]);
    const updateCalls = harness.github.calls.filter(
      (call) => call === "updateIssueBody",
    );
    expect(updateCalls).toHaveLength(1);
  });

  it("falls back to fresh when --from-check names an unknown analysis id", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, ready, github, async () => true);

    await harness.run(["prepare", "42", "--from-check", "does-not-exist"]);

    // Unknown id falls back to a fresh analysis: one refiner request.
    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.exitCodes).toEqual([0]);
    expect(harness.runner.requests[0]?.role).toBe("refiner");
  });

  it("falls back to fresh when --from-check names a NEEDS_REFINEMENT report", async () => {
    // The shared refiner returns NEEDS_REFINEMENT for the first invocation
    // (the prior `check`) and READY thereafter (prepare's fresh fallback).
    let calls = 0;
    const stateful = (): RefinerResult => {
      calls += 1;
      if (calls === 1) {
        return {
          outcome: "NEEDS_REFINEMENT",
          taskDraft: completeDraft(),
          missingInformation: [],
          dependencies: [],
          ambiguities: [],
          suggestions: ["clarify the validation strategy"],
        };
      }
      return ready();
    };

    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, stateful, github, async () => true);

    // Prior check: produces a NEEDS_REFINEMENT report under a KNOWN id.
    await harness.prepareNonReady();
    expect(harness.runner.requests).toHaveLength(1);

    await harness.run(["prepare", "42", "--from-check", "prior-check-needs-refinement", "--json"]);

    // A non-READY report is not reusable: prepare falls back to a fresh refiner.
    expect(harness.runner.requests).toHaveLength(2);
    expect(harness.runner.requests[1]?.role).toBe("refiner");
    expect(harness.exitCodes).toEqual([0]);

    const outcome = JSON.parse(harness.stdoutLines.join("\n"));
    expect(outcome.source).toBe("fresh");
  });
});
