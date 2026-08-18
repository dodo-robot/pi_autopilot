import { Command } from "commander";
import type { ResolvedRoleModel } from "../config/load-config.js";
import {
  DEFAULT_PI_MODEL,
  loadRepositoryConfig,
  resolveRoleModel,
} from "../config/load-config.js";
import type {
  AutopilotConfig,
  RoleModelEntry,
  RoleModelOverride,
} from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import {
  assertRepositoryMatches,
  resolveRepositoryContext,
} from "../github/repository-context.js";
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

export interface PrepareCommandDeps extends CheckCommandDeps {
  /**
   * Ask the operator to approve applying the proposed refinement. Defaults
   * to an interactive readline prompt; tests inject a stub.
   */
  confirm?: (prompt: string) => Promise<boolean>;
}

interface PrepareOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
}

interface PrepareOutcome {
  repository: { owner: string; repo: string };
  issueNumber: number;
  applied: boolean;
  reason: "approved" | "declined" | "json-proposal";
  /** `updatedAt` of the analyzed issue (pre-edit). */
  updatedAt: string;
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
    .action(async (issueRef: string, opts: PrepareOptions) => {
      const stdout =
        deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr =
        deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const outcome = await runPrepare(issueRef, opts, deps);
        if (opts.json === true) {
          stdout(JSON.stringify(outcome, null, 2));
        } else {
          printHumanOutcome(outcome, stdout);
        }
        setExitCode(0);
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
  const refinerModel = resolveRefinerModel(opts, config, deps.piDefaultModel);
  const readiness =
    deps.createReadiness !== undefined
      ? deps.createReadiness({ repository: ctx, config, github, refinerModel })
      : new ReadinessService({
          repository: ctx,
          config,
          github,
          pi: new PiRunner(runner, deps.piCommand),
          artifacts: new ArtifactStore(paths),
          paths,
          refinerModel,
        });

  // Initial fetch: the base for the diff and the concurrent-edit guard.
  const issue = await github.getIssue(number);
  const report: ReadinessReport = await readiness.check(number);
  const proposedBody = upsertRefinementSection(issue.body, report.draft);
  const diff = renderUnifiedDiff(issue.body, proposedBody);

  if (opts.json === true) {
    return {
      repository: report.repository,
      issueNumber: number,
      applied: false,
      reason: "json-proposal",
      updatedAt: issue.updatedAt,
      proposedBody,
      diff,
    };
  }

  const confirm = deps.confirm ?? defaultConfirm;
  const approved = await confirm(`Apply the proposed refinement to issue #${number}?`);
  if (!approved) {
    return {
      repository: report.repository,
      issueNumber: number,
      applied: false,
      reason: "declined",
      updatedAt: issue.updatedAt,
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
    proposedBody,
    diff,
  };
}

function printHumanOutcome(
  outcome: PrepareOutcome,
  stdout: (text: string) => void,
): void {
  stdout(
    `Issue: ${outcome.repository.owner}/${outcome.repository.repo}#${outcome.issueNumber}`,
  );
  if (outcome.applied) {
    stdout(`Applied refinement (issue updated at ${outcome.updatedAt})`);
    return;
  }
  if (outcome.reason === "declined") {
    stdout("Declined — no changes made to the issue");
    return;
  }
  stdout("Proposal generated (not applied) — run interactively to apply it");
}

function resolveIssueRef(
  issueRef: string,
  ctx: RepositoryContext,
): { number: number } {
  const trimmed = issueRef.trim();
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare !== null) {
    return { number: Number(bare[1]) };
  }
  const qualified = /^([^/]+)\/([^/]+)#(\d+)$/.exec(trimmed);
  if (qualified !== null) {
    assertRepositoryMatches(ctx, {
      owner: qualified[1] ?? "",
      repo: qualified[2] ?? "",
    });
    return { number: Number(qualified[3]) };
  }
  throw new Error(
    `invalid issue reference '${issueRef}' (expected <number> or <owner>/<repo>#<number>)`,
  );
}

function resolveRefinerModel(
  opts: PrepareOptions,
  config: AutopilotConfig,
  piDefault: RoleModelEntry | undefined,
): ResolvedRoleModel {
  const override: RoleModelOverride = {};
  if (opts.model !== undefined) {
    override.model = opts.model;
  }
  if (opts.thinking !== undefined) {
    const parsed = ThinkingLevelSchema.safeParse(opts.thinking);
    if (!parsed.success) {
      throw new Error(
        `invalid thinking level '${opts.thinking}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
      );
    }
    override.thinking = parsed.data;
  }
  return resolveRoleModel(
    "refiner",
    override.model !== undefined || override.thinking !== undefined
      ? override
      : null,
    config.agents,
    null,
    piDefault ?? DEFAULT_PI_MODEL,
  );
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
