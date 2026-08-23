import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerReconcileApplyCommand } from "../../../src/commands/reconcile-apply.js";
import type { ReconcileApplyCommandDeps } from "../../../src/commands/reconcile-apply.js";
import type { ApplyReport } from "../../../src/domain/apply.js";
import type { GitHubPort } from "../../../src/github/github-adapter.js";
import type { ProcessRunner, ProcessRequest, ProcessResult } from "../../../src/platform/process-runner.js";
import type { ApplyOptions } from "../../../src/reconciliation/apply-service.js";

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

const fakeGithub: GitHubPort = {
  async getIssue() {
    throw new Error("not used");
  },
  async findIssueByTitle() {
    return null;
  },
  async updateIssueBody() {
    throw new Error("not used");
  },
  async createIssueComment() {},
  async findPullRequestByHead() {
    return null;
  },
  async createPullRequest() {
    throw new Error("not used");
  },
  async findIssueCommentByMarker() {
    return null;
  },
  async createIssue() {
    throw new Error("not used");
  },
  async ensureLabel() {},
};

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

  it("constructs the apply service", async () => {
    const cmd = makeCommand();

    await run(cmd.program, ["reconcile-1-12", "--yes"]);

    expect(cmd.createApplyCalled()).toBe(true);
  });
});
