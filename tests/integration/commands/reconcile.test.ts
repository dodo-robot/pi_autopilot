// tests/integration/commands/reconcile.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import type { ReconcileCommandDeps } from "../../../src/commands/reconcile.js";
import type { GitHubIssue, GitHubPort } from "../../../src/github/github-adapter.js";
import type { ReconciliationReport } from "../../../src/reconciliation/reconciliation-service.js";
import type { RequirementDoc } from "../../../src/reconciliation/prompt.js";

const MINIMAL_YAML = `version: 1
commands:
  setup:
    - npm ci
  verify:
    - npm test
`;

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

const EPIC = makeIssue(12, "Authentication overhaul", "- [ ] #15 OAuth callback");
const ISSUE_15 = makeIssue(15, "OAuth callback", "Handles the callback");

class FakeGitHub implements GitHubPort {
  readonly mutationCalls: string[] = [];
  private readonly issues = new Map<number, GitHubIssue>([[12, EPIC], [15, ISSUE_15]]);

  async getIssue(number: number): Promise<GitHubIssue> {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`no such issue #${number}`);
    return issue;
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

const FIXED_REPORT: ReconciliationReport = {
  repository: { owner: "acme", repo: "widgets" },
  epicRef: 12,
  requirementsPaths: [],
  generatedAt: "2026-08-22T00:00:00Z",
  analysisId: "reconcile-test",
  coverage: [
    {
      requirementId: "REQ-AUTH-001",
      description: "Users can log in via GitHub",
      epic: 12,
      issues: [15],
      status: "covered",
      evidence: "issue #15",
    },
  ],
  patches: [
    { type: "KEEP", issue: 15, reason: "correct as-is", policy: "requires-approval" },
  ],
  summary: {
    requirementsCovered: 1,
    requirementsPartial: 0,
    requirementsMissing: 0,
    requirementsTotal: 1,
    patchCounts: { KEEP: 1 },
  },
};

function baseDeps(overrides: Partial<ReconcileCommandDeps> = {}): ReconcileCommandDeps {
  const github = new FakeGitHub();
  return {
    cwd: tempRepoRoot(),
    createGitHub: async () => github,
    createReconciliation: () => ({
      reconcile: async () => FIXED_REPORT,
    }),
    ...overrides,
  };
}

const dirs: string[] = [];
function tempRepoRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "autopilot-reconcile-cli-"));
  // `resolveRepositoryContext` shells out to real git (mirroring analyze.ts's
  // wiring), so the fixture must be a real repo with an origin remote
  // matching FIXED_REPORT's owner/repo.
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
    { cwd: root, stdio: "ignore" },
  );
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(path.join(root, ".pi", "autopilot.yaml"), MINIMAL_YAML, "utf8");
  dirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("autopilot reconcile", () => {
  it("prints a human-readable report grouped by patch type, with coverage", async () => {
    const lines: string[] = [];
    const deps = baseDeps({ stdout: (line) => lines.push(line) });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);

    const output = lines.join("\n");
    expect(output).toContain("Epic #12");
    expect(output).toContain("KEEP");
    expect(output).toContain("#15");
    expect(output).toContain("COVERAGE");
    expect(output).toContain("1/1 requirements covered");
  });

  it("emits the full report as JSON with --json", async () => {
    const lines: string[] = [];
    const deps = baseDeps({ stdout: (line) => lines.push(line) });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12", "--json"]);

    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed).toEqual(FIXED_REPORT);
  });

  it("reads an explicit --requirements file and passes its content to the service", async () => {
    const root = tempRepoRoot();
    writeFileSync(path.join(root, "reqs.md"), "REQ-AUTH-001: users can log in", "utf8");
    let captured: RequirementDoc[] = [];
    const deps = baseDeps({
      cwd: root,
      stdout: () => {},
      createReconciliation: () => ({
        reconcile: async (_epicRef: number, docs: RequirementDoc[]) => {
          captured = docs;
          return FIXED_REPORT;
        },
      }),
    });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12", "--requirements", "reqs.md"]);

    expect(captured).toEqual([
      { path: "reqs.md", content: "REQ-AUTH-001: users can log in" },
    ]);
  });

  it("exits 1 with a clear error when an explicit --requirements path does not exist", async () => {
    let exitCode: number | undefined;
    let errorLine = "";
    const deps = baseDeps({
      stdout: () => {},
      stderr: (line) => (errorLine = line),
      setExitCode: (code) => (exitCode = code),
    });
    const program = buildProgram(deps);
    await program.parseAsync([
      "node",
      "autopilot",
      "reconcile",
      "12",
      "--requirements",
      "does-not-exist.md",
    ]);

    expect(exitCode).toBe(1);
    expect(errorLine).toContain("does-not-exist.md");
  });

  it("defaults to requirements.md when present and no explicit configuration is given", async () => {
    const root = tempRepoRoot();
    writeFileSync(path.join(root, "requirements.md"), "REQ-DEFAULT-001: default doc", "utf8");
    let captured: RequirementDoc[] = [];
    const deps = baseDeps({
      cwd: root,
      stdout: () => {},
      createReconciliation: () => ({
        reconcile: async (_epicRef: number, docs: RequirementDoc[]) => {
          captured = docs;
          return FIXED_REPORT;
        },
      }),
    });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);

    expect(captured).toEqual([
      { path: "requirements.md", content: "REQ-DEFAULT-001: default doc" },
    ]);
  });

  it("passes an empty requirement doc list when no requirements.md exists and none is configured", async () => {
    let captured: RequirementDoc[] | undefined;
    const deps = baseDeps({
      stdout: () => {},
      createReconciliation: () => ({
        reconcile: async (_epicRef: number, docs: RequirementDoc[]) => {
          captured = docs;
          return FIXED_REPORT;
        },
      }),
    });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);

    expect(captured).toEqual([]);
  });

  it("never calls a GitHub mutation method", async () => {
    const github = new FakeGitHub();
    const deps = baseDeps({ stdout: () => {}, createGitHub: async () => github });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);
    expect(github.mutationCalls).toEqual([]);
  });

  it("exits 0 on success", async () => {
    let exitCode: number | undefined;
    const deps = baseDeps({ stdout: () => {}, setExitCode: (code) => (exitCode = code) });
    const program = buildProgram(deps);
    await program.parseAsync(["node", "autopilot", "reconcile", "12"]);
    expect(exitCode).toBe(0);
  });
});
