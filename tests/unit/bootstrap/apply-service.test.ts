import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";
import { PlanStore } from "../../../src/bootstrap/plan-store.js";
import {
  ApplyService,
  type ExtendedGitHubPort,
  type CreateIssueInput,
} from "../../../src/bootstrap/apply-service.js";
import type { ProjectsPort, Board } from "../../../src/github/projects-adapter.js";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import type { BootstrapPlan } from "../../../src/bootstrap/types.js";

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function makeIssue(number: number, title: string): GitHubIssue {
  return {
    number,
    nodeId: `N_${number}`,
    title,
    body: "",
    updatedAt: "",
    state: "open",
    htmlUrl: `https://github.com/acme/widgets/issues/${number}`,
  };
}

class FakeGitHub implements ExtendedGitHubPort {
  issueCounter = 100;
  createdIssues: CreateIssueInput[] = [];
  updatedBodies: Array<{ number: number; body: string }> = [];
  ensuredLabels: string[] = [];

  async getIssue(): Promise<GitHubIssue> {
    return makeIssue(1, "stub");
  }
  async createIssueComment(): Promise<void> {}
  async closeIssue(): Promise<void> {}
  async findPullRequestByHead() {
    return null;
  }
  async createPullRequest(): Promise<never> {
    throw new Error("not used");
  }
  async findIssueCommentByMarker() {
    return null;
  }

  async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
    const number = ++this.issueCounter;
    this.createdIssues.push(input);
    return makeIssue(number, input.title);
  }
  async findIssueByTitle(title: string): Promise<GitHubIssue | null> {
    const desired = title.trim().toLowerCase();
    const source = this as { issues?: Map<number, GitHubIssue>; issue?: GitHubIssue };
    const issues = source.issues !== undefined
      ? [...source.issues.values()]
      : source.issue !== undefined
        ? [source.issue]
        : [];
    return issues.find((issue) => issue.title.trim().toLowerCase() === desired) ?? null;
  }

  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    this.updatedBodies.push({ number, body });
    return makeIssue(number, "updated");
  }
  async ensureLabel(name: string): Promise<void> {
    this.ensuredLabels.push(name);
  }
}

class FakeProjects implements ProjectsPort {
  boards: Board[] = [];
  addedItems: Array<{ boardId: string; nodeId: string }> = [];

  async listBoards(): Promise<Board[]> {
    return this.boards;
  }
  async createBoard(title: string): Promise<Board> {
    const board = { id: "board-1", title };
    this.boards.push(board);
    return board;
  }
  async addIssueToBoard(boardId: string, issueNodeId: string, _status: string): Promise<void> {
    this.addedItems.push({ boardId, nodeId: issueNodeId });
  }
}

function makePlan(): BootstrapPlan {
  return {
    planId: "bootstrap-20260823-apply01",
    createdAt: "2026-08-23T10:00:00Z",
    requirementDocs: ["requirements.md"],
    proposedConfig: null,
    projectBoard: {
      title: "My Project",
      columns: ["Todo", "In Progress", "Done"],
    },
    epics: [
      {
        title: "Auth",
        description: "Authentication",
        labels: ["epic"],
        issues: [{ title: "Implement login", body: "Login flow", labels: ["task"] }],
      },
    ],
    dependencies: [],
    tracks: [{ wave: 1, issues: ["Implement login"] }],
    applyState: {
      epicsCreated: false,
      issuesCreated: false,
      checklistsPatched: false,
      addedToBoard: false,
      configWritten: false,
    },
  };
}

interface MakeServiceResult {
  service: ApplyService;
  store: PlanStore;
  github: FakeGitHub;
  projects: FakeProjects;
  tmpDir: string;
}

function makeService(prompt?: (msg: string) => Promise<boolean>): MakeServiceResult {
  tmpDir = mkdtempSync(path.join(tmpdir(), "apply-service-test-"));
  const artifacts = new ArtifactStore(appPaths(tmpDir));
  const store = new PlanStore(artifacts);
  const github = new FakeGitHub();
  const projects = new FakeProjects();
  const service = new ApplyService({
    planStore: store,
    github,
    projects,
    repositoryRoot: tmpDir,
    prompt,
  });
  return { service, store, github, projects, tmpDir };
}

describe("ApplyService.apply", () => {
  it("creates epic and child issues", async () => {
    const { service, store, github } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    // 1 epic + 1 child = 2 created issues
    expect(github.createdIssues).toHaveLength(2);
    expect(github.createdIssues[0].title).toBe("Auth");
    expect(github.createdIssues[1].title).toBe("Implement login");
  });

  it("creates a board when none exists", async () => {
    const { service, store, projects } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    expect(projects.boards).toHaveLength(1);
    expect(projects.boards[0].title).toBe("My Project");
  });

  it("adds all issues to the board", async () => {
    const { service, store, projects } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    // 1 epic + 1 child issue
    expect(projects.addedItems).toHaveLength(2);
  });

  it("patches epic body with child issue checklist", async () => {
    const { service, store, github } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    const epicUpdate = github.updatedBodies.find((u) => u.body.includes("- [ ]"));
    expect(epicUpdate).toBeDefined();
    expect(epicUpdate?.body).toContain("Implement login");
  });

  it("is idempotent: skips completed steps on second apply", async () => {
    const { service, store, github, projects } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    const firstCreateCount = github.createdIssues.length;
    const firstBoardItems = projects.addedItems.length;
    await service.apply("bootstrap-20260823-apply01");
    // No new issues should have been created
    expect(github.createdIssues.length).toBe(firstCreateCount);
    expect(projects.addedItems.length).toBe(firstBoardItems);
  });

  it("writes .pi/autopilot.yaml when proposedConfig is non-null and file doesn't exist", async () => {
    const { service, store, tmpDir } = makeService(async () => true);
    const plan = makePlan();
    plan.proposedConfig = "model: gpt-4\nreviewer: claude";
    await store.save(plan);
    await service.apply("bootstrap-20260823-apply01");
    const configPath = path.join(tmpDir, ".pi", "autopilot.yaml");
    expect(existsSync(configPath)).toBe(true);
  });

  it("does not overwrite .pi/autopilot.yaml on second apply", async () => {
    const { service, store, tmpDir } = makeService(async () => true);
    const plan = makePlan();
    plan.proposedConfig = "model: gpt-4\nreviewer: claude";
    await store.save(plan);
    await service.apply("bootstrap-20260823-apply01");
    const configPath = path.join(tmpDir, ".pi", "autopilot.yaml");
    const { mtimeMs } = await import("node:fs/promises").then((m) =>
      m.stat(configPath),
    );
    // Wait a bit to ensure different mtime if written again
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.apply("bootstrap-20260823-apply01");
    const { mtimeMs: newMtime } = await import("node:fs/promises").then((m) =>
      m.stat(configPath),
    );
    expect(newMtime).toBe(mtimeMs);
  });

  it("uses existing board when one exists", async () => {
    const { service, store, projects } = makeService(async () => true);
    projects.boards.push({ id: "existing-board", title: "Existing Board" });
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    // Should not create a new board
    expect(projects.boards).toHaveLength(1);
    expect(projects.boards[0].id).toBe("existing-board");
    // But should still add issues to it
    expect(projects.addedItems.length).toBeGreaterThan(0);
    expect(projects.addedItems[0].boardId).toBe("existing-board");
  });

  it("ensures epic and task labels exist", async () => {
    const { service, store, github } = makeService(async () => true);
    await store.save(makePlan());
    await service.apply("bootstrap-20260823-apply01");
    expect(github.ensuredLabels).toContain("epic");
    expect(github.ensuredLabels).toContain("task");
  });
});
