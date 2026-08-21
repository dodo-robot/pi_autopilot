import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ProcessRunner } from "../platform/process-runner.js";

export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

/** Repository-level policy governing worktree and branch lifecycle. */
export interface WorkspacePolicy {
  baseBranch: string;
  branchPrefix: string;
  requireCleanCheckout: boolean;
  retainBlockedWorktree: boolean;
}

export interface WorkspaceManagerDeps {
  processRunner: ProcessRunner;
  repository: RepositoryContext;
  policy: WorkspacePolicy;
}

export interface CreateWorkspaceRequest {
  runId: string;
  issueNumber: number;
  title: string;
  baseBranch: string;
}

/** A run's isolated sibling worktree and dedicated branch. */
export interface Workspace {
  runId: string;
  path: string;
  branch: string;
  baseBranch: string;
}

export interface WorkspaceStatus {
  exists: boolean;
  branch: string | null;
  isClean: boolean;
}

export interface CommitRequest {
  issueNumber: number;
  message: string;
  /** The exact tree hash verification last ran against; must match at commit time. */
  expectedTreeHash: string;
}

/**
 * The terminal outcome of a run, used to gate whether a workspace's
 * worktree and branch may be removed. Only `"success"` may bypass
 * `policy.retainBlockedWorktree`.
 */
export type RunOutcome = "success" | "blocked" | "failed";

const MAX_SLUG_LENGTH = 40;

/** Lowercase, hyphenate, and bound a title for use in a branch name. */
function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

async function runGit(
  processRunner: ProcessRunner,
  args: string[],
  cwd: string,
  env: Record<string, string> = safeProcessEnv(),
): Promise<string> {
  const result = await processRunner.run({
    command: "git",
    args,
    cwd,
    timeoutMs: 30_000,
    env,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new WorkspaceError(
      `git ${args.join(" ")} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Owns the sibling Git worktree and dedicated branch for one run. This is
 * the orchestrator's only tool for worktree/branch lifecycle: it never
 * modifies the primary checkout and never pushes.
 */
export class WorkspaceManager {
  private readonly processRunner: ProcessRunner;
  private readonly repository: RepositoryContext;
  private readonly policy: WorkspacePolicy;
  private readonly claimedPaths = new Set<string>();
  private readonly claimedBranches = new Set<string>();

  constructor(deps: WorkspaceManagerDeps) {
    this.processRunner = deps.processRunner;
    this.repository = deps.repository;
    this.policy = deps.policy;
  }

  private worktreeParent(): string {
    return path.join(
      path.dirname(this.repository.root),
      ".pi-autopilot-worktrees",
      this.repository.repository.repo,
    );
  }

  private branchName(issueNumber: number, title: string): string {
    const slug = slugifyTitle(title);
    const suffix = slug.length > 0 ? `${issueNumber}-${slug}` : `${issueNumber}`;
    return `${this.policy.branchPrefix}${suffix}`;
  }

  /**
   * Deterministically reconstruct the `Workspace` for a run that already
   * has a worktree, without creating anything or touching Git. Recovery
   * and resume use this to relocate a preserved workspace by run id and
   * the same issue number/title/base branch that were used to create it
   * originally (`create` derives the path and branch from exactly these
   * inputs, so recomputing them here yields the identical values).
   */
  locate(request: CreateWorkspaceRequest): Workspace {
    return {
      runId: request.runId,
      path: path.join(this.worktreeParent(), request.runId),
      branch: this.branchName(request.issueNumber, request.title),
      baseBranch: request.baseBranch,
    };
  }

  /**
   * Create a sibling worktree on a fresh branch for one run. Refuses a
   * dirty primary checkout (when required), a base branch mismatch, a
   * branch already owned by another run, or a path already registered to
   * another run.
   */
  async create(request: CreateWorkspaceRequest): Promise<Workspace> {
    if (this.policy.requireCleanCheckout) {
      const status = await runGit(
        this.processRunner,
        ["status", "--porcelain"],
        this.repository.root,
      );
      if (status.length > 0) {
        throw new WorkspaceError(
          "refusing to create a workspace: primary checkout is dirty",
        );
      }
    }

    if (request.baseBranch !== this.policy.baseBranch) {
      throw new WorkspaceError(
        `refusing to create a workspace: base branch '${request.baseBranch}' does not match the protected base branch '${this.policy.baseBranch}'`,
      );
    }

    const branch = this.branchName(request.issueNumber, request.title);
    const worktreePath = path.join(this.worktreeParent(), request.runId);

    if (this.claimedPaths.has(worktreePath)) {
      throw new WorkspaceError(
        `refusing to create a workspace: path already registered to another run: ${worktreePath}`,
      );
    }
    if (this.claimedBranches.has(branch)) {
      throw new WorkspaceError(
        `refusing to create a workspace: branch already owned by another run: ${branch}`,
      );
    }

    const existingBranches = await runGit(
      this.processRunner,
      ["branch", "--list", branch],
      this.repository.root,
    );
    if (existingBranches.length > 0) {
      throw new WorkspaceError(
        `refusing to create a workspace: branch already exists: ${branch}`,
      );
    }

    await mkdir(this.worktreeParent(), { recursive: true });

    await runGit(
      this.processRunner,
      ["worktree", "add", "-b", branch, worktreePath, request.baseBranch],
      this.repository.root,
    );

    this.claimedPaths.add(worktreePath);
    this.claimedBranches.add(branch);

    return {
      runId: request.runId,
      path: worktreePath,
      branch,
      baseBranch: request.baseBranch,
    };
  }

  /** Report whether a workspace's worktree exists, its branch, and cleanliness. */
  async inspect(workspace: Workspace): Promise<WorkspaceStatus> {
    if (!existsSync(workspace.path)) {
      return { exists: false, branch: null, isClean: false };
    }

    const branch = await runGit(
      this.processRunner,
      ["branch", "--show-current"],
      workspace.path,
    );
    const status = await runGit(
      this.processRunner,
      ["status", "--porcelain"],
      workspace.path,
    );

    return { exists: true, branch, isClean: status.length === 0 };
  }

  /**
   * Return the tree hash for the workspace's current file state, staged
   * into a temporary index. Never mutates the real index and never
   * creates a commit, so it is safe to call repeatedly.
   */
  async treeHash(workspace: Workspace): Promise<string> {
    const tempIndex = path.join(
      tmpdir(),
      `autopilot-index-${workspace.runId}-${Date.now()}`,
    );
    const env = safeProcessEnv({ GIT_INDEX_FILE: tempIndex });
    try {
      await runGit(this.processRunner, ["read-tree", "HEAD"], workspace.path, env);
      await runGit(this.processRunner, ["add", "-A"], workspace.path, env);
      return await runGit(this.processRunner, ["write-tree"], workspace.path, env);
    } finally {
      await rm(tempIndex, { force: true });
    }
  }

  /**
   * Stage all task changes and commit only if the staged tree exactly
   * matches the tree hash verification last ran against. Never pushes.
   */
  async commit(workspace: Workspace, request: CommitRequest): Promise<string> {
    await runGit(this.processRunner, ["add", "-A"], workspace.path);
    const stagedTreeHash = await runGit(
      this.processRunner,
      ["write-tree"],
      workspace.path,
    );

    if (stagedTreeHash !== request.expectedTreeHash) {
      throw new WorkspaceError(
        `refusing to commit: staged tree ${stagedTreeHash} does not match the verified tree ${request.expectedTreeHash}`,
      );
    }

    const body = `${request.message}\n\nRefs #${request.issueNumber}`;
    await runGit(this.processRunner, ["commit", "-m", body], workspace.path);
    return await runGit(this.processRunner, ["rev-parse", "HEAD"], workspace.path);
  }

  /**
   * Remove a workspace's worktree and branch. Callers must only invoke
   * this after durable PR evidence exists for a successful run. Refuses
   * when `outcome` is not `"success"` and `policy.retainBlockedWorktree`
   * is true, so blocked or failed workspaces are left in place for
   * diagnosis by construction, not merely by caller discipline.
   */
  async removeSuccessful(
    workspace: Workspace,
    outcome: RunOutcome,
  ): Promise<void> {
    if (outcome !== "success" && this.policy.retainBlockedWorktree) {
      throw new WorkspaceError(
        `refusing to remove workspace: run outcome '${outcome}' must be retained for diagnosis (retainBlockedWorktree is enabled)`,
      );
    }

    await runGit(
      this.processRunner,
      ["worktree", "remove", "--force", workspace.path],
      this.repository.root,
    );
    await runGit(
      this.processRunner,
      ["branch", "-D", workspace.branch],
      this.repository.root,
    );
    this.claimedPaths.delete(workspace.path);
    this.claimedBranches.delete(workspace.branch);
  }

  /**
   * Remove a workspace's worktree and branch unconditionally, plus prune it
   * from the claimed path/branch registries. Unlike {@link removeSuccessful},
   * this never refuses based on run outcome or `retainBlockedWorktree`:
   * `--fresh` is the explicit-discard caller that deliberately throws away a
   * prior (e.g. FAILED) run's workspace before starting clean. Tolerates a
   * worktree or branch that no longer exists.
   */
  async discard(workspace: Workspace): Promise<void> {
    if (existsSync(workspace.path)) {
      await runGit(
        this.processRunner,
        ["worktree", "remove", "--force", workspace.path],
        this.repository.root,
      );
    }
    const existing = await runGit(
      this.processRunner,
      ["branch", "--list", workspace.branch],
      this.repository.root,
    );
    if (existing.length > 0) {
      await runGit(
        this.processRunner,
        ["branch", "-D", workspace.branch],
        this.repository.root,
      );
    }
    this.claimedPaths.delete(workspace.path);
    this.claimedBranches.delete(workspace.branch);
  }
}
