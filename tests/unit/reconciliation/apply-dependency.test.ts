import { describe, expect, it } from "vitest";
import {
  appendDependencyToBody,
  bodyAlreadyDependsOn,
  renderDependencyLine,
} from "../../../src/reconciliation/apply-dependency.js";

describe("renderDependencyLine", () => {
  it("renders the managed dependency-marker line", () => {
    expect(renderDependencyLine(16)).toBe("- #16 (unsatisfied)");
  });
});

describe("appendDependencyToBody", () => {
  it("appends the dependency line, separating from existing content", () => {
    const body = "Do the oauth thing.";
    expect(appendDependencyToBody(body, 16)).toBe(
      "Do the oauth thing.\n\nDepends on:\n- #16 (unsatisfied)",
    );
  });

  it("preserves existing content and keeps the dependency grammar at line start", () => {
    const body = "Body here.";
    const out = appendDependencyToBody(body, 7);
    expect(out).toBe("Body here.\n\nDepends on:\n- #7 (unsatisfied)");
    // the rendered dependency must satisfy the downstream BLOCKED/screen
    // grammar: extend dependency-markers LINE_DEPENDENCY_PATTERN matches
    // a line that starts with `- #7 (unsatisfied)`.
    expect(out).toContain("- #7 (unsatisfied)");
  });
});

describe("bodyAlreadyDependsOn", () => {
  it("detects an existing managed dependency marker", () => {
    const body = "goal\n\nDepends on:\n- #16 (unsatisfied)";
    expect(bodyAlreadyDependsOn(body, 16)).toBe(true);
    expect(bodyAlreadyDependsOn(body, 15)).toBe(false);
  });

  it("detects an explicit line-start dependency", () => {
    const body = "depends on: #12\nmore";
    expect(bodyAlreadyDependsOn(body, 12)).toBe(true);
  });
});
