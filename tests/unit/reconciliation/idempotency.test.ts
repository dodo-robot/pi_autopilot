import { describe, expect, it } from "vitest";
import type { BacklogPatch, IssueEnrichment } from "../../../src/domain/reconciliation.js";
import { applyIdempotencyDowngrades } from "../../../src/reconciliation/idempotency.js";
import {
  RECONCILIATION_START,
  upsertReconciliationSection,
} from "../../../src/reconciliation/managed-section.js";

function enrichment(overrides: Partial<IssueEnrichment> = {}): IssueEnrichment {
  return {
    goal: "Create a user record from a verified GitHub identity",
    sourceRequirements: ["REQ-AUTH-004"],
    acceptanceCriteria: ["A first-time GitHub login creates exactly one user row"],
    constraints: [],
    nonGoals: [],
    validation: ["npm test -- auth"],
    relevantAreas: ["src/auth/"],
    ...overrides,
  };
}

describe("applyIdempotencyDowngrades", () => {
  it("downgrades an ENRICH_ISSUE patch to KEEP when the issue already carries the identical proposed section", () => {
    const already = upsertReconciliationSection("Original body", enrichment());
    const patches: BacklogPatch[] = [
      { type: "ENRICH_ISSUE", issue: 16, reason: "add contract", patch: enrichment() },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 16, title: "Create user from GitHub identity", body: already, state: "open" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 16 });
  });

  it("leaves an ENRICH_ISSUE patch unchanged when the issue's current section differs", () => {
    const patches: BacklogPatch[] = [
      { type: "ENRICH_ISSUE", issue: 16, reason: "add contract", patch: enrichment() },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 16, title: "Create user from GitHub identity", body: "Original body, no section yet", state: "open" },
    ]);
    expect(result.type).toBe("ENRICH_ISSUE");
  });

  it("downgrades an ADD_DEPENDENCY patch to KEEP when the dependency marker is already present", () => {
    const patches: BacklogPatch[] = [
      { type: "ADD_DEPENDENCY", issue: 17, dependsOn: 15, reason: "ordering" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "depends on: #15\n", state: "open" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 17 });
  });

  it("leaves an ADD_DEPENDENCY patch unchanged when no marker references it", () => {
    const patches: BacklogPatch[] = [
      { type: "ADD_DEPENDENCY", issue: 17, dependsOn: 15, reason: "ordering" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "no dependency markers here", state: "open" },
    ]);
    expect(result.type).toBe("ADD_DEPENDENCY");
  });

  it("downgrades a REMOVE_DEPENDENCY patch to KEEP when the managed marker is already absent", () => {
    const patches: BacklogPatch[] = [
      { type: "REMOVE_DEPENDENCY", issue: 17, dependsOn: 15, reason: "no longer needed" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "no dependency markers here", state: "open" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 17 });
  });

  it("leaves a REMOVE_DEPENDENCY patch unchanged when the managed marker is still present", () => {
    const patches: BacklogPatch[] = [
      { type: "REMOVE_DEPENDENCY", issue: 17, dependsOn: 15, reason: "no longer needed" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "Depends on:\n- #15 (unsatisfied)", state: "open" },
    ]);
    expect(result.type).toBe("REMOVE_DEPENDENCY");
  });

  it("downgrades a REMOVE_DEPENDENCY patch to KEEP when the dependency is only present as free text", () => {
    const patches: BacklogPatch[] = [
      { type: "REMOVE_DEPENDENCY", issue: 17, dependsOn: 15, reason: "no longer needed" },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 17, title: "Validate sessions", body: "depends on: #15\n", state: "open" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 17 });
  });

  it("downgrades a SPLIT_ISSUE patch to KEEP when the parent body already lists all proposed children", () => {
    const patches: BacklogPatch[] = [
      {
        type: "SPLIT_ISSUE",
        issue: 20,
        reason: "spans two independent behavioral outcomes",
        children: [
          { title: "Reject revoked sessions during authentication", enrichment: enrichment() },
          { title: "Rate-limit failed logins", enrichment: enrichment() },
        ],
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      {
        number: 20,
        title: "Auth hardening",
        body:
          "<!-- autopilot-split:start -->\n## Split into\n\n" +
          "- [ ] #124 Reject revoked sessions during authentication\n" +
          "- [ ] #125 Rate-limit failed logins\n" +
          "<!-- autopilot-split:end -->",
        state: "open",
      },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 20 });
  });

  it("leaves a SPLIT_ISSUE patch unchanged when the parent body is missing one of the proposed children", () => {
    const patches: BacklogPatch[] = [
      {
        type: "SPLIT_ISSUE",
        issue: 20,
        reason: "spans two independent behavioral outcomes",
        children: [
          { title: "Reject revoked sessions during authentication", enrichment: enrichment() },
          { title: "Rate-limit failed logins", enrichment: enrichment() },
        ],
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      {
        number: 20,
        title: "Auth hardening",
        body:
          "<!-- autopilot-split:start -->\n## Split into\n\n" +
          "- [ ] #124 Reject revoked sessions during authentication\n" +
          "<!-- autopilot-split:end -->",
        state: "open",
      },
    ]);
    expect(result.type).toBe("SPLIT_ISSUE");
  });

  it("leaves a SPLIT_ISSUE patch unchanged when the parent body has no split section at all", () => {
    const patches: BacklogPatch[] = [
      {
        type: "SPLIT_ISSUE",
        issue: 20,
        reason: "spans two independent behavioral outcomes",
        children: [
          { title: "Reject revoked sessions during authentication", enrichment: enrichment() },
          { title: "Rate-limit failed logins", enrichment: enrichment() },
        ],
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 20, title: "Auth hardening", body: "Original body, no section yet", state: "open" },
    ]);
    expect(result.type).toBe("SPLIT_ISSUE");
  });

  it("downgrades a CREATE_ISSUE patch to KEEP of the matching issue on an exact (case-insensitive) title match", () => {
    const patches: BacklogPatch[] = [
      {
        type: "CREATE_ISSUE",
        epic: 12,
        reason: "missing coverage",
        spec: { title: "  admin session revocation endpoint  ", enrichment: enrichment() },
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 30, title: "Admin session revocation endpoint", body: "already exists", state: "open" },
    ]);
    expect(result).toMatchObject({ type: "KEEP", issue: 30 });
  });

  it("leaves a CREATE_ISSUE patch unchanged when no existing issue matches its title", () => {
    const patches: BacklogPatch[] = [
      {
        type: "CREATE_ISSUE",
        epic: 12,
        reason: "missing coverage",
        spec: { title: "Admin session revocation endpoint", enrichment: enrichment() },
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 30, title: "Something unrelated", body: "", state: "open" },
    ]);
    expect(result.type).toBe("CREATE_ISSUE");
  });

  it("downgrades an ENRICH_ISSUE patch to NEEDS_HUMAN when the issue body has ambiguous managed-section markers, instead of throwing", () => {
    const ambiguousBody = `${RECONCILIATION_START}\nold\n${RECONCILIATION_START}\nolder`;
    const patches: BacklogPatch[] = [
      { type: "ENRICH_ISSUE", issue: 16, reason: "add contract", patch: enrichment() },
    ];

    const result = applyIdempotencyDowngrades(patches, [
      { number: 16, title: "Create user from GitHub identity", body: ambiguousBody, state: "open" },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        type: "NEEDS_HUMAN",
        issue: 16,
        ambiguityType: "MISSING_CONTEXT",
      }),
    ]);
  });

  it("passes KEEP, MARK_STALE, and NEEDS_HUMAN patches through unchanged", () => {
    const patches: BacklogPatch[] = [
      { type: "KEEP", issue: 1, reason: "fine" },
      { type: "MARK_STALE", issue: 2, reason: "superseded" },
      {
        type: "NEEDS_HUMAN",
        issue: null,
        ambiguityType: "PRODUCT",
        reason: "unclear",
        questions: [{ question: "?", recommendation: "?" }],
      },
    ];
    const result = applyIdempotencyDowngrades(patches, []);
    expect(result).toEqual(patches);
  });

  it("downgrades a MERGE_DUPLICATE patch to KEEP when the duplicate issue is already closed", () => {
    const patches: BacklogPatch[] = [
      {
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 123,
        reason: "same behavioral outcome",
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 120, title: "OAuth callback", body: "", state: "open" },
      { number: 123, title: "OAuth callback (dup)", body: "", state: "closed" },
    ]);
    expect(result).toEqual({
      type: "KEEP",
      issue: 123,
      reason: "already closed as a duplicate of #120",
    });
  });

  it("leaves a MERGE_DUPLICATE patch unchanged when the duplicate issue is still open", () => {
    const patches: BacklogPatch[] = [
      {
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 123,
        reason: "same behavioral outcome",
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 120, title: "OAuth callback", body: "", state: "open" },
      { number: 123, title: "OAuth callback (dup)", body: "", state: "open" },
    ]);
    expect(result).toEqual(patches[0]);
  });

  it("leaves a MERGE_DUPLICATE patch unchanged when the duplicate issue is not in the provided issue list", () => {
    const patches: BacklogPatch[] = [
      {
        type: "MERGE_DUPLICATE",
        keep: 120,
        duplicate: 999,
        reason: "same behavioral outcome",
      },
    ];
    const [result] = applyIdempotencyDowngrades(patches, [
      { number: 120, title: "OAuth callback", body: "", state: "open" },
    ]);
    expect(result).toEqual(patches[0]);
  });
});
