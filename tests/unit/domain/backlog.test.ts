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

  it("accepts an issue entry with an optional labelAction", () => {
    const report = parseBacklogReport({
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
          labelAction: "labeled",
        },
      ],
      executable: [42],
      needsWork: [],
      summary: { ready: 1, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
      refinerSessions: 0,
    });
    expect(report.issues[0]!.labelAction).toBe("labeled");
  });

  it("still accepts a report with no labelAction (analyze's existing shape)", () => {
    const report = parseBacklogReport({
      repository: { owner: "acme", repo: "widgets" },
      epicRef: null,
      requestedRefs: [42],
      generatedAt: "2026-08-23T00:00:00Z",
      analysisId: "analyze-1",
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
    });
    expect(report.issues[0]!.labelAction).toBeUndefined();
  });
});
