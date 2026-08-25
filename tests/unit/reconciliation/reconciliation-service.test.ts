import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import type { ReconcilerResult } from "../../../src/domain/contracts.js";
import { GitHubError } from "../../../src/github/github-adapter.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { PiRunError } from "../../../src/pi/pi-runner.js";
import type { PiExecution, PiRunRequest } from "../../../src/pi/pi-runner.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ReconciliationService } from "../../../src/reconciliation/reconciliation-service.js";
import type { ReconcilerRunner } from "../../../src/reconciliation/reconciliation-service.js";

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
  commands: { setup: [], verify: ["npm test"] },
  agents: {},
  agentPolicy: { allowedCommands: [], protectedPaths: [], allowNetwork: false },
  budgets: {
    refiner: { timeoutMinutes: 5 },
    reconciler: { timeoutMinutes: 10 },
    implementation: { timeoutMinutes: 60, maxAttempts: 3 },
    review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
  },
  publication: { draftPr: false, issueComment: "concise", autoMerge: false },
  reconciliation: {},
};

const reconcilerModel: ResolvedRoleModel = {
  model: "anthropic/claude-haiku",
  thinking: "high",
  source: "repository",
};

function makeIssue(number: number, title: string, body: string): GitHubIssue {
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

const EPIC = makeIssue(
  12,
  "Authentication overhaul",
  "- [ ] #15 OAuth callback\n- [ ] #16 Create user from GitHub identity",
);
const ISSUE_15 = makeIssue(15, "OAuth callback", "Handles the GitHub OAuth callback");
const ISSUE_16 = makeIssue(16, "Create user from GitHub identity", "Creates the user row");

class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];
  private readonly issues = new Map<number, GitHubIssue>([
    [12, EPIC],
    [15, ISSUE_15],
    [16, ISSUE_16],
  ]);

  async getIssue(number: number): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) {
      throw new GitHubError(`failed to fetch issue #${number}`, { cause: { status: 404 } });
    }
    return issue;
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

function fakePi(result: ReconcilerResult): ReconcilerRunner {
  return {
    async run(): Promise<PiExecution> {
      return {
        result,
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        resultPath: "/tmp/result.json",
        sessionDir: "/tmp/session",
      };
    },
  };
}

let capturedPrompt: string;
function capturePi(): ReconcilerRunner {
  return {
    async run(request): Promise<PiExecution> {
      capturedPrompt = request.prompt;
      return {
        result: { coverage: [], patches: [] },
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        resultPath: "/tmp/result.json",
        sessionDir: "/tmp/session",
      };
    },
  };
}

const dirs: string[] = [];
function makeService(pi: ReconcilerRunner, github: GitHubPort = new FakeGitHub()) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "autopilot-reconcile-"));
  dirs.push(dataDir);
  const paths = appPaths(dataDir);
  const artifacts = new ArtifactStore(paths);
  const service = new ReconciliationService({
    repository,
    config,
    github,
    pi,
    artifacts,
    paths,
    reconcilerModel,
    analysisId: () => "reconcile-test",
    now: () => "2026-08-22T00:00:00Z",
  });
  return { service, dataDir, paths, artifacts };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ReconciliationService.reconcile", () => {
  it("produces a coverage map and policy-classified patches from a valid reconciler result", async () => {
    const { service } = makeService(
      fakePi({
        coverage: [
          {
            requirementId: "REQ-AUTH-001",
            description: "Users can log in via GitHub",
            epic: 12,
            issues: [15],
            status: "covered",
            evidence: "issue #15",
          },
          {
            requirementId: "REQ-AUTH-009",
            description: "Admins can revoke sessions",
            epic: 12,
            issues: [],
            status: "missing",
            evidence: "no matching issue",
          },
        ],
        patches: [
          { type: "KEEP", issue: 15, reason: "correct as-is" },
          {
            type: "ENRICH_ISSUE",
            issue: 16,
            reason: "missing acceptance criteria",
            patch: {
              goal: "Create a user record from a verified GitHub identity",
              sourceRequirements: ["REQ-AUTH-004"],
              acceptanceCriteria: ["A first login creates exactly one user row"],
              constraints: [],
              nonGoals: [],
              validation: ["npm test -- auth"],
              relevantAreas: ["src/auth/"],
            },
          },
        ],
      }),
    );

    const report = await service.reconcile(12, []);

    expect(report.epicRef).toBe(12);
    expect(report.coverage).toHaveLength(2);
    expect(report.summary).toMatchObject({
      requirementsCovered: 1,
      requirementsMissing: 1,
      requirementsTotal: 2,
    });
    expect(report.patches).toContainEqual(
      expect.objectContaining({ type: "KEEP", issue: 15, policy: "requires-approval" }),
    );
    expect(report.patches).toContainEqual(
      expect.objectContaining({ type: "ENRICH_ISSUE", issue: 16, policy: "auto-safe" }),
    );
  });

  it("passes through a NEEDS_HUMAN patch the reconciler raised for an oversized issue, classified requires-approval", async () => {
    const { service } = makeService(
      fakePi({
        coverage: [],
        patches: [
          {
            type: "NEEDS_HUMAN",
            issue: 16,
            ambiguityType: "ENGINEERING",
            reason:
              "issue #16 bundles three independent outcomes (create user, link identity, send welcome email) into one issue",
            questions: [
              {
                question: "Should this be split into three issues, or is bundling them intentional?",
                recommendation: "Split into three issues — each outcome is independently testable and shippable.",
              },
            ],
          },
        ],
      }),
    );

    const report = await service.reconcile(12, []);

    expect(report.patches).toContainEqual(
      expect.objectContaining({
        type: "NEEDS_HUMAN",
        issue: 16,
        ambiguityType: "ENGINEERING",
        policy: "requires-approval",
      }),
    );
  });

  it("downgrades an ENRICH_ISSUE patch to KEEP when the issue already carries the identical section", async () => {
    const enrichment = {
      goal: "Create a user record from a verified GitHub identity",
      sourceRequirements: ["REQ-AUTH-004"],
      acceptanceCriteria: ["A first login creates exactly one user row"],
      constraints: [],
      nonGoals: [],
      validation: ["npm test -- auth"],
      relevantAreas: ["src/auth/"],
    };
    const { upsertReconciliationSection } = await import(
      "../../../src/reconciliation/managed-section.js"
    );
    const alreadyEnriched = new (class extends FakeGitHub {
      override async getIssue(number: number): Promise<GitHubIssue> {
        const issue = await super.getIssue(number);
        if (number === 16) {
          return { ...issue, body: upsertReconciliationSection(issue.body, enrichment) };
        }
        return issue;
      }
    })();

    const { service } = makeService(
      fakePi({
        coverage: [],
        patches: [
          { type: "ENRICH_ISSUE", issue: 16, reason: "missing acceptance criteria", patch: enrichment },
        ],
      }),
      alreadyEnriched,
    );

    const report = await service.reconcile(12, []);
    expect(report.patches).toContainEqual(
      expect.objectContaining({ type: "KEEP", issue: 16 }),
    );
  });

  it("produces a NEEDS_HUMAN patch for an epic checklist ref that cannot be fetched", async () => {
    const withMissingRef = new (class extends FakeGitHub {
      override async getIssue(number: number): Promise<GitHubIssue> {
        if (number === 12) {
          return makeIssue(12, "Authentication overhaul", "- [ ] #15 OAuth callback\n- [ ] #999 Gone");
        }
        return super.getIssue(number);
      }
    })();

    const { service } = makeService(fakePi({ coverage: [], patches: [] }), withMissingRef);
    const report = await service.reconcile(12, []);

    expect(report.patches).toContainEqual(
      expect.objectContaining({
        type: "NEEDS_HUMAN",
        issue: null,
        ambiguityType: "MISSING_CONTEXT",
      }),
    );
  });

  it("propagates a PiRunError from the reconciler session without swallowing it", async () => {
    const failing: ReconcilerRunner = {
      async run(): Promise<PiExecution> {
        throw new PiRunError("invalid reconciler result: patches: Required", "reconciler", {
          stdout: "",
          stderr: "",
          resultPath: "/tmp/result.json",
        });
      },
    };
    const { service } = makeService(failing);
    await expect(service.reconcile(12, [])).rejects.toThrow(PiRunError);
  });

  it("never calls a GitHub mutation method", async () => {
    const github = new FakeGitHub();
    const { service } = makeService(fakePi({ coverage: [], patches: [] }), github);
    await service.reconcile(12, []);
    expect(github.mutationCalls).toEqual([]);
  });

  it("produces a NEEDS_HUMAN patch for a prose-only checklist line in the epic body", async () => {
    const withProseLine = new (class extends FakeGitHub {
      override async getIssue(number: number): Promise<GitHubIssue> {
        if (number === 12) {
          return makeIssue(
            12,
            "Authentication overhaul",
            "- [ ] #15 OAuth callback\n- [ ] #16 Create user from GitHub identity\n- [ ] Some prose-only thing without a ref",
          );
        }
        return super.getIssue(number);
      }
    })();

    const { service } = makeService(fakePi({ coverage: [], patches: [] }), withProseLine);
    const report = await service.reconcile(12, []);

    expect(report.patches).toContainEqual(
      expect.objectContaining({
        type: "NEEDS_HUMAN",
        issue: null,
        ambiguityType: "MISSING_CONTEXT",
        reason: expect.stringContaining("checklist line 3"),
      }),
    );
  });

  it("computes summary counts across all four coverage statuses, counting implemented alongside covered", async () => {
    const { service } = makeService(
      fakePi({
        coverage: [
          {
            requirementId: "REQ-A-001",
            description: "requirement one",
            epic: 12,
            issues: [15],
            status: "covered",
            evidence: "e1",
          },
          {
            requirementId: "REQ-A-002",
            description: "requirement two",
            epic: 12,
            issues: [15],
            status: "partial",
            evidence: "e2",
          },
          {
            requirementId: "REQ-A-003",
            description: "requirement three",
            epic: 12,
            issues: [],
            status: "missing",
            evidence: "e3",
          },
          {
            requirementId: "REQ-A-004",
            description: "requirement four",
            epic: 12,
            issues: [16],
            status: "implemented",
            evidence: "e4",
          },
        ],
        patches: [],
      }),
    );

    const report = await service.reconcile(12, []);

    expect(report.summary).toMatchObject({
      requirementsCovered: 2,
      requirementsPartial: 1,
      requirementsMissing: 1,
      requirementsTotal: 4,
    });
  });

  it("persists the report to the artifact store", async () => {
    const { service, artifacts } = makeService(fakePi({ coverage: [], patches: [] }));
    const report = await service.reconcile(12, []);
    const persisted = await artifacts.readJson("reconcile-test", "reconciliation-report.json");
    expect(persisted).toEqual(report);
  });

  it("passes apply declines from the latest apply report into the reconciler prompt", async () => {
    capturedPrompt = "";
    const { service, artifacts } = makeService(capturePi());
    // Epic #12 has issue #15.
    // Write a prior apply report for epic #12 with a user decline, plus the index pointer.
    await artifacts.writeJson(
      "reconcile-test",
      "reconciliation-apply.json",
      {
        repository,
        analysisId: "reconcile-test",
        appliedAt: "2026-08-22T00:00:00Z",
        staleness: { staleAgeHours: 1, guardApplied: true, overriddenByForce: false },
        entries: [
          { patchType: "ENRICH_ISSUE", targetIssue: 15, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "enrich #15", declineReason: "waiting on product decision" },
        ],
        summary: { applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0, skippedUser: 1, failed: 0, previewed: 0 },
      },
    );
    await artifacts.writeLatestApply("acme", "widgets", 12, {
      analysisId: "reconcile-test",
      epicRef: 12,
      repository,
      appliedAt: "2026-08-22T00:00:00Z",
    });

    await service.reconcile(12, []);
    expect(capturedPrompt).toContain("Apply steering context");
    expect(capturedPrompt).toContain("ENRICH_ISSUE #15");
    expect(capturedPrompt).toContain("waiting on product decision");
  });

  it("builds the prompt without steering when no apply index exists for the epic", async () => {
    capturedPrompt = "";
    const { service } = makeService(capturePi());
    await service.reconcile(12, []);
    expect(capturedPrompt).not.toContain("Apply steering context");
  });
});
