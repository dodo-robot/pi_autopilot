import type { CompletedRun } from "../daemon/queue-store.js";
import type { RunSummary } from "../workflow/run-service.js";
import type {
  InitialSchedulerIssueInput,
  SchedulerIssue,
  SchedulerState,
} from "./state.js";
import {
  workspaceScopeReason,
  workspaceScopesConflict,
} from "./workspace-scope.js";

export function updateBudgetUsage(
  state: SchedulerState,
  now: string,
): SchedulerState {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(state.startedAt)) / 60_000),
  );
  return {
    ...state,
    budgets: { ...state.budgets, elapsedMinutes },
    lastUpdatedAt: now,
  };
}

export function isStartBudgetExhausted(state: SchedulerState): string | null {
  const budgets = state.policy.budgets;
  if (
    budgets.maxElapsedMinutes !== null &&
    state.budgets.elapsedMinutes >= budgets.maxElapsedMinutes
  ) {
    return `max elapsed minutes reached (${state.budgets.elapsedMinutes}/${budgets.maxElapsedMinutes})`;
  }
  if (
    budgets.maxStartedRuns !== null &&
    state.budgets.startedRuns >= budgets.maxStartedRuns
  ) {
    return `max started runs reached (${state.budgets.startedRuns}/${budgets.maxStartedRuns})`;
  }
  if (
    budgets.maxFailedRuns !== null &&
    state.budgets.failedRuns >= budgets.maxFailedRuns
  ) {
    return `max failed runs reached (${state.budgets.failedRuns}/${budgets.maxFailedRuns})`;
  }
  return null;
}

export function findStartableIssue(
  state: SchedulerState,
  now: string,
): SchedulerIssue | null {
  const current = updateBudgetUsage(state, now);
  if (isStartBudgetExhausted(current) !== null) return null;
  if (current.activeRuns.length >= current.policy.maxConcurrentRuns) return null;
  return current.issues.find(
    (issue) =>
      issue.state === "PENDING" &&
      issue.dependencies.every((dependency) => dependency.satisfied) &&
      !current.activeRuns.some((run) =>
        workspaceScopesConflict(issue.workspaceScope, run.workspaceScope),
      ),
  ) ?? null;
}

export function markIssueRunning(
  state: SchedulerState,
  issueNumber: number,
  runId: string | null,
  startedAt: string,
): SchedulerState {
  const issue = state.issues.find(
    (candidate) => candidate.issueNumber === issueNumber,
  );
  if (issue === undefined) {
    throw new Error(`cannot start unknown scheduler issue #${issueNumber}`);
  }
  return {
    ...state,
    lastUpdatedAt: startedAt,
    idleSince: null,
    budgets: {
      ...state.budgets,
      startedRuns: state.budgets.startedRuns + 1,
    },
    issues: state.issues.map((candidate) =>
      candidate.issueNumber === issueNumber
        ? { ...candidate, state: "RUNNING", runId, reason: "running" }
        : candidate,
    ),
    activeRuns: [
      ...state.activeRuns,
      { issueNumber, runId, startedAt, workspaceScope: issue.workspaceScope },
    ],
  };
}

export function completeIssue(
  state: SchedulerState,
  summary: RunSummary,
  completedAt: string,
): SchedulerState {
  const failed = summary.stage === "FAILED" || summary.stage === "BLOCKED";
  const completedIssues = state.issues.map((issue) => {
    if (issue.issueNumber === summary.issueNumber) {
      return {
        ...issue,
        state: "COMPLETED" as const,
        runId: summary.runId,
        outcome: summary.stage,
        reason: summary.stage,
      };
    }
    if (summary.stage === "PR_OPEN") {
      const dependencies = issue.dependencies.map((dependency) =>
        dependency.issueNumber === summary.issueNumber
          ? {
              ...dependency,
              satisfied: true,
              source: "local-pr-open" as const,
              checkedAt: completedAt,
            }
          : dependency,
      );
      const unblocked =
        issue.state === "DEFERRED_DEPENDENCY" &&
        dependencies.every((dependency) => dependency.satisfied);
      return {
        ...issue,
        dependencies,
        ...(unblocked ? { state: "PENDING" as const, reason: "ready" } : {}),
      };
    }
    return issue;
  });

  return refreshConflictStates({
    ...state,
    lastUpdatedAt: completedAt,
    activeRuns: state.activeRuns.filter(
      (run) => run.issueNumber !== summary.issueNumber,
    ),
    budgets: {
      ...state.budgets,
      failedRuns: state.budgets.failedRuns + (failed ? 1 : 0),
    },
    issues: completedIssues,
  });
}

export function mergePendingIssues(
  state: SchedulerState,
  issueInputs: InitialSchedulerIssueInput[],
): SchedulerState {
  const existing = new Set(state.issues.map((issue) => issue.issueNumber));
  const newIssues = issueInputs
    .filter((issue) => !existing.has(issue.issueNumber))
    .map((issue) => ({
      issueNumber: issue.issueNumber,
      state: issue.initialState,
      dependencies: issue.dependencies,
      workspaceScope: issue.workspaceScope,
      reason: issue.reason,
      runId: null,
      outcome: null,
    }));
  return {
    ...state,
    issues: [...state.issues, ...newIssues],
  };
}

function isCompletedRunOutcome(stage: RunSummary["stage"]): stage is CompletedRun["outcome"] {
  return (
    stage === "PR_OPEN" ||
    stage === "BLOCKED" ||
    stage === "NEEDS_REFINEMENT" ||
    stage === "FAILED"
  );
}

export function toCompletedRun(
  summary: RunSummary,
  completedAt: string,
): CompletedRun {
  if (!isCompletedRunOutcome(summary.stage)) {
    throw new Error(`cannot convert non-terminal run stage ${summary.stage} to completed run`);
  }
  return {
    issueNumber: summary.issueNumber,
    outcome: summary.stage,
    completedAt,
    runId: summary.runId,
  };
}

export function refreshConflictStates(state: SchedulerState): SchedulerState {
  const issues = state.issues.map((issue) => {
    if (issue.state !== "PENDING" && issue.state !== "DEFERRED_CONFLICT") {
      return issue;
    }
    const conflict = state.activeRuns.find((run) =>
      workspaceScopesConflict(issue.workspaceScope, run.workspaceScope),
    );
    if (conflict !== undefined) {
      return {
        ...issue,
        state: "DEFERRED_CONFLICT" as const,
        reason: `conflicts with #${conflict.issueNumber}: ${workspaceScopeReason(conflict.workspaceScope)}`,
      };
    }
    if (issue.state === "DEFERRED_CONFLICT") {
      return { ...issue, state: "PENDING" as const, reason: "ready" };
    }
    return issue;
  });
  return { ...state, issues };
}
