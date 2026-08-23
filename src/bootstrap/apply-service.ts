import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import type { ProjectsPort } from "../github/projects-adapter.js";
import type { PlanStore } from "./plan-store.js";
import type { BootstrapPlan } from "./types.js";

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface ExtendedGitHubPort extends GitHubPort {
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>;
  ensureLabel(name: string, color: string): Promise<void>;
}

export interface ApplyServiceDeps {
  planStore: PlanStore;
  github: ExtendedGitHubPort;
  projects: ProjectsPort;
  repositoryRoot: string;
  stdout?: (msg: string) => void;
  /** Prompt for yes/no; returns true for yes. Injected for tests. */
  prompt?: (msg: string) => Promise<boolean>;
}

export class ApplyService {
  private readonly log: (msg: string) => void;
  private readonly prompt: (msg: string) => Promise<boolean>;

  constructor(private readonly deps: ApplyServiceDeps) {
    this.log = deps.stdout ?? ((msg) => process.stdout.write(`${msg}\n`));
    this.prompt = deps.prompt ?? defaultPrompt;
  }

  async apply(planId: string): Promise<void> {
    const plan = await this.deps.planStore.load(planId);
    const state = plan.applyState;

    // Step 1: board
    let boardId = state.boardId;
    if (boardId === undefined) {
      boardId = await this.resolveOrCreateBoard(plan);
      state.boardId = boardId;
      await this.deps.planStore.update(plan);
    }

    // Step 2: ensure labels exist
    await this.deps.github.ensureLabel("epic", "0075ca");
    await this.deps.github.ensureLabel("task", "e4e669");

    // Step 3: create epic issues (idempotent: skip if already done)
    if (!state.epicsCreated) {
      this.log("→ creating epic issues...");
      for (const epic of plan.epics) {
        const issue = await this.deps.github.createIssue({
          title: epic.title,
          body: `${epic.description}\n\n## Tasks\n_(child issues will be linked below)_`,
          labels: epic.labels,
        });
        epic.githubNumber = issue.number;
        epic.githubNodeId = issue.nodeId;
        this.log(`  ✓ epic #${issue.number}: ${epic.title}`);
      }
      state.epicsCreated = true;
      await this.deps.planStore.update(plan);
    }

    // Step 4: create child issues
    if (!state.issuesCreated) {
      this.log("→ creating child issues...");
      for (const epic of plan.epics) {
        for (const issue of epic.issues) {
          const refSection = issue.requirementRef
            ? `\n\n## Requirements\nSource: \`${issue.requirementRef.doc}\` — ${issue.requirementRef.section}`
            : "";
          const created = await this.deps.github.createIssue({
            title: issue.title,
            body: `${issue.body}${refSection}`,
            labels: issue.labels,
          });
          issue.githubNumber = created.number;
          issue.githubNodeId = created.nodeId;
          this.log(`  ✓ issue #${created.number}: ${issue.title}`);
        }
      }
      state.issuesCreated = true;
      await this.deps.planStore.update(plan);
    }

    // Step 5: patch epic checklists
    if (!state.checklistsPatched) {
      this.log("→ patching epic checklists...");
      for (const epic of plan.epics) {
        if (epic.githubNumber === undefined) continue;
        const checklist = epic.issues
          .filter((i) => i.githubNumber !== undefined)
          .map((i) => `- [ ] #${i.githubNumber} ${i.title}`)
          .join("\n");
        await this.deps.github.updateIssueBody(
          epic.githubNumber,
          `${epic.description}\n\n## Tasks\n${checklist}`,
        );
      }
      state.checklistsPatched = true;
      await this.deps.planStore.update(plan);
    }

    // Step 6: add to board
    if (!state.addedToBoard) {
      this.log("→ adding issues to board...");
      const allIssues = [
        ...plan.epics
          .filter((e) => e.githubNodeId !== undefined)
          .map((e) => ({ nodeId: e.githubNodeId! })),
        ...plan.epics.flatMap((e) =>
          e.issues
            .filter((i) => i.githubNodeId !== undefined)
            .map((i) => ({ nodeId: i.githubNodeId! })),
        ),
      ];
      for (const issue of allIssues) {
        await this.deps.projects.addIssueToBoard(boardId, issue.nodeId, "Todo");
      }
      state.addedToBoard = true;
      await this.deps.planStore.update(plan);
    }

    // Step 7: write .pi/autopilot.yaml if needed
    if (!state.configWritten) {
      const configPath = path.join(
        this.deps.repositoryRoot,
        ".pi",
        "autopilot.yaml",
      );
      if (!existsSync(configPath) && typeof plan.proposedConfig === "string") {
        await mkdir(path.dirname(configPath), { recursive: true });
        await writeFile(configPath, plan.proposedConfig, "utf8");
        this.log("✓ wrote .pi/autopilot.yaml");
      }
      state.configWritten = true;
      await this.deps.planStore.update(plan);
    }

    this.log("✓ apply complete");
  }

  private async resolveOrCreateBoard(plan: BootstrapPlan): Promise<string> {
    const boards = await this.deps.projects.listBoards();
    if (boards.length === 0) {
      const yes = await this.prompt(
        `No Projects v2 board found. Create board "${plan.projectBoard.title}"? [y/N]`,
      );
      if (!yes)
        throw new Error("board creation declined; cannot proceed with --apply");
      const board = await this.deps.projects.createBoard(
        plan.projectBoard.title,
        plan.projectBoard.columns,
      );
      this.log(`  ✓ created board: ${board.title}`);
      return board.id;
    }
    if (boards.length === 1) {
      this.log(`  → using existing board: ${boards[0]!.title}`);
      return boards[0]!.id;
    }
    // Multiple boards: use the first one (CLI selection is a future extension)
    this.log(
      `  → using board: ${boards[0]!.title} (${boards.length} boards found; using first)`,
    );
    return boards[0]!.id;
  }
}

async function defaultPrompt(msg: string): Promise<boolean> {
  if (process.stdout.isTTY === true && process.stdin.isTTY === true) {
    process.stdout.write(`${msg} `);
    return new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        resolve(data.toString().trim().toLowerCase() === "y");
      });
    });
  }
  // Non-interactive: default to no
  return false;
}
