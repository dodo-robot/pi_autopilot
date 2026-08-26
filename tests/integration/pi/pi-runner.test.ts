import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PiRunError, PiRunner } from "../../../src/pi/pi-runner.js";
import type { PiRunRequest } from "../../../src/pi/pi-runner.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";

const fakePiPath = fileURLToPath(
  new URL("../../fixtures/pi/fake-pi.mjs", import.meta.url),
);

const dirs: string[] = [];

function makeRequest(overrides: Partial<PiRunRequest> = {}): PiRunRequest {
  const worktree = mkdtempSync(path.join(tmpdir(), "ap-wt-"));
  const sessionDir = mkdtempSync(path.join(tmpdir(), "ap-session-"));
  const diagnosticsDir = mkdtempSync(path.join(tmpdir(), "ap-diag-"));
  dirs.push(worktree, sessionDir, diagnosticsDir);

  const model: ResolvedRoleModel = {
    model: "test/model",
    thinking: "high",
    source: "pi-default",
  };

  return {
    role: "reviewer",
    model,
    prompt: "Review the changes. SCENARIO:valid-reviewer",
    worktree,
    allowedCommands: ["npm", "npx", "node"],
    protectedPaths: [],
    sessionDir,
    diagnosticsDir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    timeoutMs: 5_000,
    piCommand: fakePiPath,
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("PiRunner", () => {
  it("accepts a valid reviewer result", async () => {
    const request = makeRequest();
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ outcome: "APPROVED" });
    expect(execution.exitCode).toBe(0);
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(execution.resultPath)).toBe(true);
    // Guard envelope is persisted for diagnosis.
    expect(
      existsSync(path.join(request.diagnosticsDir, "guard-envelope.json")),
    ).toBe(true);
  });

  it("accepts a valid verifier result", async () => {
    const request = makeRequest({
      role: "verifier",
      prompt: "Verify the acceptance criteria. SCENARIO:valid-verifier",
    });
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ outcome: "VERIFIED" });
  });

  it("rejects a verifier result that fails the role schema", async () => {
    const request = makeRequest({
      role: "verifier",
      prompt: "Verify the acceptance criteria. SCENARIO:invalid-schema",
    });
    await expect(new PiRunner().run(request)).rejects.toThrow(
      "invalid verifier result",
    );
  });

  it("accepts a valid implementer result", async () => {
    const request = makeRequest({
      role: "implementer",
      prompt: "Implement the task. SCENARIO:valid-implementer",
    });
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ outcome: "COMPLETED" });
  });

  it("accepts a valid refiner result", async () => {
    const request = makeRequest({
      role: "refiner",
      prompt: "Analyze the issue. SCENARIO:valid-refiner",
    });
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ outcome: "READY" });
  });

  it("accepts a valid reconciler result", async () => {
    const request = makeRequest({
      role: "reconciler",
      prompt: "Reconcile the epic. SCENARIO:valid-reconciler",
    });
    const execution = await new PiRunner().run(request);
    expect(execution.result).toMatchObject({ coverage: [], patches: [] });
  });

  it("rejects malformed JSON from the role session", async () => {
    const request = makeRequest({
      prompt: "Review the changes. SCENARIO:malformed",
    });
    await expect(new PiRunner().run(request)).rejects.toThrow(
      "invalid reviewer result",
    );
  });

  it("rejects a result that fails the role schema", async () => {
    const request = makeRequest({
      prompt: "Review the changes. SCENARIO:invalid-schema",
    });
    await expect(new PiRunner().run(request)).rejects.toThrow(
      "invalid reviewer result",
    );
  });

  it("rejects a session that exits without submitting a result", async () => {
    const request = makeRequest({ prompt: "Do nothing. SCENARIO:omit" });
    await expect(new PiRunner().run(request)).rejects.toThrow(
      "no structured result submitted by reviewer",
    );
  });

  it("rejects a timed-out session even if it would later submit", async () => {
    const request = makeRequest({
      prompt: "Think forever. SCENARIO:timeout",
      timeoutMs: 400,
    });
    await expect(new PiRunner().run(request)).rejects.toThrow("timed out");
  });

  it("rejects a nonzero exit code", async () => {
    const request = makeRequest({ prompt: "Fail hard. SCENARIO:exit-nonzero" });
    const error = await new PiRunner().run(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiRunError);
    expect((error as PiRunError).message).toMatch(/exited with code 2/);
  });

  it("treats a nonzero exit as failure even when a result file exists", async () => {
    const request = makeRequest({
      prompt: "Submit then fail. SCENARIO:exit-nonzero-after-result",
    });
    await expect(new PiRunner().run(request)).rejects.toThrow(
      "exited with code 2",
    );
  });

  it("exposes diagnostics with the error", async () => {
    const request = makeRequest({ prompt: "Fail hard. SCENARIO:exit-nonzero" });
    const error = await new PiRunner().run(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiRunError);
    const runError = error as PiRunError;
    expect(runError.diagnostics.stdout).toContain("diagnostic");
    expect(runError.diagnostics.resultPath).toContain("result.json");
  });
});
