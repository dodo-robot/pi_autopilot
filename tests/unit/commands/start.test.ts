import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerStartCommand } from "../../../src/commands/start.js";
import type { StartCommandDeps } from "../../../src/commands/start.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BacklogReport } from "../../../src/domain/backlog.js";

const REPO = { owner: "acme", repo: "widgets" };

function fakeContext() {
  return {
    repository: REPO,
    remote: "https://github.com/acme/widgets.git",
    cwd: "/repo",
  };
}

function writeAnalyzeReport(dataDir: string, report: Partial<BacklogReport> & { executable: number[] }, runId = `analyze-${Date.now()}`) {
  const full: BacklogReport = {
    repository: REPO,
    epicRef: null,
    requestedRefs: report.executable,
    generatedAt: new Date().toISOString(),
    analysisId: runId,
    scope: { totalIssues: report.executable.length, analyzed: report.executable.length, unresolved: 0 },
    issues: [],
    executable: report.executable,
    needsWork: [],
    summary: { ready: report.executable.length, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
    refinerSessions: 0,
    ...report,
  };
  const runsDir = path.join(dataDir, "runs", runId);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, "backlog-report.json"), JSON.stringify(full));
}

function makeDeps(tmpDir: string, overrides: Partial<StartCommandDeps> = {}): StartCommandDeps {
  return {
    dataDir: tmpDir,
    cwd: "/repo",
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    spawnDaemon: vi.fn().mockReturnValue({ pid: 12345 }),
    resolveContext: vi.fn().mockResolvedValue(fakeContext()),
    processRunner: {} as any,
    verifyIssues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function runStart(deps: StartCommandDeps, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program, deps);
  await program.parseAsync(["start", ...args], { from: "user" });
}

describe("start command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "start-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("spawns daemon with explicit issue list", async () => {
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["28", "29", "30"]);
    expect(deps.spawnDaemon).toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("daemon started"));
  });

  it("exits 1 when a daemon is already running", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), String(process.pid));
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["28"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("already running"));
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it("uses --from-analyze to load the executable list", async () => {
    writeAnalyzeReport(tmpDir, { executable: [101, 102] });
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["--from-analyze"]);
    expect(deps.spawnDaemon).toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("daemon started"));
  });

  it("uses the latest --from-analyze report for the current repository", async () => {
    writeAnalyzeReport(tmpDir, {
      repository: { owner: "other", repo: "repo" },
      executable: [999],
      generatedAt: "2026-01-02T00:00:00.000Z",
    }, "other-repo-report");
    writeAnalyzeReport(tmpDir, {
      executable: [101, 102],
      generatedAt: "2026-01-01T00:00:00.000Z",
    }, "current-repo-report");
    const deps = makeDeps(tmpDir);

    await runStart(deps, ["--from-analyze"]);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("queue: [101, 102]"));
  });

  it("exits 1 when --from-analyze cannot resolve repository context", async () => {
    writeAnalyzeReport(tmpDir, { executable: [101] }, "current-repo-report");
    const deps = makeDeps(tmpDir, {
      resolveContext: vi.fn().mockRejectedValue(new Error("not a git repository")),
    });

    await runStart(deps, ["--from-analyze"]);

    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("not a git repository"));
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it("rejects path-like --from-analyze report ids", async () => {
    const deps = makeDeps(tmpDir);

    await runStart(deps, ["--from-analyze", "../chosen-report"]);

    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("invalid analyze report id"));
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it("uses the named --from-analyze report instead of the latest report", async () => {
    writeAnalyzeReport(tmpDir, {
      executable: [999],
      generatedAt: "2026-01-02T00:00:00.000Z",
    }, "latest-report");
    writeAnalyzeReport(tmpDir, {
      executable: [101, 102],
      generatedAt: "2026-01-01T00:00:00.000Z",
    }, "chosen-report");
    const deps = makeDeps(tmpDir);

    await runStart(deps, ["--from-analyze", "chosen-report"]);

    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("queue: [101, 102]"));
  });

  it("persists role overrides for the daemon", async () => {
    const deps = makeDeps(tmpDir);

    await runStart(deps, [
      "28",
      "--refiner-model", "r-model",
      "--refiner-thinking", "low",
      "--implementer-model", "i-model",
      "--reviewer-thinking", "high",
      "--refiner-timeout", "7",
    ]);

    const queue = JSON.parse(readFileSync(path.join(tmpDir, "daemon", "queue.json"), "utf8"));
    expect(queue.overrides).toEqual({
      refiner: { model: "r-model", thinking: "low" },
      implementer: { model: "i-model" },
      reviewer: { thinking: "high" },
      refinerTimeoutMs: 420000,
    });
  });

  it("verifies explicit issues exist before spawning the daemon", async () => {
    const verifyIssues = vi.fn().mockRejectedValue(new Error("missing issue #28"));
    const deps = makeDeps(tmpDir, { verifyIssues });

    await runStart(deps, ["28"]);

    expect(verifyIssues).toHaveBeenCalledWith([28]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("missing issue #28"));
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it("exits 1 when --from-analyze finds no report", async () => {
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["--from-analyze"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining("no analyze report found"),
    );
  });

  it("exits 1 when --from-analyze report has empty executable list", async () => {
    writeAnalyzeReport(tmpDir, { executable: [] });
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["--from-analyze"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no READY issues"));
  });

  it("exits 1 when no issues provided and no --from-analyze", async () => {
    const deps = makeDeps(tmpDir);
    await runStart(deps, []);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });
});
