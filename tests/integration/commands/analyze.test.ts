import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import type { AnalyzeCommandDeps } from "../../../src/commands/analyze.js";
import type {
  ResolvedRoleModel,
} from "../../../src/config/load-config.js";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type {
  RefinerResult,
  TaskDraft,
} from "../../../src/domain/contracts.js";
import type {
  GitHubIssue,
  GitHubPort,
} from "../../../src/github/github-adapter.js";
import { safeProcessEnv } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import type {
  PiExecution,
  PiRunRequest,
} from "../../../src/pi/pi-runner.js";
import { ProcessRunner } from "../../../src/platform/process-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReadinessService } from "../../../src/readiness/readiness-service.js";
import type { RefinerRunner } from "../../../src/readiness/readiness-service.js";
import { BacklogAnalyst } from "../../../src/analysis/backlog-analyst.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - npm ci
  verify:
    - npm test
`;

const REFINEMENT_START = "<!-- autopilot-refinement:start -->";
const REFINEMENT_END = "<!-- autopilot-refinement:end -->";

function makeIssue(
  number: number,
  title: string,
  body: string,
): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-18T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

const READY_BODY = `## Objective
Implement the widget.

${REFINEMENT_START}
- [ ] A widget renders
${REFINEMENT_END}
`;

const CANDIDATE_BODY = `## Objective
Implement the gadget.

## Acceptance criteria
- [ ] A gadget renders
- [ ] A gadget can be toggled
`;

// An explicit open dependency marker → BLOCKED when #201 is still open.
const BLOCKED_BODY = `## Objective
Implement the widget.

depends on: #201
`;

// No objective heading and no acceptance criteria → NEEDS_REFINEMENT.
const NEEDS_REFINEMENT_BODY = `some vague idea that lacks a contract\n`;

const EPIC_BODY = `## Objective
Ship the dashboard epic.

- [ ] Fix widget (#101)
- [ ] Build gadget (#102)
- [ ] Some prose-only thing without a ref
`;

const EPIC_ISSUE = makeIssue(28, "Dashboard epic", EPIC_BODY);
const ISSUE_101 = makeIssue(101, "Fix widget", READY_BODY);
const ISSUE_102 = makeIssue(102, "Build gadget", CANDIDATE_BODY);
const ISSUE_29 = makeIssue(29, "Another ready", READY_BODY);
const ISSUE_30 = makeIssue(30, "Another candidate", CANDIDATE_BODY);
const ISSUE_201_BLOCKED = makeIssue(201, "Blocked widget", BLOCKED_BODY);
const ISSUE_202_NEEDS = makeIssue(202, "Vague idea", NEEDS_REFINEMENT_BODY);
// The dependency target referenced by BLOCKED_BODY; left open so it is
// unsatisfied.
const ISSUE_777 = makeIssue(777, "Open dependency target", "just a stub\n");

function completeDraft(number: number): TaskDraft {
  // The readiness gate validates the snapshot against the strict schema,
  // which requires a positive issue number; the refiner fake returns a draft
  // whose issue number is not cross-checked against the requested issue.
  const positive = number > 0 ? number : 1;
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "widgets" },
    issue: { number: positive, nodeId: `I_${positive}`, updatedAt: "2026-08-18T00:00:00Z" },
    objective: "Implement the feature",
    context: "The module owns it.",
    expectedBehavior: ["Observable behavior after implementation"],
    acceptanceCriteria: [{ id: "ac1", text: "The feature works" }],
    constraints: [],
    nonGoals: [],
    validation: ["npm test"],
    dependencies: [],
    canonicalReferences: [],
    sourceBodyHash: "stale-hash",
  };
}

const READY_REFINER: RefinerResult = {
  outcome: "READY",
  taskDraft: completeDraft(1),
  missingInformation: [],
  dependencies: [],
  ambiguities: [],
};

class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];
  constructor(private readonly issues: Map<number, GitHubIssue>) {}

  async getIssue(number: number): Promise<GitHubIssue> {
    const found = this.issues.get(number);
    if (!found) throw new Error(`issue #${number} not found`);
    return { ...found, number };
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
  requests: PiRunRequest[] = [];

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    // Return a READY draft for the requested issue number (last path segment
    // of the worktree is the repo root; we don't know the issue number here,
    // but the fake returns a complete, gate-satisfying draft regardless).
    return {
      result: {
        ...READY_REFINER,
        taskDraft: completeDraft(0),
      },
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

async function createFixtureRepo(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "ap-analyze-repo-"));
  tempDirs.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), MINIMAL_YAML, "utf8");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

interface Harness {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  github: FakeGitHub;
  runner: FakeRefinerRunner;
  artifactStore: ArtifactStore;
  analysisId: string;
  run: (args: string[]) => Promise<unknown>;
}

function makeHarness(
  root: string,
  issues: Map<number, GitHubIssue>,
  analysisId: string,
): Harness {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-analyze-data-"));
  tempDirs.push(dataDir);
  const github = new FakeGitHub(issues);
  const runner = new FakeRefinerRunner();
  const paths = appPaths(dataDir);
  const artifactStore = new ArtifactStore(paths);

  const deps: AnalyzeCommandDeps = {
    cwd: root,
    dataDir,
    analysisId,
    createGitHub: async () => github,
    createAnalyst: (d) =>
      new BacklogAnalyst({
        repository: d.repository,
        config: d.config,
        github: d.github,
        readiness: d.readiness,
        artifacts: artifactStore,
        paths,
        refinerModel: d.refinerModel,
        refinerTimeoutMs: d.refinerTimeoutMs,
        analysisId: d.analysisId,
        now: d.now,
      }),
    createReadiness: (d) =>
      new ReadinessService({
        repository: d.repository,
        config: d.config,
        github: d.github,
        pi: runner,
        artifacts: artifactStore,
        paths,
        refinerModel: d.refinerModel,
        refinerTimeoutMs: d.refinerTimeoutMs,
        analysisId: (n: number) => `readiness-${n}`,
        now: () => "2026-08-18T00:00:00.000Z",
      }),
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
    artifactStore,
    analysisId,
    run,
  };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot analyze", () => {
  it("analyzes an epic: merges checklist refs, refines the candidate, skips prose-only", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [28, EPIC_ISSUE],
      [101, ISSUE_101],
      [102, ISSUE_102],
    ]);
    const harness = makeHarness(root, issues, "analyze-test-1");

    await harness.run(["analyze", "28", "--json"]);

    expect(harness.exitCodes).toEqual([0]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.summary.ready).toBe(2); // #101 (contract) + #102 (refined)
    expect(report.summary.needsRefinement).toBe(0);
    expect(report.summary.unresolved).toBe(1); // prose bullet
    expect(report.refinerSessions).toBe(1); // only #102 refined
    expect(report.executable).toEqual([101, 102]);
    expect(report.epicRef).toBe(28);
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("persists the backlog report under the injected analysisId", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [28, EPIC_ISSUE],
      [101, ISSUE_101],
      [102, ISSUE_102],
    ]);
    const harness = makeHarness(root, issues, "analyze-test-1");

    await harness.run(["analyze", "28", "--json"]);

    const persisted =
      await harness.artifactStore.readJson<{ summary: { ready: number } }>(
        "analyze-test-1",
        "backlog-report.json",
      );
    expect(persisted.summary.ready).toBe(2);
  });

  it("treats an explicit issue list as a set (epicRef null, no epic parse)", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [101, ISSUE_101],
      [102, ISSUE_102],
    ]);
    const harness = makeHarness(root, issues, "analyze-test-set");

    await harness.run(["analyze", "101", "102", "--json"]);

    expect(harness.exitCodes).toEqual([0]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.epicRef).toBeNull();
    expect(report.executable).toEqual([101, 102]);
    expect(report.refinerSessions).toBe(1); // #102 candidate only
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("--deep forces a refiner session on every analyzable issue", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [101, ISSUE_101],
      [102, ISSUE_102],
    ]);
    const harness = makeHarness(root, issues, "analyze-test-deep");

    await harness.run(["analyze", "101", "102", "--deep", "--json"]);

    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.refinerSessions).toBe(2); // both READY-by-contract and candidate
    expect(report.executable).toEqual([101, 102]);
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("mixed set with a READY and a BLOCKED (zero needs-refinement) exits 0", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [101, ISSUE_101], // READY (full contract)
      [201, ISSUE_201_BLOCKED], // BLOCKED (open dependency on #777)
      [777, ISSUE_777], // open → dependency unsatisfied
    ]);
    const harness = makeHarness(root, issues, "analyze-test-mixed-ok");

    await harness.run(["analyze", "101", "201", "--json"]);

    expect(harness.exitCodes).toEqual([0]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.summary.ready).toBe(1);
    expect(report.summary.blocked).toBe(1);
    expect(report.summary.needsRefinement).toBe(0);
    expect(report.executable).toEqual([101]);
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("zero executable (all BLOCKED) exits 2", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [201, ISSUE_201_BLOCKED], // BLOCKED (open dependency on #777)
      [777, ISSUE_777], // open → dependency unsatisfied
    ]);
    const harness = makeHarness(root, issues, "analyze-test-zero-exec");

    await harness.run(["analyze", "201", "--json"]);

    expect(harness.exitCodes).toEqual([2]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.executable).toEqual([]);
    expect(report.summary.needsRefinement).toBe(0);
    expect(report.summary.blocked).toBe(1);
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("all NEEDS_REFINEMENT (zero executable) exits 2", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [202, ISSUE_202_NEEDS], // NEEDS_REFINEMENT (no contract)
    ]);
    const harness = makeHarness(root, issues, "analyze-test-needs");

    await harness.run(["analyze", "202", "--json"]);

    expect(harness.exitCodes).toEqual([2]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.executable).toEqual([]);
    expect(report.summary.needsRefinement).toBe(1);
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("invalid --min-ready is an argument error (exit 1)", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([[101, ISSUE_101]]);
    const harness = makeHarness(root, issues, "analyze-test-min-invalid");

    await harness.run(["analyze", "101", "--min-ready", "abc", "--json"]);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stdoutLines.join("\n")).toBe("");
    expect(harness.stderrLines.join("\n")).toMatch(/invalid --min-ready 'abc'/);
    expect(harness.github.mutationCalls).toEqual([]);
  });

  it("exits 2 when --min-ready is not satisfied", async () => {
    const root = await createFixtureRepo();
    const issues = new Map<number, GitHubIssue>([
      [101, ISSUE_101],
      [102, ISSUE_102],
    ]);
    const harness = makeHarness(root, issues, "analyze-test-min");

    await harness.run(["analyze", "101", "102", "--min-ready", "3", "--json"]);

    expect(harness.exitCodes).toEqual([2]);
    const report = JSON.parse(harness.stdoutLines.join("\n"));
    expect(report.executable.length).toBe(2);
    expect(harness.github.mutationCalls).toEqual([]);
  });
});
