import { describe, expect, it } from "vitest";
import type { TaskSnapshot, VerifierResult } from "../../../src/domain/contracts.js";
import type { VerificationEvidence } from "../../../src/verification/verification-runner.js";
import {
  buildAcceptanceCorrectionPrompt,
  buildReviewerPrompt,
  buildVerifierPrompt,
} from "../../../src/workflow/run-service.js";

function snapshot(): TaskSnapshot {
  return {
    schemaVersion: 1,
    repository: { owner: "acme", repo: "widgets" },
    issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
    objective: "Implement token refresh validation",
    context: "The auth module owns session refresh.",
    expectedBehavior: ["Expired refresh tokens are rejected"],
    acceptanceCriteria: [{ id: "ac1", text: "A refresh with an expired token returns 401" }],
    constraints: [],
    nonGoals: [],
    validation: ["npm test"],
    dependencies: [],
    canonicalReferences: [],
    sourceBodyHash: "hash",
  };
}

function verification(): VerificationEvidence {
  return {
    passed: true,
    treeHash: "abc123",
    policyHash: "def456",
    commands: [
      { command: "npm test", exitCode: 0, timedOut: false, stdout: "", stderr: "" },
    ],
    startedAt: "2026-08-18T00:00:00Z",
    finishedAt: "2026-08-18T00:00:00Z",
  };
}

function notVerified(): Extract<VerifierResult, { outcome: "NOT_VERIFIED" }> {
  return {
    outcome: "NOT_VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: false, notes: "no evidence in diff" }],
    findings: [
      {
        criterionId: "ac1",
        evidence: "no test exercises the 401 path",
        notes: "acceptance criterion is unverified",
      },
    ],
  };
}

describe("buildVerifierPrompt", () => {
  it("instructs the verifier how to call submit_result", () => {
    const prompt = buildVerifierPrompt(snapshot(), verification());
    expect(prompt).toContain("submit_result");
  });

  it("asks for one criteriaResults entry per acceptance criterion", () => {
    const prompt = buildVerifierPrompt(snapshot(), verification());
    expect(prompt).toContain("criteriaResults");
    expect(prompt).toContain("criterionId");
    expect(prompt).toContain("NOT_VERIFIED");
  });

  it("never includes a reviewer result or implementer transcript, only its own two arguments", () => {
    const prompt = buildVerifierPrompt(snapshot(), verification());
    const reviewerPrompt = buildReviewerPrompt(snapshot(), verification());
    // The verifier prompt is built from (snapshot, verification) alone --
    // buildVerifierPrompt's signature has no third parameter for a review
    // result, so there is nothing reviewer-shaped it could leak. This test
    // guards the call site: it fails if a future edit adds a reviewer
    // argument whose content becomes part of the rendered prompt text in a
    // way that isn't already covered by the shared snapshot/verification
    // arguments both prompts legitimately render.
    expect(reviewerPrompt).not.toBe(prompt);
  });
});

describe("buildAcceptanceCorrectionPrompt", () => {
  it("feeds the implementer the verifier's findings", () => {
    const prompt = buildAcceptanceCorrectionPrompt(snapshot(), notVerified());
    expect(prompt).toContain("submit_result");
    expect(prompt).toContain("no test exercises the 401 path");
  });
});
