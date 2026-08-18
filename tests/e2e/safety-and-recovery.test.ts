import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTrackedTempDirs,
  createFixtureRepo,
  git,
  makeHarness,
  makeIssue,
  pointOriginAtBareRemote,
  readyRefinerPayload,
  writeScenario,
} from "./helpers.js";
import type { FakeScenario } from "../../src/testing/fake-pi.js";
import type { CreatePullRequestInput, PullRequestRef } from "../../src/github/github-adapter.js";

/**
 * Safety and recovery acceptance cases, exercised the same way as
 * `supervised-task-run.test.ts`: the COMPILED CLI, real workflow engine,
 * real `WorkspaceManager`/`VerificationRunner`/`Publisher`, a fake
 * `GitHubPort`, and the real `PiRunner` pointed at the compiled fake Pi
 * executable via `piCommand`.
 *
 * Two cases below (denied destructive command, protected-path write) rely
 * on `src/testing/fake-pi.ts` calling the REAL
 * `src/security/command-policy.ts` functions before acting, since the
 * production guard extension only intercepts tool calls inside a live Pi
 * session — a standalone fake executable never receives a `tool_call`
 * event. That interception itself is already covered by
 * `tests/unit/pi/guard-extension.test.ts` and
 * `tests/unit/security/command-policy.test.ts`; this suite instead proves
 * the orchestrator's policy configuration (`allowedCommands`,
 * `protectedPaths`) actually reaches the guard envelope for a real run and
 * that a denied attempt stops the run explicitly (BLOCKED), rather than
 * silently succeeding.
 */

let repoCounter = 0;
function uniqueRepoName(prefix: string): string {
  repoCounter += 1;
  return `${prefix}-${String(repoCounter)}`;
}

const tempDirs: string[] = [];

function scenarioDir(): string {
  const dir = mktempScenario();
  tempDirs.push(dir);
  return dir;
}

function mktempScenario(): string {
  return mkdtempSync(path.join(tmpdir(), "ap-safety-scenario-"));
}

afterEach(() => {
  cleanupTrackedTempDirs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("safety and recovery acceptance", () => {
  it("denies an implementer's destructive command attempt and stops explicitly (BLOCKED)", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          action: "result",
          policyAttempt: { command: "git push origin main --force" },
        },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(2);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Stage: BLOCKED");
    expect(output).toContain("autopilot policy denied the attempt");
  });

  it("denies an implementer's write to a protected path and stops explicitly (BLOCKED)", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root } = await createFixtureRepo(repoName);
    // Declare a protected path so the guard envelope PiRunner writes (and
    // that fake-pi enforces via the real command-policy module) actually
    // includes it; the base fixture config declares none.
    writeFileSync(
      path.join(root, ".pi", "autopilot.yaml"),
      [
        "version: 1",
        "commands:",
        "  setup:",
        '    - "true"',
        "  verify:",
        '    - "test -f .verify-ok"',
        "agentPolicy:",
        "  protectedPaths:",
        "    - .github/workflows/",
        "",
      ].join("\n"),
      "utf8",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "declare a protected path"]);

    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          action: "result",
          policyAttempt: { path: ".github/workflows/ci.yml" },
        },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(2);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Stage: BLOCKED");
    expect(output).toContain("autopilot policy denied the attempt");
  });

  it("blocks after a failed verification, then succeeds via one correction attempt", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root, remote } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          attempt: 1,
          action: "result",
          payload: {
            outcome: "COMPLETED",
            summary: "First attempt (missing the verify marker).",
            changedPaths: [],
            commandsAttempted: [],
            unresolvedProblems: [],
            evidenceLocations: [],
          },
          // No mutate: `.verify-ok` is never written, so verification fails.
        },
        {
          role: "implementer",
          attempt: 2,
          action: "result",
          payload: {
            outcome: "COMPLETED",
            summary: "Correction: writes the missing marker.",
            changedPaths: [".verify-ok"],
            commandsAttempted: ["true"],
            unresolvedProblems: [],
            evidenceLocations: [],
          },
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", action: "result" },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["check", "42"]);
    await pointOriginAtBareRemote(root, remote);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;
    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(0);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("VERIFICATION -> IMPLEMENTATION");
    expect(output).toContain("Stage: PR_OPEN");
  });

  it("requests two review correction cycles, then approves on the third attempt", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root, remote } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    const completedPayload = (summary: string) => ({
      outcome: "COMPLETED",
      summary,
      changedPaths: [".verify-ok"],
      commandsAttempted: ["true"],
      unresolvedProblems: [],
      evidenceLocations: [],
    });
    const changesRequested = (note: string) => ({
      outcome: "CHANGES_REQUESTED",
      criteriaResults: [{ criterionId: "ac1", passed: false, notes: "not yet" }],
      findings: [
        {
          severity: "important" as const,
          criterionId: "ac1",
          path: "src/token-refresh.ts",
          line: 1,
          evidence: "missing check",
          // Distinct requestedChange text per cycle: BudgetTracker
          // fingerprints (severity, criterionId, path, line, requestedChange),
          // and an identical fingerprint on a second occurrence blocks
          // immediately as a repeated failure rather than consuming a
          // correction cycle (see workflow/budgets.ts).
          requestedChange: `add the check (${note})`,
        },
      ],
    });

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          attempt: 1,
          action: "result",
          payload: completedPayload("Attempt 1."),
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", attempt: 1, action: "result", payload: changesRequested("v1") },
        {
          role: "implementer",
          attempt: 2,
          action: "result",
          payload: completedPayload("Attempt 2 (first correction)."),
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", attempt: 2, action: "result", payload: changesRequested("v2") },
        {
          role: "implementer",
          attempt: 3,
          action: "result",
          payload: completedPayload("Attempt 3 (second correction)."),
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        {
          role: "reviewer",
          attempt: 3,
          action: "result",
          payload: {
            outcome: "APPROVED",
            criteriaResults: [{ criterionId: "ac1", passed: true, notes: "now verified" }],
            findings: [],
          },
        },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["check", "42"]);
    await pointOriginAtBareRemote(root, remote);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;
    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(0);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Stage: PR_OPEN");
    expect(output.match(/CORRECTION -> IMPLEMENTATION/g) ?? []).toHaveLength(2);
  });

  it("blocks when correction cycles are exhausted (findings persist beyond the budget)", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    const completedPayload = (summary: string) => ({
      outcome: "COMPLETED",
      summary,
      changedPaths: [".verify-ok"],
      commandsAttempted: ["true"],
      unresolvedProblems: [],
      evidenceLocations: [],
    });
    const changesRequested = (note: string) => ({
      outcome: "CHANGES_REQUESTED",
      criteriaResults: [{ criterionId: "ac1", passed: false, notes: note }],
      findings: [
        {
          severity: "important" as const,
          criterionId: "ac1",
          path: "src/token-refresh.ts",
          line: 1,
          evidence: `still missing (${note})`,
          // Distinct per cycle so each is a distinct (not repeated)
          // fingerprint, exhausting the correction-cycle budget itself
          // rather than tripping the earlier repeated-failure block.
          requestedChange: `add the check (${note})`,
        },
      ],
    });

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          attempt: 1,
          action: "result",
          payload: completedPayload("Attempt 1."),
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", attempt: 1, action: "result", payload: changesRequested("v1") },
        {
          role: "implementer",
          attempt: 2,
          action: "result",
          payload: completedPayload("Attempt 2."),
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", attempt: 2, action: "result", payload: changesRequested("v2") },
        {
          role: "implementer",
          attempt: 3,
          action: "result",
          payload: completedPayload("Attempt 3."),
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        // A third distinct CHANGES_REQUESTED (still failing) exhausts the
        // configured maxCorrectionCycles (2), which BLOCKS rather than
        // looping forever.
        { role: "reviewer", attempt: 3, action: "result", payload: changesRequested("v3") },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(2);
    const output = harness.stdoutLines.join("\n");
    expect(output).toContain("Stage: BLOCKED");
    expect(output).toContain("correction cycles exhausted");
  });

  it("preserves the worktree on disk after a BLOCKED run", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          action: "result",
          payload: {
            outcome: "BLOCKED",
            reason: "cannot proceed without credentials",
            unresolvedProblems: ["missing credentials"],
          },
        },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["run", "42"]);
    expect(harness.exitCodes.at(-1)).toBe(2);
    const runId = /Run: (\S+)/.exec(harness.stdoutLines.join("\n"))![1]!;

    const worktreePath = path.join(
      path.dirname(root),
      ".pi-autopilot-worktrees",
      repoName,
      runId,
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("resumes a BLOCKED run with a fresh implementer session and reaches PR_OPEN", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root, remote } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          attempt: 1,
          action: "result",
          payload: {
            outcome: "BLOCKED",
            reason: "cannot proceed without credentials",
            unresolvedProblems: ["missing credentials"],
          },
        },
        {
          role: "implementer",
          attempt: 2,
          action: "result",
          payload: {
            outcome: "COMPLETED",
            summary: "Resumed with a fresh session.",
            changedPaths: [".verify-ok"],
            commandsAttempted: ["true"],
            unresolvedProblems: [],
            evidenceLocations: [],
          },
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", action: "result" },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    await harness.run(["run", "42"]);
    expect(harness.exitCodes.at(-1)).toBe(2);
    const runId = /Run: (\S+)/.exec(harness.stdoutLines.join("\n"))![1]!;

    await pointOriginAtBareRemote(root, remote);
    harness.stdoutLines.length = 0;
    harness.exitCodes.length = 0;
    await harness.run(["resume", runId]);

    expect(harness.exitCodes.at(-1)).toBe(0);
    expect(harness.stdoutLines.join("\n")).toContain("Stage: PR_OPEN");
  });

  it("never duplicates the PR or issue comment when GitHub already has them from an earlier interrupted publication", async () => {
    const repoName = uniqueRepoName("safety-fixture");
    const { root, remote } = await createFixtureRepo(repoName);
    const dir = scenarioDir();
    const scenarioPath = path.join(dir, "scenario.json");

    writeScenario(dir, {
      steps: [
        { role: "refiner", action: "result", payload: readyRefinerPayload(scenarioPath, repoName) },
        {
          role: "implementer",
          action: "result",
          payload: {
            outcome: "COMPLETED",
            summary: "Implemented.",
            changedPaths: [".verify-ok"],
            commandsAttempted: ["true"],
            unresolvedProblems: [],
            evidenceLocations: [],
          },
          mutate: { writeFiles: { ".verify-ok": "ok\n" } },
        },
        { role: "reviewer", action: "result" },
      ],
    });
    const harness = makeHarness(root, repoName, makeIssue(scenarioPath));

    // Simulate GitHub already having the branch's PR and the run's issue
    // comment from an earlier, interrupted publication attempt (the
    // orchestrator crashed after creating them but before recording
    // success locally). The branch name is deterministic from the
    // objective in readyRefinerPayload ("Token refresh" -> "token-refresh").
    const branch = "autopilot/42-token-refresh";
    const existingPr: PullRequestRef = {
      number: 999,
      url: "https://github.com/acme/pre-existing/pull/999",
      head: branch,
      state: "open",
    };
    harness.github.pullRequests.push(existingPr);
    const runId = "e2e-run-1";
    const marker = `<!-- autopilot-run:${runId} -->`;
    harness.github.issueComments.push({ id: 1, body: `Already posted.\n${marker}` });

    const createPullRequestCalls: CreatePullRequestInput[] = [];
    const originalCreate = harness.github.createPullRequest.bind(harness.github);
    harness.github.createPullRequest = async (input) => {
      createPullRequestCalls.push(input);
      return originalCreate(input);
    };

    await pointOriginAtBareRemote(root, remote);
    await harness.run(["run", "42"]);

    expect(harness.exitCodes.at(-1)).toBe(0);
    expect(createPullRequestCalls).toHaveLength(0);
    expect(harness.github.pullRequests).toHaveLength(1);
    expect(harness.github.issueComments).toHaveLength(1);
  });
});
