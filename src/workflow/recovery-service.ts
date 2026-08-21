import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { RunRecord, TaskSnapshot } from "../domain/contracts.js";
import type { GitHubPort } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { RunStoreError } from "../persistence/run-store.js";
import type { RunStore } from "../persistence/run-store.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { isTerminalStage } from "../persistence/run-store.js";
import type { VerificationEvidence } from "../verification/verification-runner.js";
import type { Workspace } from "../workspace/workspace-manager.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { RunOverrides, RunService, RunSummary } from "./run-service.js";

export class RecoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecoveryError";
  }
}

/**
 * One conservative, explicit recommendation surfaced by reconciliation.
 * Every variant reflects an actual, queried fact about persisted or
 * remote state; none of them ever assume a stage succeeded.
 */
export type RecoveryAction =
  | { type: "WORKSPACE_MISSING" }
  | { type: "PRESERVE_WORKSPACE" }
  | { type: "REUSE_VERIFICATION"; treeHash: string }
  | { type: "RETRY_PUSH"; branch: string }
  | { type: "REUSE_EXISTING_PR"; number: number };

export interface RecoveryReport {
  runId: string;
  stage: RunRecord["stage"];
  actions: RecoveryAction[];
}

export interface RecoveryServiceDeps {
  runStore: RunStore;
  artifacts: ArtifactStore;
  paths: AppPaths;
  workspaceManager: WorkspaceManager;
  github: GitHubPort;
  processRunner: ProcessRunner;
  repository: RepositoryContext;
  /**
   * The repository's protected base branch (`config.workspace.baseBranch`),
   * used only to relocate an existing workspace by the same coordinates
   * `WorkspaceManager.create` originally used. `reconcile`/`abandon` never
   * create anything from it, so this never triggers policy validation.
   */
  baseBranch: string;
  /**
   * Owns the actual correction session for `resume`. Optional because
   * `reconcile`/`abandon` never need it; omitting it and then calling
   * `resume` is a programmer error and throws immediately.
   */
  runService?: RunService;
}

/** Minimal shape read back from a `verification-*.json` artifact. */
interface StoredVerificationEvidence {
  treeHash?: unknown;
}

function isVerificationArtifactName(name: string): boolean {
  return /^verification-\d+\.json$/.test(name);
}

/**
 * Reconciles a nonterminal run's persisted metadata against the actual,
 * queried state of its worktree, Git remote, and GitHub. Never assumes a
 * side effect succeeded and never automatically restarts an uncertain
 * agent stage (implementer/reviewer sessions are never re-launched here);
 * it only reports what the orchestrator can safely reuse or must retry.
 */
export class RecoveryService {
  constructor(private readonly deps: RecoveryServiceDeps) {}

  async reconcile(runId: string): Promise<RecoveryReport> {
    const run = this.requireRun(runId);
    const actions: RecoveryAction[] = [];

    const workspace = await this.locateWorkspace(run);
    if (workspace === null) {
      // No task snapshot yet (interrupted before WORKSPACE_CREATION
      // recorded one), so there is nothing on disk to reconcile against.
      return { runId, stage: run.stage, actions };
    }

    const status = await this.deps.workspaceManager.inspect(workspace);
    if (!status.exists) {
      actions.push({ type: "WORKSPACE_MISSING" });
      return { runId, stage: run.stage, actions };
    }

    // The worktree exists: by policy it is always preserved for
    // diagnosis/resume until an explicit abandon or a successful cleanup,
    // never deleted as a side effect of reconciliation itself.
    actions.push({ type: "PRESERVE_WORKSPACE" });

    const currentTreeHash = await this.deps.workspaceManager.treeHash(workspace);

    const reusableEvidence = await this.findReusableVerificationEvidence(
      runId,
      currentTreeHash,
    );
    if (reusableEvidence !== null) {
      actions.push({ type: "REUSE_VERIFICATION", treeHash: reusableEvidence });
    }

    const publication = this.deps.runStore.getPublication(runId);
    if (publication !== null && publication.commitSha !== null) {
      // A local commit is durable evidence: check the actual remote state
      // before deciding whether a push is still needed, never assuming a
      // prior push attempt (interrupted or not) succeeded.
      const remoteHasBranch = await this.remoteBranchExists(publication.branch);
      if (!remoteHasBranch) {
        actions.push({ type: "RETRY_PUSH", branch: publication.branch });
      } else {
        // Only once the branch is confirmed on the remote is it meaningful
        // to look for an existing PR by head; otherwise `findPullRequestByHead`
        // would legitimately (and correctly) return null and we would wrongly
        // conclude no PR exists yet.
        const existingPr =
          publication.prNumber !== null
            ? { number: publication.prNumber }
            : await this.deps.github.findPullRequestByHead(publication.branch);
        if (existingPr !== null) {
          actions.push({ type: "REUSE_EXISTING_PR", number: existingPr.number });
        }
      }
    }

    return { runId, stage: run.stage, actions };
  }

  /**
   * Resume a `BLOCKED` run: validate it is actually resumable, then
   * delegate to `RunService.resume`, which preserves the frozen snapshot,
   * increments attempt counters, and launches exactly one fresh, bounded
   * correction session in the preserved workspace. Never continues any
   * hidden conversational context from the interrupted attempt.
   */
  async resume(runId: string, overrides: RunOverrides = {}): Promise<RunSummary> {
    const run = this.requireRun(runId);
    if (run.stage !== "BLOCKED" && run.stage !== "FAILED") {
      throw new RecoveryError(
        `cannot resume run ${runId}: stage is ${run.stage}, not BLOCKED or FAILED`,
      );
    }
    if (this.deps.runService === undefined) {
      throw new RecoveryError(
        "RecoveryService was constructed without a runService and cannot resume runs",
      );
    }
    return await this.deps.runService.resume(runId, overrides);
  }

  async abandon(runId: string): Promise<RunRecord> {
    const run = this.requireRun(runId);
    if (isTerminalStage(run.stage)) {
      throw new RecoveryError(
        `cannot abandon run ${runId}: already in terminal stage ${run.stage}`,
      );
    }
    try {
      this.deps.runStore.transition(runId, run.stage, "CANCELLED", null);
    } catch (error) {
      if (error instanceof RunStoreError) {
        throw new RecoveryError(
          `failed to abandon run ${runId}: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
    const updated = this.deps.runStore.getRun(runId);
    if (updated === null) {
      throw new RecoveryError(`run ${runId} disappeared during abandon`);
    }
    return updated;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.deps.runStore.getRun(runId);
    if (run === null) {
      throw new RecoveryError(`no run found with id ${runId}`);
    }
    return run;
  }

  /**
   * Reconstruct the run's workspace from its frozen task snapshot, without
   * creating anything or assuming the worktree still exists. Returns null
   * only when no snapshot was ever persisted (the run never reached
   * WORKSPACE_CREATION), in which case there is nothing to locate.
   */
  private async locateWorkspace(run: RunRecord): Promise<Workspace | null> {
    if (run.taskSnapshotRef === null) return null;
    const snapshot = await this.deps.artifacts.readJson<TaskSnapshot>(
      run.id,
      run.taskSnapshotRef,
    );
    return this.deps.workspaceManager.locate({
      runId: run.id,
      issueNumber: run.issueNumber,
      title: snapshot.objective,
      baseBranch: this.deps.baseBranch,
    });
  }

  /**
   * Look for a persisted `verification-*.json` artifact whose recorded
   * tree hash still matches the worktree's current tree hash. Only that
   * exact match makes the evidence reusable; any drift means verification
   * must run again, never be assumed to still hold.
   */
  private async findReusableVerificationEvidence(
    runId: string,
    currentTreeHash: string,
  ): Promise<string | null> {
    const runDir = this.deps.paths.runDir(runId);
    if (!existsSync(runDir)) return null;

    let entries: string[];
    try {
      entries = await readdir(runDir);
    } catch {
      return null;
    }

    const candidates = entries.filter(isVerificationArtifactName).sort();
    for (const relative of candidates.reverse()) {
      const evidence = await this.deps.artifacts.readJson<
        StoredVerificationEvidence & Partial<VerificationEvidence>
      >(runId, relative);
      if (evidence.treeHash === currentTreeHash) {
        return currentTreeHash;
      }
    }
    return null;
  }

  /** Query the actual remote state; never assume a prior push succeeded. */
  private async remoteBranchExists(branch: string): Promise<boolean> {
    const result = await this.deps.processRunner.run({
      command: "git",
      args: ["ls-remote", "--heads", "origin", branch],
      cwd: this.deps.repository.root,
      timeoutMs: 30_000,
      env: safeProcessEnv(),
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new RecoveryError(
        `failed to query remote branch ${branch}${detail ? `: ${detail}` : ""}`,
      );
    }
    return result.stdout.trim().length > 0;
  }
}
