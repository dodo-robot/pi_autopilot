import { Command } from "commander";
import type { AutopilotConfig } from "../config/schema.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { ApplyReport } from "../domain/apply.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { appPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { confirmMenu } from "../reconciliation/apply-preview.js";
import { ApplyService } from "../reconciliation/apply-service.js";
import type { ApplyOptions } from "../reconciliation/apply-service.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";
import { redact } from "./redact.js";

export interface ReconcileApplyCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  createApplyService?: (deps: {
    github: GitHubPort;
    artifacts: ArtifactStore;
    repository: RepositoryContext["repository"];
    reportStaleAfterHours?: AutopilotConfig["reconciliation"]["reportStaleAfterHours"];
  }) => Pick<ApplyService, "apply"> | Promise<Pick<ApplyService, "apply">>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  isTTY?: boolean;
}

interface ReconcileApplyOptions {
  json?: boolean;
  yes?: boolean;
  force?: boolean;
}

/**
 * `autopilot reconcile-apply <analysisId>` — apply auto-safe patches from a
 * stored reconciliation report. Non-TTY operation without --yes is preview-only
 * and performs no writes.
 */
export function registerReconcileApplyCommand(
  program: Command,
  deps: ReconcileApplyCommandDeps = {},
): void {
  program
    .command("reconcile-apply")
    .description(
      "Apply a stored reconciliation report's auto-safe patches to GitHub (interactive by default; use --yes unattended)",
    )
    .argument(
      "<analysisId>",
      "analysis id of a stored reconciliation report (the id echoed by `autopilot reconcile --json`)",
    )
    .option(
      "--yes",
      "apply auto-safe patches without prompting (required for any writes in a non-TTY); skips requires-approval",
    )
    .option("--force", "bypass the staleness guard")
    .option("--json", "emit the ApplyReport as JSON")
    .action(async (analysisId: string, opts: ReconcileApplyOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const safeStdout = (text: string): void => stdout(redactText(text));
      const safeStderr = (text: string): void => stderr(redactText(text));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });

      try {
        const reporter = opts.json === true ? null : createReporter(safeStdout, deps.isTTY);
        try {
          const result = await runReconcileApply(analysisId, opts, deps, reporter);
          const report = redact(result.report) as ApplyReport;
          if (opts.json === true) {
            safeStdout(JSON.stringify(report, null, 2));
          } else {
            printApplySummary(report, safeStdout);
            reporter?.line(
              `apply-safe: ${report.summary.applied} applied, ` +
                `${report.summary.failed} failed, ` +
                `${report.summary.skippedRequiresApproval} requires-approval, ` +
                `${report.summary.skippedIdempotent} already-satisfied`,
            );
          }
          setExitCode(isPartial(report) ? 2 : 0);
        } finally {
          reporter?.close();
        }
      } catch (error) {
        safeStderr(
          `autopilot reconcile-apply: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

async function runReconcileApply(
  analysisId: string,
  opts: ReconcileApplyOptions,
  deps: ReconcileApplyCommandDeps,
  reporter: Reporter | null,
): Promise<{ report: ApplyReport }> {
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const config = await loadRepositoryConfig(ctx.root);
  const github =
    deps.createGitHub !== undefined
      ? await deps.createGitHub(ctx, runner)
      : await GitHubAdapter.create(ctx.root, runner);

  const artifacts = new ArtifactStore(appPaths(deps.dataDir));
  const service =
    deps.createApplyService !== undefined
      ? await deps.createApplyService({
          github,
          artifacts,
          repository: ctx.repository,
          reportStaleAfterHours: config.reconciliation.reportStaleAfterHours,
        })
      : new ApplyService({
          github,
          artifacts,
          repository: ctx.repository,
          reportStaleAfterHours: config.reconciliation.reportStaleAfterHours,
          onPreview: (text) => reporter?.line(redactText(text)),
          confirmMenu,
        });

  reporter?.line(`→ applying ${analysisId} on ${ctx.repository.owner}/${ctx.repository.repo}`);
  const isTTY = deps.isTTY ?? process.stdout.isTTY === true;
  const applyOptions: ApplyOptions = {
    yes: opts.yes === true,
    force: opts.force === true,
    ...(opts.yes !== true && !isTTY ? { previewOnly: true } : {}),
  };
  const report = await service.apply(analysisId, applyOptions);
  return { report };
}

function printApplySummary(report: ApplyReport, stdout: (text: string) => void): void {
  for (const entry of report.entries) {
    const target = entry.targetIssue === null ? "" : `#${entry.targetIssue} `;
    if (entry.outcome.status === "applied") {
      stdout(`  ✓ ${target}${entry.detail}`);
    } else if (entry.outcome.status === "failed") {
      stdout(`  ✗ ${target}${entry.detail} (${entry.outcome.error})`);
    } else {
      // detail carries useful context for every skip reason (e.g. NEEDS_HUMAN's
      // questions, which are never surfaced any other way — that patch type has
      // no write action to confirm interactively).
      stdout(`  → ${target}skipped (${entry.outcome.skippedBy}): ${entry.detail}`);
    }
  }
}

function isPartial(report: ApplyReport): boolean {
  return (
    report.summary.failed > 0 ||
    report.summary.skippedUser > 0 ||
    report.entries.some(
      (entry) => entry.outcome.status === "skipped" && entry.outcome.skippedBy === "failed-to-fetch",
    ) ||
    report.aborted === true
  );
}

function redactText(text: string): string {
  return redact(text) as string;
}
