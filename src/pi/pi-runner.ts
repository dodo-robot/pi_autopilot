import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { Role, RoleResult } from "../domain/contracts.js";
import {
  ImplementerResultSchema,
  RefinerResultSchema,
  ReviewerResultSchema,
} from "../domain/contracts.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { ProcessRunner } from "../platform/process-runner.js";

const ROLE_SCHEMAS: Record<Role, z.ZodType> = {
  refiner: RefinerResultSchema,
  implementer: ImplementerResultSchema,
  reviewer: ReviewerResultSchema,
};

/** Tools available to analysis roles (refiner/reviewer): read-only + submit. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "submit_result"];

/** Tools available to the implementer: read-only tools plus guarded mutations. */
const IMPLEMENTER_TOOLS = [...READ_ONLY_TOOLS, "bash", "edit", "write"];

const ROLE_TOOLS: Record<Role, string[]> = {
  refiner: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
};

export interface PiRunRequest {
  role: Role;
  model: ResolvedRoleModel;
  /** Instructions for the role session, including the result contract. */
  prompt: string;
  /** Session working directory; must exist. */
  worktree: string;
  allowedCommands: string[];
  protectedPaths: string[];
  /** Dedicated Pi session directory for this role attempt. */
  sessionDir: string;
  /** Directory where the guard envelope, result, and diagnostics land. */
  diagnosticsDir: string;
  /**
   * Explicit environment for the Pi process. Callers must include PATH
   * (and provider credentials) they want the session to see. The runner
   * always adds AUTOPILOT_GUARD_CONFIG itself.
   */
  env: Record<string, string>;
  timeoutMs: number;
  /** Override the Pi executable (tests use a fake). Defaults to `pi`. */
  piCommand?: string;
  /** Override the guard extension path. Defaults to the compiled sibling. */
  extensionPath?: string;
}

export interface PiExecution {
  /** Validated role result, never derived from stdout/stderr. */
  result: RoleResult;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  resultPath: string;
  sessionDir: string;
}

export class PiRunError extends Error {
  constructor(
    message: string,
    public readonly role: Role,
    public readonly diagnostics: {
      stdout: string;
      stderr: string;
      resultPath: string;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PiRunError";
  }
}

const DEFAULT_EXTENSION_PATH = fileURLToPath(
  new URL("./guard-extension.js", import.meta.url),
);

/**
 * Launches a bounded, headless, role-specific Pi session and validates its
 * structured result. The session runs inside the given worktree with a
 * dedicated session directory, an explicit environment, a per-role tool
 * allowlist, and the compiled guard extension enforcing the command/path
 * policy. Only the result file the guard wrote is trusted.
 */
export class PiRunner {
  constructor(
    private readonly processRunner: ProcessRunner = new ProcessRunner(),
    private readonly defaultPiCommand = "pi",
    private readonly defaultExtensionPath = DEFAULT_EXTENSION_PATH,
  ) {}

  async run(request: PiRunRequest): Promise<PiExecution> {
    const role = request.role;
    const resultPath = path.join(request.diagnosticsDir, "result.json");
    const envelopePath = path.join(request.diagnosticsDir, "guard-envelope.json");

    mkdirSync(request.diagnosticsDir, { recursive: true });
    mkdirSync(request.sessionDir, { recursive: true });
    // A fresh attempt must never pick up a stale result file.
    rmSync(resultPath, { force: true });
    rmSync(envelopePath, { force: true });

    const envelope = {
      worktree: request.worktree,
      role,
      resultPath,
      allowedCommands: request.allowedCommands,
      protectedPaths: request.protectedPaths,
      allowedTools: ROLE_TOOLS[role],
    };
    writeFileSync(envelopePath, JSON.stringify(envelope), {
      encoding: "utf8",
      mode: 0o600,
    });

    const piCommand = request.piCommand ?? this.defaultPiCommand;
    const extensionPath = request.extensionPath ?? this.defaultExtensionPath;
    const tools = ROLE_TOOLS[role].join(",");

    const processResult = await this.processRunner.run({
      command: piCommand,
      args: [
        "--print",
        "--mode",
        "json",
        "--approve",
        "--session-dir",
        request.sessionDir,
        "--model",
        request.model.model,
        "--thinking",
        request.model.thinking,
        "--tools",
        tools,
        "--extension",
        extensionPath,
        request.prompt,
      ],
      cwd: request.worktree,
      timeoutMs: request.timeoutMs,
      env: { ...request.env, AUTOPILOT_GUARD_CONFIG: envelopePath },
    });

    const diagnostics = {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      resultPath,
    };

    if (processResult.timedOut) {
      throw new PiRunError(
        `${role} session timed out after ${request.timeoutMs}ms`,
        role,
        diagnostics,
      );
    }
    if (processResult.exitCode !== 0) {
      const signal = processResult.signal ? ` (${processResult.signal})` : "";
      throw new PiRunError(
        `${role} session exited with code ${String(processResult.exitCode)}${signal}`,
        role,
        diagnostics,
      );
    }

    if (!existsSync(resultPath)) {
      throw new PiRunError(
        `no structured result submitted by ${role}`,
        role,
        diagnostics,
      );
    }

    let raw: string;
    try {
      raw = readFileSync(resultPath, "utf8");
    } catch (error) {
      throw new PiRunError(
        `cannot read result submitted by ${role}`,
        role,
        diagnostics,
        { cause: error },
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new PiRunError(
        `invalid ${role} result: not valid JSON`,
        role,
        diagnostics,
        { cause: error },
      );
    }

    const parsed = ROLE_SCHEMAS[role].safeParse(data);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new PiRunError(`invalid ${role} result: ${details}`, role, diagnostics);
    }

    return {
      result: parsed.data as RoleResult,
      exitCode: processResult.exitCode,
      durationMs: processResult.durationMs,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      resultPath,
      sessionDir: request.sessionDir,
    };
  }
}
