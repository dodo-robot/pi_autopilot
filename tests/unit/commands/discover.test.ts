import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerDiscoverCommand } from "../../../src/commands/discover.js";
import type { DiscoverCommandDeps } from "../../../src/commands/discover.js";
import type { BacklogReport } from "../../../src/domain/backlog.js";

function makeProgram(deps: DiscoverCommandDeps) {
  const program = new Command();
  program.exitOverride();
  registerDiscoverCommand(program, deps);
  return program;
}

function baseReport(overrides: Partial<BacklogReport> = {}): BacklogReport {
  return {
    repository: { owner: "acme", repo: "widgets" },
    epicRef: null,
    requestedRefs: [42],
    generatedAt: "2026-08-23T00:00:00Z",
    analysisId: "discover-1",
    scope: { totalIssues: 1, analyzed: 1, unresolved: 0 },
    issues: [
      {
        issueNumber: 42,
        title: "Fix widget",
        url: "https://github.com/acme/widgets/issues/42",
        classification: "READY",
        screen: { classification: "READY", reasons: [] },
        readiness: null,
      },
    ],
    executable: [42],
    needsWork: [],
    summary: { ready: 1, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
    refinerSessions: 0,
    ...overrides,
  };
}

describe("discover command", () => {
  it("labels a READY issue with no existing labels", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const messages: string[] = [];
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => [],
      addLabel,
      removeLabel,
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["discover", "42"], { from: "user" });
    expect(addLabel).toHaveBeenCalledWith(42, "agent:ready");
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it("unlabels a non-READY issue that currently has agent:ready", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport({
        issues: [{
          issueNumber: 42, title: "Fix widget", url: "https://github.com/acme/widgets/issues/42",
          classification: "NEEDS_REFINEMENT", screen: { classification: "NEEDS_REFINEMENT", reasons: [] }, readiness: null,
        }],
        executable: [], needsWork: [42],
        summary: { ready: 0, needsRefinement: 1, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
      }),
      listLabels: async () => ["agent:ready"],
      addLabel,
      removeLabel,
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["discover", "42"], { from: "user" });
    expect(removeLabel).toHaveBeenCalledWith(42, "agent:ready");
    expect(addLabel).not.toHaveBeenCalled();
  });

  it("never touches labels on an issue with agent:in-progress", async () => {
    const addLabel = vi.fn();
    const removeLabel = vi.fn();
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => ["agent:in-progress"],
      addLabel,
      removeLabel,
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["discover", "42"], { from: "user" });
    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it("includes labelAction in --json output", async () => {
    const messages: string[] = [];
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport(),
      listLabels: async () => [],
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
      stdout: (t) => messages.push(t),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["discover", "42", "--json"], { from: "user" });
    const parsed = JSON.parse(messages.join(""));
    expect(parsed.issues[0].labelAction).toBe("labeled");
  });

  it("continues processing remaining issues when one issue's label write fails", async () => {
    const addLabel = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValue(undefined);
    const deps: DiscoverCommandDeps = {
      analyze: async () => baseReport({
        requestedRefs: [42, 43],
        scope: { totalIssues: 2, analyzed: 2, unresolved: 0 },
        issues: [
          { issueNumber: 42, title: "A", url: "u1", classification: "READY", screen: { classification: "READY", reasons: [] }, readiness: null },
          { issueNumber: 43, title: "B", url: "u2", classification: "READY", screen: { classification: "READY", reasons: [] }, readiness: null },
        ],
        executable: [42, 43],
        summary: { ready: 2, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
      }),
      listLabels: async () => [],
      addLabel,
      removeLabel: vi.fn(),
      stdout: vi.fn(),
      setExitCode: vi.fn(),
    };
    await makeProgram(deps).parseAsync(["discover", "42", "43"], { from: "user" });
    expect(addLabel).toHaveBeenCalledTimes(2);
  });
});
