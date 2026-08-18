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

/**
 * Dangerous or network-capable executables that may never be smuggled
 * through an allowlisted executor (for example `find -exec rm` or
 * `npm exec -- curl`). They are permitted only as the primary command of
 * the line, and only when a repository policy explicitly allowlists them.
 *
 * This is a fail-closed default rather than configuration: a repository
 * cannot accidentally widen the deny set, and the default policy never
 * includes these programs.
 */
const DENIED_EXECUTABLES = new Set([
  "rm",
  "mv",
  "cp",
  "curl",
  "wget",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  // Scripting runtimes and multicall binaries: extremely common smuggling
  // targets (`npm exec -- node -e 'child_process…'`, `find -exec busybox`,
  // `deno eval`, `bun -e`). They are still usable as an allowlisted PRIMARY
  // command; this entry only closes the executor-smuggling position.
  "node",
  "deno",
  "bun",
  "busybox",
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
 * subcommands, dangerous executables smuggled through executors, and
 * anything whose first token is not explicitly allowed.
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

  // `npm --call` / `npm -c` (and the nopt `--call=` form) run an arbitrary
  // quoted string through a shell, bypassing every token-level check. `npx`
  // accepts the identical `--call`/`-c` flags with the same effect. Reject
  // the whole command outright: parsing the quoted string's own tokens would
  // reopen the same smuggling class by construction.
  if (first === "npm" || first === "npx") {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        typeof token === "string" &&
        (token === "--call" || token === "-c" || token.startsWith("--call="))
      ) {
        return {
          allowed: false,
          reason: "npm run-string flag (--call/-c) not allowed",
        };
      }
    }
  }

  // Full-token scan: dispatchers and `gh` are rejected anywhere; dangerous
  // executables are rejected anywhere except as a policy-allowlisted
  // primary command; `git` pairs must use an allowed read-only subcommand.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== "string") {
      continue;
    }
    if (DENIED_DISPATCHERS.has(token) || token === "gh") {
      return { allowed: false, reason: `denied executable: ${token}` };
    }
    if (DENIED_EXECUTABLES.has(token)) {
      if (i === 0 && allowedCommands.includes(token)) {
        continue;
      }
      return { allowed: false, reason: `denied executable: ${token}` };
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
