import { UNKNOWN_WORKSPACE_SCOPE, type WorkspaceScope } from "./state.js";

const WORKSPACE_SCOPE_HEADING = /^###\s+Workspace scope\s*$/i;
const NEXT_HEADING = /^###\s+/;

export function normalizePathPattern(pattern: string): string {
  return pattern
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

export function parseWorkspaceScopeFromIssueBody(body: string): WorkspaceScope {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => WORKSPACE_SCOPE_HEADING.test(line.trim()));
  if (start === -1) return UNKNOWN_WORKSPACE_SCOPE;

  const patterns: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (NEXT_HEADING.test(line)) break;
    if (line.length === 0) continue;
    const bullet = line.match(/^-\s+(.+)$/);
    const value = normalizePathPattern(bullet?.[1] ?? line);
    if (value.length > 0 && value.toLowerCase() !== "none.") patterns.push(value);
  }

  if (patterns.length === 0) return UNKNOWN_WORKSPACE_SCOPE;
  return { kind: "paths", patterns: Array.from(new Set(patterns)), source: "issue-contract" };
}

export function workspaceScopesConflict(a: WorkspaceScope, b: WorkspaceScope): boolean {
  if (a.kind === "unknown" || b.kind === "unknown") return true;
  for (const left of a.patterns.map(normalizePathPattern)) {
    for (const right of b.patterns.map(normalizePathPattern)) {
      if (patternsConflict(left, right)) return true;
    }
  }
  return false;
}

export function workspaceScopeReason(scope: WorkspaceScope): string {
  if (scope.kind === "unknown") return "unknown workspace scope";
  return scope.patterns.join(", ");
}

function patternsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const aPrefix = globPrefix(a);
  const bPrefix = globPrefix(b);
  if (isSameOrChild(aPrefix, bPrefix) || isSameOrChild(bPrefix, aPrefix)) return true;
  return false;
}

function globPrefix(pattern: string): string {
  const wildcard = pattern.search(/[\*\?\[]/);
  const raw = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return normalizePathPattern(raw.replace(/\/[^/]*$/, (match) => match.includes(".") ? "" : match));
}

function isSameOrChild(parent: string, child: string): boolean {
  if (parent.length === 0 || child.length === 0) return true;
  return child === parent || child.startsWith(`${parent}/`);
}
