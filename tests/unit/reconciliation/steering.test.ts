import { describe, expect, it } from "vitest";
import type { ApplyReport } from "../../../src/domain/apply.js";
import { extractDeclines } from "../../../src/reconciliation/steering.js";

const base: ApplyReport = {
  repository: { owner: "acme", repo: "widgets" },
  analysisId: "reconcile-1-12",
  appliedAt: "2026-08-25T00:00:00Z",
  staleness: { staleAgeHours: 1, guardApplied: true, overriddenByForce: false },
  entries: [],
  summary: {
    applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0,
    skippedUser: 0, failed: 0, previewed: 0,
  },
};

describe("extractDeclines", () => {
  it("returns only skipped-by-user entries with a target issue, carrying the declineReason", () => {
    const report: ApplyReport = {
      ...base,
      entries: [
        { patchType: "ENRICH_ISSUE", targetIssue: 7, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "enrich #7", declineReason: "waiting on product decision" },
        { patchType: "ADD_DEPENDENCY", targetIssue: 8, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "dep #8" },
        { patchType: "ENRICH_ISSUE", targetIssue: 9, policy: "auto-safe", outcome: { status: "applied" }, detail: "applied", appliedIssueNumber: 9 },
        { patchType: "ENRICH_ISSUE", targetIssue: 10, policy: "auto-safe", outcome: { status: "skipped", skippedBy: "idempotent" }, detail: "already" },
        { patchType: "REMOVE_DEPENDENCY", targetIssue: 11, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "requires-approval" }, detail: "gate" },
        { patchType: "ENRICH_ISSUE", targetIssue: 12, policy: "auto-safe", outcome: { status: "failed", error: "boom" }, detail: "failed" },
        { patchType: "NEEDS_HUMAN", targetIssue: 13, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "answered" },
      ],
    };
    expect(extractDeclines(report)).toEqual([
      { patchType: "ENRICH_ISSUE", targetIssue: 7, reason: "waiting on product decision" },
      { patchType: "ADD_DEPENDENCY", targetIssue: 8 },
      { patchType: "NEEDS_HUMAN", targetIssue: 13 },
    ]);
  });

  it("drops skipped-by-user entries whose targetIssue is null", () => {
    const report: ApplyReport = {
      ...base,
      entries: [
        { patchType: "NEEDS_HUMAN", targetIssue: null, policy: "requires-approval", outcome: { status: "skipped", skippedBy: "user" }, detail: "no target" },
      ],
    };
    expect(extractDeclines(report)).toEqual([]);
  });

  it("returns an empty array for a report with no declines", () => {
    expect(extractDeclines(base)).toEqual([]);
  });
});
