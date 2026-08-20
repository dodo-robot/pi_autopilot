import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import type {
  RefinerResult,
  TaskDraft,
} from "../../../src/domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import {
  computeReadinessGaps,
  ReadinessService,
  sha256,
} from "../../../src/readiness/readiness-service.js";
import type { RefinerRunner } from "../../../src/readiness/readiness-service.js";

const repository: RepositoryContext = {
  root: "/tmp/fake-repo",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config: AutopilotConfig = {
  version: 1,
  workspace: {
    baseBranch: "main",
    branchPrefix: "autopilot/",
    requireCleanCheckout: true,
    retainBlockedWorktree: true,
  },
  commands: { setup: ["npm ci"], verify: ["npm test"] },
  agents: {},
  agentPolicy: {
    allowedCommands: ["npm"],
    protectedPaths: [],
    allowNetwork: false,
  },
  budgets: {
    implementation: { timeoutMinutes: 60, maxAttempts: 3 },
    review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
  },
  publication: { draftPr: false, issueComment: "concise", autoMerge: false },
};

const issue: GitHubIssue = {
  number: 42,
  nodeId: "I_42",
  title: "Add token refresh validation",
  body: "Refresh tokens must be rejected when expired.\n\n## Acceptance criteria\n- [ ] A refresh with an expired token returns 401",
  updatedAt: "2026-08-18T00:00:00Z",
  state: "open",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
};

const refinerModel: ResolvedRoleModel = {
  model: "anthropic/claude-haiku",
  thinking: "high",
  source: "repository",
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

function readyResult(draft: TaskDraft = completeDraft()): RefinerResult {
  return {
    outcome: "READY",
    taskDraft: draft,
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
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
  readonly requests: PiRunRequest[] = [];
  constructor(private readonly result: RefinerResult) {}

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

function makeService(
  result: RefinerResult,
  githubIssue: GitHubIssue = issue,
): {
  service: ReadinessService;
  runner: FakeRefinerRunner;
  github: FakeGitHub;
  dataDir: string;
} {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-readiness-"));
  tempDirs.push(dataDir);
  const paths = appPaths(dataDir);
  const github = new FakeGitHub(githubIssue);
  const runner = new FakeRefinerRunner(result);
  const service = new ReadinessService({
    repository,
    config,
    github,
    pi: runner,
    artifacts: new ArtifactStore(paths),
    paths,
    refinerModel,
    analysisId: () => "check-test-42",
    now: () => "2026-08-18T00:00:00.000Z",
  });
  return { service, runner, github, dataDir };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("ReadinessService.check", () => {
  it("classifies a complete issue as ready and promotes a snapshot", async () => {
    const { service, runner, github } = makeService(readyResult());
    const report = await service.check(42);

    expect(report.status).toBe("READY");
    expect(report.outcome).toBe("READY");
    expect(report.gaps).toEqual([]);
    expect(report.snapshot).not.toBeNull();
    expect(report.snapshot?.objective).toBe("Implement token refresh validation");
    expect(report.snapshot?.acceptanceCriteria).toHaveLength(1);

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.role).toBe("refiner");
    expect(runner.requests[0]?.prompt).toContain("acme/widgets");
    expect(github.mutationCalls).toEqual([]);
  });

  it("downgrades a refiner READY outcome when acceptance criteria are missing", async () => {
    const draft = completeDraft();
    draft.acceptanceCriteria = [];
    const { service, github } = makeService(readyResult(draft));

    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.outcome).toBe("READY");
    expect(report.snapshot).toBeNull();
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "NO_TESTABLE_ACCEPTANCE_CRITERIA" }),
    );
    expect(github.mutationCalls).toEqual([]);
  });

  it("flags an empty objective", async () => {
    const draft = completeDraft();
    draft.objective = "   ";
    const { service } = makeService(readyResult(draft));
    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "NO_OBJECTIVE" }),
    );
  });

  it("flags missing expected behavior", async () => {
    const draft = completeDraft();
    draft.expectedBehavior = [];
    const { service } = makeService(readyResult(draft));
    const report = await service.check(42);

    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "NO_EXPECTED_BEHAVIOR" }),
    );
  });

  it("flags missing validation expectations", async () => {
    const draft = completeDraft();
    draft.validation = [];
    const { service } = makeService(readyResult(draft));
    const report = await service.check(42);

    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "NO_VALIDATION" }),
    );
  });

  it("flags manual-only validation expectations", async () => {
    const draft = completeDraft();
    draft.validation = ["Manually verify the login flow in the browser"];
    const { service } = makeService(readyResult(draft));
    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "MANUAL_ONLY_VALIDATION" }),
    );
  });

  it("flags unsatisfied dependencies", async () => {
    const draft = completeDraft();
    draft.dependencies = [{ issue: 7, satisfied: false }];
    const result: RefinerResult = {
      outcome: "READY",
      taskDraft: draft,
      missingInformation: [],
      dependencies: [{ issue: 7, satisfied: false }],
      ambiguities: [],
    };
    const { service } = makeService(result);
    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "UNSATISFIED_DEPENDENCIES" }),
    );
  });

  it("flags unresolved product ambiguity", async () => {
    const result: RefinerResult = {
      outcome: "PRODUCT_AMBIGUITY",
      taskDraft: completeDraft(),
      missingInformation: [],
      dependencies: [],
      ambiguities: [
        { type: "PRODUCT", description: "Which business rule should apply?" },
      ],
    };
    const { service } = makeService(result);
    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "PRODUCT_AMBIGUITY" }),
    );
    expect(report.ambiguities).toEqual([
      { type: "PRODUCT", description: "Which business rule should apply?" },
    ]);
  });

  it("flags a failed refiner without crashing", async () => {
    const result: RefinerResult = {
      outcome: "FAILED",
      reason: "provider unavailable",
      taskDraft: completeDraft(),
    };
    const { service } = makeService(result);
    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "REFINER_FAILED" }),
    );
    expect(report.missingInformation).toEqual([]);
    expect(report.ambiguities).toEqual([]);
  });

  it("flags missing information reported by the refiner", async () => {
    const result: RefinerResult = {
      outcome: "NEEDS_REFINEMENT",
      taskDraft: completeDraft(),
      missingInformation: ["Acceptance criteria unspecified"],
      dependencies: [],
      ambiguities: [],
      suggestions: ["Add acceptance criteria"],
    };
    const { service } = makeService(result);
    const report = await service.check(42);

    expect(report.status).toBe("NEEDS_REFINEMENT");
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "INCOMPLETE_INFORMATION" }),
    );
    expect(report.suggestions).toEqual(["Add acceptance criteria"]);
  });

  it("forces the computed source body hash into the report and snapshot", async () => {
    const { service } = makeService(readyResult());
    const report = await service.check(42);

    const expected = sha256(issue.body);
    expect(report.sourceBodyHash).toBe(expected);
    expect(report.snapshot?.sourceBodyHash).toBe(expected);
  });

  it("records the resolved refiner model in the report", async () => {
    const { service } = makeService(readyResult());
    const report = await service.check(42);

    expect(report.refinerModel).toEqual(refinerModel);
  });

  it("persists the report and snapshot as run-independent artifacts", async () => {
    const { service, dataDir } = makeService(readyResult());
    const report = await service.check(42);

    const paths = appPaths(dataDir);
    const store = new ArtifactStore(paths);
    const persisted = await store.readJson(report.analysisId, "readiness-report.json");
    expect(persisted.status).toBe("READY");
    expect(persisted.sourceBodyHash).toBe(sha256(issue.body));

    const snapshot = await store.readJson(report.analysisId, "task-snapshot.json");
    expect(snapshot.objective).toBe("Implement token refresh validation");
  });

  it("writes the per-issue latest-READY pointer only when the issue is READY", async () => {
    const { service, dataDir } = makeService(readyResult());
    await service.check(42);

    const paths = appPaths(dataDir);
    const store = new ArtifactStore(paths);
    const pointer = await store.readLatestReadiness(
      "acme",
      "widgets",
      42,
    );
    expect(pointer).not.toBeNull();
    expect(pointer?.analysisId).toBe("check-test-42");
    expect(pointer?.status).toBe("READY");
    expect(pointer?.issueNumber).toBe(42);
    expect(pointer?.sourceBodyHash).toBe(sha256(issue.body));
    expect(pointer?.updatedAt).toBe(issue.updatedAt);
  });

  it("does not write the per-issue pointer when the issue needs refinement", async () => {
    const draft = completeDraft();
    draft.acceptanceCriteria = [];
    const { service, dataDir } = makeService(readyResult(draft));
    await service.check(42);

    const paths = appPaths(dataDir);
    const store = new ArtifactStore(paths);
    const pointer = await store.readLatestReadiness(
      "acme",
      "widgets",
      42,
    );
    expect(pointer).toBeNull();
  });
});

describe("computeReadinessGaps", () => {
  it("returns no gaps for a complete draft with a READY outcome", () => {
    const refiner: RefinerResult = readyResult();
    expect(computeReadinessGaps(refiner, completeDraft())).toEqual([]);
  });

  it("does not flag manual-only wording in an otherwise valid command", () => {
    const refiner: RefinerResult = readyResult();
    const draft = completeDraft();
    draft.validation = ["npm test"];
    expect(computeReadinessGaps(refiner, draft)).toEqual([]);
  });

  it("flags an empty objective", () => {
    const refiner: RefinerResult = readyResult();
    const draft = completeDraft();
    draft.objective = "";
    expect(computeReadinessGaps(refiner, draft)).toContainEqual(
      expect.objectContaining({ code: "NO_OBJECTIVE" }),
    );
  });
});
