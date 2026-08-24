import { Command } from "commander";
import { BacklogAnalyst as BacklogAnalystImpl } from "../analysis/backlog-analyst.js";
import { isEpicBody } from "../analysis/issue-set.js";
import {
  reconcileReadyLabel,
  AGENT_READY_LABEL,
  AGENT_IN_PROGRESS_LABEL,
  SPLIT_LABEL,
  type LabelAction,
} from "../analysis/label-reconciliation.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { AutopilotConfig, RoleModelEntry } from "../config/schema.js";
import type { BacklogReport } from "../domain/backlog.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { ReadinessService as ReadinessServiceImpl } from "../readiness/readiness-service.js";
import type { ReadinessService } from "../readiness/readiness-service.js";
import { resolveIssueRefs, resolveRefinerModel, resolveRefinerTimeout } from "./args.js";

export interface DiscoverCommandDeps {
  cwd?: string;
  processRunner?: ProcessRunner;
  dataDir?: string;
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  /** Test seam: run the full readiness analysis, bypassing the real
   * BacklogAnalyst/ReadinessService/GitHubAdapter chain (already covered by
   * analyze's own tests — discover does not change that behavior). */
  analyze?: (
    ref: string,
    moreRefs: string[],
    opts: { deep?: boolean; model?: string; thinking?: string; refinerTimeout?: number },
  ) => Promise<BacklogReport>;
  listLabels?: (issueNumber: number) => Promise<string[]>;
  addLabel?: (issueNumber: number, name: string) => Promise<void>;
  removeLabel?: (issueNumber: number, name: string) => Promise<void>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface DiscoverOptions {
  json?: boolean;
  deep?: boolean;
  model?: string;
  thinking?: string;
  refinerTimeout?: number;
}

/**
 * `autopilot discover <ref> [moreRefs...]` — analyze an epic or an explicit
 * issue set for backlog readiness and reconcile the agent:ready label to match
 * computed readiness (mutating sibling of `analyze`).
 */
export function registerDiscoverCommand(program: Command, deps: DiscoverCommandDeps = {}): void {
  program
    .command("discover")
    .description(
      "Analyze an epic (or explicit issue set) and reconcile the agent:ready label to match readiness",
    )
    .argument("<ref>", "issue/epic number, or owner/repo#number matching the local origin")
    .argument("[moreRefs...]", "additional issue references in an explicit set")
    .option("--json", "emit the backlog report as machine-readable JSON")
    .option("--deep", "run a full refiner session and readiness gate on every issue")
    .option("--model <model>", "override the refiner model")
    .option("--thinking <level>", "override the refiner thinking level")
    .option("--refiner-timeout <minutes>", "override the refiner session timeout in minutes")
    .action(async (ref: string, moreRefs: string[], opts: DiscoverOptions) => {
      const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
      const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
      const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });

      try {
        const { report, github } = await runDiscoverAnalysis(ref, moreRefs, opts, deps);

        const listLabels = deps.listLabels ?? ((n: number) => github!.listLabels(n));
        const addLabel = deps.addLabel ?? ((n: number, name: string) => github!.addLabel(n, name));
        const removeLabel = deps.removeLabel ?? ((n: number, name: string) => github!.removeLabel(n, name));

        const issuesWithAction: Array<BacklogReport["issues"][number] & { labelAction: LabelAction }> = [];
        for (const issue of report.issues) {
          let labels: string[];
          try {
            labels = await listLabels(issue.issueNumber);
          } catch (error) {
            stderr(`discover: failed to read labels for #${issue.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
            issuesWithAction.push({ ...issue, labelAction: "unchanged" });
            continue;
          }
          const action = reconcileReadyLabel({
            isReady: issue.classification === "READY",
            hasReadyLabel: labels.includes(AGENT_READY_LABEL),
            hasInProgressLabel: labels.includes(AGENT_IN_PROGRESS_LABEL),
            hasSplitLabel: labels.includes(SPLIT_LABEL),
          });
          try {
            if (action === "labeled") await addLabel(issue.issueNumber, AGENT_READY_LABEL);
            if (action === "unlabeled") await removeLabel(issue.issueNumber, AGENT_READY_LABEL);
          } catch (error) {
            stderr(`discover: failed to update label for #${issue.issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
          }
          issuesWithAction.push({ ...issue, labelAction: action });
        }

        const finalReport: BacklogReport = { ...report, issues: issuesWithAction };

        if (opts.json === true) {
          stdout(JSON.stringify(finalReport, null, 2));
        } else {
          printHumanReport(finalReport, stdout);
        }
        setExitCode(0);
      } catch (error) {
        stderr(`autopilot discover: ${error instanceof Error ? error.message : String(error)}`);
        setExitCode(1);
      }
    });
}

async function runDiscoverAnalysis(
  ref: string,
  moreRefs: string[],
  opts: DiscoverOptions,
  deps: DiscoverCommandDeps,
): Promise<{ report: BacklogReport; github: GitHubPort | null }> {
  if (deps.analyze !== undefined) {
    const report = await deps.analyze(ref, moreRefs, opts);
    return { report, github: null };
  }

  // Production path: build the same chain analyze.ts builds.
  const runner = deps.processRunner ?? new ProcessRunnerImpl();
  const ctx: RepositoryContext = await resolveRepositoryContext(deps.cwd ?? process.cwd(), runner);
  const config: AutopilotConfig = await loadRepositoryConfig(ctx.root);
  const github: GitHubPort = await GitHubAdapter.create(ctx.root, runner);
  const paths: AppPaths = appPaths(deps.dataDir);

  const refinerModel: ResolvedRoleModel = resolveRefinerModel(
    {
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.thinking === undefined ? {} : { thinking: opts.thinking }),
    },
    config,
    deps.piDefaultModel,
  );
  const refinerTimeoutMs = resolveRefinerTimeout(opts.refinerTimeout, config);

  const readiness: Pick<ReadinessService, "check"> = new ReadinessServiceImpl({
    repository: ctx,
    config,
    github,
    pi: new PiRunner(runner, deps.piCommand),
    artifacts: new ArtifactStore(paths),
    paths,
    refinerModel,
    refinerTimeoutMs,
  });

  const analysisId = `discover-${Date.now()}`;
  const analyst = new BacklogAnalystImpl({
    repository: ctx,
    config,
    github,
    readiness,
    artifacts: new ArtifactStore(paths),
    paths,
    refinerModel,
    refinerTimeoutMs,
    analysisId,
    now: () => new Date().toISOString(),
  });

  const numbers = resolveIssueRefs([ref, ...moreRefs], ctx);
  let epicRef: number | null = null;
  let requestedRefs: number[] = numbers;
  if (moreRefs.length === 0 && numbers.length === 1) {
    const single = numbers[0]!;
    const issue = await github.getIssue(single);
    if (isEpicBody(issue.body)) {
      epicRef = single;
      requestedRefs = [];
    }
  }

  const report = await analyst.analyzeIssues({ epicRef, requestedRefs, deep: opts.deep === true });
  return { report, github };
}

function printHumanReport(report: BacklogReport, stdout: (text: string) => void): void {
  stdout(`Repository: ${report.repository.owner}/${report.repository.repo}`);
  for (const issue of report.issues) {
    const action = (issue as { labelAction?: LabelAction }).labelAction ?? "unchanged";
    stdout(
      `[${issue.classification}] #${issue.issueNumber} ${issue.title} (${issue.url}) — label: ${action}`,
    );
  }
  stdout(`Executable: ${report.executable.length > 0 ? report.executable.join(", ") : "(none)"}`);
  stdout(`Needs work: ${report.needsWork.length > 0 ? report.needsWork.join(", ") : "(none)"}`);
  stdout(
    `Summary: ${report.summary.ready} ready, ${report.summary.needsRefinement} needsRefinement, ` +
      `${report.summary.blocked} blocked, ${report.summary.ambiguous} ambiguous, ` +
      `${report.summary.skipped} skipped, ${report.summary.unresolved} unresolved`,
  );
  stdout(`Analysis ID: ${report.analysisId}`);
}
