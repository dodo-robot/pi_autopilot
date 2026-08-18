import { Command } from "commander";
import type { RoleModelOverride } from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import type { RunOverrides, RunServiceDeps, RunSummary } from "../workflow/run-service.js";
import { RunService } from "../workflow/run-service.js";

export interface ResumeCommandDeps extends RunServiceDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface ResumeOptions {
  json?: boolean;
  model?: string;
  thinking?: string;
}

function exitCodeFor(summary: RunSummary): number {
  if (summary.stage === "PR_OPEN") return 0;
  if (summary.stage === "NEEDS_REFINEMENT" || summary.stage === "BLOCKED") return 2;
  return 1;
}

function resolveOverrides(opts: ResumeOptions): RunOverrides {
  const override: RoleModelOverride = {};
  if (opts.model !== undefined) override.model = opts.model;
  if (opts.thinking !== undefined) {
    const parsed = ThinkingLevelSchema.safeParse(opts.thinking);
    if (!parsed.success) {
      throw new Error(
        `invalid thinking level '${opts.thinking}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
      );
    }
    override.thinking = parsed.data;
  }
  if (override.model === undefined && override.thinking === undefined) return {};
  return { implementer: override, reviewer: override };
}

/**
 * `autopilot resume <run-id>` — continue a `BLOCKED` run with one fresh,
 * transcript-free correction attempt in its preserved workspace. Requires
 * the run to be currently `BLOCKED`; every other stage (including every
 * terminal stage) is rejected.
 */
export function registerResumeCommand(
  program: Command,
  deps: ResumeCommandDeps = {},
): void {
  program
    .command("resume")
    .description("Resume a BLOCKED run with a fresh correction attempt")
    .argument("<run-id>", "run id")
    .option("--json", "emit a machine-readable run summary")
    .option("--model <model>", "override the model for the resumed attempt")
    .option("--thinking <level>", "override the thinking level for the resumed attempt")
    .action(async (runId: string, opts: ResumeOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      try {
        const overrides = resolveOverrides(opts);
        const service = new RunService(deps);
        const summary = await service.resume(runId, overrides);
        if (opts.json === true) {
          stdout(JSON.stringify(summary, null, 2));
        } else {
          printHumanSummary(summary, stdout);
        }
        setExitCode(exitCodeFor(summary));
      } catch (error) {
        stderr(
          `autopilot resume: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      }
    });
}

function printHumanSummary(summary: RunSummary, stdout: (text: string) => void): void {
  stdout(
    `Issue: ${summary.repository.owner}/${summary.repository.repo}#${String(summary.issueNumber)}`,
  );
  stdout(`Run: ${summary.runId}`);
  stdout(`Stage: ${summary.stage}`);
  if (summary.reason !== null) {
    stdout(`Reason: ${summary.reason}`);
  }
  if (summary.publication !== null) {
    stdout(`Pull request: ${summary.publication.pullRequest.url}`);
  }
}
