import type { DaemonQueue } from "../daemon/queue-store.js";
import type { SchedulerPolicy } from "./policy.js";

export type SchedulerIssueState =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "DEFERRED_DEPENDENCY"
  | "DEFERRED_CONFLICT"
  | "DEFERRED_INVALID";

export interface DependencySnapshot {
  issueNumber: number;
  satisfied: boolean;
  source: "github-closed" | "local-pr-open" | "unsatisfied" | "invalid";
  checkedAt: string;
}

export interface WorkspaceScope {
  kind: "paths" | "unknown";
  patterns: string[];
  source: "issue-contract" | "analysis-report" | "missing";
}

export interface SchedulerIssue {
  issueNumber: number;
  state: SchedulerIssueState;
  dependencies: DependencySnapshot[];
  workspaceScope: WorkspaceScope;
  reason: string | null;
  runId: string | null;
  outcome: string | null;
}

export interface ActiveSchedulerRun {
  issueNumber: number;
  runId: string | null;
  startedAt: string;
  workspaceScope: WorkspaceScope;
}

export interface SchedulerBudgetUsage {
  startedRuns: number;
  failedRuns: number;
  elapsedMinutes: number;
  stopReason: string | null;
}

export interface SchedulerState {
  version: 1;
  policy: SchedulerPolicy;
  startedAt: string;
  lastUpdatedAt: string;
  issues: SchedulerIssue[];
  activeRuns: ActiveSchedulerRun[];
  budgets: SchedulerBudgetUsage;
  lastBlockedRefreshAt: string | null;
  idleSince: string | null;
}

export const UNKNOWN_WORKSPACE_SCOPE: WorkspaceScope = {
  kind: "unknown",
  patterns: [],
  source: "missing",
};

export interface InitialSchedulerIssueInput {
  issueNumber: number;
  dependencies: DependencySnapshot[];
  workspaceScope: WorkspaceScope;
  initialState: SchedulerIssueState;
  reason: string | null;
}

export function createInitialSchedulerState(input: {
  policy: SchedulerPolicy;
  startedAt: string;
  issues: InitialSchedulerIssueInput[];
}): SchedulerState {
  return {
    version: 1,
    policy: input.policy,
    startedAt: input.startedAt,
    lastUpdatedAt: input.startedAt,
    issues: input.issues.map((issue) => ({
      issueNumber: issue.issueNumber,
      state: issue.initialState,
      dependencies: issue.dependencies,
      workspaceScope: issue.workspaceScope,
      reason: issue.reason,
      runId: null,
      outcome: null,
    })),
    activeRuns: [],
    budgets: {
      startedRuns: 0,
      failedRuns: 0,
      elapsedMinutes: 0,
      stopReason: null,
    },
    lastBlockedRefreshAt: null,
    idleSince: null,
  };
}

export function ensureSchedulerState(
  queue: DaemonQueue,
  policy: SchedulerPolicy,
  now: () => string,
): SchedulerState {
  if (queue.scheduler !== undefined) return queue.scheduler;
  void now;
  return createInitialSchedulerState({
    policy,
    startedAt: queue.startedAt,
    issues: queue.issues.slice(queue.currentIndex).map((issueNumber) => ({
      issueNumber,
      dependencies: [],
      workspaceScope: UNKNOWN_WORKSPACE_SCOPE,
      initialState: "PENDING",
      reason: "legacy queue entry",
    })),
  });
}
