import { describe, expect, it } from "vitest";
import type { AutopilotConfig } from "../../../src/config/schema.js";
import type { ResolvedRoleModel } from "../../../src/config/load-config.js";
import { DEFAULT_PI_MODEL } from "../../../src/config/load-config.js";
import type { RepositoryContext } from "../../../src/github/repository-context.js";
import {
  resolveIssueRef,
  resolveIssueRefs,
  resolveRefinerModel,
  resolveRefinerTimeout,
} from "../../../src/commands/args.js";

const ctx: RepositoryContext = {
  root: "/tmp/repo",
  repository: { owner: "acme", repo: "widgets" },
  originUrl: "git@github.com:acme/widgets.git",
  currentBranch: "main",
  isClean: true,
};

const config = {
  versions: [],
  schemaVersion: 1,
  workspace: { baseBranch: "main", branchPrefix: "autopilot/", requireCleanCheckout: true, retainBlockedWorktree: true },
  commands: { setup: [], verify: ["npm test"] },
  agents: {},
  agentPolicy: { allowedCommands: [], protectedPaths: [], allowNetwork: false },
  budgets: { refiner: { timeoutMinutes: 5 }, implementation: { timeoutMinutes: 60, maxAttempts: 3 }, review: { timeoutMinutes: 20, maxCorrectionCycles: 2 } },
  publication: { draftPr: false, issueComment: "concise", autoMerge: false },
} as AutopilotConfig;

describe("resolveIssueRef", () => {
  it("accepts a bare issue number", () => {
    expect(resolveIssueRef("42", ctx)).toEqual({ number: 42 });
  });
  it("accepts a qualified ref matching the origin", () => {
    expect(resolveIssueRef("acme/widgets#42", ctx)).toEqual({ number: 42 });
  });
  it("rejects a qualified ref that does not match the origin", () => {
    expect(() => resolveIssueRef("other/repo#42", ctx)).toThrow(/origin/);
  });
  it("rejects a malformed ref", () => {
    expect(() => resolveIssueRef("not-a-ref", ctx)).toThrow(/invalid issue reference/);
  });
});

describe("resolveIssueRefs", () => {
  it("resolves a list, de-duping and preserving order", () => {
    expect(resolveIssueRefs(["28", "29", "28", "acme/widgets#29"], ctx)).toEqual([28, 29]);
  });
  it("rejects a malformed entry", () => {
    expect(() => resolveIssueRefs(["28", "bogus"], ctx)).toThrow(/invalid issue reference/);
  });
});

describe("resolveRefinerModel", () => {
  it("applies CLI overrides with source 'cli'", () => {
    const resolved = resolveRefinerModel({ model: "openai/gpt-5.2", thinking: "high" }, config, undefined);
    expect(resolved).toEqual({
      model: "openai/gpt-5.2",
      thinking: "high",
      source: "cli",
    });
  });
  it("falls back to the Pi default when no override is given", () => {
    const resolved = resolveRefinerModel({}, config, DEFAULT_PI_MODEL);
    expect(resolved.model).toBe(DEFAULT_PI_MODEL.model);
  });
  it("rejects an invalid thinking level", () => {
    expect(() => resolveRefinerModel({ thinking: "turbo" }, config, undefined)).toThrow(/thinking/);
  });
});

describe("resolveRefinerTimeout", () => {
  it("uses the explicit timeout when provided", () => {
    expect(resolveRefinerTimeout(12, config)).toBe(12 * 60_000);
  });
  it("falls back to the policy value when the override is undefined", () => {
    expect(resolveRefinerTimeout(undefined, config)).toBe(5 * 60_000);
  });
});
