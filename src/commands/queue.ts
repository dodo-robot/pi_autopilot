import { Command } from "commander";
import { PidFile } from "../daemon/pid-file.js";
import { PendingQueueStore } from "../daemon/pending-queue-store.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { appPaths } from "../platform/paths.js";
import { ProcessRunner } from "../platform/process-runner.js";
import { resolveIssueRefs } from "./args.js";

export interface QueueCommandDeps {
  dataDir?: string;
  cwd?: string;
  /** Test seam: replaces PidFile.isLive(). */
  isDaemonLive?: () => boolean;
  /** Test seam: replaces PendingQueueStore.append(). */
  appendPending?: (issues: number[]) => void;
  /** Test seam: replaces resolveIssueRefs + resolveRepositoryContext. */
  resolveIssues?: (refs: string[]) => Promise<number[]>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export function registerQueueCommand(program: Command, deps: QueueCommandDeps = {}): void {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
  const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });

  const queueCommand = program.command("queue").description("Manage a running daemon's issue queue");

  queueCommand
    .command("add")
    .description("Append issues to a running daemon's queue")
    .argument("<issues...>", "issue numbers (bare or owner/repo#number)")
    .option("--json", "emit machine-readable output")
    .action(async (issueArgs: string[], opts: { json?: boolean }) => {
      const paths = appPaths(deps.dataDir);
      const isDaemonLive =
        deps.isDaemonLive ??
        (() => new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir }).isLive());

      if (!isDaemonLive()) {
        stderr("no daemon running — use autopilot start first");
        setExitCode(1);
        return;
      }

      try {
        const resolveIssues =
          deps.resolveIssues ??
          (async (refs: string[]) => {
            const cwd = deps.cwd ?? process.cwd();
            const runner = new ProcessRunner();
            const ctx = await resolveRepositoryContext(cwd, runner);
            return resolveIssueRefs(refs, ctx);
          });
        const issues = await resolveIssues(issueArgs);

        const appendPending =
          deps.appendPending ??
          ((nums: number[]) => {
            const store = new PendingQueueStore({
              pendingQueuePath: paths.pendingQueuePath,
              daemonDir: paths.daemonDir,
            });
            store.append(nums);
          });
        appendPending(issues);

        if (opts.json === true) {
          stdout(JSON.stringify({ queued: issues, daemonRunning: true }));
        } else {
          stdout(`Queued ${issues.length} issue(s) (pending until next daemon loop iteration).`);
        }
        setExitCode(0);
      } catch (error) {
        stderr(`queue add: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(1);
      }
    });
}
