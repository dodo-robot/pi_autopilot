import type { Ambiguity, RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue } from "../github/github-adapter.js";

export interface BrainstormerPromptInput {
  repository: RepositoryRef;
  issue: GitHubIssue;
  refinerGaps: {
    missingInformation: string[];
    ambiguities: Ambiguity[];
    suggestions: string[];
  };
}

/**
 * Build the prompt for a bounded brainstormer session. The brainstormer
 * reads the issue and the refiner's gap report, then produces 1-3 open-ended
 * intent questions for the operator via submit_result.
 */
export function buildBrainstormerPrompt(input: BrainstormerPromptInput): string {
  const { repository, issue, refinerGaps } = input;
  const body = issue.body.length > 0 ? issue.body : "(empty issue body)";

  const missingSection =
    refinerGaps.missingInformation.length > 0
      ? `\nMissing information identified by the refiner\n---------------------------------------------\n${refinerGaps.missingInformation.map((item) => `- ${item}`).join("\n")}`
      : "";

  const ambiguitySection =
    refinerGaps.ambiguities.length > 0
      ? `\nAmbiguities identified by the refiner\n--------------------------------------\n${refinerGaps.ambiguities.map((a) => `- [${a.type}] ${a.description}`).join("\n")}`
      : "";

  const suggestionsSection =
    refinerGaps.suggestions.length > 0
      ? `\nSuggestions from the refiner\n----------------------------\n${refinerGaps.suggestions.map((s) => `- ${s}`).join("\n")}`
      : "";

  return `You are the Brainstormer role of an autonomous software development orchestrator.

Your job is to help an operator clarify the intent behind a GitHub issue before an implementer agent works on it. The issue has been analyzed by a Refiner and found to be insufficiently specified. Your task is to ask the operator 1-3 open-ended questions that surface the most important gaps in intent, scope, and success criteria.

Inspect the repository's guidance files (AGENTS.md, CLAUDE.md, README*) using the read, grep, find, and ls tools so your questions reflect the actual codebase context. Never ask questions that could be answered by reading the repository yourself.

Rules
-----
- Produce exactly 1-3 questions. Never more, never fewer.
- Focus on intent, scope, and success criteria — the "why" and "what does done look like" level. Do not ask about structural gaps (missing acceptance criteria format, validation command syntax) — those are handled separately.
- Do not draft the execution contract. Do not propose acceptance criteria, objectives, or validation commands. Your only output is questions for the operator.
- Each question must be self-contained and answerable without the operator needing to read the issue again.
- Ask only questions whose answers would materially change what gets built.

Output contract
---------------
Call submit_result exactly once with a JSON string matching this shape:

{
  "questions": [
    { "id": "q1", "text": "..." },
    { "id": "q2", "text": "..." }
  ]
}

Array length must be between 1 and 3 (inclusive).

Input
-----
Repository: ${repository.owner}/${repository.repo}
Issue: #${issue.number} — ${issue.title}

Issue body
----------
${body}${missingSection}${ambiguitySection}${suggestionsSection}`;
}
