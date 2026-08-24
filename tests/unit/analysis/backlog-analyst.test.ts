import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutopilotConfigSchema } from "../../../src/config/schema.js";
import {
  REFINEMENT_START,
  REFINEMENT_END,
} from "../../../src/analysis/heuristic-screen.js";
import type {
  GitHubIssue,
  GitHubPort,
} from "../../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReadinessService } from "../../../src/readiness/readiness-service.js";
import type { RefinerRunner } from "../../../src/readiness/readiness-service.js";
import type { RefinerResult, TaskDraft } from "../../../src/domain/contracts.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { BacklogAnalyst } from "../../../src/analysis/backlog-analyst.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";

const CONTRACT_BODY = `${REFINEMENT_START}
## Autonomous execution contract

### Goal
Implement x.

### Acceptance criteria
- [ ] **ac1** It works

${REFINEMENT_END}
`;

const CANDIDATE_BODY = `## Goal
Implement login

## Acceptance criteria
- [ ] user can log in
`;

const VAGUE_BODY = "Just a vague note.";

const AMBIGUOUS_BODY = "Which behavior should win here?";

const BLOCKED_BODY = "Depends on: #10\n\n## Goal\nImplement y";

function makeIssue(
  number: number,
  body: string,
  state = "open",
  title = `Issue ${number}`,
): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-20T00:00:00Z",
    state,
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

function completeDraft(number: number): TaskDraft {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "widgets" },
    issue: { number, nodeId: `I_${number}`, updatedAt: "2026-08-20T00:00:00Z" },
    objective: "Implement x",
    context: "The module owns x.",
    expectedBehavior: ["x is implemented"],
    acceptanceCriteria: [{ id: "ac1", text: "It works" }],
    constraints: [],
    nonGoals: [],
    validation: ["npm test"],
    dependencies: [],
    canonicalReferences: [],
    sourceBodyHash: "stale-hash",
  };
}

function readyResult(number: number): RefinerResult {
  return {
    outcome: "READY",
    taskDraft: completeDraft(number),
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  };
}

class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];

  constructor(private readonly issues: Map<number, GitHubIssue>) {}

  async getIssue(number: number): Promise<GitHubIssue> {
    const found = this.issues.get(number);
    if (found === undefined) {
      throw new Error(`no such issue #${number}`);
    }
    return { ...found };
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
    this.mutationCalls.push("updateIssueBody");
    throw new Error("must not be called");
  }

  async createIssueComment(): Promise<void> {
    this.mutationCalls.push("createIssueComment");
    throw new Error("must not be called");
  }

  async closeIssue(): Promise<void> {
    this.mutationCalls.push("closeIssue");
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

/** Determines the refiner outcome for an issue number; CANDIDATE issues refine to READY. */
function refinerResultFor(number: number): RefinerResult {
  return readyResult(number);
}

class FakeRefinerRunner implements RefinerRunner {
  requests: PiRunRequest[] = [];

  async run(request: PiRunRequest): Promise<PiExecution> {
    this.requests.push(request);
    const issueNumberMatch = /#(\d+)/.exec(request.prompt);
    const number = issueNumberMatch ? Number(issueNumberMatch[1]) : 0;
    return {
      result: refinerResultFor(number),
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
      resultPath: path.join(request.diagnosticsDir, "result.json"),
    };
  }
}

const refinerModel: ResolvedRoleModel = {
  model: "anthropic/claude-sonnet-4",
  thinking: "high",
  source: "repository",
};

const repoCtx: RepositoryContext = {
  root: "/tmp/acme/widgets",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config = AutopilotConfigSchema.parse({
  version: 1,
  commands: { verify: ["npm test"] },
});

let tempDirs: string[] = [];

interface Harness {
  analyst: BacklogAnalyst;
  github: FakeGitHub;
  runner: FakeRefinerRunner;
  store: ArtifactStore;
  dataDir: string;
}

function makeHarness(
  issues: Map<number, GitHubIssue>,
  analysisId: string,
): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-analyze-"));
  tempDirs.push(dataDir);
  const github = new FakeGitHub(issues);
  const runner = new FakeRefinerRunner();
  const store = new ArtifactStore(appPaths(dataDir));

  const analyst = new BacklogAnalyst({
    repository: repoCtx,
    config,
    github,
    readiness: new ReadinessService({
      repository: repoCtx,
      config,
      github,
      pi: runner,
      artifacts: store,
      paths: appPaths(dataDir),
      refinerModel,
      analysisId: (n) => `check-${n}`,
      now: () => "2026-08-20T00:00:00.000Z",
    }),
    artifacts: store,
    paths: appPaths(dataDir),
    refinerModel,
    analysisId,
    now: () => "2026-08-20T00:00:00.000Z",
  });

  return { analyst, github, runner, store, dataDir };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("BacklogAnalyst.analyzeIssues", () => {
  it("triages a mixed set: refiner only for CANDIDATE in non-deep mode", async () => {
    const issues = new Map<number, GitHubIssue>([
      [1, makeIssue(1, CONTRACT_BODY)], // READY without refiner
      [2, makeIssue(2, CANDIDATE_BODY)], // CANDIDATE -> refiner -> READY
      [3, makeIssue(3, VAGUE_BODY)], // NEEDS_REFINEMENT, no refiner
      [4, makeIssue(4, BLOCKED_BODY)], // BLOCKED (depends on #10, open)
      [5, makeIssue(5, AMBIGUOUS_BODY)], // AMBIGUOUS
      [10, makeIssue(10, VAGUE_BODY, "open", "Dependency")], // dependency target, open
    ]);
    const { analyst, github, runner, store } = makeHarness(
      issues,
      "analyze-test-1",
    );

    const report = await analyst.analyzeIssues({
      epicRef: null,
      requestedRefs: [1, 2, 3, 4, 5],
    });

    // Only issue #2 is CANDIDATE; only it should refine (non-deep).
    expect(report.refinerSessions).toBe(1);
    expect(runner.requests).toHaveLength(1);
    expect(report.analysisId).toBe("analyze-test-1");

    expect(report.executable.sort()).toEqual([1, 2]);
    expect(report.needsWork.sort()).toEqual([3, 4, 5]);

    // Screen classifications preserved verbatim.
    const byNumber = new Map(
      report.issues.map((r) => [r.issueNumber, r]),
    );
    expect(byNumber.get(1)!.screen.classification).toBe("READY");
    expect(byNumber.get(2)!.screen.classification).toBe("CANDIDATE");
    expect(byNumber.get(2)!.classification).toBe("READY");
    expect(byNumber.get(2)!.readiness?.status).toBe("READY");
    expect(byNumber.get(3)!.classification).toBe("NEEDS_REFINEMENT");
    expect(byNumber.get(4)!.classification).toBe("BLOCKED");
    expect(byNumber.get(5)!.classification).toBe("AMBIGUOUS");

    // Scope accounting.
    expect(report.scope.totalIssues).toBe(5);
    expect(report.scope.analyzed).toBe(5);
    expect(report.scope.unresolved).toBe(0);

    // Zero mutation calls.
    expect(github.mutationCalls).toEqual([]);

    // Artifact persisted.
    const persisted = await store.readJson(
      "analyze-test-1",
      "backlog-report.json",
    );
    expect(persisted).toMatchObject({ analysisId: "analyze-test-1" });
  });

  it("epic mode merges and de-dupes requested + epic refs", async () => {
    const epicBody = `# Epic\n\n- [ ] #1\n- [ ] #2\n- [ ] prose only line\n- [ ] #1\n`;
    const issues = new Map<number, GitHubIssue>([
      [100, makeIssue(100, epicBody, "open", "Epic")],
      [1, makeIssue(1, CONTRACT_BODY)],
      [2, makeIssue(2, CONTRACT_BODY)],
      [3, makeIssue(3, CONTRACT_BODY)],
    ]);
    const { analyst } = makeHarness(issues, "analyze-test-2");

    const report = await analyst.analyzeIssues({
      epicRef: 100,
      requestedRefs: [3, 1],
    });

    // requested [3,1] then epic [1,2,1] merged de-duped -> [3,1,2].
    expect(report.requestedRefs).toEqual([3, 1, 2]);
    expect(report.epicRef).toBe(100);
    expect(report.scope.totalIssues).toBe(3);
    expect(report.scope.unresolved).toBe(1); // one prose-only line
  });

  it("deep mode runs a refiner for every analyzable issue", async () => {
    const issues = new Map<number, GitHubIssue>([
      [1, makeIssue(1, CONTRACT_BODY)], // READY
      [2, makeIssue(2, CANDIDATE_BODY)], // CANDIDATE
      [3, makeIssue(3, VAGUE_BODY)], // NEEDS_REFINEMENT
    ]);
    const { analyst, runner } = makeHarness(issues, "analyze-test-3");

    const report = await analyst.analyzeIssues({
      epicRef: null,
      requestedRefs: [1, 2, 3],
      deep: true,
    });

    // All three are analyzable (non-SKIPPED); deep refines each.
    expect(report.refinerSessions).toBe(3);
    expect(runner.requests).toHaveLength(3);
  });

  it("SKIPPED issues never refine and are excluded from executable/needsWork/analyzed", async () => {
    const issues = new Map<number, GitHubIssue>([
      [1, makeIssue(1, CONTRACT_BODY)],
      [9, makeIssue(9, "", "open", "")], // empty body + empty title -> SKIPPED
    ]);
    const { analyst, runner } = makeHarness(issues, "analyze-test-4");

    const report = await analyst.analyzeIssues({
      epicRef: null,
      requestedRefs: [1, 9],
      deep: true,
    });

    // Only #1 refines; #9 is SKIPPED and never reaches the refiner.
    expect(report.refinerSessions).toBe(1);
    expect(runner.requests).toHaveLength(1);
    expect(report.executable).toEqual([1]);
    expect(report.needsWork).toEqual([]);
    expect(report.scope.analyzed).toBe(1);
    expect(report.scope.totalIssues).toBe(2);
    const skipped = report.issues.find((r) => r.issueNumber === 9);
    expect(skipped?.classification).toBe("SKIPPED");
  });

  it("deep mode preserves screen BLOCKED even when the gate reports READY", async () => {
    // Issue #4 is screen-BLOCKED (open explicit dependency on #10). Under
    // --deep the refiner runs and the fake gate would report READY, but the
    // screen's BLOCKED must be authoritative so the issue never lands in
    // `executable`.
    const issues = new Map<number, GitHubIssue>([
      [4, makeIssue(4, BLOCKED_BODY)], // BLOCKED (depends on #10, open)
      [10, makeIssue(10, VAGUE_BODY, "open", "Dependency")], // dependency target, open
    ]);
    const { analyst, runner } = makeHarness(issues, "analyze-test-blocked-deep");

    const report = await analyst.analyzeIssues({
      epicRef: null,
      requestedRefs: [4],
      deep: true,
    });

    // Deep refines the analyzable issue, but it stays BLOCKED.
    expect(runner.requests).toHaveLength(1);
    expect(report.refinerSessions).toBe(1);
    const row = report.issues.find((r) => r.issueNumber === 4);
    expect(row?.screen.classification).toBe("BLOCKED");
    expect(row?.classification).toBe("BLOCKED");
    expect(report.executable).toEqual([]);
    expect(report.needsWork).toEqual([4]);
  });

  it("summary counts match the classified rows", async () => {
    const issues = new Map<number, GitHubIssue>([
      [1, makeIssue(1, CONTRACT_BODY)], // READY
      [2, makeIssue(2, CANDIDATE_BODY)], // -> READY
      [3, makeIssue(3, VAGUE_BODY)], // NEEDS_REFINEMENT
      [4, makeIssue(4, BLOCKED_BODY)], // BLOCKED
      [5, makeIssue(5, AMBIGUOUS_BODY)], // AMBIGUOUS
      [10, makeIssue(10, VAGUE_BODY, "open", "Dependency")],
    ]);
    const { analyst } = makeHarness(issues, "analyze-test-5");

    const report = await analyst.analyzeIssues({
      epicRef: null,
      requestedRefs: [1, 2, 3, 4, 5],
    });

    expect(report.summary).toEqual({
      ready: 2,
      needsRefinement: 1,
      blocked: 1,
      ambiguous: 1,
      skipped: 0,
      unresolved: 0,
    });
  });
});
