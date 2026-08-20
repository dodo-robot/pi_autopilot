import { describe, expect, it } from "vitest";
import {
  dependencyNumberFromMatch,
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
} from "../../../src/analysis/dependency-markers.js";

describe("dependency-markers", () => {
  it("MANAGED_DEPENDENCY_PATTERN matches the rendered - #n (unsatisfied) line", () => {
    const body = "- [ ] do a thing\n- #12 (unsatisfied)\n- #34 (unsatisfied)";
    const matches = [...body.matchAll(MANAGED_DEPENDENCY_PATTERN)];
    expect(matches.map((m) => dependencyNumberFromMatch(m))).toEqual([12, 34]);
  });

  it("LINE_DEPENDENCY_PATTERN matches depends-on and dependency line variants", () => {
    const body = [
      "depends on: #12",
      "depend on #34",
      "Dependency: 56",
      "dependency 78",
      "See #99 for background",
    ].join("\n");
    const matches = [...body.matchAll(LINE_DEPENDENCY_PATTERN)];
    expect(matches.map((m) => dependencyNumberFromMatch(m))).toEqual([
      12, 34, 56, 78,
    ]);
  });

  it("dependencyNumberFromMatch never yields NaN for a real capture", () => {
    const match = [..."depends on: #7".matchAll(LINE_DEPENDENCY_PATTERN)][0]!;
    expect(dependencyNumberFromMatch(match)).toBe(7);
    expect(Number.isNaN(dependencyNumberFromMatch(match))).toBe(false);
  });
});
