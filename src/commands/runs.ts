import { Command } from "commander";
import type { RunRecord, RunStage } from "../domain/contracts.js";
import { appPaths } from "../platform/paths.js";
import { RunStore } from "../persistence/run-store.js";

export interface RunsCommandDeps {
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface RunsOptions {
  json?: boolean;
  limit?: string;
  issue?: string;
}

interface RunsRow {
  id: string;
  stage: RunStage;
  repository: RunRecord["repository"];
  issueNumber: number;
  resumeAt: RunStage | null;
  createdAt: string;
}

/**
 * `autopilot runs` — list runs newest-first (terminal and active alike).
 * Read-only, for discovering a run id to `status`/`inspect`/`resume`/`abandon`.
 */
export function registerRunsCommand(
  program: Command,
  deps: RunsCommandDeps = {},
): void {
  program
    .command("runs")
    .description("List runs newest-first (stage, issue, run id)")
    .option("--json", "emit a machine-readable array of runs")
    .option("--limit <n>", "maximum number of runs to list (default: 20)")
    .option("--issue <ref>", "only runs for owner/repo#number, e.g. acme/widgets#42")
    .action((opts: RunsOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      const paths = appPaths(deps.dataDir);
      const runStore = new RunStore(paths.dbPath);
      try {
        const limit = parseLimit(opts.limit);
        const issue = parseIssue(opts.issue);
        const rows: RunsRow[] = runStore
          .listRuns({
            ...(limit === undefined ? {} : { limit }),
            ...(issue === undefined ? {} : { issue }),
          })
          .map((r) => ({
            id: r.id,
            stage: r.stage,
            repository: r.repository,
            issueNumber: r.issueNumber,
            resumeAt: r.resumeAt,
            createdAt: r.createdAt,
          }));
        if (opts.json === true) {
          stdout(JSON.stringify(rows, null, 2));
        } else {
          for (const row of rows) {
            const resume = row.stage === "FAILED" && row.resumeAt !== null
              ? ` (failed at ${row.resumeAt})`
              : "";
            stdout(
              `[${row.stage}${resume}] ${row.repository.owner}/${row.repository.repo}#${String(row.issueNumber)}  ${row.id}  ${row.createdAt}`,
            );
          }
        }
        setExitCode(0);
      } catch (error) {
        stderr(
          `autopilot runs: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      } finally {
        runStore.close();
      }
    });
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid --limit '${raw}' (expected a positive integer)`);
  }
  return n;
}

function parseIssue(
  raw: string | undefined,
): { owner: string; repo: string; issueNumber: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^([^/]+)\/([^/]+)#(\d+)$/.exec(raw.trim());
  if (match === null) {
    throw new Error(
      `invalid --issue '${raw}' (expected <owner>/<repo>#<number>, e.g. acme/widgets#42)`,
    );
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    issueNumber: Number(match[3]),
  };
}
