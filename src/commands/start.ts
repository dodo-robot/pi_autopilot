import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { appPaths } from "../platform/paths.js";
import { PidFile } from "../daemon/pid-file.js";
import { QueueStore } from "../daemon/queue-store.js";
import { parseBacklogReport } from "../domain/backlog.js";
import { resolveRepositoryContext, safeProcessEnv } from "../github/repository-context.js";
import { ProcessRunner } from "../platform/process-runner.js";
import { resolveIssueRefs } from "./args.js";

export interface StartCommandDeps {
  dataDir?: string;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  spawnDaemon?: (daemonEntryPath: string, env: Record<string, string>) => { pid: number };
  resolveContext?: (root: string, processRunner: ProcessRunner) => Promise<ReturnType<typeof resolveRepositoryContext>>;
  processRunner?: ProcessRunner;
  verifyIssues?: (issueNumbers: number[]) => Promise<void>;
}

/** Find the most recent backlog-report.json in the runs directory (by generatedAt). */
function findLatestBacklogReport(runsDir: string): ReturnType<typeof parseBacklogReport> | null {
  if (!existsSync(runsDir)) return null;
  let latest: ReturnType<typeof parseBacklogReport> | null = null;
  for (const runId of readdirSync(runsDir)) {
    const reportPath = path.join(runsDir, runId, "backlog-report.json");
    if (!existsSync(reportPath)) continue;
    try {
      const report = parseBacklogReport(JSON.parse(readFileSync(reportPath, "utf8")));
      if (latest === null || report.generatedAt > latest.generatedAt) {
        latest = report;
      }
    } catch {
      // skip malformed reports
    }
  }
  return latest;
}

function defaultSpawnDaemon(daemonEntryPath: string, env: Record<string, string>): { pid: number } {
  const child = spawn(process.execPath, [daemonEntryPath], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  return { pid: child.pid! };
}

export function registerStartCommand(program: Command, deps: StartCommandDeps = {}): void {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
  const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
  const spawnDaemon = deps.spawnDaemon ?? defaultSpawnDaemon;
  const resolveFn = deps.resolveContext ?? resolveRepositoryContext;
  const runner = deps.processRunner ?? new ProcessRunner();

  program
    .command("start")
    .description("Start the autonomous daemon over a queue of issues")
    .argument("[issues...]", "issue numbers (bare or owner/repo#number)")
    .option("--from-analyze [report-id]", "use executable list from a prior analyze report")
    .option("--refiner-timeout <minutes>", "override refiner timeout in minutes")
    .option("--refiner-model <model>")
    .option("--refiner-thinking <level>")
    .option("--implementer-model <model>")
    .option("--implementer-thinking <level>")
    .option("--reviewer-model <model>")
    .option("--reviewer-thinking <level>")
    .action(async (issueArgs: string[], opts: Record<string, string | boolean | undefined>) => {
      const cwd = deps.cwd ?? process.cwd();
      const paths = appPaths(deps.dataDir);
      const pidFile = new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir });
      const queueStore = new QueueStore({ queuePath: paths.queuePath, daemonDir: paths.daemonDir });

      // --- Guard: already running ---
      if (pidFile.isLive()) {
        const pid = pidFile.read();
        stderr(`daemon already running (PID ${pid}) — use autopilot stop first`);
        setExitCode(1);
        return;
      }

      // --- Resolve issue queue ---
      let issues: number[];

      if (opts.fromAnalyze === true || typeof opts.fromAnalyze === "string") {
        const report = findLatestBacklogReport(paths.runsDir);
        if (report === null) {
          stderr("no analyze report found — run autopilot analyze first");
          setExitCode(1);
          return;
        }
        if (report.executable.length === 0) {
          stderr(`no READY issues in report (generatedAt ${report.generatedAt})`);
          setExitCode(1);
          return;
        }
        issues = report.executable;
      } else if (issueArgs.length > 0) {
        try {
          const ctx = await resolveFn(cwd, runner);
          issues = resolveIssueRefs(issueArgs, ctx);
        } catch (err) {
          stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
          setExitCode(1);
          return;
        }
      } else {
        stderr("start: provide issue numbers or --from-analyze");
        setExitCode(1);
        return;
      }

      // --- Write queue ---
      const ctx = await resolveFn(cwd, runner).catch(() => null);
      queueStore.write({
        repository: ctx?.repository ?? { owner: "unknown", repo: "unknown" },
        issues,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        completedRuns: [],
      });

      // --- Spawn daemon ---
      const daemonEntryPath = fileURLToPath(
        new URL("../daemon/daemon-entry.js", import.meta.url),
      );
      const env: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
        ),
        AUTOPILOT_DAEMON_CWD: cwd,
      };
      if (deps.dataDir !== undefined) env.AUTOPILOT_DATA_DIR = deps.dataDir;

      const { pid } = spawnDaemon(daemonEntryPath, env);
      stdout(`daemon started (PID ${pid}) — queue: [${issues.join(", ")}]`);
      stdout(`use 'autopilot status' to monitor and 'autopilot stop' to stop`);
    });
}
