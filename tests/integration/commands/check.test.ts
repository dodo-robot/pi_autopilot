import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import type { RefinerResult, TaskDraft } from "../../../src/domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReadinessService } from "../../../src/readiness/readiness-service.js";
import type { RefinerRunner } from "../../../src/readiness/readiness-service.js";
import { buildProgram } from "../../../src/cli.js";
import type { CheckCommandDeps } from "../../../src/commands/check.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - npm ci
  verify:
    - npm test
`;

const issue: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.\n\n## Acceptance criteria\n- [ ] A refresh with an expired token returns 401",
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
  readonly mutationCalls: string[] = [];
  constructor(private readonly issue: GitHubIssue) {}

  async getIssue(number: number): Promise<GitHubIssue> {
    return { ...this.issue, number };
  }

  async updateIssueBody(): Promise<GitHubIssue> {
    this.mutationCalls.push("updateIssueBody");
    throw new Error("must not be called");
  }

  async createIssueComment(): Promise<void> {
    this.mutationCalls.push("createIssueComment");
    throw new Error("must not be called");
  }

  async findPullRequestByHead(): Promise<null> {
    return null;
  }

  async createPullRequest(): Promise<never> {
    this.mutationCalls.push("createPullRequest");
    throw new Error("must not be called");
  }

  async findIssueCommentByMarker(): Promise<null> {
    return null;
  }
}

class FakeRefinerRunner implements RefinerRunner {
  constructor(private readonly result: RefinerResult) {}

  requests: PiRunRequest[] = [];

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    return {
      result: this.result,
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
      resultPath: path.join(request.diagnosticsDir, "result.json"),
    };
  }
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

async function createFixtureRepo(yamlOverride?: string): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "ap-check-repo-"));
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

function makeHarness(
  root: string,
  refinerResult: RefinerResult,
): {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  github: FakeGitHub;
  run: (args: string[]) => Promise<unknown>;
} {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-check-data-"));
  tempDirs.push(dataDir);
  const github = new FakeGitHub(issue);
  const runner = new FakeRefinerRunner(refinerResult);

  const deps: CheckCommandDeps = {
    cwd: root,
    dataDir,
    createGitHub: async () => github,
    createReadiness: (d) =>
      new ReadinessService({
        repository: d.repository,
        config: d.config,
        github: d.github,
        pi: runner,
        artifacts: new ArtifactStore(appPaths(dataDir)),
        paths: appPaths(dataDir),
        refinerModel: d.refinerModel,
        refinerTimeoutMs: d.refinerTimeoutMs,
        analysisId: () => "check-test-42",
        now: () => "2026-08-18T00:00:00.000Z",
      }),
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, github, runner, run };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot check", () => {
  it("reports READY with exit code 0 and never mutates GitHub", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Status: READY");
    expect(harness.stdoutLines.join("\n")).toContain(
      "Objective: Implement token refresh validation",
    );
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("emits non-ANSI human progress lines (piped output stays clean)", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42"]);

    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("→ refining issue acme/widgets#42 (refiner timeout 5m)");
    expect(output).toContain("readiness assessment complete for acme/widgets#42");
    // Piped (non-TTY) output must never contain ANSI repaint sequences.
    expect(output).not.toContain("\u001b[");
  });

  it("reports NEEDS_REFINEMENT with exit code 2 when the deterministic gate fails", async () => {
    const root = await createFixtureRepo();
    const draft = completeDraft();
    draft.acceptanceCriteria = [];
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: draft,
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42"]);

    expect(harness.exitCodes).toEqual([2]);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Status: NEEDS_REFINEMENT");
    expect(output).toContain("NO_TESTABLE_ACCEPTANCE_CRITERIA");
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("uses the policy's budgets.refiner.timeoutMinutes for the refiner session", async () => {
    const root = await createFixtureRepo(
      `version: 1\ncommands:\n  verify:\n    - npm test\nbudgets:\n  refiner:\n    timeoutMinutes: 12\n`,
    );
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.runner.requests[0]?.timeoutMs).toBe(12 * 60_000);
  });

  it("overrides the policy refiner timeout with --refiner-timeout", async () => {
    const root = await createFixtureRepo(
      `version: 1\ncommands:\n  verify:\n    - npm test\nbudgets:\n  refiner:\n    timeoutMinutes: 3\n`,
    );
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42", "--refiner-timeout", "20"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.runner.requests[0]?.timeoutMs).toBe(20 * 60_000);
  });

  it("emits a machine-readable report with --json", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42", "--json"]);

    expect(harness.exitCodes).toEqual([0]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.status).toBe("READY");
    expect(report.issueNumber).toBe(42);
    expect(report.repository).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("accepts a qualified issue reference matching the origin", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "acme/widgets#42"]);

    expect(harness.exitCodes).toEqual([0]);
  });

  it("rejects a qualified issue reference that does not match the origin", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "other/repo#42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("origin");
  });

  it("resolves role models with CLI overrides and records them", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42", "--json", "--model", "openai/gpt-5.2", "--thinking", "max"]);

    expect(harness.exitCodes).toEqual([0]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.refinerModel).toEqual({
      model: "openai/gpt-5.2",
      thinking: "max",
      source: "cli",
    });
  });

  it("rejects an invalid thinking level with exit code 1", async () => {
    const root = await createFixtureRepo();
    const refiner: RefinerResult = {
      outcome: "READY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [],
    };
    const harness = makeHarness(root, refiner);

    await harness.run(["check", "42", "--thinking", "turbo"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("thinking");
  });
});
