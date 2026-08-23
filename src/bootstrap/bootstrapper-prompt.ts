import type { RepositoryRef } from "../domain/contracts.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";

export interface BootstrapperPromptInput {
  repository: RepositoryRef;
  requirementDocs: RequirementDoc[];
  hasExistingConfig: boolean;
}

export function buildBootstrapperPrompt(input: BootstrapperPromptInput): string {
  const { repository, requirementDocs, hasExistingConfig } = input;

  const requirementsSection = requirementDocs
    .map((doc) => `--- ${doc.path} ---\n${doc.content}`)
    .join("\n\n");

  const configNote = hasExistingConfig
    ? "An `autopilot.yaml` already exists in the repository — do NOT propose a new one."
    : "No `autopilot.yaml` exists yet. Include a `proposedConfig` in your output with sensible role defaults.";

  return `You are the Bootstrapper role of an autonomous software development orchestrator.

Repository: ${repository.owner}/${repository.repo}

Your task is to read the requirement documents below and produce a complete bootstrap plan for a new GitHub project backlog. Use the superpowers brainstorming skill to reason carefully about how requirements group into epics, what the dependencies between pieces of work are, and how to maximize parallel development.

${configNote}

## Your output must include:

1. **Epic structure** — group related requirements into named epics. Each epic gets a description and a list of child issues with titles, bodies, and requirement references.

2. **Dependency graph** — explicit directed dependencies between issues and epics. For each dependency, state which item depends on which, and why. Use "epic:<title>" or "issue:<title>" as identifiers.

3. **Parallel tracks (waves)** — derive a wave-based execution ordering from the dependency graph. Issues in the same wave have no dependencies on each other and can be worked in parallel. Assign every issue to exactly one wave.

4. **Project board** — propose a board title (default: the repo name) and standard columns ["Todo", "In Progress", "Done"].

## Requirement documents

${requirementsSection}

## Output contract

When your analysis is complete, call the submit_result tool exactly once with a JSON string matching this shape:

{
  "projectBoard": {
    "title": "<board title>",
    "columns": ["Todo", "In Progress", "Done"]
  },
  "epics": [
    {
      "title": "<epic title>",
      "description": "<epic description>",
      "issues": [
        {
          "title": "<issue title>",
          "body": "<full issue body with context, acceptance criteria, and constraints>",
          "requirementRef": { "doc": "<path>", "section": "<section heading>" }
        }
      ]
    }
  ],
  "dependencies": [
    { "from": "issue:<title>", "to": "issue:<title>", "reason": "<why>" }
  ],
  "tracks": [
    { "wave": 1, "issues": ["<title>", "<title>"] },
    { "wave": 2, "issues": ["<title>"] }
  ]${hasExistingConfig ? "" : `,
  "proposedConfig": {
    "roles": {
      "bootstrapper": { "model": "<model-used>", "thinking": "high" },
      "implementer":  { "model": "anthropic/claude-sonnet-4", "thinking": "high" },
      "reviewer":     { "model": "anthropic/claude-sonnet-4", "thinking": "high" },
      "reconciler":   { "model": "anthropic/claude-sonnet-4", "thinking": "high" }
    }
  }`}
}

Rules:
- Every issue must appear in exactly one wave.
- Dependencies must be acyclic (no circular dependencies).
- Issue bodies must be self-contained: include goal, acceptance criteria, constraints, and relevant source sections.
- Do not invent requirements not present in the documents.
`;
}
