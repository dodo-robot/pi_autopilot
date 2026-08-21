import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli.js";
import type { CliDeps } from "../../../src/cli.js";
import { RunStore } from "../../../src/persistence/run-store.js";

let tempDirs: string[] = [];

function makeHarness(): {
  exitCodes: number[];
  stdoutLines: string[];
  stderrLines: string[];
  run: (args: string[]) => Promise<unknown>;
  store: RunStore;
} {
  const exitCodes: number[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), "ap-runs-cmd-"));
  tempDirs.push(dataDir);

  const deps: CliDeps = {
    dataDir,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    setExitCode: (code) => exitCodes.push(code),
  };

  const store = new RunStore(path.join(dataDir, "autopilot.db"));
  const run = (args: string[]) =>
    buildProgram(deps).parseAsync(["node", "autopilot", ...args]);

  return { exitCodes, stdoutLines, stderrLines, run, store };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("autopilot runs", () => {
  it("lists runs newest first with stage, issue, and run id", async () => {
    const { run, store, stdoutLines } = makeHarness();
    const a = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 42 });
    store.transition(a.id, "PREFLIGHT", "FAILED", null, { resumeAt: "INDEPENDENT_REVIEW" });
    const b = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 43 });

    await run(["runs"]);

    const output = stdoutLines.join("\n");
    expect(output).toContain("FAILED");
    expect(output).toContain("acme/widgets#42");
    expect(output).toContain("acme/widgets#43");
    // Newest first: b's row appears before a's in the joined output.
    expect(output.indexOf(b.id)).toBeLessThan(output.indexOf(a.id));
  });

  it("emits machine-readable JSON with --json", async () => {
    const { run, store, stdoutLines } = makeHarness();
    const a = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 42 });
    store.transition(a.id, "PREFLIGHT", "FAILED", null, { resumeAt: "INDEPENDENT_REVIEW" });

    await run(["runs", "--json"]);

    const parsed = JSON.parse(stdoutLines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      id: a.id,
      issueNumber: 42,
      stage: "FAILED",
      resumeAt: "INDEPENDENT_REVIEW",
    });
  });

  it("honors --limit and --issue filters", async () => {
    const { run, store, stdoutLines } = makeHarness();
    const a = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 42 });
    const b = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 43 });
    const c = store.createRun({ repository: { owner: "acme", repo: "other" }, issueNumber: 7 });

    await run(["runs", "--limit", "1"]);
    let output = stdoutLines.join("\n");
    expect(output).toContain(c.id);
    expect(output).not.toContain(a.id);

    stdoutLines.length = 0;
    await run(["runs", "--issue", "acme/widgets#42"]);
    output = stdoutLines.join("\n");
    expect(output).toContain(a.id);
    expect(output).not.toContain(b.id);
    expect(output).not.toContain(c.id);
  });
});
