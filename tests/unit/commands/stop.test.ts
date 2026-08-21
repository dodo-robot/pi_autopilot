import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerStopCommand } from "../../../src/commands/stop.js";
import type { StopCommandDeps } from "../../../src/commands/stop.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeDeps(tmpDir: string, overrides: Partial<StopCommandDeps> = {}): StopCommandDeps {
  return {
    dataDir: tmpDir,
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    sendSignal: vi.fn(),
    waitForExit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

async function runStop(deps: StopCommandDeps, args: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStopCommand(program, deps);
  await program.parseAsync(["stop", ...args], { from: "user" });
}

describe("stop command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "stop-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 with message when no PID file exists", async () => {
    const deps = makeDeps(tmpDir);
    await runStop(deps);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no daemon running"));
  });

  it("exits 1 with message when PID file is stale (ESRCH)", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "99999");
    const sendSignal = vi.fn().mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    });
    const deps = makeDeps(tmpDir, { sendSignal });
    await runStop(deps);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no daemon running"));
  });

  it("sends SIGTERM and exits 0 when daemon stops", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "12345");
    const deps = makeDeps(tmpDir, {
      waitForExit: vi.fn().mockResolvedValue(true),
    });
    await runStop(deps);
    expect(deps.sendSignal).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(deps.setExitCode).not.toHaveBeenCalledWith(1);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("stopped"));
  });

  it("exits 1 when daemon does not stop within timeout", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "12345");
    const deps = makeDeps(tmpDir, {
      waitForExit: vi.fn().mockResolvedValue(false),
    });
    await runStop(deps);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining("did not stop within"),
    );
  });
});
