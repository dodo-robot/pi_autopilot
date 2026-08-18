import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ProcessError,
  ProcessRunner,
} from "../../../src/platform/process-runner.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "autopilot-proc-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const runner = new ProcessRunner();

function nodeArgs(script: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ["-e", script] };
}

describe("ProcessRunner", () => {
  it("captures stdout and stderr and reports a zero exit", async () => {
    const result = await runner.run({
      ...nodeArgs(`console.log("hello-out"); console.error("hello-err");`),
      cwd: tempDir,
      timeoutMs: 5_000,
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("hello-out");
    expect(result.stderr).toContain("hello-err");
  });

  it("reports a nonzero exit code", async () => {
    const result = await runner.run({
      ...nodeArgs(`process.exit(3);`),
      cwd: tempDir,
      timeoutMs: 5_000,
      env: {},
    });
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it("terminates a hung process group on timeout", async () => {
    const result = await runner.run({
      ...nodeArgs(`setTimeout(() => {}, 10_000);`),
      cwd: tempDir,
      timeoutMs: 25,
      env: {},
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("runs with only the explicitly provided environment", async () => {
    const result = await runner.run({
      ...nodeArgs(
        `console.log(process.env.FOO ?? "unset"); console.log(process.env.PATH ?? "nopath");`,
      ),
      cwd: tempDir,
      timeoutMs: 5_000,
      env: { FOO: "bar" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bar");
    expect(result.stdout).toContain("nopath");
  });

  it("rejects when the command cannot be spawned", async () => {
    await expect(
      runner.run({
        command: "definitely-not-a-real-binary-xyz",
        args: [],
        cwd: tempDir,
        timeoutMs: 500,
        env: {},
      }),
    ).rejects.toBeInstanceOf(ProcessError);
  });

  it("bounds captured output instead of buffering it unboundedly", async () => {
    const result = await runner.run({
      ...nodeArgs(`process.stdout.write("x".repeat(3_000_000));`),
      cwd: tempDir,
      timeoutMs: 5_000,
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1_100_000);
    expect(result.stdout.endsWith("xxxxx")).toBe(true);
  });
});
