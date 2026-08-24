import {
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
  dependencyNumberFromMatch,
} from "../analysis/dependency-markers.js";
import type { DaemonQueue } from "../daemon/queue-store.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { GitHubPort } from "../github/github-adapter.js";
import type { RunStore } from "../persistence/run-store.js";
import type { DependencySnapshot, InitialSchedulerIssueInput } from "./state.js";
import { parseWorkspaceScopeFromIssueBody } from "./workspace-scope.js";

export function extractDependencyNumbers(body: string): number[] {
  const numbers: number[] = [];
  for (const pattern of [MANAGED_DEPENDENCY_PATTERN, LINE_DEPENDENCY_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      numbers.push(dependencyNumberFromMatch(match));
    }
  }
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

export function detectDependencyCycles(graph: Map<number, number[]>): Set<number> {
  const index = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const cyclic = new Set<number>();
  let nextIndex = 0;

  function strongConnect(node: number): void {
    index.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue;
      if (!index.has(dep)) {
        strongConnect(dep);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(dep)!));
      } else if (onStack.has(dep)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(dep)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const component: number[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      const selfCycle = component.length === 1 && (graph.get(component[0]!) ?? []).includes(component[0]!);
      if (component.length > 1 || selfCycle) {
        for (const member of component) cyclic.add(member);
      }
    }
  }

  for (const node of graph.keys()) {
    if (!index.has(node)) strongConnect(node);
  }
  return cyclic;
}

export async function refreshSchedulerDependencies(input: {
  queue: DaemonQueue;
  github: Pick<GitHubPort, "getIssue">;
  runStore: Pick<RunStore, "hasSuccessfulPrOpenForIssue">;
  now: () => string;
}): Promise<DaemonQueue> {
  if (input.queue.scheduler === undefined) return input.queue;
  const repository = input.queue.repository;
  const refreshedIssues = [];
  for (const issue of input.queue.scheduler.issues) {
    if (issue.state !== "DEFERRED_DEPENDENCY") {
      refreshedIssues.push(issue);
      continue;
    }
    const dependencies = [];
    for (const dependency of issue.dependencies) {
      const checkedAt = input.now();
      try {
        const dependencyIssue = await input.github.getIssue(dependency.issueNumber);
        if (dependencyIssue.state === "closed") {
          dependencies.push({ ...dependency, satisfied: true, source: "github-closed" as const, checkedAt });
        } else if (input.runStore.hasSuccessfulPrOpenForIssue(repository.owner, repository.repo, dependency.issueNumber)) {
          dependencies.push({ ...dependency, satisfied: true, source: "local-pr-open" as const, checkedAt });
        } else {
          dependencies.push({ ...dependency, satisfied: false, source: "unsatisfied" as const, checkedAt });
        }
      } catch (error) {
        dependencies.push({ ...dependency, satisfied: false, source: "unsatisfied" as const, checkedAt });
      }
    }
    const unblocked = dependencies.every((dependency) => dependency.satisfied);
    refreshedIssues.push({
      ...issue,
      dependencies,
      state: unblocked ? "PENDING" as const : "DEFERRED_DEPENDENCY" as const,
      reason: unblocked ? "ready" : "waiting for dependencies",
    });
  }
  const refreshedAt = input.now();
  return {
    ...input.queue,
    scheduler: {
      ...input.queue.scheduler,
      issues: refreshedIssues,
      lastBlockedRefreshAt: refreshedAt,
      lastUpdatedAt: refreshedAt,
    },
  };
}

export async function buildSchedulerIssueInputs(input: {
  root?: string;
  repository: RepositoryRef;
  issueNumbers: number[];
  now: string;
  github: Pick<GitHubPort, "getIssue">;
  runStore: Pick<RunStore, "hasSuccessfulPrOpenForIssue">;
}): Promise<InitialSchedulerIssueInput[]> {
  const issues: Array<{ issueNumber: number; body: string }> = [];
  for (const issueNumber of input.issueNumbers) {
    const issue = await input.github.getIssue(issueNumber);
    issues.push({ issueNumber, body: issue.body });
  }

  const snapshots = await buildDependencySnapshots({
    repository: input.repository,
    issues,
    now: () => input.now,
    getIssueState: async (issueNumber) => (await input.github.getIssue(issueNumber)).state,
    hasLocalPrOpen: async (issueNumber) => input.runStore.hasSuccessfulPrOpenForIssue(
      input.repository.owner,
      input.repository.repo,
      issueNumber,
    ),
  });
  const graph = new Map<number, number[]>(
    issues.map((issue) => [
      issue.issueNumber,
      (snapshots.get(issue.issueNumber) ?? []).map((dependency) => dependency.issueNumber),
    ]),
  );
  const cyclic = detectDependencyCycles(graph);
  return issues.map((issue) => {
    const dependencies = snapshots.get(issue.issueNumber) ?? [];
    const hasInvalid = dependencies.some((dependency) => dependency.source === "invalid");
    const hasUnsatisfied = dependencies.some((dependency) => !dependency.satisfied);
    const workspaceScope = parseWorkspaceScopeFromIssueBody(issue.body);
    if (cyclic.has(issue.issueNumber)) {
      return {
        issueNumber: issue.issueNumber,
        dependencies,
        workspaceScope,
        initialState: "DEFERRED_INVALID",
        reason: "dependency cycle",
      };
    }
    if (hasInvalid) {
      return {
        issueNumber: issue.issueNumber,
        dependencies,
        workspaceScope,
        initialState: "DEFERRED_INVALID",
        reason: "invalid dependency metadata",
      };
    }
    if (hasUnsatisfied) {
      return {
        issueNumber: issue.issueNumber,
        dependencies,
        workspaceScope,
        initialState: "DEFERRED_DEPENDENCY",
        reason: "waiting for dependencies",
      };
    }
    return {
      issueNumber: issue.issueNumber,
      dependencies,
      workspaceScope,
      initialState: "PENDING",
      reason: "ready",
    };
  });
}

export async function buildDependencySnapshots(input: {
  repository: RepositoryRef;
  issues: Array<{ issueNumber: number; body: string }>;
  now: () => string;
  getIssueState(issueNumber: number): Promise<string>;
  hasLocalPrOpen(issueNumber: number): Promise<boolean>;
}): Promise<Map<number, DependencySnapshot[]>> {
  void input.repository;
  const result = new Map<number, DependencySnapshot[]>();
  for (const issue of input.issues) {
    const snapshots: DependencySnapshot[] = [];
    for (const dependency of extractDependencyNumbers(issue.body)) {
      const checkedAt = input.now();
      try {
        const state = await input.getIssueState(dependency);
        if (state === "closed") {
          snapshots.push({ issueNumber: dependency, satisfied: true, source: "github-closed", checkedAt });
        } else if (await input.hasLocalPrOpen(dependency)) {
          snapshots.push({ issueNumber: dependency, satisfied: true, source: "local-pr-open", checkedAt });
        } else {
          snapshots.push({ issueNumber: dependency, satisfied: false, source: "unsatisfied", checkedAt });
        }
      } catch {
        snapshots.push({ issueNumber: dependency, satisfied: false, source: "invalid", checkedAt });
      }
    }
    result.set(issue.issueNumber, snapshots);
  }
  return result;
}
