import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseShell } from "shell-quote";

export interface CommandDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * First tokens that dispatch to arbitrary subcommands and therefore bypass
 * every token-level check (allowlist, git/gh denials). They are rejected
 * even if a repository policy explicitly allowlists them.
 */
const DENIED_DISPATCHERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "env",
  "sudo",
  "doas",
  "su",
  "xargs",
  "nohup",
  "nice",
  "setsid",
  "stdbuf",
  "time",
  "timeout",
  "watch",
  "strace",
  "ltrace",
  "gdb",
  "script",
]);

/** Read-only git subcommands that an agent may run when git is allowlisted. */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "blame",
  "describe",
  "shortlog",
  "name-rev",
]);

/**
 * Fail-closed evaluation of a shell command an agent wants to run inside
 * its workspace. Rejects operators, substitutions, redirections, globs,
 * path-qualified executables, command dispatchers, `gh`, mutating git
 * subcommands, and anything whose first token is not explicitly allowed.
 */
export function evaluateShellCommand(
  command: string,
  allowedCommands: string[],
): CommandDecision {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { allowed: false, reason: "empty command" };
  }
  if (command.includes("$")) {
    return { allowed: false, reason: "variable or command substitution" };
  }
  if (command.includes("`")) {
    return { allowed: false, reason: "command substitution" };
  }
  if (command.includes("\n")) {
    return { allowed: false, reason: "newline in command" };
  }

  let tokens: unknown[];
  try {
    tokens = parseShell(command);
  } catch {
    return { allowed: false, reason: "unparseable command" };
  }

  // Reject any non-string token: shell operators, redirections, globs.
  for (const token of tokens) {
    if (typeof token !== "string") {
      return { allowed: false, reason: "shell operator or glob" };
    }
    if (token.includes("`")) {
      return { allowed: false, reason: "command substitution" };
    }
  }

  const first = tokens[0];
  if (typeof first !== "string" || first.length === 0) {
    return { allowed: false, reason: "missing command" };
  }

  // Bare executable names only: no absolute or relative paths.
  if (first.includes("/") || first.startsWith(".")) {
    return { allowed: false, reason: "command must be a bare name" };
  }

  if (DENIED_DISPATCHERS.has(first)) {
    return { allowed: false, reason: `command dispatcher not allowed: ${first}` };
  }

  if (!allowedCommands.includes(first)) {
    return { allowed: false, reason: `command not allowed: ${first}` };
  }

  if (first === "git") {
    const subcommand = tokens[1];
    if (
      typeof subcommand !== "string" ||
      !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)
    ) {
      return {
        allowed: false,
        reason: `git subcommand not allowed: ${String(subcommand ?? "(none)")}`,
      };
    }
  }

  // Scan all tokens: `gh` anywhere, and `git <forbidden>` pairs smuggled
  // through executors such as `npm exec -- git push`.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "gh") {
      return { allowed: false, reason: "gh is not allowed" };
    }
    if (token === "git") {
      const next = tokens[i + 1];
      if (typeof next !== "string" || !ALLOWED_GIT_SUBCOMMANDS.has(next)) {
        return {
          allowed: false,
          reason: `git subcommand not allowed: ${String(next ?? "(none)")}`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Resolve a candidate path against the worktree, following existing
 * symlinked ancestors, and reject anything that escapes the worktree or
 * lands under a protected path. Returns the normalized absolute path.
 */
export function assertWorkspacePath(
  worktree: string,
  candidate: string,
  protectedPaths: string[],
): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("empty path");
  }

  const root = realpathSync(worktree);
  const candidateAbs = path.isAbsolute(candidate)
    ? candidate
    : path.join(root, candidate);
  const resolved = resolveFollowingAncestors(candidateAbs);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path outside worktree: ${candidate}`);
  }

  for (const protectedPath of protectedPaths) {
    const protectedAbs = path.isAbsolute(protectedPath)
      ? protectedPath
      : path.join(root, protectedPath);
    const protectedResolved = resolveFollowingAncestors(protectedAbs);
    if (
      protectedResolved === resolved ||
      resolved.startsWith(`${protectedResolved}${path.sep}`)
    ) {
      throw new Error(`path is protected: ${candidate}`);
    }
  }

  return resolved;
}

/**
 * Realpath the deepest existing ancestor so symlinked directories cannot
 * smuggle a path outside the worktree, then append the unresolved tail.
 */
function resolveFollowingAncestors(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(target);
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...tail);
}
