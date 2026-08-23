import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerQueueCommand } from "../../../src/commands/queue.js";
import type { QueueCommandDeps } from "../../../src/commands/queue.js";

async function runQueueAdd(deps: QueueCommandDeps, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerQueueCommand(program, deps);
  await program.parseAsync(["queue", "add", ...args], { from: "user" });
}

describe("queue add command", () => {
  it("errors when no daemon is running", async () => {
    const errors: string[] = [];
    let exitCode: number | undefined;
    const deps: QueueCommandDeps = {
      isDaemonLive: () => false,
      appendPending: vi.fn(),
      stderr: (t) => errors.push(t),
      setExitCode: (c) => { exitCode = c; },
    };
    await runQueueAdd(deps, ["42"]);
    expect(errors.join(" ")).toMatch(/no daemon running/i);
    expect(exitCode).toBe(1);
    expect(deps.appendPending).not.toHaveBeenCalled();
  });

  it("appends parsed issue numbers when a daemon is running", async () => {
    let appended: number[] | undefined;
    const messages: string[] = [];
    const deps: QueueCommandDeps = {
      isDaemonLive: () => true,
      appendPending: (issues) => { appended = issues; },
      resolveIssues: async (refs) => refs.map(Number),
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    await runQueueAdd(deps, ["42", "43"]);
    expect(appended).toEqual([42, 43]);
    expect(messages.join(" ")).toMatch(/queued 2/i);
  });

  it("emits JSON when --json is passed", async () => {
    const messages: string[] = [];
    const deps: QueueCommandDeps = {
      isDaemonLive: () => true,
      appendPending: vi.fn(),
      resolveIssues: async (refs) => refs.map(Number),
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    await runQueueAdd(deps, ["42", "--json"]);
    const parsed = JSON.parse(messages.join(""));
    expect(parsed).toEqual({ queued: [42], daemonRunning: true });
  });

  it("handles resolution errors gracefully", async () => {
    const errors: string[] = [];
    let exitCode: number | undefined;
    const deps: QueueCommandDeps = {
      isDaemonLive: () => true,
      appendPending: vi.fn(),
      resolveIssues: async () => { throw new Error("invalid issue reference 'bad'"); },
      stderr: (t) => errors.push(t),
      setExitCode: (c) => { exitCode = c; },
    };
    await runQueueAdd(deps, ["bad"]);
    expect(errors.join(" ")).toMatch(/invalid issue reference/);
    expect(exitCode).toBe(1);
    expect(deps.appendPending).not.toHaveBeenCalled();
  });
});
