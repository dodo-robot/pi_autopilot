import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyReport } from "../../../src/domain/apply.js";
import type { GitHubIssue, GitHubPort, IssueCommentRef, PullRequestRef } from "../../../src/github/github-adapter.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { ApplyService, type ApplyOptions } from "../../../src/reconciliation/apply-service.js";
import type { ReconciliationReport } from "../../../src/reconciliation/reconciliation-service.js";
import { upsertReconciliationSection } from "../../../src/reconciliation/managed-section.js";

const repository = { owner: "acme", repo: "widgets" };
const analysisId = "reconcile-1-12";
const now = "2026-08-23T00:00:00.000Z";
const opts: ApplyOptions = { yes: true, force: false };

function enrichment(goal: string) {
  return {
    goal,
    sourceRequirements: [] as string[],
    acceptanceCriteria: [] as string[],
    constraints: [] as string[],
    nonGoals: [] as string[],
    validation: [] as string[],
    relevantAreas: [] as string[],
  };
}

function makeIssue(number: number, title: string, body: string): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-23T00:00:00Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

function epic(): GitHubIssue {
  return makeIssue(12, "Epic", "- [ ] #15 OAuth\n- [ ] #16 Session storage\n");
}

function issue15(): GitHubIssue {
  return makeIssue(15, "OAuth callback", "Handles OAuth");
}

function baseReport(patches: ReconciliationReport["patches"]): ReconciliationReport {
  return {
    repository,
    epicRef: 12,
    requirementsPaths: [],
    generatedAt: now,
    analysisId,
    coverage: [],
    patches,
    summary: {
      requirementsCovered: 0,
      requirementsPartial: 0,
      requirementsMissing: 0,
      requirementsTotal: 0,
      patchCounts: {},
    },
  };
}

class FakeGitHub implements GitHubPort {
  readonly created: Array<{ title: string; body: string; labels: string[] }> = [];
  readonly updated: Array<{ number: number; body: string }> = [];
  issues = new Map<number, GitHubIssue>();
  failFetchFor = new Set<number>();

  async getIssue(number: number): Promise<GitHubIssue> {
    if (this.failFetchFor.has(number)) throw new Error(`fetch fail ${number}`);
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`missing #${number}`);
    return issue;
  }

  async findIssueByTitle(title: string): Promise<GitHubIssue | null> {
    const desired = title.trim().toLowerCase();
    return [...this.issues.values()].find((issue) => issue.title.trim().toLowerCase() === desired) ?? null;
  }

  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    this.updated.push({ number, body });
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`missing #${number}`);
    const next = { ...issue, body };
    this.issues.set(number, next);
    return next;
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<GitHubIssue> {
    this.created.push(input);
    const number = Math.max(0, ...this.issues.keys()) + 1;
    const issue = makeIssue(number, input.title, input.body);
    this.issues.set(number, issue);
    return issue;
  }

  async createIssueComment(): Promise<void> {
    throw new Error("not called");
  }

  async findPullRequestByHead(): Promise<PullRequestRef | null> {
    return null;
  }

  async createPullRequest(): Promise<PullRequestRef> {
    throw new Error("not called");
  }

  async findIssueCommentByMarker(): Promise<IssueCommentRef | null> {
    return null;
  }

  async ensureLabel(): Promise<void> {}
}

class FakeGitHubWithFail extends FakeGitHub {
  throwOnUpdateIndex: number[] = [];

  override async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    if (this.throwOnUpdateIndex.includes(this.updated.length)) {
      this.throwOnUpdateIndex = this.throwOnUpdateIndex.filter((index) => index !== this.updated.length);
      throw new Error("github 409");
    }
    return super.updateIssueBody(number, body);
  }
}

describe("ApplyService.apply", () => {
  let tmp: string;
  let artifacts: ArtifactStore;
  let github: FakeGitHub;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "apply-svc-"));
    artifacts = new ArtifactStore(appPaths(tmp));
    github = new FakeGitHub();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function service(extra: Partial<ConstructorParameters<typeof ApplyService>[0]> = {}) {
    return new ApplyService({
      github,
      artifacts,
      repository,
      now: () => now,
      confirmMenu: async () => "apply",
      ...extra,
    });
  }

  it("applies auto-safe patches in CREATE then ENRICH then ADD order and writes an artifact", async () => {
    github.issues.set(12, epic());
    github.issues.set(15, issue15());
    github.issues.set(16, makeIssue(16, "Session storage", "Implement sessions"));

    const report = baseReport([
      { type: "KEEP", issue: 15, reason: "fine", policy: "requires-approval" },
      { type: "ADD_DEPENDENCY", issue: 15, dependsOn: 16, reason: "needs #16", policy: "auto-safe" },
      { type: "MARK_STALE", issue: 16, reason: "superseded", policy: "requires-approval" },
      {
        type: "ENRICH_ISSUE",
        issue: 15,
        patch: { ...enrichment("Add OAuth refresh"), acceptanceCriteria: ["refresh"] },
        reason: "missing criteria",
        policy: "auto-safe",
      },
      {
        type: "CREATE_ISSUE",
        epic: 12,
        spec: { title: "New widget", enrichment: enrichment("Create new widget") },
        reason: "missing",
        policy: "auto-safe",
      },
    ]);
    await artifacts.writeJson(analysisId, "reconciliation-report.json", report);

    const result = await service().apply(analysisId, opts);

    const firstWrite = github.updated[0];
    expect(firstWrite?.number).toBe(12);
    expect(firstWrite?.body).toContain("- [ ] #17 New widget");
    expect(github.created[0]?.title).toBe("New widget");

    const enrichWrite = github.updated.find(
      (u) => u.number === 15 && u.body.includes("autopilot-reconciliation"),
    );
    expect(enrichWrite).toBeDefined();
    expect(enrichWrite?.body).toContain("Add OAuth refresh");

    const depWrite = github.updated.find(
      (u) => u.number === 15 && u.body.includes("Depends on:"),
    );
    expect(depWrite).toBeDefined();
    expect(depWrite?.body).toContain("autopilot-reconciliation");

    expect(result.summary.applied).toBe(3);
    expect(result.entries.find((e) => e.patchType === "MARK_STALE")?.outcome).toEqual({
      status: "skipped",
      skippedBy: "requires-approval",
    });
    expect(result.entries.map((e) => e.patchType)).toEqual([
      "CREATE_ISSUE",
      "ENRICH_ISSUE",
      "ADD_DEPENDENCY",
      "KEEP",
      "MARK_STALE",
    ]);

    const stored = await artifacts.readJson<ApplyReport>(analysisId, "reconciliation-apply.json");
    expect(stored).toEqual(result);
  });

  it("links a matching unlinked live issue by title instead of creating a duplicate", async () => {
    github.issues.set(12, epic());
    github.issues.set(21, makeIssue(21, "New widget", "Already exists outside the epic"));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "CREATE_ISSUE",
          epic: 12,
          spec: { title: "new widget", enrichment: enrichment("Create new widget") },
          reason: "missing",
          policy: "auto-safe",
        },
      ]),
    );

    const result = await service().apply(analysisId, opts);

    expect(github.created).toHaveLength(0);
    expect(github.updated).toEqual([
      { number: 12, body: expect.stringContaining("- [ ] #21 New widget") },
    ]);
    expect(result.summary.applied).toBe(1);
    expect(result.entries[0]).toMatchObject({
      detail: "linked existing #21 \"New widget\" to epic #12",
      appliedIssueNumber: 21,
      outcome: { status: "applied" },
    });
  });

  it("previews a CREATE_ISSUE title match as linkback, not creation, before prompting", async () => {
    github.issues.set(12, epic());
    github.issues.set(21, makeIssue(21, "New widget", "Already exists outside the epic"));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "CREATE_ISSUE",
          epic: 12,
          spec: { title: "New widget", enrichment: enrichment("Create new widget") },
          reason: "missing",
          policy: "auto-safe",
        },
      ]),
    );
    const previews: string[] = [];
    let prompts = 0;

    const result = await service({
      onPreview: (text) => previews.push(text),
      confirmMenu: async () => {
        prompts += 1;
        return "apply";
      },
    }).apply(analysisId, { yes: false });

    expect(prompts).toBe(1);
    expect(previews).toEqual([
      "existing issue: #21 New widget\nwill append to epic #12 checklist",
    ]);
    expect(previews[0]).not.toContain("title: New widget");
    expect(github.created).toHaveLength(0);
    expect(result.entries[0]).toMatchObject({
      appliedIssueNumber: 21,
      outcome: { status: "applied" },
    });
  });

  it("retries a create whose issue was created but epic linkback failed without duplicating it", async () => {
    const failingGithub = new FakeGitHubWithFail();
    github = failingGithub;
    github.issues.set(12, epic());
    failingGithub.throwOnUpdateIndex = [0];
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "CREATE_ISSUE",
          epic: 12,
          spec: { title: "New widget", enrichment: enrichment("Create new widget") },
          reason: "missing",
          policy: "auto-safe",
        },
      ]),
    );

    const first = await service({ github }).apply(analysisId, opts);
    expect(first.summary.failed).toBe(1);
    expect(first.entries[0]).toMatchObject({
      appliedIssueNumber: 13,
      outcome: { status: "failed" },
    });
    expect(github.created).toHaveLength(1);
    expect(github.issues.get(12)?.body).not.toContain("#13 New widget");

    const second = await service({ github }).apply(analysisId, opts);

    expect(second.summary.applied).toBe(1);
    expect(second.entries[0]).toMatchObject({
      appliedIssueNumber: 13,
      outcome: { status: "applied" },
    });
    expect(github.created).toHaveLength(1);
    expect(github.issues.get(12)?.body).toContain("- [ ] #13 New widget");
  });

  it("skips an auto-safe patch whose target already reflects the change", async () => {
    github.issues.set(
      15,
      makeIssue(15, "OAuth", upsertReconciliationSection("Handles OAuth", enrichment("Add OAuth refresh"))),
    );
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: enrichment("Add OAuth refresh"),
          reason: "x",
          policy: "auto-safe",
        },
      ]),
    );

    const result = await service().apply(analysisId, opts);

    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "idempotent" });
    expect(github.updated).toHaveLength(0);
  });

  it("continues-on-error and records failed patches while applying later patches", async () => {
    const failingGithub = new FakeGitHubWithFail();
    github = failingGithub;
    github.issues.set(12, epic());
    github.issues.set(15, issue15());
    github.issues.set(16, makeIssue(16, "Session storage", "Implement sessions"));
    failingGithub.throwOnUpdateIndex = [1];
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "CREATE_ISSUE",
          epic: 12,
          spec: { title: "New widget", enrichment: enrichment("Create new widget") },
          reason: "missing",
          policy: "auto-safe",
        },
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: enrichment("Add OAuth refresh"),
          reason: "missing criteria",
          policy: "auto-safe",
        },
        { type: "ADD_DEPENDENCY", issue: 15, dependsOn: 16, reason: "needs #16", policy: "auto-safe" },
      ]),
    );

    const result = await service({ github }).apply(analysisId, opts);

    expect(result.summary.applied).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.entries.map((e) => e.outcome.status)).toEqual(["applied", "failed", "applied"]);
    expect(github.updated.some((u) => u.number === 15 && u.body.includes("Depends on:"))).toBe(true);
  });

  it("applies the current and remaining auto-safe patches when interactive answer is all", async () => {
    github.issues.set(15, issue15());
    github.issues.set(16, makeIssue(16, "Session storage", "Implement sessions"));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: enrichment("Add OAuth refresh"),
          reason: "missing criteria",
          policy: "auto-safe",
        },
        { type: "ADD_DEPENDENCY", issue: 15, dependsOn: 16, reason: "needs #16", policy: "auto-safe" },
      ]),
    );
    const previews: string[] = [];
    let promptCount = 0;

    const result = await service({
      onPreview: (text) => previews.push(text),
      confirmMenu: async () => {
        promptCount += 1;
        return "all";
      },
    }).apply(analysisId, { yes: false });

    expect(promptCount).toBe(1);
    expect(previews).toHaveLength(1);
    expect(result.summary.applied).toBe(2);
    expect(result.entries.map((entry) => entry.outcome.status)).toEqual(["applied", "applied"]);
    expect(github.updated.some((u) => u.body.includes("Depends on:"))).toBe(true);
  });

  it("records user skips and aborts in interactive mode without applying aborted patches", async () => {
    github.issues.set(15, issue15());
    github.issues.set(16, makeIssue(16, "Session storage", "Implement sessions"));
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: enrichment("Add OAuth refresh"),
          reason: "missing criteria",
          policy: "auto-safe",
        },
        { type: "ADD_DEPENDENCY", issue: 15, dependsOn: 16, reason: "needs #16", policy: "auto-safe" },
      ]),
    );
    const answers: Array<"skip" | "abort"> = ["skip", "abort"];
    const previews: string[] = [];

    const result = await service({
      onPreview: (text) => previews.push(text),
      confirmMenu: async () => answers.shift() ?? "abort",
    }).apply(analysisId, { yes: false });

    expect(result.aborted).toBe(true);
    expect(result.summary.skippedUser).toBe(1);
    expect(result.summary.applied).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(previews).toHaveLength(2);
    expect(github.updated).toHaveLength(0);
  });

  it("renders previews without mutation when previewOnly is set", async () => {
    github.issues.set(15, issue15());
    const previews: string[] = [];
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      baseReport([
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: enrichment("Add OAuth refresh"),
          reason: "missing criteria",
          policy: "auto-safe",
        },
      ]),
    );

    const result = await service({ onPreview: (text) => previews.push(text) }).apply(analysisId, {
      yes: true,
      previewOnly: true,
    });

    expect(result.summary.previewed).toBe(1);
    expect(result.summary.skippedUser).toBe(0);
    expect(result.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "preview-only" });
    expect(previews[0]).toContain("Add OAuth refresh");
    expect(github.updated).toHaveLength(0);
  });

  it("enforces the report staleness guard unless force is set", async () => {
    github.issues.set(15, issue15());
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      {
        ...baseReport([
          {
            type: "ENRICH_ISSUE",
            issue: 15,
            patch: enrichment("Add OAuth refresh"),
            reason: "missing criteria",
            policy: "auto-safe",
          },
        ]),
        generatedAt: "2026-08-01T00:00:00.000Z",
      },
    );

    await expect(service().apply(analysisId, opts)).rejects.toThrow("re-run reconcile or pass --force");
    await expect(service().apply(analysisId, { ...opts, force: true })).resolves.toMatchObject({
      staleness: { overriddenByForce: true },
    });
  });

  it("treats zero stale hours as an active zero-hour guard and disables only null/negative", async () => {
    github.issues.set(15, issue15());
    await artifacts.writeJson(
      analysisId,
      "reconciliation-report.json",
      {
        ...baseReport([
          {
            type: "ENRICH_ISSUE",
            issue: 15,
            patch: enrichment("Add OAuth refresh"),
            reason: "missing criteria",
            policy: "auto-safe",
          },
        ]),
        generatedAt: "2026-08-22T23:59:00.000Z",
      },
    );

    await expect(service({ reportStaleAfterHours: 0 }).apply(analysisId, opts)).rejects.toThrow(
      "re-run reconcile or pass --force",
    );
    await expect(service({ reportStaleAfterHours: null }).apply(analysisId, opts)).resolves.toMatchObject({
      staleness: { guardApplied: false },
    });
    await expect(service({ reportStaleAfterHours: -1 }).apply(analysisId, opts)).resolves.toMatchObject({
      staleness: { guardApplied: false },
    });
  });
});
