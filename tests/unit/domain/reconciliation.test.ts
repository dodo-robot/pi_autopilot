import { describe, expect, it } from "vitest";
import {
  BacklogPatchSchema,
  CoverageEntrySchema,
} from "../../../src/domain/reconciliation.js";

const validCoverageEntry = {
  requirementId: "REQ-AUTH-001",
  description: "Users can reset a forgotten password",
  epic: 12,
  issues: [15, 16],
  status: "covered" as const,
  evidence: "issue #15 implements the reset flow",
};

describe("CoverageEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(CoverageEntrySchema.safeParse(validCoverageEntry).success).toBe(true);
  });

  it("accepts a null epic and an empty issues list for a missing requirement", () => {
    const result = CoverageEntrySchema.safeParse({
      ...validCoverageEntry,
      epic: null,
      issues: [],
      status: "missing",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status", () => {
    const result = CoverageEntrySchema.safeParse({
      ...validCoverageEntry,
      status: "done",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty requirementId", () => {
    const result = CoverageEntrySchema.safeParse({
      ...validCoverageEntry,
      requirementId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("BacklogPatchSchema", () => {
  it("accepts a KEEP patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "KEEP",
      issue: 15,
      reason: "correct and complete as-is",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an ENRICH_ISSUE patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "ENRICH_ISSUE",
      issue: 16,
      reason: "missing a testable acceptance criterion",
      patch: {
        goal: "Create a user record from a verified GitHub identity",
        sourceRequirements: ["REQ-AUTH-004"],
        acceptanceCriteria: ["A first-time GitHub login creates exactly one user row"],
        constraints: [],
        nonGoals: [],
        validation: ["npm test -- auth"],
        relevantAreas: ["src/auth/"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an ENRICH_ISSUE patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "ENRICH_ISSUE",
      issue: 16,
      reason: "",
      patch: {
        goal: "x",
        sourceRequirements: [],
        acceptanceCriteria: [],
        constraints: [],
        nonGoals: [],
        validation: [],
        relevantAreas: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a CREATE_ISSUE patch with a null epic", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "CREATE_ISSUE",
      epic: null,
      reason: "no existing issue covers session revocation",
      spec: {
        title: "Admin session revocation endpoint",
        enrichment: {
          goal: "An admin can revoke a user's active sessions",
          sourceRequirements: ["REQ-AUTH-009"],
          acceptanceCriteria: ["Revoking a session invalidates its refresh token"],
          constraints: [],
          nonGoals: [],
          validation: ["npm test -- sessions"],
          relevantAreas: ["src/auth/sessions.ts"],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an ADD_DEPENDENCY patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "ADD_DEPENDENCY",
      issue: 17,
      dependsOn: 15,
      reason: "session validation needs the OAuth callback in place first",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a REMOVE_DEPENDENCY patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "REMOVE_DEPENDENCY",
      issue: 15,
      dependsOn: 12,
      reason: "dependency was satisfied by a rearchitecting",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a REMOVE_DEPENDENCY patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "REMOVE_DEPENDENCY",
      issue: 15,
      dependsOn: 12,
      reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a REMOVE_DEPENDENCY patch with a non-positive dependsOn", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "REMOVE_DEPENDENCY",
      issue: 15,
      dependsOn: 0,
      reason: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a SPLIT_ISSUE patch with two children", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "spans two independent behavioral outcomes",
      children: [
        {
          title: "Reject revoked sessions during authentication",
          enrichment: {
            goal: "A revoked session is rejected at the next authentication check",
            sourceRequirements: ["REQ-AUTH-012"],
            acceptanceCriteria: ["A revoked session's token is rejected with 401"],
            constraints: [],
            nonGoals: [],
            validation: ["npm test -- auth"],
            relevantAreas: ["src/auth/"],
          },
        },
        {
          title: "Rate-limit failed logins",
          enrichment: {
            goal: "Repeated failed logins from one account are throttled",
            sourceRequirements: ["REQ-AUTH-013"],
            acceptanceCriteria: ["The 6th failed login within a minute is rejected"],
            constraints: [],
            nonGoals: [],
            validation: ["npm test -- auth"],
            relevantAreas: ["src/auth/"],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a SPLIT_ISSUE patch with fewer than two children", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "too large",
      children: [
        {
          title: "Only one child",
          enrichment: {
            goal: "x",
            sourceRequirements: [],
            acceptanceCriteria: [],
            constraints: [],
            nonGoals: [],
            validation: [],
            relevantAreas: [],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a SPLIT_ISSUE patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "SPLIT_ISSUE",
      issue: 17,
      reason: "",
      children: [
        { title: "A", enrichment: { goal: "x", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } },
        { title: "B", enrichment: { goal: "x", sourceRequirements: [], acceptanceCriteria: [], constraints: [], nonGoals: [], validation: [], relevantAreas: [] } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a MERGE_DUPLICATE patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MERGE_DUPLICATE",
      keep: 120,
      duplicate: 123,
      reason: "both issues describe the same OAuth callback rejection behavior",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a MERGE_DUPLICATE patch with an empty reason", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MERGE_DUPLICATE",
      keep: 120,
      duplicate: 123,
      reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a MERGE_DUPLICATE patch with a non-positive issue number", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MERGE_DUPLICATE",
      keep: 120,
      duplicate: 0,
      reason: "x",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a MARK_STALE patch", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "MARK_STALE",
      issue: 21,
      reason: "browser-stored OAuth tokens were replaced by httpOnly cookies in #40",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a NEEDS_HUMAN patch with a null issue and rejects an empty questions list", () => {
    const withQuestion = BacklogPatchSchema.safeParse({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "CONFLICTING_REQUIREMENTS",
      reason: "REQ-AUTH-002 and REQ-AUTH-011 disagree on session length",
      questions: ["Should sessions expire after 24h (REQ-AUTH-002) or 7d (REQ-AUTH-011)?"],
    });
    expect(withQuestion.success).toBe(true);

    const withoutQuestions = BacklogPatchSchema.safeParse({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "CONFLICTING_REQUIREMENTS",
      reason: "REQ-AUTH-002 and REQ-AUTH-011 disagree on session length",
      questions: [],
    });
    expect(withoutQuestions.success).toBe(false);
  });

  it("rejects an unknown patch type", () => {
    const result = BacklogPatchSchema.safeParse({
      type: "BOGUS_TYPE",
      issue: 17,
      reason: "too large",
    });
    expect(result.success).toBe(false);
  });
});
