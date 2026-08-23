import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import type { BrainstormerResult, RefinerResult, TaskDraft } from "../../../src/domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReadinessService, sha256 } from "../../../src/readiness/readiness-service.js";
import type { RefinerRunner } from "../../../src/readiness/readiness-service.js";
import { REFINEMENT_START } from "../../../src/readiness/refinement-section.js";
import { buildProgram } from "../../../src/cli.js";
import type { PrepareCommandDeps } from "../../../src/commands/prepare.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - npm ci
  verify:
    - npm test
`;

const ISSUE_BODY =
  "Original issue body text.\n\nMore context that must be preserved.";

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

/** Mutates the issue only after the analysis-time fetch, simulating an edit. */
class ConcurrentEditGitHub extends FakeGitHub {
  private reads = 0;

  constructor(
    issue: GitHubIssue,
    private readonly mutate: (issue: GitHubIssue) => GitHubIssue,
  ) {
    super(issue);
  }

  override async getIssue(number: number): Promise<GitHubIssue> {
    this.reads += 1;
    // Initial fetch (1) and the analysis-time fetch (2) see the original;
    // the pre-mutation re-fetch (3) sees the concurrent edit.
    if (this.reads >= 3) {
      return { ...this.mutate(this.issue), number };
    }
    return super.getIssue(number);
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
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

async function createFixtureRepo(yamlOverride?: string): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "ap-prepare-repo-"));
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
  refinerResult: RefinerResult | RefinerResult[],
  github: FakeGitHub,
  confirm: (prompt: string) => Promise<boolean>,
  answer?: (prompt: string) => Promise<string>,
): {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  runner: FakeRefinerRunner;
  run: (args: string[]) => Promise<unknown>;
} {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-data-"));
  tempDirs.push(dataDir);
  const refinerResults = Array.isArray(refinerResult) ? refinerResult : [refinerResult];
  const runner = new FakeRefinerRunner(refinerResults[0]!);

  const deps: PrepareCommandDeps = {
    cwd: root,
    dataDir,
    createGitHub: async () => github,
    createReadiness: (d) => {
      let index = 0;
      return new ReadinessService({
        repository: d.repository,
        config: d.config,
        github: d.github,
        pi: {
          run: async (request) => {
            const current = refinerResults[index] ?? refinerResults[refinerResults.length - 1]!;
            index += 1;
            runner.requests.push(request);
            return {
              result: current,
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
            };
          },
        },
        artifacts: new ArtifactStore(appPaths(dataDir)),
        paths: appPaths(dataDir),
        refinerModel: d.refinerModel,
        refinerTimeoutMs: d.refinerTimeoutMs,
        analysisId: () => "prepare-test-42",
        now: () => "2026-08-18T00:00:00.000Z",
      });
    },
    confirm,
    answer,
    runBrainstormer: async () => [],
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, runner, run };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot prepare", () => {
  const readyRefiner: RefinerResult = {
    outcome: "READY",
    taskDraft: completeDraft(),
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  };

  const needsRefinementRefiner: RefinerResult = {
    outcome: "NEEDS_REFINEMENT",
    taskDraft: {
      ...completeDraft(),
      objective: "",
    },
    missingInformation: ["What is the expected UX for expired sessions?"],
    dependencies: [],
    ambiguities: [{ type: "PRODUCT", description: "Should expired sessions hard-fail or redirect to login?" }],
    suggestions: ["Clarify the expected UX for expired sessions."],
  };

  it("applies the managed refinement after explicit approval", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, readyRefiner, github, async () => true);

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Applied");
    // The proposed diff must be shown before the approval prompt, not
    // hidden while the operator approves a blind edit.
    const stdout = harness.stdoutLines.join("\n");
    expect(stdout).toContain("Proposed refinement:");
    expect(stdout).toContain("--- original");
    expect(stdout).toContain("+### Goal");
    expect(stdout.indexOf("Proposed refinement:")).toBeLessThan(
      stdout.indexOf("Applied"),
    );
    const updateCalls = github.calls.filter(
      (call) => call === "updateIssueBody",
    );
    expect(updateCalls).toHaveLength(1);
    expect(github.issue.body).toContain(ISSUE_BODY);
    expect(github.issue.body).toContain(REFINEMENT_START);
    expect(github.issue.body).toContain(
      "Implement token refresh validation",
    );
    expect(github.calls).not.toContain("createIssueComment");
    expect(github.calls).not.toContain("createPullRequest");
  });

  it("loops through one question at a time, then asks final approval when refinement becomes ready", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const prompts: string[] = [];
    const answers: string[] = [];
    const secondReady: RefinerResult = {
      ...readyRefiner,
      taskDraft: {
        ...completeDraft(),
        context: "The auth module owns session refresh. Answer incorporated: redirect to login.",
      },
    };
    const harness = makeHarness(
      root,
      [needsRefinementRefiner, secondReady],
      github,
      async (prompt) => {
        prompts.push(prompt);
        return true;
      },
      async (prompt) => {
        answers.push(prompt);
        return "Redirect to login";
      },
    );

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(answers).toEqual([
      "Clarification needed:\nWhat is the expected UX for expired sessions?\n\nAnswer (or 'cancel'): ",
    ]);
    expect(prompts).toContain("Apply the proposed refinement to issue #42?");
    expect(harness.runner.requests).toHaveLength(2);
    expect(harness.runner.requests[1]?.prompt).toContain("Operator clarifications collected during this prepare session");
    expect(harness.runner.requests[1]?.prompt).toContain("Q: What is the expected UX for expired sessions?");
    expect(harness.runner.requests[1]?.prompt).toContain("A: Redirect to login");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(1);
    expect(github.issue.body).toContain("Answer incorporated: redirect to login.");
  });

  it("re-prompts on empty answers before continuing", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const answerPrompts: string[] = [];
    const secondReady: RefinerResult = {
      ...readyRefiner,
      taskDraft: {
        ...completeDraft(),
        context: "The auth module owns session refresh. Answer incorporated: redirect to login.",
      },
    };
    let answers = 0;
    const harness = makeHarness(
      root,
      [needsRefinementRefiner, secondReady],
      github,
      async () => true,
      async (prompt) => {
        answerPrompts.push(prompt);
        answers += 1;
        return answers === 1 ? "   " : "Redirect to login";
      },
    );

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(answerPrompts).toEqual([
      "Clarification needed:\nWhat is the expected UX for expired sessions?\n\nAnswer (or 'cancel'): ",
      "Clarification needed:\nWhat is the expected UX for expired sessions?\n\nAnswer (or 'cancel'): ",
    ]);
    expect(harness.runner.requests).toHaveLength(2);
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(1);
  });

  it("cancels cleanly when the operator enters cancel", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(
      root,
      needsRefinementRefiner,
      github,
      async () => true,
      async () => "cancel",
    );

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("Cancelled");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("fails clearly when interactive clarification has no stdin available", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(
      root,
      needsRefinementRefiner,
      github,
      async () => true,
      async () => "",
    );

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("interactive clarification required but no usable stdin answer was available");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("fails safely when the question guard is exceeded", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const repeated = Array.from({ length: 12 }, () => needsRefinementRefiner);
    const harness = makeHarness(
      root,
      repeated,
      github,
      async () => true,
      async () => "Redirect to login",
    );

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("maximum number of clarification questions");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("makes zero mutation calls when the operator declines", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, readyRefiner, github, async () => false);

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stdoutLines.join("\n")).toContain("no changes");
    expect(github.calls).toEqual(["getIssue", "getIssue"]);
    expect(github.issue.body).toBe(ISSUE_BODY);
  });

  it("emits the proposed body and diff under --json without applying", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, readyRefiner, github, async () => {
      throw new Error("--json must not prompt for approval");
    });

    await harness.run(["prepare", "42", "--json"]);

    expect(harness.exitCodes).toEqual([0]);
    expect(github.calls).toEqual(["getIssue", "getIssue"]);
    const outcome = JSON.parse(harness.stdoutLines.join("\n"));
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("json-proposal");
    expect(outcome.proposedBody).toContain(REFINEMENT_START);
    expect(outcome.proposedBody).toContain(ISSUE_BODY);
    expect(outcome.diff).toContain("--- original");
    expect(outcome.diff).toContain("+### Goal");
    expect(outcome.updatedAt).toBe("2026-08-18T00:00:00Z");
  });

  it("uses the policy's budgets.refiner.timeoutMinutes and honors --refiner-timeout", async () => {
    const root = await createFixtureRepo(
      `version: 1\ncommands:\n  verify:\n    - npm test\nbudgets:\n  refiner:\n    timeoutMinutes: 9\n`,
    );
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, readyRefiner, github, async () => {
      throw new Error("--json must not prompt for approval");
    });

    await harness.run(["prepare", "42", "--json"]);
    expect(harness.runner.requests[0]?.timeoutMs).toBe(9 * 60_000);

    // Use a different issue so the fast-path reuse of #42's READY snapshot
    // does not short-circuit this fresh-override assertion.
    await harness.run(["prepare", "43", "--json", "--refiner-timeout", "25"]);
    expect(harness.runner.requests[1]?.timeoutMs).toBe(25 * 60_000);
    expect(harness.exitCodes).toEqual([0, 0]);
  });

  it("aborts without mutating when the issue changed during analysis", async () => {
    const root = await createFixtureRepo();
    const github = new ConcurrentEditGitHub(issue, (current) => ({
      ...current,
      updatedAt: "2026-08-18T09:00:00Z",
    }));
    const harness = makeHarness(root, readyRefiner, github, async () => true);

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain(
      "changed during analysis",
    );
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("aborts without mutating when the body changed but updatedAt did not", async () => {
    const root = await createFixtureRepo();
    const github = new ConcurrentEditGitHub(issue, (current) => ({
      ...current,
      body: "someone edited the body in place",
    }));
    const harness = makeHarness(root, readyRefiner, github, async () => true);

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("body changed");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("errors without mutating when the issue body already has duplicate markers", async () => {
    const root = await createFixtureRepo();
    const body = `${REFINEMENT_START}\nold\n${REFINEMENT_START}\nolder`;
    const github = new FakeGitHub({ ...issue, body });
    const harness = makeHarness(root, readyRefiner, github, async () => true);

    await harness.run(["prepare", "42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain(
      "multiple managed-section markers",
    );
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("rejects a qualified issue reference that does not match the origin", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, readyRefiner, github, async () => true);

    await harness.run(["prepare", "other/repo#42"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("origin");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });

  it("rejects an invalid thinking level", async () => {
    const root = await createFixtureRepo();
    const github = new FakeGitHub(issue);
    const harness = makeHarness(root, readyRefiner, github, async () => true);

    await harness.run(["prepare", "42", "--thinking", "turbo"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stderrLines.join("\n")).toContain("thinking");
    expect(github.calls.filter((call) => call === "updateIssueBody")).toHaveLength(0);
  });
});

function needsRefinementResult(): RefinerResult {
  return {
    outcome: "NEEDS_REFINEMENT",
    taskDraft: {
      ...completeDraft(),
      sourceBodyHash: sha256(ISSUE_BODY),
    },
    missingInformation: ["What is the expected UX for expired sessions?"],
    dependencies: [],
    ambiguities: [],
    suggestions: ["Describe the UX for expired sessions"],
  };
}

function productAmbiguityResult(): RefinerResult {
  return {
    outcome: "PRODUCT_AMBIGUITY",
    taskDraft: {
      ...completeDraft(),
      sourceBodyHash: sha256(ISSUE_BODY),
    },
    missingInformation: [],
    dependencies: [],
    ambiguities: [{ type: "PRODUCT", description: "Return 401 or 403?" }],
  };
}

function readyResult(): RefinerResult {
  const draft = completeDraft();
  return {
    outcome: "READY",
    taskDraft: { ...draft, sourceBodyHash: sha256(ISSUE_BODY) },
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  };
}

function makeBrainstormHarness(
  root: string,
  refinerResults: RefinerResult[],
  github: FakeGitHub,
  confirm: (prompt: string) => Promise<boolean>,
  brainstormResult: BrainstormerResult,
  answer?: (prompt: string) => Promise<string>,
) {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-"));
  tempDirs.push(dataDir);
  let refinerIndex = 0;

  const deps: PrepareCommandDeps = {
    cwd: root,
    dataDir,
    createGitHub: async () => github,
    createReadiness: (d) =>
      new ReadinessService({
        repository: d.repository,
        config: d.config,
        github: d.github,
        pi: {
          run: async (request) => {
            const current =
              refinerResults[refinerIndex] ??
              refinerResults[refinerResults.length - 1]!;
            refinerIndex += 1;
            return {
              result: current,
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
              sessionDir: request.sessionDir,
            };
          },
        },
        artifacts: new ArtifactStore(appPaths(dataDir)),
        paths: appPaths(dataDir),
        refinerModel: d.refinerModel,
        refinerTimeoutMs: d.refinerTimeoutMs,
        analysisId: () => "prepare-bs-test-42",
        now: () => "2026-08-18T00:00:00.000Z",
        brainstorm: async () => brainstormResult,
      }),
    confirm,
    answer,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, run };
}

describe("prepare — brainstorm phase", () => {
  let root: string;

  beforeEach(async () => {
    root = await createFixtureRepo();
  });

  it("triggers the brainstorm phase when refiner pass-1 returns NEEDS_REFINEMENT", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [
        { id: "q1", text: "What is the real goal?" },
        { id: "q2", text: "What does done look like to you?" },
      ],
    };
    const answersGiven: string[] = [];
    const { exitCodes, run } = makeBrainstormHarness(
      root,
      [needsRefinementResult(), readyResult()],
      github,
      async () => true,
      brainstormResult,
      async (prompt) => {
        answersGiven.push(prompt);
        return "Some answer";
      },
    );

    await run(["prepare", "42"]);

    expect(exitCodes).toEqual([0]);
    expect(answersGiven.some((p) => p.includes("What is the real goal?"))).toBe(true);
    expect(answersGiven.some((p) => p.includes("What does done look like to you?"))).toBe(true);
  });

  it("triggers the brainstorm phase when refiner pass-1 returns PRODUCT_AMBIGUITY", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "Which status code is correct?" }],
    };
    const answersGiven: string[] = [];
    const { exitCodes, run } = makeBrainstormHarness(
      root,
      [productAmbiguityResult(), readyResult()],
      github,
      async () => true,
      brainstormResult,
      async (prompt) => {
        answersGiven.push(prompt);
        return "Use 401";
      },
    );

    await run(["prepare", "42"]);

    expect(exitCodes).toEqual([0]);
    expect(answersGiven.some((p) => p.includes("Which status code is correct?"))).toBe(true);
  });

  it("feeds brainstorm answers to the refiner as clarifications (pass 2)", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "What is the real goal?" }],
    };
    let pass2PromptSeen = "";
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-pass2-"));
    tempDirs.push(dataDir);
    let refinerIndex = 0;
    const refinerResults = [needsRefinementResult(), readyResult()];
    const refinerRequests: PiRunRequest[] = [];

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => {
              refinerRequests.push(request);
              const current =
                refinerResults[refinerIndex] ??
                refinerResults[refinerResults.length - 1]!;
              refinerIndex += 1;
              if (refinerIndex === 2) pass2PromptSeen = request.prompt;
              return {
                result: current,
                exitCode: 0,
                durationMs: 1,
                stdout: "",
                stderr: "",
                resultPath: path.join(request.diagnosticsDir, "result.json"),
                sessionDir: request.sessionDir,
              };
            },
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => `bs-pass2-${String(refinerIndex)}`,
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => brainstormResult,
        }),
      confirm: async () => true,
      answer: async () => "The real goal is to prevent replay attacks",
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "42"]);

    expect(pass2PromptSeen).toContain("The real goal is to prevent replay attacks");
    expect(pass2PromptSeen).toContain("What is the real goal?");
  });

  it("skips the brainstorm phase when refiner pass-1 returns READY", async () => {
    const github = new FakeGitHub(issue);
    let brainstormCalled = false;
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-skip-"));
    tempDirs.push(dataDir);

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => ({
              result: readyResult(),
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
              sessionDir: request.sessionDir,
            }),
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => "bs-skip-42",
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => {
            brainstormCalled = true;
            return { questions: [{ id: "q1", text: "Skipped?" }] };
          },
        }),
      confirm: async () => true,
      answer: async () => "",
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "42"]);

    expect(brainstormCalled).toBe(false);
  });

  it("skips the brainstorm phase in --json mode", async () => {
    const github = new FakeGitHub(issue);
    let brainstormCalled = false;
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-json-"));
    tempDirs.push(dataDir);

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => ({
              result: needsRefinementResult(),
              exitCode: 0,
              durationMs: 1,
              stdout: "",
              stderr: "",
              resultPath: path.join(request.diagnosticsDir, "result.json"),
              sessionDir: request.sessionDir,
            }),
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => "bs-json-42",
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => {
            brainstormCalled = true;
            return { questions: [{ id: "q1", text: "Should not appear?" }] };
          },
        }),
      confirm: async () => true,
      stdout: () => undefined,
      stderr: () => undefined,
      setExitCode: () => undefined,
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "--json", "42"]);

    expect(brainstormCalled).toBe(false);
  });

  it("returns cancelled status when operator types cancel during brainstorm Q&A", async () => {
    const github = new FakeGitHub(issue);
    const brainstormResult: BrainstormerResult = {
      questions: [{ id: "q1", text: "What is the real goal?" }],
    };
    let pass2RefinerCalled = false;
    const dataDir = mkdtempSync(path.join(tmpdir(), "ap-prepare-bs-cancel-"));
    tempDirs.push(dataDir);
    let refinerIndex = 0;
    const refinerResults = [needsRefinementResult(), readyResult()];
    const stdoutLines: string[] = [];
    const exitCodes: number[] = [];

    const deps: PrepareCommandDeps = {
      cwd: root,
      dataDir,
      createGitHub: async () => github,
      createReadiness: (d) =>
        new ReadinessService({
          repository: d.repository,
          config: d.config,
          github: d.github,
          pi: {
            run: async (request) => {
              const current =
                refinerResults[refinerIndex] ??
                refinerResults[refinerResults.length - 1]!;
              refinerIndex += 1;
              if (refinerIndex === 2) pass2RefinerCalled = true;
              return {
                result: current,
                exitCode: 0,
                durationMs: 1,
                stdout: "",
                stderr: "",
                resultPath: path.join(request.diagnosticsDir, "result.json"),
                sessionDir: request.sessionDir,
              };
            },
          },
          artifacts: new ArtifactStore(appPaths(dataDir)),
          paths: appPaths(dataDir),
          refinerModel: d.refinerModel,
          refinerTimeoutMs: d.refinerTimeoutMs,
          analysisId: () => "bs-cancel-42",
          now: () => "2026-08-18T00:00:00.000Z",
          brainstorm: async () => brainstormResult,
        }),
      confirm: async () => true,
      answer: async () => "cancel",
      stdout: (text) => stdoutLines.push(text),
      stderr: () => undefined,
      setExitCode: (code) => exitCodes.push(code),
    };

    await buildProgram(deps).parseAsync(["node", "autopilot", "prepare", "42"]);

    expect(exitCodes).toEqual([0]);
    expect(stdoutLines.join("\n")).toContain("Cancelled");
    expect(pass2RefinerCalled).toBe(false);
  });
});
