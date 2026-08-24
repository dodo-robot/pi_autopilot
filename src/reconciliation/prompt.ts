import type { RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue } from "../github/github-adapter.js";

export interface RequirementDoc {
  path: string;
  content: string;
}

export interface ReconcilerPromptInput {
  repository: RepositoryRef;
  epic: GitHubIssue;
  issues: GitHubIssue[];
  requirementDocs: RequirementDoc[];
  /** A prior reconciliation report for this epic, if one exists, so the
   * model can reuse previously assigned requirement IDs instead of
   * re-deriving them from scratch. Omitted on a first run. */
  priorReport?: {
    coverage: Array<{ requirementId: string; description: string }>;
  };
}

/**
 * Build the prompt for a bounded reconciler session. The reconciler
 * inspects the repository checkout and produces a structured coverage map
 * plus a patch plan through the `submit_result` tool; it never gains write
 * access to GitHub.
 */
export function buildReconcilerPrompt(input: ReconcilerPromptInput): string {
  const { repository, epic, issues, requirementDocs } = input;

  const requirementsSection =
    requirementDocs.length > 0
      ? requirementDocs
          .map((doc) => `--- ${doc.path} ---\n${doc.content}`)
          .join("\n\n")
      : "(no requirement documents configured)";

  const issuesSection =
    issues.length > 0
      ? issues
          .map(
            (issue) =>
              `#${issue.number} — ${issue.title} (${issue.state})\n${
                issue.body.length > 0 ? issue.body : "(empty issue body)"
              }`,
          )
          .join("\n\n")
      : "(epic has no checklist issues)";

  const priorSection =
    input.priorReport !== undefined && input.priorReport.coverage.length > 0
      ? `\n\nRequirement IDs assigned in a prior reconciliation of this epic\n------------------------------------------------------------\n${input.priorReport.coverage
          .map((entry) => `- ${entry.requirementId}: ${entry.description}`)
          .join(
            "\n",
          )}\nReuse these IDs for the same requirements; only assign new IDs for requirements not listed here.`
      : "";

  return `You are the Reconciler role of an autonomous software development orchestrator.

You are operating inside a checkout of the target repository at the current working directory. Use the read, grep, find, and ls tools to inspect the repository — confirm whether work an issue describes already exists, is partially implemented, or was superseded, before proposing a patch about it.

Your job is to compare the requirement documents below against the epic's existing issues, and produce two things: a requirement coverage map, and a set of proposed patches to the backlog. You do not have write access to GitHub — every patch is a proposal for a human to review.

Output contract
---------------
When your analysis is complete, call the submit_result tool exactly once with a JSON string matching this shape:

{
  "coverage": [
    { "requirementId": "REQ-AUTH-001", "description": "...", "epic": ${epic.number}, "issues": [123], "status": "covered" | "partial" | "missing" | "implemented", "evidence": "..." }
  ],
  "patches": [
    { "type": "KEEP", "issue": 123, "reason": "..." },
    { "type": "ENRICH_ISSUE", "issue": 123, "reason": "...", "patch": { "goal": "...", "sourceRequirements": ["REQ-AUTH-001"], "acceptanceCriteria": ["..."], "constraints": [], "nonGoals": [], "validation": ["..."], "relevantAreas": ["src/auth/"] } },
    { "type": "CREATE_ISSUE", "epic": ${epic.number}, "reason": "...", "spec": { "title": "...", "enrichment": { "goal": "...", "sourceRequirements": [], "acceptanceCriteria": [], "constraints": [], "nonGoals": [], "validation": [], "relevantAreas": [] } } },
    { "type": "ADD_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." },
    { "type": "REMOVE_DEPENDENCY", "issue": 123, "dependsOn": 120, "reason": "..." },
    { "type": "SPLIT_ISSUE", "issue": 123, "reason": "...", "children": [ { "title": "...", "enrichment": { "goal": "...", "sourceRequirements": [], "acceptanceCriteria": [], "constraints": [], "nonGoals": [], "validation": [], "relevantAreas": [] } } ] },
    { "type": "MERGE_DUPLICATE", "keep": 120, "duplicate": 123, "reason": "..." },
    { "type": "MARK_STALE", "issue": 123, "reason": "..." },
    { "type": "NEEDS_HUMAN", "issue": 123, "ambiguityType": "ENGINEERING" | "PRODUCT" | "MISSING_CONTEXT" | "CONFLICTING_REQUIREMENTS", "reason": "...", "questions": ["..."] }
  ]
}

Rules
-----
- Assign a stable REQ-<AREA>-<NNN> identifier to every requirement you find, unless a prior reconciliation (below) already assigned one — reuse those exactly.
- Every issue in the epic must be classified with exactly one patch: KEEP when it is correct and complete as-is, ENRICH_ISSUE when it needs the machine-owned execution-contract fields added, MARK_STALE when the repository already contains an equivalent implementation (name the evidence in "reason"), or NEEDS_HUMAN when you cannot decide without a product decision.
- Propose CREATE_ISSUE only for a requirement with no corresponding issue anywhere in the epic.
- Propose ADD_DEPENDENCY when one issue's work genuinely cannot start before another completes and no dependency is currently recorded.
- Propose REMOVE_DEPENDENCY only when a currently-recorded managed-form dependency (the "- #N (unsatisfied)" bullet, not free-text prose like "depends on #12") no longer reflects a real ordering constraint — for example, the dependency was satisfied by a rearchitecting that removed the need for it, or was recorded in error. Never propose it against a dependency you only see written as free-text human prose.
- Propose MERGE_DUPLICATE when two issues in this epic describe the same actual piece of work — not merely similar titles or overlapping keywords, but the same behavioral outcome such that implementing one would fully satisfy the other. Set "keep" to whichever issue has more complete or enriched content (fuller acceptance criteria, more validated context); if the two are equally complete, "keep" is the lower-numbered issue. Set "duplicate" to the other. Never propose MERGE_DUPLICATE for issues that merely depend on or relate to each other — only true duplicates.
- ENGINEERING ambiguity (which module owns a behavior, whether an abstraction already exists) does NOT require NEEDS_HUMAN: resolve it by inspecting the repository.
- PRODUCT ambiguity, MISSING_CONTEXT (a requirement you cannot locate enough information about), and CONFLICTING_REQUIREMENTS (two requirement documents disagree) MUST produce a NEEDS_HUMAN patch with specific questions.
- An issue is the right size when it has one primary outcome, fits one isolated agent session, and its acceptance criteria are independently testable. If an issue's scope spans multiple independent behavioral outcomes (not just multiple implementation steps toward one outcome), it is oversized. When the split itself is mechanical — the outcomes are clear and their relative order/priority is not a product call — propose SPLIT_ISSUE with one full IssueSpec (title + complete enrichment) per outcome. When which slice ships first, or how to divide the scope, requires a product decision, raise a NEEDS_HUMAN patch (ambiguityType "PRODUCT") naming the outcomes instead of proposing a split yourself.
- Never silently drop a requirement or an issue from your analysis.

Input
-----
Repository: ${repository.owner}/${repository.repo}
Epic: #${epic.number} — ${epic.title} (${epic.state})

Epic body
---------
${epic.body.length > 0 ? epic.body : "(empty epic body)"}

Requirement documents
----------------------
${requirementsSection}

Epic issues
-----------
${issuesSection}${priorSection}`;
}
