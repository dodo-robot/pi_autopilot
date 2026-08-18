import { createHash } from "node:crypto";
import { parse as parseShell } from "shell-quote";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactRef } from "../persistence/artifact-store.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import type { Workspace, WorkspaceManager } from "../workspace/workspace-manager.js";

export class VerificationRunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VerificationRunnerError";
  }
}

/** Outcome of one executed shell command (setup or verification). */
export interface CommandOutcome {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  stdoutArtifact: ArtifactRef | null;
  stderrArtifact: ArtifactRef | null;
  /**
   * Set when the command could not be executed at all (empty command, or a
   * shell operator/glob/substitution/redirection that this runner refuses
   * to interpret). `exitCode` is `null` and no process ever ran.
   */
  error?: string;
}

/** Result of running a workspace's configured setup commands. */
export interface SetupResult {
  passed: boolean;
  commands: CommandOutcome[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Deterministic evidence produced by running every configured verification
 * command against a workspace, bound to the exact tree that was verified.
 */
export interface VerificationEvidence {
  passed: boolean;
  /** Tree hash of the workspace's file state, captured after the final command. */
  treeHash: string;
  /** Hash of the configured commands this evidence was produced against. */
  policyHash: string;
  commands: CommandOutcome[];
  startedAt: string;
  finishedAt: string;
}

/** Options shared by setup and verification runs. */
export interface CommandRunOptions {
  commands: string[];
  /** Timeout applied to each individual command. */
  timeoutMs: number;
  /** Nonsecret environment additions layered on top of the safe base env. */
  env?: Record<string, string>;
}

export interface VerificationRunnerDeps {
  processRunner: ProcessRunner;
  artifacts: ArtifactStore;
  /** Used to capture the workspace tree hash after verification. */
  workspaceManager: WorkspaceManager;
}

const MAX_ARTIFACT_CHARS = 200_000;

function truncate(text: string): string {
  if (text.length <= MAX_ARTIFACT_CHARS) return text;
  return text.slice(text.length - MAX_ARTIFACT_CHARS);
}

function nowIso(): string {
  return new Date().toISOString();
}

function policyHash(commands: string[]): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

/**
 * Split a shell command string into a bare command and its arguments.
 *
 * Fails closed, matching the convention in `src/security/command-policy.ts`:
 * any non-string token from `shell-quote` (operators like `&&`/`||`/`;`/`|`,
 * globs, substitutions, redirections) means the string is not a single plain
 * command, so it is rejected outright rather than silently dropped and
 * glued onto the surrounding tokens.
 */
function splitCommand(command: string): { command: string; args: string[] } {
  if (command.trim().length === 0) {
    throw new VerificationRunnerError(`empty command: ${JSON.stringify(command)}`);
  }

  const rawTokens = parseShell(command);
  const tokens: string[] = [];
  for (const token of rawTokens) {
    if (typeof token !== "string") {
      throw new VerificationRunnerError(
        `command contains a shell operator, glob, substitution, or redirection and was rejected: ${JSON.stringify(command)}`,
      );
    }
    tokens.push(token);
  }

  const [first, ...rest] = tokens;
  if (first === undefined) {
    throw new VerificationRunnerError(`empty command: ${JSON.stringify(command)}`);
  }
  return { command: first, args: rest };
}

/**
 * Runs a workspace's configured setup and verification commands with a
 * deterministic, explicit environment and persists bounded evidence for
 * every command. Verification evidence is independent of any agent claim:
 * `passed` reflects only the commands' actual exit status and timeouts,
 * and `treeHash` is captured from the exact tree after the final command.
 */
export class VerificationRunner {
  private readonly processRunner: ProcessRunner;
  private readonly artifacts: ArtifactStore;
  private readonly workspaceManager: WorkspaceManager;

  constructor(deps: VerificationRunnerDeps) {
    this.processRunner = deps.processRunner;
    this.artifacts = deps.artifacts;
    this.workspaceManager = deps.workspaceManager;
  }

  /**
   * Execute setup commands once, in order, stopping at the first failure
   * (including a timeout) so implementation never begins against a
   * partially prepared workspace.
   */
  async runSetup(
    workspace: Workspace,
    runId: string,
    options: CommandRunOptions,
  ): Promise<SetupResult> {
    const startedAt = nowIso();
    const commands: CommandOutcome[] = [];

    for (let index = 0; index < options.commands.length; index++) {
      const command = options.commands[index]!;
      const outcome = await this.runOne(
        workspace,
        runId,
        "setup",
        index,
        command,
        options.timeoutMs,
        options.env,
      );
      commands.push(outcome);
      if (outcome.timedOut || outcome.exitCode !== 0) {
        return { passed: false, commands, startedAt, finishedAt: nowIso() };
      }
    }

    return { passed: true, commands, startedAt, finishedAt: nowIso() };
  }

  /**
   * Execute every configured verification command in order, continuing
   * past a failed or timed-out command so the reviewer receives complete
   * evidence. The tree hash is captured only after the final command runs.
   */
  async runVerification(
    workspace: Workspace,
    runId: string,
    options: CommandRunOptions,
  ): Promise<VerificationEvidence> {
    const startedAt = nowIso();
    const commands: CommandOutcome[] = [];

    for (let index = 0; index < options.commands.length; index++) {
      const command = options.commands[index]!;
      const outcome = await this.runOne(
        workspace,
        runId,
        "verification",
        index,
        command,
        options.timeoutMs,
        options.env,
      );
      commands.push(outcome);
    }

    const passed = commands.every(
      (outcome) => !outcome.timedOut && outcome.exitCode === 0,
    );
    const treeHash = await this.workspaceManager.treeHash(workspace);

    return {
      passed,
      treeHash,
      policyHash: policyHash(options.commands),
      commands,
      startedAt,
      finishedAt: nowIso(),
    };
  }

  private async runOne(
    workspace: Workspace,
    runId: string,
    phase: "setup" | "verification",
    index: number,
    command: string,
    timeoutMs: number,
    env: Record<string, string> | undefined,
  ): Promise<CommandOutcome> {
    const startedAt = nowIso();

    let bin: string;
    let args: string[];
    try {
      ({ command: bin, args } = splitCommand(command));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        command,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        startedAt,
        finishedAt: nowIso(),
        stdoutArtifact: null,
        stderrArtifact: null,
        error: message,
      };
    }

    const result = await this.processRunner.run({
      command: bin,
      args,
      cwd: workspace.path,
      timeoutMs,
      env: safeProcessEnv(env),
    });

    const base = `${phase}/${index}-${bin}`;
    const stdoutArtifact = await this.artifacts.writeJson(
      runId,
      `${base}.stdout.json`,
      truncate(result.stdout),
    );
    const stderrArtifact = await this.artifacts.writeJson(
      runId,
      `${base}.stderr.json`,
      truncate(result.stderr),
    );

    return {
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      startedAt,
      finishedAt: nowIso(),
      stdoutArtifact,
      stderrArtifact,
    };
  }
}
