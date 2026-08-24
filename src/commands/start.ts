import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadRepositoryConfig } from "../config/load-config.js";
import { appPaths } from "../platform/paths.js";
import { PidFile } from "../daemon/pid-file.js";
import { QueueStore } from "../daemon/queue-store.js";
import { parseBacklogReport } from "../domain/backlog.js";
import type { RepositoryRef } from "../domain/contracts.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ProcessRunner } from "../platform/process-runner.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import type { RoleModelEntry, RoleModelOverride } from "../config/schema.js";
import { RunStore } from "../persistence/run-store.js";
import { buildSchedulerIssueInputs } from "../scheduler/dependencies.js";
import {
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  resolveSchedulerPolicy,
  type SchedulerCliOverrides,
  type SchedulerPolicy,
} from "../scheduler/policy.js";
import {
  createInitialSchedulerState,
  type SchedulerState,
} from "../scheduler/state.js";
import type { RunOverrides } from "../workflow/run-service.js";
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
  createSchedulerState?: (input: {
    repository: RepositoryRef;
    issueNumbers: number[];
    policy: SchedulerPolicy;
    now: string;
  }) => Promise<SchedulerState>;
  now?: () => string;
}

type BacklogReport = ReturnType<typeof parseBacklogReport>;

function readBacklogReport(reportPath: string): BacklogReport | null {
  if (!existsSync(reportPath)) return null;
  try {
    return parseBacklogReport(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch {
    return null;
  }
}

/** Find a backlog-report.json by run directory name or embedded analysisId. */
function repositoryMatches(report: BacklogReport, repository: RepositoryRef | null): boolean {
  return repository === null ||
    (report.repository.owner === repository.owner && report.repository.repo === repository.repo);
}

function assertSafeReportId(reportId: string): void {
  if (reportId.includes("/") || reportId.includes("\\") || reportId.includes("..")) {
    throw new Error(`invalid analyze report id '${reportId}'`);
  }
}

function findNamedBacklogReport(
  runsDir: string,
  reportId: string,
  repository: RepositoryRef,
): BacklogReport | null {
  assertSafeReportId(reportId);
  if (!existsSync(runsDir)) return null;

  const direct = readBacklogReport(path.join(runsDir, reportId, "backlog-report.json"));
  if (direct !== null && repositoryMatches(direct, repository)) return direct;

  for (const runId of readdirSync(runsDir)) {
    const report = readBacklogReport(path.join(runsDir, runId, "backlog-report.json"));
    if (report?.analysisId === reportId && repositoryMatches(report, repository)) return report;
  }
  return null;
}

/** Find the most recent backlog-report.json in the runs directory (by generatedAt). */
function findLatestBacklogReport(runsDir: string, repository: RepositoryRef): BacklogReport | null {
  if (!existsSync(runsDir)) return null;
  let latest: BacklogReport | null = null;
  for (const runId of readdirSync(runsDir)) {
    const report = readBacklogReport(path.join(runsDir, runId, "backlog-report.json"));
    if (
      report !== null &&
      repositoryMatches(report, repository) &&
      (latest === null || report.generatedAt > latest.generatedAt)
    ) {
      latest = report;
    }
  }
  return latest;
}

function parseThinking(value: string): RoleModelEntry["thinking"] {
  const parsed = ThinkingLevelSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid thinking level '${value}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
    );
  }
  return parsed.data;
}

function mergeOverride(
  model: string | undefined,
  thinking: string | undefined,
): RoleModelOverride | undefined {
  const override: RoleModelOverride = {};
  if (model !== undefined) override.model = model;
  if (thinking !== undefined) override.thinking = parseThinking(thinking);
  return override.model !== undefined || override.thinking !== undefined ? override : undefined;
}

function resolveStartOverrides(opts: Record<string, string | boolean | undefined>): RunOverrides {
  const overrides: RunOverrides = {};
  const refiner = mergeOverride(
    typeof opts.refinerModel === "string" ? opts.refinerModel : undefined,
    typeof opts.refinerThinking === "string" ? opts.refinerThinking : undefined,
  );
  const implementer = mergeOverride(
    typeof opts.implementerModel === "string" ? opts.implementerModel : undefined,
    typeof opts.implementerThinking === "string" ? opts.implementerThinking : undefined,
  );
  const reviewer = mergeOverride(
    typeof opts.reviewerModel === "string" ? opts.reviewerModel : undefined,
    typeof opts.reviewerThinking === "string" ? opts.reviewerThinking : undefined,
  );
  if (refiner !== undefined) overrides.refiner = refiner;
  if (implementer !== undefined) overrides.implementer = implementer;
  if (reviewer !== undefined) overrides.reviewer = reviewer;
  if (typeof opts.refinerTimeout === "string") {
    const minutes = Number(opts.refinerTimeout);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("invalid refiner timeout (expected a positive number of minutes)");
    }
    overrides.refinerTimeoutMs = minutes * 60_000;
  }
  return overrides;
}

function resolveSchedulerCliOverrides(opts: Record<string, string | boolean | undefined>): SchedulerCliOverrides {
  const maxConcurrentRuns = parseOptionalPositiveInt(
    typeof opts.maxConcurrent === "string" ? opts.maxConcurrent : undefined,
    "--max-concurrent",
  );
  const idleTimeoutMinutes = parseOptionalNonNegativeInt(
    typeof opts.idleTimeout === "string" ? opts.idleTimeout : undefined,
    "--idle-timeout",
  );
  const maxElapsedMinutes = parseOptionalNonNegativeInt(
    typeof opts.maxElapsed === "string" ? opts.maxElapsed : undefined,
    "--max-elapsed",
  );
  const maxStartedRuns = parseOptionalNonNegativeInt(
    typeof opts.maxStartedRuns === "string" ? opts.maxStartedRuns : undefined,
    "--max-started-runs",
  );
  const maxFailedRuns = parseOptionalNonNegativeInt(
    typeof opts.maxFailedRuns === "string" ? opts.maxFailedRuns : undefined,
    "--max-failed-runs",
  );
  return {
    ...(maxConcurrentRuns === null ? {} : { maxConcurrentRuns }),
    ...(idleTimeoutMinutes === null ? {} : { idleTimeoutMinutes }),
    ...(maxElapsedMinutes === null ? {} : { maxElapsedMinutes }),
    ...(maxStartedRuns === null ? {} : { maxStartedRuns }),
    ...(maxFailedRuns === null ? {} : { maxFailedRuns }),
  };
}

async function buildSchedulerState(input: {
  root: string;
  repository: RepositoryRef;
  issueNumbers: number[];
  policy: SchedulerPolicy;
  now: string;
  runner: ProcessRunner;
  dataDir?: string;
}): Promise<SchedulerState> {
  const github = await GitHubAdapter.create(input.root, input.runner);
  const runStore = new RunStore(appPaths(input.dataDir).dbPath);
  try {
    const normalized = await buildSchedulerIssueInputs({
      root: input.root,
      repository: input.repository,
      issueNumbers: input.issueNumbers,
      now: input.now,
      github,
      runStore,
    });
    return createInitialSchedulerState({ policy: input.policy, startedAt: input.now, issues: normalized });
  } finally {
    runStore.close();
  }
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
    .option("--max-concurrent <n>", "override scheduler.maxConcurrentRuns for this daemon")
    .option("--max-elapsed <minutes>", "override scheduler.budgets.maxElapsedMinutes")
    .option("--max-started-runs <n>", "override scheduler.budgets.maxStartedRuns")
    .option("--max-failed-runs <n>", "override scheduler.budgets.maxFailedRuns")
    .option("--idle-timeout <minutes>", "override scheduler.idleTimeoutMinutes")
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
      let ctx: Awaited<ReturnType<typeof resolveRepositoryContext>> | null = null;
      let overrides: RunOverrides;
      let schedulerCliOverrides: SchedulerCliOverrides;
      try {
        overrides = resolveStartOverrides(opts);
        schedulerCliOverrides = resolveSchedulerCliOverrides(opts);
      } catch (err) {
        stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
        setExitCode(1);
        return;
      }

      if (opts.fromAnalyze === true || typeof opts.fromAnalyze === "string") {
        try {
          ctx = await resolveFn(cwd, runner);
        } catch (err) {
          stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
          setExitCode(1);
          return;
        }
        let report: BacklogReport | null;
        try {
          report = typeof opts.fromAnalyze === "string"
            ? findNamedBacklogReport(paths.runsDir, opts.fromAnalyze, ctx.repository)
            : findLatestBacklogReport(paths.runsDir, ctx.repository);
        } catch (err) {
          stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
          setExitCode(1);
          return;
        }
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
          ctx = await resolveFn(cwd, runner);
          issues = resolveIssueRefs(issueArgs, ctx);
          const verifyIssues = deps.verifyIssues ?? (async (issueNumbers: number[]) => {
            const github = await GitHubAdapter.create(ctx!.root, runner);
            for (const number of issueNumbers) {
              await github.getIssue(number);
            }
          });
          await verifyIssues(issues);
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

      if (ctx === null) {
        stderr("start: failed to resolve repository context");
        setExitCode(1);
        return;
      }

      let scheduler: SchedulerState;
      let startedAt: string;
      try {
        const config = await loadRepositoryConfig(ctx.root);
        const schedulerPolicy = resolveSchedulerPolicy(config, schedulerCliOverrides);
        startedAt = (deps.now ?? (() => new Date().toISOString()))();
        scheduler = deps.createSchedulerState !== undefined
          ? await deps.createSchedulerState({
              repository: ctx.repository,
              issueNumbers: issues,
              policy: schedulerPolicy,
              now: startedAt,
            })
          : await buildSchedulerState({
              root: ctx.root,
              repository: ctx.repository,
              issueNumbers: issues,
              policy: schedulerPolicy,
              now: startedAt,
              runner,
              ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
            });
      } catch (err) {
        stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
        setExitCode(1);
        return;
      }

      // --- Write queue ---
      queueStore.write({
        repository: ctx.repository,
        issues,
        currentIndex: 0,
        startedAt,
        completedRuns: [],
        scheduler,
        ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
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
