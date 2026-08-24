import { describe, expect, it } from "vitest";
import {
  normalizePathPattern,
  parseWorkspaceScopeFromIssueBody,
  workspaceScopeReason,
  workspaceScopesConflict,
} from "../../../src/scheduler/workspace-scope.js";
import type { WorkspaceScope } from "../../../src/scheduler/state.js";

const scope = (patterns: string[]): WorkspaceScope => ({ kind: "paths", patterns, source: "issue-contract" });

describe("workspace scope", () => {
  it("parses workspace scope from the autonomous execution contract", () => {
    const body = [
      "Intro",
      "<!-- autopilot-refinement:start -->",
      "## Autonomous execution contract",
      "### Workspace scope",
      "- src/daemon/**",
      "- tests/unit/daemon/**",
      "### Validation",
      "- npm test",
      "<!-- autopilot-refinement:end -->",
    ].join("\n");

    expect(parseWorkspaceScopeFromIssueBody(body)).toEqual({
      kind: "paths",
      patterns: ["src/daemon/**", "tests/unit/daemon/**"],
      source: "issue-contract",
    });
  });

  it("returns unknown when no scope section exists", () => {
    expect(parseWorkspaceScopeFromIssueBody("plain issue body")).toEqual({
      kind: "unknown",
      patterns: [],
      source: "missing",
    });
  });

  it("normalizes leading dot slash and duplicate slashes", () => {
    expect(normalizePathPattern("./src//daemon/**")).toBe("src/daemon/**");
  });

  it("conflicts unknown scope with everything", () => {
    expect(workspaceScopesConflict({ kind: "unknown", patterns: [], source: "missing" }, scope(["src/daemon/**"]))).toBe(true);
    expect(workspaceScopesConflict({ kind: "unknown", patterns: [], source: "missing" }, { kind: "unknown", patterns: [], source: "missing" })).toBe(true);
  });

  it("detects exact and parent-child path conflicts", () => {
    expect(workspaceScopesConflict(scope(["src/daemon/daemon-runner.ts"]), scope(["src/daemon/daemon-runner.ts"]))).toBe(true);
    expect(workspaceScopesConflict(scope(["src/daemon/**"]), scope(["src/daemon/daemon-runner.ts"]))).toBe(true);
    expect(workspaceScopesConflict(scope(["src/daemon"]), scope(["src/daemon/daemon-runner.ts"]))).toBe(true);
  });

  it("treats disjoint top-level paths as non-conflicting", () => {
    expect(workspaceScopesConflict(scope(["src/daemon/**"]), scope(["src/commands/**"]))).toBe(false);
  });

  it("returns human-readable scope reasons", () => {
    expect(workspaceScopeReason(scope(["src/daemon/**"]))).toBe("src/daemon/**");
    expect(workspaceScopeReason({ kind: "unknown", patterns: [], source: "missing" })).toBe("unknown workspace scope");
  });
});
