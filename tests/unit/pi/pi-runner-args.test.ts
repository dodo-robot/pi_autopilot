import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiRunner } from "../../../src/pi/pi-runner.js";
import type { PiRunRequest } from "../../../src/pi/pi-runner.js";
import type { ProcessRequest, ProcessResult } from "../../../src/platform/process-runner.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";

const dirs: string[] = [];

function makeRequest(overrides: Partial<PiRunRequest> = {}): PiRunRequest {
  const diagnosticsDir = mkdtempSync(path.join(tmpdir(), "ap-arg-diag-"));
  const sessionDir = mkdtempSync(path.join(tmpdir(), "ap-arg-session-"));
  dirs.push(diagnosticsDir, sessionDir);
  const model: ResolvedRoleModel = { model: "test/model", thinking: "high", source: "pi-default" };
  return {
    role: "bootstrapper",
    model,
    prompt: "Build a plan.",
    worktree: mkdtempSync(path.join(tmpdir(), "ap-arg-wt-")),
    allowedCommands: [],
    protectedPaths: [],
    sessionDir,
    diagnosticsDir,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5000,
    ...overrides,
  };
}

/** Captures the args and writes a plausible reviewer-ish result file. */
class CapturingRunner {
  calls: ProcessRequest[] = [];
  diagnosticsDir: string;
  constructor() {
    this.diagnosticsDir = "";
  }
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    // Locate the result path from the guard envelope url the runner wrote.
    const envelopePath = request.env.AUTOPILOT_GUARD_CONFIG;
    if (envelopePath) {
      const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as {
        resultPath: string;
        role: string;
        skillPaths?: string[];
      };
      const validResult =
        envelope.role === "bootstrapper"
          ? {
              projectBoard: { title: "T", columns: ["Todo"] },
              epics: [],
              dependencies: [],
              tracks: [],
            }
          : { outcome: "COMPLETED" };
      writeFileSync(envelope.resultPath, JSON.stringify(validResult), "utf8");
      this.diagnosticsDir = path.dirname(envelope.resultPath);
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 10, timedOut: false };
  }
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("PiRunner arg propagation", () => {
  it("passes --skill for each provided skill path", async () => {
    const runner = new CapturingRunner();
    const request = makeRequest({ skills: ["/skills/brainstorming/SKILL.md"] });
    await new PiRunner(runner as never).run(request);
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0].args;
    const skillFlag = args.indexOf("--skill");
    expect(skillFlag).toBeGreaterThan(-1);
    expect(args[skillFlag + 1]).toBe("/skills/brainstorming/SKILL.md");
  });

  it("includes skillPaths in the guard envelope", async () => {
    const runner = new CapturingRunner();
    const request = makeRequest({ skillPaths: ["/skills/brainstorming"] });
    await new PiRunner(runner as never).run(request);
    const envelopePath = runner.calls[0].env.AUTOPILOT_GUARD_CONFIG;
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as { skillPaths?: string[] };
    expect(envelope.skillPaths).toEqual(["/skills/brainstorming"]);
  });

  it("defaults skillPaths to empty array when omitted", async () => {
    const runner = new CapturingRunner();
    await new PiRunner(runner as never).run(makeRequest());
    const envelopePath = runner.calls[0].env.AUTOPILOT_GUARD_CONFIG;
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as { skillPaths?: string[] };
    expect(envelope.skillPaths).toEqual([]);
  });
});
