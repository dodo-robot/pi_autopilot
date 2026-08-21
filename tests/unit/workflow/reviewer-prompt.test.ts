import { describe, expect, it } from "vitest";
import type { TaskSnapshot } from "../../../src/domain/contracts.js";
import type { VerificationEvidence } from "../../../src/verification/verification-runner.js";
import { buildReviewerPrompt } from "../../../src/workflow/run-service.js";

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
      {
        command: "npm test",
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
      },
    ],
    startedAt: "2026-08-18T00:00:00Z",
    finishedAt: "2026-08-18T00:00:00Z",
  };
}

describe("buildReviewerPrompt", () => {
  it("instructs the reviewer how to call submit_result", () => {
    const prompt = buildReviewerPrompt(snapshot(), verification());
    expect(prompt).toContain("submit_result");
  });

  it("includes the exact reviewer result schema example so the reviewer produces criteriaResults", () => {
    const prompt = buildReviewerPrompt(snapshot(), verification());
    // The reviewer must know APPROVED requires criteriaResults + findings,
    // otherwise a provider may submit an APPROVED result missing them
    // (a validated-reviewer result that fails RunStageSchema on the review path).
    expect(prompt).toContain("criteriaResults");
    expect(prompt).toContain("criterionId");
    expect(prompt).toContain("passed");
    expect(prompt).toContain("findings");
    expect(prompt).toMatch(/criteriaResults[\s\S]*criterionId/);
  });
});
