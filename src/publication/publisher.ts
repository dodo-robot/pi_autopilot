import type { ReviewerResult, TaskSnapshot } from "../domain/contracts.js";
import type {
  GitHubPort,
  PullRequestRef,
} from "../github/github-adapter.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import type { RunStore } from "../persistence/run-store.js";
import type { VerificationEvidence } from "../verification/verification-runner.js";
import type { Workspace, WorkspaceManager } from "../workspace/workspace-manager.js";

export class PublicationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PublicationError";
  }
}

export interface PublicationConfig {
  baseBranch: string;
  draftPr: boolean;
}

export interface PublishInput {
  runId: string;
  issueNumber: number;
  workspace: Workspace;
  taskSnapshot: TaskSnapshot;
  review: ReviewerResult;
  verification: VerificationEvidence;
  /** Implementer's prose summary of the change, folded into the PR body. */
  implementationSummary: string;
  config: PublicationConfig;
}

export interface PublicationCommentResult {
  id: number;
  marker: string;
}

export interface PublicationResult {
  commitSha: string;
  branch: string;
  pullRequest: PullRequestRef;
  comment: PublicationCommentResult;
}

export interface PublisherDeps {
  github: GitHubPort;
  workspaceManager: WorkspaceManager;
  runStore: RunStore;
  processRunner: ProcessRunner;
}

function commentMarker(runId: string): string {
  return `<!-- autopilot-run:${runId} -->`;
}

function renderPrBody(input: {
  runId: string;
  taskSnapshot: TaskSnapshot;
  review: ReviewerResult;
  verification: VerificationEvidence;
  implementationSummary: string;
}): string {
  const { runId, taskSnapshot, review, verification, implementationSummary } = input;

  const criteriaChecklist = taskSnapshot.acceptanceCriteria
    .map((criterion) => {
      const result = review.outcome === "APPROVED"
        ? review.criteriaResults.find((r) => r.criterionId === criterion.id)
        : undefined;
      const checked = result?.passed === true ? "x" : " ";
      return `- [${checked}] ${criterion.text}`;
    })
    .join("\n");

  const verificationLines = verification.commands
    .map((cmd) => {
      const status = cmd.timedOut ? "timed out" : `exit ${cmd.exitCode}`;
      return `- \`${cmd.command}\` — ${status}`;
    })
    .join("\n");

  const reviewSummary = review.outcome === "APPROVED"
    ? "Reviewer outcome: **APPROVED**"
    : `Reviewer outcome: ${review.outcome}`;

  return [
    `## Objective`,
    taskSnapshot.objective,
    ``,
    `## Acceptance criteria`,
    criteriaChecklist,
    ``,
    `## Implementation summary`,
    implementationSummary,
    ``,
    `## Verification`,
    `Verification passed: ${verification.passed}`,
    verificationLines,
    ``,
    `## Review`,
    reviewSummary,
    ``,
    `Refs #${taskSnapshot.issue.number}`,
    `Run: ${runId}`,
  ].join("\n");
}

function renderIssueComment(input: {
  runId: string;
  pullRequest: PullRequestRef;
  verification: VerificationEvidence;
}): string {
  const { runId, pullRequest, verification } = input;
  const commandCount = verification.commands.length;
  return [
    `Opened ${pullRequest.url} with the verified changes for this issue.`,
    ``,
    `Verification: ${commandCount} command(s), passed=${verification.passed}.`,
    ``,
    `Run: ${runId}`,
    commentMarker(runId),
  ].join("\n");
}

/**
 * Idempotently publishes a run's verified work: commits via the
 * `WorkspaceManager` (which itself refuses a stale tree), pushes the
 * dedicated branch, opens (or reconciles) a linked pull request, and posts
 * exactly one concise issue comment. Every GitHub mutation is looked up
 * before it is attempted so an interrupted-and-retried publication never
 * creates a duplicate PR or comment. Never force-pushes, closes the issue,
 * or merges the PR.
 */
export class Publisher {
  private readonly github: GitHubPort;
  private readonly workspaceManager: WorkspaceManager;
  private readonly runStore: RunStore;
  private readonly processRunner: ProcessRunner;

  constructor(deps: PublisherDeps) {
    this.github = deps.github;
    this.workspaceManager = deps.workspaceManager;
    this.runStore = deps.runStore;
    this.processRunner = deps.processRunner;
  }

  async publish(input: PublishInput): Promise<PublicationResult> {
    if (input.review.outcome !== "APPROVED") {
      throw new PublicationError(
        `refusing to publish: review outcome is '${input.review.outcome}', not approved`,
      );
    }
    if (!input.verification.passed) {
      throw new PublicationError(
        "refusing to publish: verification evidence did not pass",
      );
    }

    const stagedTreeHash = await this.workspaceManager.treeHash(input.workspace);
    if (stagedTreeHash !== input.verification.treeHash) {
      throw new PublicationError(
        `refusing to publish: tree changed after verification (staged ${stagedTreeHash}, verified ${input.verification.treeHash})`,
      );
    }

    const commitSha = await this.workspaceManager.commit(input.workspace, {
      issueNumber: input.issueNumber,
      message: input.taskSnapshot.objective,
      expectedTreeHash: input.verification.treeHash,
    });

    this.runStore.recordPublication(input.runId, {
      branch: input.workspace.branch,
      commitSha,
    });

    await this.push(input.workspace);

    const pullRequest = await this.publishPullRequest(input);

    this.runStore.recordPublication(input.runId, {
      branch: input.workspace.branch,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
    });

    const comment = await this.publishIssueComment(input, pullRequest);

    this.runStore.recordPublication(input.runId, {
      branch: input.workspace.branch,
      commentMarker: comment.marker,
      commentId: comment.id,
    });

    return {
      commitSha,
      branch: input.workspace.branch,
      pullRequest,
      comment,
    };
  }

  private async push(workspace: Workspace): Promise<void> {
    const result = await this.processRunner.run({
      command: "git",
      args: ["push", "--set-upstream", "origin", workspace.branch],
      cwd: workspace.path,
      timeoutMs: 60_000,
      env: safeProcessEnv(),
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new PublicationError(
        `git push failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
      );
    }
  }

  private async publishPullRequest(input: PublishInput): Promise<PullRequestRef> {
    const existing = await this.github.findPullRequestByHead(input.workspace.branch);
    if (existing !== null) return existing;

    const body = renderPrBody({
      runId: input.runId,
      taskSnapshot: input.taskSnapshot,
      review: input.review,
      verification: input.verification,
      implementationSummary: input.implementationSummary,
    });

    return await this.github.createPullRequest({
      title: input.taskSnapshot.objective,
      body,
      head: input.workspace.branch,
      base: input.config.baseBranch,
      draft: input.config.draftPr,
    });
  }

  private async publishIssueComment(
    input: PublishInput,
    pullRequest: PullRequestRef,
  ): Promise<PublicationCommentResult> {
    const marker = commentMarker(input.runId);
    const existing = await this.github.findIssueCommentByMarker(
      input.issueNumber,
      marker,
    );
    if (existing !== null) return { id: existing.id, marker };

    const body = renderIssueComment({
      runId: input.runId,
      pullRequest,
      verification: input.verification,
    });
    await this.github.createIssueComment(input.issueNumber, body);
    const created = await this.github.findIssueCommentByMarker(
      input.issueNumber,
      marker,
    );
    if (created === null) {
      throw new PublicationError(
        `posted issue comment for run ${input.runId} but could not find it afterward`,
      );
    }
    return { id: created.id, marker };
  }
}
