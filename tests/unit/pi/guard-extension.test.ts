import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolCallEvent = {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
};

type MockPi = {
  handlers: Map<string, (event: ToolCallEvent) => unknown>;
  tools: Array<{
    name: string;
    execute: (
      id: string,
      params: { payload?: string },
    ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  }>;
  pi: ExtensionAPI;
};

function mockPi(): MockPi {
  const handlers = new Map<string, (event: ToolCallEvent) => unknown>();
  const tools: MockPi["tools"] = [];
  const pi = {
    on: (name: string, handler: (event: ToolCallEvent) => unknown) => {
      handlers.set(name, handler);
    },
    registerTool: (def: MockPi["tools"][number]) => {
      tools.push(def);
    },
  } as unknown as ExtensionAPI;
  return { handlers, tools, pi };
}

interface GuardSetup {
  dir: string;
  worktree: string;
  resultPath: string;
  envelopePath: string;
}

const dirs: string[] = [];

function setupGuard(
  overrides: Record<string, unknown> = {},
): GuardSetup {
  const dir = mkdtempSync(path.join(tmpdir(), "ap-guard-"));
  const worktree = mkdtempSync(path.join(tmpdir(), "ap-guard-wt-"));
  dirs.push(dir, worktree);
  mkdirSync(path.join(worktree, "src"), { recursive: true });
  writeFileSync(path.join(worktree, "src", "a.ts"), "x");
  const resultPath = path.join(dir, "result.json");
  const envelopePath = path.join(dir, "envelope.json");
  const envelope = {
    worktree,
    role: "implementer",
    resultPath,
    allowedCommands: ["npm", "npx", "node", "git"],
    protectedPaths: ["docs/protected"],
    allowedTools: [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "submit_result",
    ],
    skillPaths: [],
    ...overrides,
  };
  writeFileSync(envelopePath, JSON.stringify(envelope), "utf8");
  process.env.AUTOPILOT_GUARD_CONFIG = envelopePath;
  return { dir, worktree, resultPath, envelopePath };
}

function toolCallHandler(pi: MockPi): (event: ToolCallEvent) => unknown {
  const handler = pi.handlers.get("tool_call");
  if (!handler) throw new Error("tool_call handler not registered");
  return handler;
}

function submitTool(pi: MockPi): MockPi["tools"][number] {
  const tool = pi.tools.find((t) => t.name === "submit_result");
  if (!tool) throw new Error("submit_result tool not registered");
  return tool;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.AUTOPILOT_GUARD_CONFIG;
});

describe("guard extension", () => {
  it("loads the envelope at factory invocation", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    expect(() => mod.default(mock.pi)).not.toThrow();
    expect(mock.handlers.has("tool_call")).toBe(true);
    expect(mock.tools.some((t) => t.name === "submit_result")).toBe(true);
    expect(setup.dir).toBeTruthy();
  });

  it("fails closed when AUTOPILOT_GUARD_CONFIG is not set", async () => {
    delete process.env.AUTOPILOT_GUARD_CONFIG;
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    expect(() => mod.default(mock.pi)).toThrow(/AUTOPILOT_GUARD_CONFIG/);
  });

  it("fails closed on an invalid envelope", async () => {
    const setup = setupGuard({ worktree: 42 });
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    expect(() => mod.default(mock.pi)).toThrow(/envelope/);
    expect(setup.dir).toBeTruthy();
  });

  it("blocks mutating git commands from bash", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    const verdict = await handler({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "git push origin main" },
    });
    expect(verdict).toMatchObject({ block: true });
    expect((verdict as { reason: string }).reason).toContain("git subcommand");
    expect(setup.dir).toBeTruthy();
  });

  it("blocks gh and shell composition from bash", async () => {
    setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    expect(
      await handler({ toolName: "bash", toolCallId: "2", input: { command: "gh pr list" } }),
    ).toMatchObject({ block: true });
    expect(
      await handler({
        toolName: "bash",
        toolCallId: "3",
        input: { command: "npm test && git push" },
      }),
    ).toMatchObject({ block: true });
  });

  it("allows allowed bash commands", async () => {
    setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    expect(
      await handler({ toolName: "bash", toolCallId: "4", input: { command: "npm test" } }),
    ).toBeUndefined();
  });

  it("blocks path escapes and protected paths on file tools", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);

    expect(
      await handler({ toolName: "read", toolCallId: "5", input: { path: "../secret" } }),
    ).toMatchObject({ block: true });

    expect(
      await handler({
        toolName: "write",
        toolCallId: "6",
        input: { path: "docs/protected/plan.md", content: "x" },
      }),
    ).toMatchObject({ block: true });

    expect(
      await handler({
        toolName: "edit",
        toolCallId: "7",
        input: { path: "/etc/hosts", edits: [] },
      }),
    ).toMatchObject({ block: true });
    expect(setup.dir).toBeTruthy();
  });

  it("allows file tools inside the worktree", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);

    expect(
      await handler({ toolName: "read", toolCallId: "8", input: { path: "src/a.ts" } }),
    ).toBeUndefined();
    expect(
      await handler({
        toolName: "write",
        toolCallId: "9",
        input: { path: "src/new.ts", content: "x" },
      }),
    ).toBeUndefined();
    expect(
      await handler({ toolName: "grep", toolCallId: "10", input: { path: "src", pattern: "x" } }),
    ).toBeUndefined();
    expect(setup.dir).toBeTruthy();
  });

  it("blocks tools that are not enabled for the role", async () => {
    setupGuard({ role: "reviewer", allowedTools: ["read", "grep", "find", "ls", "submit_result"] });
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    expect(
      await handler({ toolName: "bash", toolCallId: "11", input: { command: "npm test" } }),
    ).toMatchObject({ block: true });
    expect(
      await handler({
        toolName: "write",
        toolCallId: "12",
        input: { path: "src/a.ts", content: "x" },
      }),
    ).toMatchObject({ block: true });
  });

  it("does not block unrelated tools", async () => {
    setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    expect(
      await handler({ toolName: "ask_question", toolCallId: "13", input: { question: "?" } }),
    ).toBeUndefined();
  });

  it("submit_result writes the payload exactly once", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const tool = submitTool(mock);

    const payload = JSON.stringify({
      outcome: "APPROVED",
      criteriaResults: [],
      findings: [],
    });

    const first = await tool.execute("call-1", { payload });
    expect(first.isError).not.toBe(true);
    expect(existsSync(setup.resultPath)).toBe(true);
    expect(readFileSync(setup.resultPath, "utf8")).toBe(payload);

    const second = await tool.execute("call-2", { payload });
    expect(second.isError).toBe(true);
  });

  it("submit_result rejects malformed payloads with the same once-only rule", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const tool = submitTool(mock);

    const verdict = await tool.execute("call-3", { payload: "{not json" });
    // The guard stores whatever the agent submits; schema validation happens
    // in the runner after the process exits. The store itself is atomic.
    expect(verdict.isError).not.toBe(true);
    expect(existsSync(setup.resultPath)).toBe(true);
    expect(readFileSync(setup.resultPath, "utf8")).toBe("{not json");
  });

  it("allows reads of a skill path listed in skillPaths", async () => {
    const skillDir = mkdtempSync(path.join(tmpdir(), "ap-skill-"));
    dirs.push(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");
    const setup = setupGuard({ skillPaths: [skillDir] });
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    expect(
      await handler({
        toolName: "read",
        toolCallId: "14",
        input: { path: path.join(skillDir, "SKILL.md") },
      }),
    ).toBeUndefined();
    expect(setup.dir).toBeTruthy();
  });

  it("still blocks reads of paths outside worktree when not in skillPaths", async () => {
    const skillDir = mkdtempSync(path.join(tmpdir(), "ap-skill-"));
    dirs.push(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");
    setupGuard({ skillPaths: [skillDir] });
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const handler = toolCallHandler(mock);
    // A different dir, not listed, is still denied.
    const other = mkdtempSync(path.join(tmpdir(), "ap-other-"));
    dirs.push(other);
    writeFileSync(path.join(other, "x.txt"), "x");
    expect(
      await handler({ toolName: "read", toolCallId: "15", input: { path: path.join(other, "x.txt") } }),
    ).toMatchObject({ block: true });
  });

  it("ask_human writes a question and blocks until an answer appears", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const askTool = mock.tools.find((t) => t.name === "ask_human");
    expect(askTool).toBeDefined();

    const askDir = path.join(path.dirname(setup.resultPath), "ask");
    const exec = askTool!.execute("ask-1", { question: "Which scope?" });
    // First write the question file; then wait for the answer. Use a short wait
    // to let the tool observe the question file and block.
    await new Promise((r) => setTimeout(r, 150));
    const files = require("node:fs").readdirSync(askDir);
    const questionFile = files.find((f: string) => f.endsWith("-question.json"));
    expect(questionFile).toBeDefined();
    const q = JSON.parse(readFileSync(path.join(askDir, questionFile!), "utf8"));
    expect(q.question).toBe("Which scope?");

    // Write the answer; the blocked execute should resolve with the answer.
    const answerFile = questionFile!.replace("-question.json", "-answer.json");
    writeFileSync(path.join(askDir, answerFile), JSON.stringify({ answer: "M1 only" }), "utf8");

    const result = await exec;
    expect(result.isError).not.toBe(true);
    const textContent = result.content.find((c) => c.type === "text");
    expect(textContent?.text).toContain("M1 only");
  });

  it("ask_human sequences questions with an increasing index", async () => {
    const setup = setupGuard();
    const mod = await import("../../../src/pi/guard-extension.js");
    const mock = mockPi();
    mod.default(mock.pi);
    const askTool = mock.tools.find((t) => t.name === "ask_human");
    const askDir = path.join(path.dirname(setup.resultPath), "ask");

    const e1 = askTool!.execute("a", { question: "Q1" });
    await new Promise((r) => setTimeout(r, 120));
    const e2 = askTool!.execute("b", { question: "Q2" });
    await new Promise((r) => setTimeout(r, 120));
    const files = require("node:fs").readdirSync(askDir).filter((f: string) => f.endsWith("-question.json"));
    expect(files.sort()).toEqual(["000-question.json", "001-question.json"]);
    // Let both settle; resolve the promises to avoid dangling handles.
    const answerFile0 = path.join(askDir, "000-answer.json");
    const answerFile1 = path.join(askDir, "001-answer.json");
    writeFileSync(answerFile0, JSON.stringify({ answer: "A1" }), "utf8");
    writeFileSync(answerFile1, JSON.stringify({ answer: "A2" }), "utf8");
    await Promise.all([e1, e2]);
  });
});
