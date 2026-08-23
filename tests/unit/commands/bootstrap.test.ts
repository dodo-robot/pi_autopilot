import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerBootstrapCommand } from "../../../src/commands/bootstrap.js";
import type { BootstrapCommandDeps } from "../../../src/commands/bootstrap.js";

function makeProgram(deps: BootstrapCommandDeps = {}) {
  const program = new Command();
  program.exitOverride();
  registerBootstrapCommand(program, deps);
  return program;
}

describe("bootstrap command registration", () => {
  it("registers the bootstrap command", () => {
    const program = makeProgram();
    const cmd = program.commands.find((c) => c.name() === "bootstrap");
    expect(cmd).toBeDefined();
  });

  it("requires --plan or --apply", async () => {
    const errors: string[] = [];
    const program = makeProgram({
      stderr: (msg) => errors.push(msg),
      setExitCode: () => {},
    });
    await program.parseAsync(["bootstrap"], { from: "user" });
    // Should have errored because neither --plan nor --apply was given
    expect(errors.join(" ")).toMatch(/must provide|--plan|--apply/i);
  });

  it("calls planFn when --plan is passed", async () => {
    let planCalled = false;
    const deps: BootstrapCommandDeps = {
      planFn: async () => {
        planCalled = true;
        return { planId: "x", markdownPath: "/tmp/x.md" };
      },
      setExitCode: () => {},
      stdout: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["bootstrap", "--plan"], { from: "user" });
    expect(planCalled).toBe(true);
  });

  it("calls applyFn when --apply is passed", async () => {
    let applyCalled = false;
    const deps: BootstrapCommandDeps = {
      applyFn: async () => {
        applyCalled = true;
      },
      setExitCode: () => {},
      stdout: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["bootstrap", "--apply", "bootstrap-20260823-abc"], {
      from: "user",
    });
    expect(applyCalled).toBe(true);
  });

  it("passes requirement docs to planFn", async () => {
    let receivedDocs: Array<{ path: string; content: string }> = [];
    const deps: BootstrapCommandDeps = {
      planFn: async (docs) => {
        receivedDocs = docs;
        return { planId: "x", markdownPath: "/tmp/x.md" };
      },
      setExitCode: () => {},
      stdout: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["bootstrap", "--plan"], { from: "user" });
    // No requirements provided, should resolve to empty array
    expect(receivedDocs).toEqual([]);
  });

  it("sets exit code 2 for BootstrapSizeError", async () => {
    let exitCode = 0;
    const deps: BootstrapCommandDeps = {
      planFn: async () => {
        const { BootstrapSizeError } = await import(
          "../../../src/bootstrap/bootstrap-service.js"
        );
        throw new BootstrapSizeError("too large", {
          ok: false,
          totalTokens: 100000,
          threshold: 80000,
        });
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      stdout: () => {},
      stderr: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["bootstrap", "--plan"], { from: "user" });
    expect(exitCode).toBe(2);
  });

  it("sets exit code 1 for generic errors", async () => {
    let exitCode = 0;
    const deps: BootstrapCommandDeps = {
      planFn: async () => {
        throw new Error("generic error");
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      stdout: () => {},
      stderr: () => {},
    };
    const program = makeProgram(deps);
    await program.parseAsync(["bootstrap", "--plan"], { from: "user" });
    expect(exitCode).toBe(1);
  });

  it("outputs plan ID and next steps", async () => {
    const output: string[] = [];
    const deps: BootstrapCommandDeps = {
      planFn: async () => ({
        planId: "bootstrap-20260823-test",
        markdownPath: "/tmp/plan.md",
      }),
      setExitCode: () => {},
      stdout: (msg) => output.push(msg),
    };
    const program = makeProgram(deps);
    await program.parseAsync(["bootstrap", "--plan"], { from: "user" });
    expect(output.join("\n")).toContain("bootstrap-20260823-test");
    expect(output.join("\n")).toContain("autopilot bootstrap --apply");
  });
});
