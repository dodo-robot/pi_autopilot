import type { BootstrapPlan } from "./types.js";

export function renderPlan(plan: BootstrapPlan, configYaml: string | null): string {
  const sections: string[] = [];

  sections.push(`# Bootstrap Plan: ${plan.projectBoard.title}`);
  sections.push(`\n**Plan ID:** \`${plan.planId}\`  \n**Created:** ${plan.createdAt}  \n**Requirement docs:** ${plan.requirementDocs.join(", ")}`);

  // Epics and issues
  for (const epic of plan.epics) {
    sections.push(`\n## ${epic.title}\n\n${epic.description}`);
    for (let i = 0; i < epic.issues.length; i++) {
      const issue = epic.issues[i];
      if (!issue) continue;
      sections.push(`\n### ${i + 1}. ${issue.title}\n\n${issue.body}`);
      if (issue.requirementRef) {
        sections.push(`\n> **Requirement:** \`${issue.requirementRef.doc}\` — ${issue.requirementRef.section}`);
      }
    }
  }

  // Dependency graph
  sections.push(`\n## Dependency Graph\n\n\`\`\`mermaid\ngraph TD`);
  for (const dep of plan.dependencies) {
    const fromId = dep.from.replace(/[^a-zA-Z0-9]/g, "_");
    const toId = dep.to.replace(/[^a-zA-Z0-9]/g, "_");
    sections.push(`  ${fromId} -->|"${dep.reason}"| ${toId}`);
  }
  sections.push("```");

  // Parallel tracks
  sections.push(`\n## Parallel Tracks`);
  for (const track of plan.tracks) {
    const label = track.issues.length > 1 ? "parallel" : "sequential";
    sections.push(`\nWave ${track.wave} (${label}): ${track.issues.join(", ")}`);
  }

  // Proposed autopilot.yaml
  if (configYaml !== null) {
    sections.push(`\n## Proposed \`autopilot.yaml\`\n\n\`\`\`yaml\n${configYaml}\`\`\``);
  }

  // Project board
  sections.push(`\n## Project Board\n\n**Title:** ${plan.projectBoard.title}  \n**Columns:** ${plan.projectBoard.columns.join(", ")}`);

  return sections.join("\n");
}
