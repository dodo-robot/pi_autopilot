import { describe, expect, it } from "vitest";
import {
  buildDependencySnapshots,
  detectDependencyCycles,
  extractDependencyNumbers,
} from "../../../src/scheduler/dependencies.js";

describe("scheduler dependencies", () => {
  it("extracts managed and line dependency markers once", () => {
    const body = [
      "depends on: #10",
      "dependency 11",
      "### Dependencies",
      "- #12 (unsatisfied)",
      "- #10 (unsatisfied)",
    ].join("\n");
    expect(extractDependencyNumbers(body)).toEqual([10, 11, 12]);
  });

  it("detects only issues participating in cycles", () => {
    const cycles = detectDependencyCycles(new Map([
      [1, [2]],
      [2, [3]],
      [3, [1]],
      [4, [1]],
      [5, []],
    ]));
    expect(Array.from(cycles).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("builds hybrid dependency snapshots", async () => {
    const snapshots = await buildDependencySnapshots({
      repository: { owner: "acme", repo: "widgets" },
      issues: [
        { issueNumber: 42, body: "depends on: #10\ndepends on: #11\ndepends on: #12" },
      ],
      now: () => "2026-08-24T00:00:00.000Z",
      getIssueState: async (issueNumber) => issueNumber === 10 ? "closed" : "open",
      hasLocalPrOpen: async (issueNumber) => issueNumber === 11,
    });

    expect(snapshots.get(42)).toEqual([
      { issueNumber: 10, satisfied: true, source: "github-closed", checkedAt: "2026-08-24T00:00:00.000Z" },
      { issueNumber: 11, satisfied: true, source: "local-pr-open", checkedAt: "2026-08-24T00:00:00.000Z" },
      { issueNumber: 12, satisfied: false, source: "unsatisfied", checkedAt: "2026-08-24T00:00:00.000Z" },
    ]);
  });

  it("marks dependency fetch failures as invalid snapshots", async () => {
    const snapshots = await buildDependencySnapshots({
      repository: { owner: "acme", repo: "widgets" },
      issues: [{ issueNumber: 42, body: "depends on: #99" }],
      now: () => "2026-08-24T00:00:00.000Z",
      getIssueState: async () => { throw new Error("not found"); },
      hasLocalPrOpen: async () => false,
    });

    expect(snapshots.get(42)).toEqual([
      { issueNumber: 99, satisfied: false, source: "invalid", checkedAt: "2026-08-24T00:00:00.000Z" },
    ]);
  });
});
