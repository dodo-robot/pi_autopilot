import { Command } from "commander";
import type { RunRecord, RunStage } from "../domain/contracts.js";
import { appPaths } from "../platform/paths.js";
import { RunStore, isTerminalStage } from "../persistence/run-store.js";
import { PidFile } from "../daemon/pid-file.js";
import { QueueStore } from "../daemon/queue-store.js";
import { formatDaemonStatus } from "../ui/reporter.js";

export interface StatusCommandDeps {
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface StatusOptions {
  json?: boolean;
}

export interface StatusReport {
  runId: string;
  stage: RunStage;
  repository: RunRecord["repository"];
  issueNumber: number;
  nextAction: string;
}

/** Describe the next valid administrative or automatic action for a stage. */
function describeNextAction(stage: RunStage): string {
  if (stage === "BLOCKED") {
    return "resume (continue with a fresh correction attempt) or abandon (mark CANCELLED)";
  }
  if (isTerminalStage(stage)) {
    return "no further action (terminal stage)";
  }
  return "in progress (automatic orchestration owns this stage)";
}

/**
 * `autopilot status <run-id>` — report a run's current stage and the next
 * valid action. Read-only: never mutates the run or GitHub.
 */
export function registerStatusCommand(
  program: Command,
  deps: StatusCommandDeps = {},
): void {
  program
    .command("status")
    .description("Report a run's current stage and next valid action")
    .argument("[run-id]", "run id")
    .option("--json", "emit a machine-readable status report")
    .action((runId: string | undefined, opts: StatusOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      const paths = appPaths(deps.dataDir);

      // Daemon overview mode when no run-id argument
      if (runId === undefined) {
        const pidFile = new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir });
        if (!pidFile.isLive()) {
          stdout("no daemon running");
          return;
        }
        const pid = pidFile.read()!;
        const queueStore = new QueueStore({ queuePath: paths.queuePath, daemonDir: paths.daemonDir });
        const queue = queueStore.read();
        if (queue === null) {
          stdout(`daemon running (PID ${pid}) but no queue found`);
          return;
        }
        const currentIssue = queue.issues[queue.currentIndex] ?? null;
        const remainingIssues = queue.issues.slice(queue.currentIndex + 1);
        const startedAt = new Date(queue.startedAt).getTime();
        const uptimeMs = Date.now() - startedAt;
        let currentStage: RunStage | null = null;
        if (currentIssue !== null) {
          const runStore = new RunStore(paths.dbPath);
          try {
            currentStage = runStore.getActiveRunForIssue(
              queue.repository.owner,
              queue.repository.repo,
              currentIssue,
            )?.stage ?? null;
          } finally {
            runStore.close();
          }
        }
        stdout(formatDaemonStatus({
          pid,
          uptimeMs,
          currentIssue: currentIssue ?? null,
          currentStage,
          currentStartedAt: null,
          remainingIssues,
          completedRuns: queue.completedRuns,
        }));
        return;
      }

      const runStore = new RunStore(paths.dbPath);
      try {
        const run = runStore.getRun(runId);
        if (run === null) {
          stderr(`autopilot status: no run found with id ${runId}`);
          setExitCode(1);
          return;
        }
        const report: StatusReport = {
          runId: run.id,
          stage: run.stage,
          repository: run.repository,
          issueNumber: run.issueNumber,
          nextAction: describeNextAction(run.stage),
        };
        if (opts.json === true) {
          stdout(JSON.stringify(report, null, 2));
        } else {
          stdout(
            `Issue: ${report.repository.owner}/${report.repository.repo}#${String(report.issueNumber)}`,
          );
          stdout(`Run: ${report.runId}`);
          stdout(`Stage: ${report.stage}`);
          stdout(`Next action: ${report.nextAction}`);
        }
        setExitCode(0);
      } catch (error) {
        stderr(
          `autopilot status: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      } finally {
        runStore.close();
      }
    });
}
