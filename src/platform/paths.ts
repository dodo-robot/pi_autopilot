import { homedir } from "node:os";
import path from "node:path";

/** Resolved application data and run-artifact paths. */
export interface AppPaths {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly runsDir: string;
  readonly daemonDir: string;
  readonly pidPath: string;
  readonly queuePath: string;
  readonly pendingQueuePath: string;
  readonly logPath: string;
  /** Absolute directory for a run's artifacts. */
  runDir(runId: string): string;
  /** Absolute path for one artifact inside a run's directory. */
  artifactPath(runId: string, relative: string): string;
  /**
   * Stable per-issue pointer path under `runs/_latest/<owner>/<repo>/<n>.json`,
   * distinct from the per-run directories under `runs/check-*`.
   */
  issuePointerPath(owner: string, repo: string, issueNumber: number): string;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const POINTER_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Reject run IDs that could escape the runs directory via path traversal. */
export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`unsafe run id: ${JSON.stringify(runId)}`);
  }
}

/**
 * Default platform data directory. The `AUTOPILOT_DATA_DIR` environment
 * variable overrides the standard `~/.local/share/pi-autopilot` location.
 */
export function defaultDataDir(): string {
  const env = process.env.AUTOPILOT_DATA_DIR;
  if (env !== undefined && env.length > 0) return env;
  return path.join(homedir(), ".local", "share", "pi-autopilot");
}

export function appPaths(dataDir: string = defaultDataDir()): AppPaths {
  const dbPath = path.join(dataDir, "autopilot.db");
  const runsDir = path.join(dataDir, "runs");
  const daemonDir = path.join(dataDir, "daemon");
  return {
    dataDir,
    dbPath,
    runsDir,
    daemonDir,
    pidPath: path.join(daemonDir, "pid"),
    queuePath: path.join(daemonDir, "queue.json"),
    pendingQueuePath: path.join(daemonDir, "queue-pending.json"),
    logPath: path.join(daemonDir, "daemon.log"),
    runDir(runId: string): string {
      assertSafeRunId(runId);
      return path.join(runsDir, runId);
    },
    artifactPath(runId: string, relative: string): string {
      assertSafeRunId(runId);
      const root = path.resolve(runsDir, runId);
      const resolved = path.resolve(root, relative);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`artifact escapes run directory: ${relative}`);
      }
      return resolved;
    },
    issuePointerPath(owner: string, repo: string, issueNumber: number): string {
      for (const segment of [owner, repo]) {
        if (!POINTER_SEGMENT_PATTERN.test(segment)) {
          throw new Error(`unsafe pointer segment: ${JSON.stringify(segment)}`);
        }
      }
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`unsafe issue number: ${JSON.stringify(issueNumber)}`);
      }
      return path.join(
        runsDir,
        "_latest",
        owner,
        repo,
        `${issueNumber}.json`,
      );
    },
  };
}
