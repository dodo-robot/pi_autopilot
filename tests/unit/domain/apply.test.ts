import { describe, expect, it } from "vitest";
import { ApplyReportSchema } from "../../../src/domain/apply.js";

describe("ApplyReportSchema", () => {
  it("parses a report with applied, skipped, and failed entries", () => {
    const report = {
      repository: { owner: "acme", repo: "widgets" },
      analysisId: "reconcile-1-12",
      appliedAt: "2026-08-23T00:00:00.000Z",
      staleness: { staleAgeHours: 0.5, guardApplied: true, overriddenByForce: false },
      entries: [
        {
          patchType: "CREATE_ISSUE",
          targetIssue: null,
          policy: "auto-safe",
          outcome: { status: "applied" },
          detail: "created 'New widget'",
          appliedIssueNumber: 30,
        },
        {
          patchType: "ENRICH_ISSUE",
          targetIssue: 15,
          policy: "auto-safe",
          outcome: { status: "skipped", skippedBy: "idempotent" },
          detail: "already reflects enrichment",
        },
        {
          patchType: "MARK_STALE",
          targetIssue: 16,
          policy: "requires-approval",
          outcome: { status: "skipped", skippedBy: "requires-approval" },
          detail: "superseded",
        },
        {
          patchType: "ADD_DEPENDENCY",
          targetIssue: 15,
          policy: "auto-safe",
          outcome: { status: "failed", error: "github 409" },
          detail: "#15 depends on #16",
        },
        {
          patchType: "ENRICH_ISSUE",
          targetIssue: 18,
          policy: "auto-safe",
          outcome: { status: "skipped", skippedBy: "user" },
          detail: "declined",
          declineReason: "not worth the churn",
        },
      ],
      summary: {
        applied: 1,
        skippedRequiresApproval: 1,
        skippedIdempotent: 1,
        skippedUser: 1,
        failed: 1,
        previewed: 0,
      },
    };

    const parsed = ApplyReportSchema.parse(report);
    expect(parsed.entries).toHaveLength(5);
    expect(parsed.entries[0]).toMatchObject({
      patchType: "CREATE_ISSUE",
      appliedIssueNumber: 30,
    });
    expect(parsed.entries[1].outcome).toEqual({ status: "skipped", skippedBy: "idempotent" });
    expect(parsed.entries[4]).toMatchObject({ outcome: { status: "skipped", skippedBy: "user" }, declineReason: "not worth the churn" });
  });

  it("rejects an entry with an unknown outcome status", () => {
    const bad = {
      repository: { owner: "acme", repo: "widgets" },
      analysisId: "reconcile-1-12",
      appliedAt: "2026-08-23T00:00:00.000Z",
      staleness: { staleAgeHours: 0.5, guardApplied: true, overriddenByForce: false },
      entries: [{ patchType: "KEEP", targetIssue: 15, policy: "requires-approval", outcome: { status: "bogus" }, detail: "x" }],
      summary: { applied: 0, skippedRequiresApproval: 0, skippedIdempotent: 0, skippedUser: 0, failed: 0, previewed: 0 },
    };
    expect(() => ApplyReportSchema.parse(bad)).toThrow();
  });
});
