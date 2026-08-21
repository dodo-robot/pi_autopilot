import { Command } from "commander";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry } from "../config/schema.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { resolveIssueRef, resolveRefinerModel, resolveRefinerTimeout } from "./args.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { ReadinessReport } from "../readiness/readiness-service.js";
import { ReadinessService } from "../readiness/readiness-service.js";

export interface CheckCommandDeps {
  /** Repository root to operate on; defaults to the current working directory. */
  cwd?: string;
  processRunner?: ProcessRunner;
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  /** Override the Pi executable used for refiner sessions. */
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  /** Test seam: construct the GitHub port bound to the resolved repository. */
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  /** Test seam: construct the readiness service from resolved inputs. */
  createReadiness?: (deps: {
    repository: RepositoryContext;
    config: AutopilotConfig;
    github: GitHubPort;
    refinerModel: ResolvedRoleModel;
    refinerTimeoutMs: number;
  }) => Pick<ReadinessService, "check">;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  /** Override terminal detection (tests simulate a pegged TTY). */
  isTTY?: boolean;
}

interface CheckOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
  refinerTimeout?: number;
}

/**
 * `autopilot check <issue>` — assess whether a GitHub issue is ready for
 * autonomous execution. Strictly read-only: the command never mutates
 * GitHub and never creates a workspace.
 */
export function registerCheckCommand(
  program: Command,
  deps: CheckCommandDeps = {},
): void {
  program
    .command("check")
    .description(
      "Assess whether a GitHub issue is ready for autonomous execution (read-only)",
    )
    .argument("<issue>", "issue number, or owner/repo#number matching the local origin")
    .option("--json", "emit a machine-readable readiness report")
    .option("--model <model>", "override the refiner model")
    .option("--thinking <level>", "override the refiner thinking level")
    .option("--refiner-timeout <minutes>", "override the refiner session timeout in minutes (default: from policy budgets.refiner.timeoutMinutes or 5)")
    .action(async (issueRef: string, opts: CheckOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const reporter =
          opts.json === true ? null : createReporter(stdout, deps.isTTY);
        try {
          const report = await runCheck(issueRef, opts, deps, reporter);
          if (opts.json === true) {
            stdout(JSON.stringify(report, null, 2));
          } else {
            printHumanReport(report, stdout);
          }
          setExitCode(report.status === "READY" ? 0 : 2);
        } finally {
          reporter?.close();
        }
      } catch (error) {
        stderr(
          `autopilot check: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

async function runCheck(
  issueRef: string,
  opts: CheckOptions,
  deps: CheckCommandDeps,
  reporter: Reporter | null,
): Promise<ReadinessReport> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const { number } = resolveIssueRef(issueRef, ctx);

  const config = await loadRepositoryConfig(ctx.root);
  const github =
    deps.createGitHub !== undefined
      ? await deps.createGitHub(ctx, runner)
      : await GitHubAdapter.create(ctx.root, runner);

  const paths: AppPaths = appPaths(deps.dataDir);
  const refinerModel = resolveRefinerModel(
    {
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.thinking === undefined ? {} : { thinking: opts.thinking }),
    },
    config,
    deps.piDefaultModel,
  );
  const refinerTimeoutMs = resolveRefinerTimeout(opts.refinerTimeout, config);
  const readiness =
    deps.createReadiness !== undefined
      ? deps.createReadiness({ repository: ctx, config, github, refinerModel, refinerTimeoutMs })
      : new ReadinessService({
          repository: ctx,
          config,
          github,
          pi: new PiRunner(runner, deps.piCommand),
          artifacts: new ArtifactStore(paths),
          paths,
          refinerModel,
          refinerTimeoutMs,
        });

  const ref = `${ctx.repository.owner}/${ctx.repository.repo}#${number}`;
  const timeoutMinutes = refinerTimeoutMs / 60_000;
  reporter?.line(`→ refining issue ${ref} (refiner timeout ${timeoutMinutes}m)`);
  reporter?.setSpinner(`refining issue ${ref}`);
  try {
    return await readiness.check(number);
  } finally {
    reporter?.stopSpinner({ commit: `readiness assessment complete for ${ref}` });
  }
}

function printHumanReport(
  report: ReadinessReport,
  stdout: (text: string) => void,
): void {
  stdout(
    `Issue: ${report.repository.owner}/${report.repository.repo}#${report.issueNumber}`,
  );
  stdout(`Status: ${report.status}`);
  if (report.status === "READY" && report.snapshot !== null) {
    stdout(`Objective: ${report.snapshot.objective}`);
    stdout(`Acceptance criteria: ${report.snapshot.acceptanceCriteria.length}`);
    return;
  }
  if (report.gaps.length > 0) {
    stdout("Gaps:");
    for (const gap of report.gaps) {
      stdout(`  - [${gap.code}] ${gap.message}`);
      stdout(`    suggestion: ${gap.suggestion}`);
    }
  }
  if (report.ambiguities.length > 0) {
    stdout("Ambiguities:");
    for (const ambiguity of report.ambiguities) {
      stdout(`  - ${ambiguity.type}: ${ambiguity.description}`);
    }
  }
  if (report.missingInformation.length > 0) {
    stdout("Missing information:");
    for (const item of report.missingInformation) stdout(`  - ${item}`);
  }
  if (report.suggestions.length > 0) {
    stdout("Suggestions:");
    for (const item of report.suggestions) stdout(`  - ${item}`);
  }
}
