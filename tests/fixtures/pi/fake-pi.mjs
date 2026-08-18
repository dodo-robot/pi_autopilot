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
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
    findings: [],
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
