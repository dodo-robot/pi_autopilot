import type { RepositoryRef } from "../domain/contracts.js";
import type { ProcessRunner } from "../platform/process-runner.js";

export class RepositoryContextError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepositoryContextError";
  }
}

/** Resolved identity and state of the local clone the CLI operates on. */
export interface RepositoryContext {
  /** Canonical absolute path of the repository working tree. */
  root: string;
  repository: RepositoryRef;
  originUrl: string;
  currentBranch: string;
  isClean: boolean;
}

/**
 * Parse a Git remote URL into its GitHub owner/repo identity. Returns null
 * for non-GitHub hosts or unrecognized URL shapes.
 */
export function parseGitHubRemote(remote: string): RepositoryRef | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  // Host may be `github.com` optionally followed by an SSH host alias segment
  // such as `github.com-smityx` (an ~/.ssh/config Host that points at GitHub
  // with a specific key). Any `-<alias>` suffix is accepted.
  const sshMatch =
    /^(?:git@|ssh:\/\/git@)github\.com(?:-[A-Za-z0-9_-]+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    );
  if (sshMatch !== null) {
    return { owner: sshMatch[1] ?? "", repo: sshMatch[2] ?? "" };
  }

  const httpsMatch =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (httpsMatch !== null) {
    return { owner: httpsMatch[1] ?? "", repo: httpsMatch[2] ?? "" };
  }

  return null;
}

/**
 * Build an explicit environment for git/gh subprocesses: only safe inherited
 * variables plus the given extras, with interactive Git prompting disabled.
 */
export function safeProcessEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // Propagate the provider credentials Pi needs to authenticate in a headless
  // session, and Pi's own provider/model selectors. These are present in the
  // operator's environment by design and are required for role sessions to
  // reach the model provider. Without them the session fails with
  // "No API key found for <provider>".
  const PROVIDER_VARS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "PI_PROVIDER",
    "PI_MODEL",
  ];
  for (const key of PROVIDER_VARS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function runGit(
  processRunner: ProcessRunner,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await processRunner.run({
    command: "git",
    args,
    cwd,
    timeoutMs: 30_000,
    env: safeProcessEnv(),
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new RepositoryContextError(
      `git ${args.join(" ")} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Resolve the local clone's identity and cleanliness. Rejects directories
 * that are not Git repositories, clones without an `origin`, and origins
 * that are not hosted on GitHub.
 */
export async function resolveRepositoryContext(
  root: string,
  processRunner: ProcessRunner,
): Promise<RepositoryContext> {
  let topLevel: string;
  try {
    topLevel = await runGit(processRunner, ["rev-parse", "--show-toplevel"], root);
  } catch (error) {
    throw new RepositoryContextError(`not a git repository: ${root}`, {
      cause: error,
    });
  }

  let originUrl: string;
  try {
    originUrl = await runGit(
      processRunner,
      ["remote", "get-url", "origin"],
      topLevel,
    );
  } catch {
    throw new RepositoryContextError(
      `no git remote 'origin' configured in ${topLevel}`,
    );
  }

  const repository = parseGitHubRemote(originUrl);
  if (repository === null) {
    throw new RepositoryContextError(
      `origin is not a GitHub repository: ${originUrl}`,
    );
  }

  const statusOutput = await runGit(
    processRunner,
    ["status", "--porcelain"],
    topLevel,
  );
  const currentBranch = await runGit(
    processRunner,
    ["branch", "--show-current"],
    topLevel,
  );

  return {
    root: topLevel,
    repository,
    originUrl,
    currentBranch,
    isClean: statusOutput.length === 0,
  };
}

/** Reject a repository reference that does not match the local origin. */
export function assertRepositoryMatches(
  ctx: RepositoryContext,
  expected: RepositoryRef,
): void {
  if (
    ctx.repository.owner !== expected.owner ||
    ctx.repository.repo !== expected.repo
  ) {
    throw new RepositoryContextError(
      `issue belongs to ${expected.owner}/${expected.repo} but origin is ${ctx.repository.owner}/${ctx.repository.repo}`,
    );
  }
}
