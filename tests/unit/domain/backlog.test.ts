import { describe, expect, it } from "vitest";
import { parseBacklogReport } from "../../../src/domain/backlog.js";

function validReport() {
  return {
    repository: { owner: "acme", repo: "widgets" },
    epicRef: 28,
    requestedRefs: [28, 101, 102],
    generatedAt: "2026-08-20T00:00:00.000Z",
    analysisId: "analyze-test-1",
    scope: { totalIssues: 3, analyzed: 2, unresolved: 1 },
    issues: [
      {
        issueNumber: 101,
        title: "Add token refresh",
        url: "https://github.com/acme/widgets/issues/101",
        classification: "READY",
        screen: { classification: "READY", reasons: ["has execution contract"] },
        readiness: null,
      },
      {
        issueNumber: 102,
        title: "OAuth callback",
        url: "https://github.com/acme/widgets/issues/102",
        classification: "NEEDS_REFINEMENT",
        screen: { classification: "NEEDS_REFINEMENT", reasons: ["missing acceptance criteria"] },
        readiness: null,
      },
    ],
    executable: [101],
    needsWork: [102],
    summary: { ready: 1, needsRefinement: 1, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 1 },
    refinerSessions: 0,
  };
}

describe("parseBacklogReport", () => {
  it("accepts a valid report", () => {
    expect(parseBacklogReport(validReport()).summary.ready).toBe(1);
  });
  it("round-trips through JSON", () => {
    const parsed = parseBacklogReport(JSON.parse(JSON.stringify(validReport())));
    expect(parsed.executable).toEqual([101]);
  });
  it("rejects an unknown classification", () => {
    const bad = validReport();
    bad.issues[0]!.classification = "BOGUS";
    expect(() => parseBacklogReport(bad)).toThrow();
  });
  it("rejects a negative count", () => {
    const bad = validReport();
    bad.scope.totalIssues = -1;
    expect(() => parseBacklogReport(bad)).toThrow();
  });
});
