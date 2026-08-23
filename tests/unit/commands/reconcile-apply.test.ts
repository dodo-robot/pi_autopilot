import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerReconcileApplyCommand } from "../../../src/commands/reconcile-apply.js";
import type { ReconcileApplyCommandDeps } from "../../../src/commands/reconcile-apply.js";
import { ApplyReportSchema, type ApplyReport } from "../../../src/domain/apply.js";
import type { IssueEnrichment } from "../../../src/domain/reconciliation.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import type { ProcessRunner, ProcessRequest, ProcessResult } from "../../../src/platform/process-runner.js";
import { REPORT_ARTIFACT, type ApplyOptions } from "../../../src/reconciliation/apply-service.js";
import type { ReconciliationReport } from "../../../src/reconciliation/reconciliation-service.js";

const APPLIED: ApplyReport = {
  repository: { owner: "acme", repo: "widgets" },
  analysisId: "reconcile-1-12",
  appliedAt: "2026-08-23T00:00:00.000Z",
  aborted: false,
  staleness: { staleAgeHours: 0.5, guardApplied: true, overriddenByForce: false },
  entries: [],
  summary: {
    applied: 0,
    skippedRequiresApproval: 0,
    skippedIdempotent: 0,
    skippedUser: 0,
    failed: 0,
    previewed: 0,
  },
};

const FAILED: ApplyReport = {
  ...APPLIED,
  entries: [
    {
      patchType: "ENRICH_ISSUE",
      targetIssue: 12,
      policy: "auto-safe",
      detail: "enrich issue #12",
      outcome: { status: "failed", error: "boom" },
    },
  ],
  summary: { ...APPLIED.summary, failed: 1 },
};

const SECRET_REPORT: ApplyReport = {
  ...APPLIED,
  entries: [
    {
      patchType: "ENRICH_ISSUE",
      targetIssue: 12,
      policy: "auto-safe",
      detail: "body contains ghp_12345678901234567890",
      outcome: { status: "applied" },
    },
  ],
  summary: { ...APPLIED.summary, applied: 1 },
};

const dirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "autopilot-reconcile-apply-cli-"));
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, ".pi", "autopilot.yaml"),
    `version: 1
commands:
  verify:
    - npm test
reconciliation:
  reportStaleAfterHours: -1
`,
    "utf8",
  );
  dirs.push(root);
  return root;
}

function fakeRunner(root: string): ProcessRunner {
  return {
    async run(request: ProcessRequest): Promise<ProcessResult> {
      const args = request.args.join(" ");
      let stdout = "";
      if (args === "rev-parse --show-toplevel") stdout = root;
      else if (args === "remote get-url origin") stdout = "git@github.com:acme/widgets.git";
      else if (args === "status --porcelain") stdout = "";
      else if (args === "branch --show-current") stdout = "main";
      else throw new Error(`unexpected command: ${request.command} ${args}`);
      return {
        exitCode: 0,
        signal: null,
        stdout: `${stdout}\n`,
        stderr: "",
        durationMs: 1,
        timedOut: false,
      };
    },
  };
}

function makeIssue(number: number, title: string, body: string): GitHubIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title,
    body,
    updatedAt: "2026-08-23T00:00:00.000Z",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

class RecordingGitHub implements GitHubPort {
  readonly writes: string[] = [];
  private readonly issues = new Map<number, GitHubIssue>();
  private nextIssueNumber = 100;

  constructor(issues: GitHubIssue[]) {
    for (const issue of issues) this.issues.set(issue.number, { ...issue });
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`no such issue #${number}`);
    return { ...issue };
  }

  async findIssueByTitle(title: string): Promise<GitHubIssue | null> {
    const normalized = title.trim().toLowerCase();
    for (const issue of this.issues.values()) {
      if (issue.title.trim().toLowerCase() === normalized) return { ...issue };
    }
    return null;
  }

  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    const existing = await this.getIssue(number);
    const updated = { ...existing, body, updatedAt: "2026-08-23T01:00:00.000Z" };
    this.issues.set(number, updated);
    this.writes.push(`updateIssueBody:#${number}`);
    return { ...updated };
  }

  async createIssueComment(): Promise<void> {
    this.writes.push("createIssueComment");
  }

  async findPullRequestByHead(): Promise<null> {
    return null;
  }

  async createPullRequest(): Promise<never> {
    this.writes.push("createPullRequest");
    throw new Error("not used");
  }

  async findIssueCommentByMarker(): Promise<null> {
    return null;
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue> {
    const issue = makeIssue(this.nextIssueNumber++, input.title, input.body);
    this.issues.set(issue.number, issue);
    this.writes.push(`createIssue:${input.title}`);
    return { ...issue };
  }

  async ensureLabel(): Promise<void> {
    this.writes.push("ensureLabel");
  }
}

const fakeGithub: GitHubPort = new RecordingGitHub([]);

function makeCommand(overrides: {
  report?: ApplyReport;
  error?: Error;
  isTTY?: boolean;
} = {}) {
  const root = tempRoot();
  const program = new Command();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  let capturedAnalysisId: string | undefined;
  let capturedOptions: ApplyOptions | undefined;
  let createApplyCalled = false;

  const deps: ReconcileApplyCommandDeps = {
    cwd: root,
    processRunner: fakeRunner(root),
    createGitHub: async () => fakeGithub,
    createApplyService: () => {
      createApplyCalled = true;
      return {
        apply: async (analysisId: string, opts: ApplyOptions) => {
          capturedAnalysisId = analysisId;
          capturedOptions = opts;
          if (overrides.error !== undefined) throw overrides.error;
          return overrides.report ?? APPLIED;
        },
      };
    },
    stdout: (text: string) => {
      stdout.push(text);
    },
    stderr: (text: string) => {
      stderr.push(text);
    },
    setExitCode: (code: number) => {
      exitCode = code;
    },
    isTTY: overrides.isTTY ?? false,
  };

  registerReconcileApplyCommand(program, deps);
  return {
    program,
    stdout,
    stderr,
    exitCode: () => exitCode,
    capturedAnalysisId: () => capturedAnalysisId,
    capturedOptions: () => capturedOptions,
    createApplyCalled: () => createApplyCalled,
  };
}

async function run(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(["reconcile-apply", ...args], { from: "user" });
}

function makeRealApplyCommand(github: GitHubPort, overrides: { isTTY?: boolean } = {}) {
  const root = tempRoot();
  const dataDir = path.join(root, "data");
  const program = new Command();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;

  registerReconcileApplyCommand(program, {
    cwd: root,
    dataDir,
    processRunner: fakeRunner(root),
    createGitHub: async () => github,
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    setExitCode: (code: number) => {
      exitCode = code;
    },
    isTTY: overrides.isTTY ?? false,
  });

  return { program, dataDir, stdout, stderr, exitCode: () => exitCode };
}

async function seedStoredReport(
  dataDir: string,
  report: ReconciliationReport,
): Promise<void> {
  await new ArtifactStore(appPaths(dataDir)).writeJson(
    report.analysisId,
    REPORT_ARTIFACT,
    report,
  );
}

function parseStdoutReport(stdout: string[]): ApplyReport {
  return ApplyReportSchema.parse(JSON.parse(stdout.join("\n")));
}

const ENRICHMENT: IssueEnrichment = {
  goal: "Keep the backlog item aligned with the requirements.",
  sourceRequirements: ["REQ-APPLY-001"],
  acceptanceCriteria: ["The issue has an execution contract."],
  constraints: ["Only deterministic apply-safe edits are written."],
  nonGoals: ["Do not resolve ambiguous patches automatically."],
  validation: ["npm test"],
  relevantAreas: ["src/reconciliation"],
};

const APPLY_SAFE_REPORT: ReconciliationReport = {
  repository: { owner: "acme", repo: "widgets" },
  epicRef: 12,
  requirementsPaths: [],
  generatedAt: "2026-08-23T00:00:00.000Z",
  analysisId: "reconcile-e2e",
  coverage: [],
  patches: [
    {
      type: "MARK_STALE",
      issue: 17,
      reason: "old issue needs human confirmation",
      policy: "requires-approval",
    },
    {
      type: "ENRICH_ISSUE",
      issue: 15,
      patch: ENRICHMENT,
      reason: "needs a managed execution contract",
      policy: "auto-safe",
    },
    {
      type: "NEEDS_HUMAN",
      issue: 18,
      ambiguityType: "PRODUCT",
      reason: "ambiguous product choice",
      questions: ["Which behavior should win?"],
      policy: "requires-approval",
    },
    {
      type: "ADD_DEPENDENCY",
      issue: 16,
      dependsOn: 15,
      reason: "task #16 depends on #15",
      policy: "auto-safe",
    },
    {
      type: "CREATE_ISSUE",
      epic: null,
      spec: { title: "Add apply-safe regression coverage", enrichment: ENRICHMENT },
      reason: "missing coverage issue",
      policy: "auto-safe",
    },
  ],
  summary: {
    requirementsCovered: 0,
    requirementsPartial: 0,
    requirementsMissing: 0,
    requirementsTotal: 0,
    patchCounts: {
      MARK_STALE: 1,
      ENRICH_ISSUE: 1,
      NEEDS_HUMAN: 1,
      ADD_DEPENDENCY: 1,
      CREATE_ISSUE: 1,
    },
  },
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("autopilot reconcile-apply", () => {
  it("exits 0 on a fully-applied ApplyReport", async () => {
    const cmd = makeCommand({ report: APPLIED });

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.exitCode()).toBe(0);
    expect(cmd.capturedAnalysisId()).toBe("reconcile-1-12");
  });

  it("exits 2 when the report summary has failures", async () => {
    const cmd = makeCommand({ report: FAILED });

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.exitCode()).toBe(2);
  });

  it("exits 2 when the report summary has user-skipped entries", async () => {
    const cmd = makeCommand({
      report: { ...APPLIED, summary: { ...APPLIED.summary, skippedUser: 1 } },
    });

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.exitCode()).toBe(2);
  });

  it("exits 2 when the report was aborted", async () => {
    const cmd = makeCommand({ report: { ...APPLIED, aborted: true } });

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.exitCode()).toBe(2);
  });

  it("exits 1 when the service throws", async () => {
    const cmd = makeCommand({ error: new Error("report not found") });

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.exitCode()).toBe(1);
    expect(cmd.stderr.join("\n")).toContain("report not found");
  });

  it("passes --yes and --force through to the service", async () => {
    const cmd = makeCommand();

    await run(cmd.program, ["reconcile-1-12", "--yes", "--force"]);

    expect(cmd.capturedOptions()).toEqual({ yes: true, force: true });
  });

  it("uses preview-only mode for non-TTY invocation without --yes", async () => {
    const cmd = makeCommand();

    await run(cmd.program, ["reconcile-1-12"]);

    expect(cmd.capturedOptions()).toEqual({ yes: false, force: false, previewOnly: true });
  });

  it("does not force preview-only mode for TTY invocation without --yes", async () => {
    const cmd = makeCommand({ isTTY: true });

    await run(cmd.program, ["reconcile-1-12"]);

    expect(cmd.capturedOptions()).toEqual({ yes: false, force: false });
  });

  it("--json emits the ApplyReport on stdout", async () => {
    const cmd = makeCommand({ report: APPLIED });

    await run(cmd.program, ["reconcile-1-12", "--yes", "--json"]);

    expect(JSON.parse(cmd.stdout.join("\n"))).toEqual(APPLIED);
  });

  it("redacts secret-shaped values in JSON output", async () => {
    const cmd = makeCommand({ report: SECRET_REPORT });

    await run(cmd.program, ["reconcile-1-12", "--yes", "--json"]);

    const output = cmd.stdout.join("\n");
    expect(output).not.toContain("ghp_12345678901234567890");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts secret-shaped values in human output", async () => {
    const cmd = makeCommand({ report: SECRET_REPORT });

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    const output = cmd.stdout.join("\n");
    expect(output).not.toContain("ghp_12345678901234567890");
    expect(output).toContain("[REDACTED]");
  });

  it("applies only auto-safe patches with --yes and writes nothing in non-TTY preview-only mode", async () => {
    const yesGithub = new RecordingGitHub([
      makeIssue(15, "Existing task", "Needs enrichment"),
      makeIssue(16, "Dependent task", "Do this after prerequisite."),
      makeIssue(17, "Stale task", "Potentially stale."),
      makeIssue(18, "Ambiguous task", "Needs a product decision."),
    ]);
    const yesCmd = makeRealApplyCommand(yesGithub);
    await seedStoredReport(yesCmd.dataDir, APPLY_SAFE_REPORT);

    await run(yesCmd.program, ["reconcile-e2e", "--yes", "--json"]);

    const yesReport = parseStdoutReport(yesCmd.stdout);
    expect(yesCmd.exitCode()).toBe(0);
    expect(yesCmd.stderr).toEqual([]);
    expect(yesReport.summary).toMatchObject({
      applied: 3,
      skippedRequiresApproval: 2,
      skippedUser: 0,
      failed: 0,
    });
    expect(yesReport.entries.map((entry) => [entry.patchType, entry.outcome.status])).toEqual([
      ["CREATE_ISSUE", "applied"],
      ["ENRICH_ISSUE", "applied"],
      ["ADD_DEPENDENCY", "applied"],
      ["MARK_STALE", "skipped"],
      ["NEEDS_HUMAN", "skipped"],
    ]);
    expect(yesGithub.writes).toEqual([
      "createIssue:Add apply-safe regression coverage",
      "updateIssueBody:#15",
      "updateIssueBody:#16",
    ]);

    const previewGithub = new RecordingGitHub([
      makeIssue(15, "Existing task", "Needs enrichment"),
      makeIssue(16, "Dependent task", "Do this after prerequisite."),
      makeIssue(17, "Stale task", "Potentially stale."),
      makeIssue(18, "Ambiguous task", "Needs a product decision."),
    ]);
    const previewCmd = makeRealApplyCommand(previewGithub);
    await seedStoredReport(previewCmd.dataDir, APPLY_SAFE_REPORT);

    await run(previewCmd.program, ["reconcile-e2e", "--json"]);

    const previewReport = parseStdoutReport(previewCmd.stdout);
    expect(previewCmd.exitCode()).toBe(0);
    expect(previewCmd.stderr).toEqual([]);
    expect(previewGithub.writes).toEqual([]);
    expect(previewReport.summary).toMatchObject({
      applied: 0,
      skippedRequiresApproval: 2,
      skippedUser: 0,
      failed: 0,
      previewed: 3,
    });
    expect(
      previewReport.entries.filter(
        (entry) => entry.outcome.status === "skipped" && entry.outcome.skippedBy === "preview-only",
      ),
    ).toHaveLength(3);
  });

  it("exits 2 when an auto-safe target issue cannot be fetched", async () => {
    const fetchFailureReport: ReconciliationReport = {
      ...APPLY_SAFE_REPORT,
      analysisId: "reconcile-fetch-failure",
      patches: [
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: ENRICHMENT,
          reason: "needs a managed execution contract",
          policy: "auto-safe",
        },
      ],
      summary: {
        ...APPLY_SAFE_REPORT.summary,
        patchCounts: { ENRICH_ISSUE: 1 },
      },
    };
    const github = new RecordingGitHub([]);
    const cmd = makeRealApplyCommand(github);
    await seedStoredReport(cmd.dataDir, fetchFailureReport);

    await run(cmd.program, ["reconcile-fetch-failure", "--yes", "--json"]);

    const report = parseStdoutReport(cmd.stdout);
    expect(cmd.exitCode()).toBe(2);
    expect(cmd.stderr).toEqual([]);
    expect(github.writes).toEqual([]);
    expect(report.entries[0]?.outcome).toEqual({ status: "skipped", skippedBy: "failed-to-fetch" });
  });

  it("redacts secret-shaped issue-body values from real apply previews and JSON output", async () => {
    const secret = "ghp_123456789012345678901234";
    const secretReport: ReconciliationReport = {
      ...APPLY_SAFE_REPORT,
      analysisId: "reconcile-secret-body",
      patches: [
        {
          type: "ENRICH_ISSUE",
          issue: 15,
          patch: ENRICHMENT,
          reason: "needs a managed execution contract",
          policy: "auto-safe",
        },
      ],
      summary: {
        ...APPLY_SAFE_REPORT.summary,
        patchCounts: { ENRICH_ISSUE: 1 },
      },
    };

    const jsonGithub = new RecordingGitHub([
      makeIssue(15, "Secret task", `Current body includes ${secret}`),
    ]);
    const jsonCmd = makeRealApplyCommand(jsonGithub);
    await seedStoredReport(jsonCmd.dataDir, secretReport);

    await run(jsonCmd.program, ["reconcile-secret-body", "--json"]);

    const jsonOutput = jsonCmd.stdout.join("\n");
    expect(() => parseStdoutReport(jsonCmd.stdout)).not.toThrow();
    expect(jsonOutput).not.toContain(secret);

    const humanGithub = new RecordingGitHub([
      makeIssue(15, "Secret task", `Current body includes ${secret}`),
    ]);
    const humanCmd = makeRealApplyCommand(humanGithub);
    await seedStoredReport(humanCmd.dataDir, secretReport);

    await run(humanCmd.program, ["reconcile-secret-body"]);

    const humanOutput = humanCmd.stdout.join("\n");
    expect(humanOutput).not.toContain(secret);
    expect(humanOutput).toContain("[REDACTED]");
    expect(humanGithub.writes).toEqual([]);
  });

  it("constructs the apply service", async () => {
    const cmd = makeCommand();

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.createApplyCalled()).toBe(true);
  });
});
