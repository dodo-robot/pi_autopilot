import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** The complete child environment; nothing is inherited beyond this map. */
  env: Record<string, string>;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class ProcessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProcessError";
  }
}

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const KILL_GRACE_MS = 1_000;

function makeBoundedCollector(limitBytes: number): {
  push(chunk: Buffer): void;
  text(): string;
} {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > limitBytes) {
        buffer = buffer.subarray(buffer.length - limitBytes);
      }
    },
    text(): string {
      return buffer.toString("utf8");
    },
  };
}

/**
 * Terminate a detached process group (POSIX) or a single process (Windows).
 * Missing groups are ignored.
 */
function terminate(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Process group already gone.
  }
}

/**
 * Runs a bounded subprocess with an explicit environment. On timeout the
 * process group receives SIGTERM and then SIGKILL after a short grace
 * period, so hung descendants cannot keep the run alive.
 */
export class ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const startedAt = Date.now();
    const stdout = makeBoundedCollector(MAX_CAPTURED_OUTPUT_BYTES);
    const stderr = makeBoundedCollector(MAX_CAPTURED_OUTPUT_BYTES);

    const child: ChildProcess = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let timedOut = false;
    let settled = false;

    return await new Promise<ProcessResult>((resolve, reject) => {
      const killTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) terminate(child.pid, "SIGTERM");
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            if (child.pid !== undefined) terminate(child.pid, "SIGKILL");
          }
        }, KILL_GRACE_MS);
        forceKill.unref();
      }, request.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        reject(
          new ProcessError(`failed to start ${request.command}: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({
          exitCode,
          signal: signal ?? null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
    });
  }
}
