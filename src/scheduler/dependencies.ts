import {
  LINE_DEPENDENCY_PATTERN,
  MANAGED_DEPENDENCY_PATTERN,
  dependencyNumberFromMatch,
} from "../analysis/dependency-markers.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { DependencySnapshot } from "./state.js";

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
