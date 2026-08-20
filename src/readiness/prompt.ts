import type { AutopilotConfig } from "../config/schema.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue } from "../github/github-adapter.js";

export interface RefinerPromptInput {
  repository: RepositoryRef;
  issue: GitHubIssue;
  config: AutopilotConfig;
  sourceBodyHash: string;
  clarifications?: Array<{ question: string; answer: string }>;
}

/**
 * Build the prompt for a bounded refiner session. The refiner inspects the
 * repository checkout and produces a structured execution contract through
 * the `submit_result` tool; the orchestrator never parses free-form prose
 * to decide readiness.
 */
export function buildRefinerPrompt(input: RefinerPromptInput): string {
  const verifyCommands = input.config.commands.verify
    .map((command) => `- ${command}`)
    .join("\n");
  const body =
    input.issue.body.length > 0 ? input.issue.body : "(empty issue body)";
  const clarifications =
    input.clarifications !== undefined && input.clarifications.length > 0
      ? `\n\nOperator clarifications collected during this prepare session\n----------------------------------------------------------\n${input.clarifications
          .map((item) => `- Q: ${item.question}\n  A: ${item.answer}`)
          .join("\n")}`
      : "";

  return `You are the Refiner role of an autonomous software development orchestrator.

You are operating inside a checkout of the target repository at the current working directory. Use the read, grep, find, and ls tools to inspect the repository's guidance files (AGENTS.md, CLAUDE.md, README*) and any documents the issue references, so the execution contract below reflects the real repository.

Analyze the GitHub issue below and produce a structured execution contract for an isolated implementer agent.

Output contract
---------------
When your analysis is complete, call the submit_result tool exactly once with a JSON string matching this shape:

{
  "outcome": "READY" | "NEEDS_REFINEMENT" | "PRODUCT_AMBIGUITY" | "FAILED",
  "taskDraft": {
    "schemaVersion": 1,
    "repository": { "owner": "${input.repository.owner}", "repo": "${input.repository.repo}" },
    "issue": { "number": ${input.issue.number}, "nodeId": "${input.issue.nodeId}", "updatedAt": "${input.issue.updatedAt}" },
    "objective": "single concrete outcome",
    "context": "why the work is needed and where the behavior currently lives",
    "expectedBehavior": ["observable behavior after implementation"],
    "acceptanceCriteria": [{ "id": "ac1", "text": "testable condition" }],
    "constraints": ["compatibility, security, architectural, or dependency constraints"],
    "nonGoals": ["related behavior deliberately excluded"],
    "validation": ["command or automated check that proves completion"],
    "dependencies": [{ "issue": 123, "satisfied": true }],
    "canonicalReferences": ["path or URL to the canonical requirement, spec, or design"],
    "sourceBodyHash": "${input.sourceBodyHash}"
  },
  "missingInformation": ["anything required for an execution contract that the issue does not provide"],
  "dependencies": [{ "issue": 123, "satisfied": false }],
  "ambiguities": [{ "type": "ENGINEERING", "description": "..." }]
}

When outcome is "NEEDS_REFINEMENT", also include "suggestions": ["concrete additions to the issue body"].

Rules
-----
- "objective" must be one concrete outcome.
- "expectedBehavior" must list observable behaviors.
- "acceptanceCriteria" must be testable conditions, each with an id.
- "validation" must name commands or automated checks. Manual-only checks (e.g. "manually verify the UI") are NOT sufficient; do not rely on them.
- List every blocking GitHub issue under "dependencies" with "satisfied": false.
- ENGINEERING ambiguity (which module owns a behavior, which internal API to reuse, which tests cover an area, whether a dependency already exists) does NOT block readiness: resolve it by inspecting the repository and continue.
- PRODUCT ambiguity (what behavior users should experience, which business rule should apply, conflicting requirements, whether a feature should support a particular workflow) MUST set outcome "PRODUCT_AMBIGUITY" and describe each ambiguity under "ambiguities".
- If the issue lacks information needed for an execution contract, set outcome "NEEDS_REFINEMENT", list the gaps under "missingInformation", and propose concrete additions under "suggestions".

Input
-----
Repository: ${input.repository.owner}/${input.repository.repo}
Issue: #${input.issue.number} (updated ${input.issue.updatedAt})
Source body hash: ${input.sourceBodyHash}

Verification commands configured in .pi/autopilot.yaml:
${verifyCommands}

Issue body
----------
${body}${clarifications}`;
}
