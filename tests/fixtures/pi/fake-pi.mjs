#!/usr/bin/env node
// Controllable fake Pi executable for autopilot runner contract tests.
//
// The PiRunner spawns this instead of the real `pi` CLI. The fake reads the
// guard envelope PiRunner wrote (AUTOPILOT_GUARD_CONFIG), determines the
// role from it, and selects a behavior from a `SCENARIO:<name>` marker in
// the trailing prompt argument. Default behavior is a valid result for the
// envelope's role.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const message = args.at(-1) ?? "";
const scenarioMatch = message.match(/SCENARIO:([A-Za-z0-9_-]+)/);
const envelopePath = process.env.AUTOPILOT_GUARD_CONFIG;
const envelope = envelopePath
  ? JSON.parse(readFileSync(envelopePath, "utf8"))
  : null;
const role = envelope?.role ?? "implementer";
const scenario = scenarioMatch ? scenarioMatch[1] : `valid-${role}`;

// Mirror Pi's session behavior: create the session directory.
const sessionDirIndex = args.indexOf("--session-dir");
if (sessionDirIndex >= 0 && args[sessionDirIndex + 1]) {
  mkdirSync(args[sessionDirIndex + 1], { recursive: true });
}

// Simulate json-mode diagnostic output on stdout.
console.log(JSON.stringify({ type: "diagnostic", role, scenario }));

const DRAFT = {
  schemaVersion: 1,
  repository: { owner: "acme", repo: "widgets" },
  issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
  objective: "Implement token refresh validation",
  context: "The auth module owns session refresh.",
  expectedBehavior: ["Expired refresh tokens are rejected"],
  acceptanceCriteria: [
    { id: "ac1", text: "A refresh with an expired token returns 401" },
  ],
  constraints: [],
  nonGoals: [],
  validation: ["npm test"],
  dependencies: [],
  canonicalReferences: [],
  sourceBodyHash: "abc123",
};

const VALID_PAYLOADS = {
  "valid-refiner": JSON.stringify({
    outcome: "READY",
    taskDraft: DRAFT,
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  }),
  "valid-implementer": JSON.stringify({
    outcome: "COMPLETED",
    summary: "implemented the task",
    changedPaths: ["src/example.ts"],
    commandsAttempted: ["npm test"],
    unresolvedProblems: [],
    evidenceLocations: [],
  }),
  "valid-reviewer": JSON.stringify({
    outcome: "APPROVED",
    findings: [],
  }),
  "valid-verifier": JSON.stringify({
    outcome: "VERIFIED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
  }),
  "valid-reconciler": JSON.stringify({
    coverage: [],
    patches: [],
  }),
  "reconciler-mixed": JSON.stringify({
    coverage: [
      {
        requirementId: "REQ-MIX-001",
        description: "Users can log in via GitHub",
        epic: 12,
        issues: [15],
        status: "covered",
        evidence: "issue #15 implements the callback",
      },
      {
        requirementId: "REQ-MIX-002",
        description: "Users can create an account from a GitHub identity",
        epic: 12,
        issues: [16],
        status: "partial",
        evidence: "issue #16 creates the user row but not the profile",
      },
      {
        requirementId: "REQ-MIX-003",
        description: "Admins can revoke sessions",
        epic: 12,
        issues: [],
        status: "missing",
        evidence: "no matching issue",
      },
      {
        requirementId: "REQ-MIX-004",
        description: "Legacy password login is disabled",
        epic: 12,
        issues: [17],
        status: "implemented",
        evidence: "already removed in src/auth/legacy.ts",
      },
    ],
    patches: [
      { type: "KEEP", issue: 15, reason: "correct as-is" },
      {
        type: "ENRICH_ISSUE",
        issue: 16,
        reason: "missing acceptance criteria",
        patch: {
          goal: "Create a user record from a verified GitHub identity",
          sourceRequirements: ["REQ-MIX-002"],
          acceptanceCriteria: ["A first login creates exactly one user row"],
          constraints: [],
          nonGoals: [],
          validation: ["npm test -- auth"],
          relevantAreas: ["src/auth/"],
        },
      },
      {
        type: "MARK_STALE",
        issue: 17,
        reason: "superseded by the SSO gateway rollout",
      },
      {
        type: "NEEDS_HUMAN",
        issue: null,
        ambiguityType: "PRODUCT",
        reason: "unclear whether the legacy password flow should be deleted or archived",
        questions: [
          {
            question: "Should the legacy password login code be deleted or kept archived?",
            recommendation: "Delete it — the SSO gateway rollout already superseded it.",
          },
        ],
      },
      {
        type: "CREATE_ISSUE",
        epic: 12,
        reason: "no issue covers admin session revocation",
        spec: {
          title: "Admin session revocation endpoint",
          enrichment: {
            goal: "Let an admin revoke a user's active sessions",
            sourceRequirements: ["REQ-MIX-003"],
            acceptanceCriteria: ["An admin can revoke another user's sessions via the API"],
            constraints: [],
            nonGoals: [],
            validation: ["npm test -- sessions"],
            relevantAreas: ["src/auth/"],
          },
        },
      },
    ],
  }),
};

function writeResult(payload) {
  if (!envelope?.resultPath) {
    throw new Error("fake pi: no resultPath in guard envelope");
  }
  writeFileSync(envelope.resultPath, payload, { flag: "wx", mode: 0o600 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  switch (scenario) {
    case "malformed":
      writeResult("{ not valid json");
      break;
    case "invalid-schema":
      writeResult(JSON.stringify({ outcome: "APPROVED" }));
      break;
    case "omit":
      // Exit zero without submitting any result.
      break;
    case "timeout":
      await sleep(30_000);
      break;
    case "exit-nonzero":
      process.exit(2);
      break;
    case "exit-nonzero-after-result":
      writeResult(VALID_PAYLOADS["valid-reviewer"]);
      process.exit(2);
      break;
    default: {
      const payload = VALID_PAYLOADS[scenario];
      if (!payload) {
        console.error(`fake pi: unknown scenario '${scenario}'`);
        process.exit(3);
      }
      writeResult(payload);
    }
  }
}

void main();
