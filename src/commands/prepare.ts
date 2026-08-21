import { Command } from "commander";
import { loadRepositoryConfig } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { BrainstormerResult } from "../domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import type { ReadinessReport } from "../readiness/readiness-service.js";
import { ReadinessService, sha256 } from "../readiness/readiness-service.js";
import {
  renderUnifiedDiff,
  upsertRefinementSection,
} from "../readiness/refinement-section.js";
import type { CheckCommandDeps } from "./check.js";
import { createReporter } from "../ui/reporter.js";
import type { Reporter } from "../ui/reporter.js";
import { resolveIssueRef, resolveRefinerModel, resolveRefinerTimeout } from "./args.js";

export interface PrepareCommandDeps extends CheckCommandDeps {
  /**
   * Ask the operator to approve applying the proposed refinement. Defaults
   * to an interactive readline prompt; tests inject a stub.
   */
  confirm?: (prompt: string) => Promise<boolean>;
  /**
   * Ask the operator to answer one refinement question in free-form text.
   * Defaults to an interactive readline prompt; tests inject a stub.
   */
  answer?: (prompt: string) => Promise<string>;
  /**
   * Test seam: bypass the brainstormer Pi session.
   */
  runBrainstormer?: (
    issue: GitHubIssue,
    report: ReadinessReport,
  ) => Promise<Array<{ id: string; text: string }>>;
}

interface PrepareOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
  refinerTimeout?: number;
  fromCheck?: string;
}

interface PrepareOutcome {
  repository: { owner: string; repo: string };
  issueNumber: number;
  applied: boolean;
  reason: "approved" | "declined" | "json-proposal" | "cancelled";
  /** `updatedAt` of the analyzed issue (pre-edit). */
  updatedAt: string;
  /** "reused" when a prior READY check snapshot was reused, else "fresh". */
  source: "reused" | "fresh";
  /** analysisId of the reused snapshot, present only when `source === "reused"`. */
  reusedFrom?: string;
  proposedBody?: string;
  diff?: string;
}

/**
 * `autopilot prepare <issue>` — draft an autonomous execution contract for
 * an issue and apply it to a managed section only after explicit approval.
 * The original issue content is always preserved. In `--json` mode no
 * interactive approval is available, so the proposal is emitted without
 * being applied.
 */
export function registerPrepareCommand(
  program: Command,
  deps: PrepareCommandDeps = {},
): void {
  program
    .command("prepare")
    .description(
      "Draft an autonomous execution contract for an issue and apply it after explicit approval",
    )
    .argument("<issue>", "issue number, or owner/repo#number matching the local origin")
    .option("--json", "emit the proposed refinement without applying it")
    .option("--model <model>", "override the refiner model")
    .option("--thinking <level>", "override the refiner thinking level")
    .option("--refiner-timeout <minutes>", "override the refiner session timeout in minutes (default: from policy budgets.refiner.timeoutMinutes or 5)")
    .option("--from-check <analysisId>", "reuse the READY snapshot from a prior `autopilot check` analysis id instead of a fresh refiner")
    .action(async (issueRef: string, opts: PrepareOptions) => {
      const stdout =
        deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr =
        deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const reporter =
          opts.json === true ? null : createReporter(stdout, deps.isTTY);
        try {
          const outcome = await runPrepare(issueRef, opts, deps, stdout, reporter);
          if (opts.json === true) {
            stdout(JSON.stringify(outcome, null, 2));
          } else {
            printHumanOutcome(outcome, stdout);
          }
          setExitCode(0);
        } finally {
          reporter?.close();
        }
      } catch (error) {
        stderr(
          `autopilot prepare: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

async function runPrepare(
  issueRef: string,
  opts: PrepareOptions,
  deps: PrepareCommandDeps,
  stdout: (text: string) => void,
  reporter: Reporter | null,
): Promise<PrepareOutcome> {
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

  // Initial fetch: the base for the diff and the concurrent-edit guard.
  const issue = await github.getIssue(number);

  const ref = `${ctx.repository.owner}/${ctx.repository.repo}#${number}`;
  reporter?.line(`→ preparing execution contract for ${ref}`);
  reporter?.setSpinner(`refining ${ref}`);
  const refine = (clarifications: Array<{ question: string; answer: string }>) => {
    reporter?.setSpinner(`refining ${ref} (${String(clarifications.length)} clarification${clarifications.length === 1 ? "" : "s"})`);
    return readiness.check(number, clarifications);
  };

  // Fast path: reuse a prior READY check snapshot when it still matches the
  // current issue version. Otherwise fall back to a fresh refiner analysis.
  const reused = await findReusableReport(
    issue,
    ctx.repository,
    paths,
    opts.fromCheck,
  );
  const source: PrepareOutcome["source"] = reused === null ? "fresh" : "reused";
  let report: ReadinessReport = reused ?? (await refine([]));

  // Brainstorm phase: trigger on NEEDS_REFINEMENT or PRODUCT_AMBIGUITY (pass 1 only).
  if (
    opts.json !== true &&
    report.status !== "READY" &&
    (report.outcome === "NEEDS_REFINEMENT" || report.outcome === "PRODUCT_AMBIGUITY")
  ) {
    const brainstormFn = async (
      _issue: GitHubIssue,
      _report: ReadinessReport,
    ): Promise<Array<{ id: string; text: string }>> => {
      if (deps.runBrainstormer !== undefined) {
        return deps.runBrainstormer(_issue, _report);
      }
      const svc = readiness as ReadinessService;
      const result = await svc.brainstorm(number, _report);
      return result.questions;
    };

    reporter?.setSpinner(`brainstorming ${ref}`);
    const questions = await brainstormFn(issue, report);
    reporter?.stopSpinner({
      commit: `brainstorm complete (${String(questions.length)} question${questions.length === 1 ? "" : "s"})`,
    });

    if (questions.length > 0) {
      const askAnswer = deps.answer ?? defaultAnswer;
      const brainstormAnswers: Array<{ question: string; answer: string }> = [];
      for (const q of questions) {
        reporter?.stopSpinner();
        const answer = await askAnswer(`${q.text}\n\nAnswer (or 'cancel'): `);
        if (answer.trim().toLowerCase() === "cancel") {
          return {
            repository: report.repository,
            issueNumber: number,
            applied: false,
            reason: "cancelled",
            updatedAt: issue.updatedAt,
            source,
            ...(reused !== null ? { reusedFrom: reused.analysisId } : {}),
          };
        }
        brainstormAnswers.push({ question: q.text, answer: answer.trim() });
      }

      reporter?.setSpinner(`refining ${ref} (brainstorm pass)`);
      report = await refine(brainstormAnswers);
      reporter?.stopSpinner({ commit: `refinement complete for ${ref} (pass 2)` });
    }
  }

  if (opts.json !== true) {
    const askAnswer = deps.answer ?? defaultAnswer;
    const answers: Array<{ question: string; answer: string }> = [];
    while (report.status !== "READY") {
      const question = report.missingInformation[0] ?? report.ambiguities[0]?.description;
      if (question === undefined) break;
      const prompt = `Clarification needed:\n${question}\n\nAnswer (or 'cancel'): `;
      let answer = "";
      let emptyAnswers = 0;
      while (answer.trim().length === 0) {
        // Suspend the live spinner before asking for stdin so it cannot erase
        // the readline prompt.
        reporter?.stopSpinner();
        answer = await askAnswer(prompt);
        if (answer.trim().toLowerCase() === "cancel") {
          return {
            repository: report.repository,
            issueNumber: number,
            applied: false,
            reason: "cancelled",
            updatedAt: issue.updatedAt,
            source,
            ...(reused !== null ? { reusedFrom: reused.analysisId } : {}),
          };
        }
        if (answer.trim().length === 0) {
          emptyAnswers += 1;
          if (emptyAnswers >= 2) {
            throw new Error("interactive clarification required but no usable stdin answer was available");
          }
        }
      }
      answers.push({ question, answer: answer.trim() });
      if (answers.length > 10) {
        throw new Error("maximum number of clarification questions exceeded");
      }
      report = await refine(answers);
    }
  }

  reporter?.stopSpinner({ commit: `refinement complete for ${ref}` });

  const proposedBody = upsertRefinementSection(issue.body, report.draft);
  const diff = renderUnifiedDiff(issue.body, proposedBody);

  if (opts.json === true) {
    return {
      repository: report.repository,
      issueNumber: number,
      applied: false,
      reason: "json-proposal",
      updatedAt: issue.updatedAt,
      source,
      ...(reused !== null ? { reusedFrom: reused.analysisId } : {}),
      proposedBody,
      diff,
    };
  }

  stdout("Proposed refinement:");
  stdout(diff);
  const confirm = deps.confirm ?? defaultConfirm;
  const approved = await confirm(`Apply the proposed refinement to issue #${number}?`);
  if (!approved) {
    return {
      repository: report.repository,
      issueNumber: number,
      applied: false,
      reason: "declined",
      updatedAt: issue.updatedAt,
      source,
      ...(reused !== null ? { reusedFrom: reused.analysisId } : {}),
    };
  }

  // Concurrent-edit protection: re-fetch immediately before mutating and
  // require both the updatedAt and the body hash to match what we analyzed.
  const latest = await github.getIssue(number);
  if (latest.updatedAt !== issue.updatedAt) {
    throw new Error(
      `issue #${number} changed during analysis (updatedAt ${issue.updatedAt} -> ${latest.updatedAt}); aborting without modification`,
    );
  }
  if (sha256(latest.body) !== report.sourceBodyHash) {
    throw new Error(
      `issue #${number} body changed during analysis; aborting without modification`,
    );
  }

  const updated = await github.updateIssueBody(number, proposedBody);
  return {
    repository: report.repository,
    issueNumber: number,
    applied: true,
    reason: "approved",
    updatedAt: updated.updatedAt,
    source,
    ...(reused !== null ? { reusedFrom: reused.analysisId } : {}),
    proposedBody,
    diff,
  };
}

/**
 * Find a reusable READY snapshot for the current issue. Returns null when no
 * valid snapshot exists, so the caller falls back to a fresh analysis.
 *
 * Reuse is valid only when the snapshot's `updatedAt` and `sourceBodyHash`
 * match the CURRENT issue exactly; a changed issue instantly invalidates the
 * snapshot (the fast-path safety rule).
 */
async function findReusableReport(
  issue: GitHubIssue,
  repository: { owner: string; repo: string },
  paths: AppPaths,
  fromCheck: string | undefined,
): Promise<ReadinessReport | null> {
  const store = new ArtifactStore(paths);

  if (fromCheck !== undefined) {
    const report = await readReportIfExists(store, fromCheck);
    if (report === null) return null;
    // The report's draft carries the issue ref the refiner saw; the source
    // body hash is authoritative (forced by the orchestrator in `check`).
    if (!isReusable(report, issue, repository, report.draft.issue.updatedAt)) {
      return null;
    }
    return report;
  }

  const pointer = await store.readLatestReadiness(
    repository.owner,
    repository.repo,
    issue.number,
  );
  if (pointer === null) return null;

  const report = await readReportIfExists(store, pointer.analysisId);
  if (report === null) return null;
  // The pointer carries the authoritative `updatedAt` recorded at check time.
  if (!isReusable(report, issue, repository, pointer.updatedAt)) {
    return null;
  }
  return report;
}

async function readReportIfExists(
  store: ArtifactStore,
  analysisId: string,
): Promise<ReadinessReport | null> {
  try {
    return await store.readJson<ReadinessReport>(
      analysisId,
      "readiness-report.json",
    );
  } catch {
    return null;
  }
}

function isReusable(
  report: ReadinessReport,
  issue: GitHubIssue,
  repository: { owner: string; repo: string },
  snapshotUpdatedAt: string,
): boolean {
  if (report.status !== "READY") return false;
  if (report.repository.owner !== repository.owner) return false;
  if (report.repository.repo !== repository.repo) return false;
  if (report.issueNumber !== issue.number) return false;
  if (report.sourceBodyHash !== sha256(issue.body)) return false;
  if (snapshotUpdatedAt !== issue.updatedAt) return false;
  return true;
}

function printHumanOutcome(
  outcome: PrepareOutcome,
  stdout: (text: string) => void,
): void {
  stdout(
    `Issue: ${outcome.repository.owner}/${outcome.repository.repo}#${outcome.issueNumber}`,
  );
  if (outcome.applied) {
    stdout(
      `Applied refinement (issue updated at ${outcome.updatedAt}${
        outcome.source === "reused" ? `; reused prior check ${outcome.reusedFrom ?? ""}` : ""
      })`,
    );
    return;
  }
  if (outcome.reason === "declined") {
    stdout("Declined — no changes made to the issue");
    return;
  }
  if (outcome.reason === "cancelled") {
    stdout("Cancelled — no changes made to the issue");
    return;
  }
  stdout("Proposal generated (not applied) — run interactively to apply it");
  if (outcome.source === "reused") {
    stdout(`(reused prior check ${outcome.reusedFrom ?? ""})`);
  }
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function defaultAnswer(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt} `)).trim();
  } finally {
    rl.close();
  }
}
