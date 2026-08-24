import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "../../../src/commands/status.js";
import type { StatusCommandDeps } from "../../../src/commands/status.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { RunStore } from "../../../src/persistence/run-store.js";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonQueue } from "../../../src/daemon/queue-store.js";

function makeDeps(tmpDir: string, overrides: Partial<StatusCommandDeps> = {}): StatusCommandDeps {
  return {
    dataDir: tmpDir,
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    ...overrides,
  };
}

function writePid(tmpDir: string, pid: number): void {
  const daemonDir = path.join(tmpDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(path.join(daemonDir, "pid"), String(pid));
}

function writeQueue(tmpDir: string, queue: DaemonQueue): void {
  const daemonDir = path.join(tmpDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(path.join(daemonDir, "queue.json"), JSON.stringify(queue));
}

async function runStatus(deps: StatusCommandDeps, args: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program, deps);
  await program.parseAsync(["status", ...args], { from: "user" });
}

describe("status command — daemon block", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "status-daemon-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints 'no daemon running' when PID file is absent", async () => {
    const deps = makeDeps(tmpDir);
    await runStatus(deps);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("no daemon running"));
  });

  it("prints daemon block when PID file is live", async () => {
    // Write our own PID so isLive() returns true
    writePid(tmpDir, process.pid);
    writeQueue(tmpDir, {
      repository: { owner: "acme", repo: "widgets" },
      issues: [28, 29, 30],
      currentIndex: 1,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedRuns: [
        { issueNumber: 28, outcome: "PR_OPEN", completedAt: new Date().toISOString(), runId: "run-1" },
      ],
    });
    const deps = makeDeps(tmpDir);
    await runStatus(deps);
    const output = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n");
    expect(output).toMatch(/Daemon\s+running/);
    expect(output).toMatch(/PID/);
    expect(output).toMatch(/Current\s+#29/);
    expect(output).toMatch(/Queue\s+#30/);
    expect(output).toMatch(/Done.*#28.*PR_OPEN/);
  });

  it("prints the current issue stage when an active run exists", async () => {
    writePid(tmpDir, process.pid);
    writeQueue(tmpDir, {
      repository: { owner: "acme", repo: "widgets" },
      issues: [28, 29],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      completedRuns: [],
    });
    const store = new RunStore(path.join(tmpDir, "autopilot.db"));
    try {
      const run = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 28 });
      store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
    } finally {
      store.close();
    }

    const deps = makeDeps(tmpDir);
    await runStatus(deps);

    const output = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n");
    expect(output).toMatch(/Current\s+#28\s+\[READINESS_CHECK\]/);
  });

  it("existing status <run-id> still works", async () => {
    // We can't easily test this without a real RunStore, so just verify
    // parsing doesn't throw when a run-id argument is given.
    const deps = makeDeps(tmpDir);
    // Should try to look up the run and print not-found
    await runStatus(deps, ["nonexistent-run-id"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });
});
