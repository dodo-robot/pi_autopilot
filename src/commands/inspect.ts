import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { Command } from "commander";
import type { RunRecord, RunStage, TaskSnapshot } from "../domain/contracts.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import type { AttemptRecord, TransitionRecord } from "../persistence/run-store.js";
import { RunStore } from "../persistence/run-store.js";
import { appPaths } from "../platform/paths.js";
import { redact } from "./redact.js";

export interface InspectCommandDeps {
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

interface InspectOptions {
  json?: boolean;
}

export interface InspectReport {
  runId: string;
  stage: RunStage;
  repository: RunRecord["repository"];
  issueNumber: number;
  snapshot: TaskSnapshot | null;
  transitions: TransitionRecord[];
  attempts: Pick<AttemptRecord, "role" | "attemptNumber" | "model" | "thinking">[];
  /** Latest persisted verification evidence artifact, if any, redacted. */
  verification: unknown;
  /** Latest persisted reviewer result artifact, if any, redacted. */
  review: unknown;
}

function isNamedArtifact(prefix: string): (name: string) => boolean {
  const pattern = new RegExp(`^${prefix}-\\d+\\.json$`);
  return (name: string) => pattern.test(name);
}

const isVerificationArtifact = isNamedArtifact("verification");
const isReviewArtifact = isNamedArtifact("review");

/** Return the lexicographically-last matching artifact's parsed contents, or null. */
async function readLatestArtifact(
  artifacts: ArtifactStore,
  runId: string,
  runDir: string,
  matches: (name: string) => boolean,
): Promise<unknown> {
  if (!existsSync(runDir)) return null;
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    return null;
  }
  const candidates = entries.filter(matches).sort();
  const latest = candidates.at(-1);
  if (latest === undefined) return null;
  return await artifacts.readJson(runId, latest);
}

/**
 * `autopilot inspect <run-id>` — report a run's frozen task snapshot,
 * transition history, model usage, and the latest verification/review
 * evidence. Read-only. Every value in the output (including captured
 * command stdout/stderr embedded in evidence) is redacted before printing.
 */
export function registerInspectCommand(
  program: Command,
  deps: InspectCommandDeps = {},
): void {
  program
    .command("inspect")
    .description("Report a run's snapshot, evidence, model usage, and transition history")
    .argument("<run-id>", "run id")
    .option("--json", "emit a machine-readable inspection report")
    .action(async (runId: string, opts: InspectOptions) => {
      const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
      const stderr = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
      const setExitCode = deps.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      });
      const paths = appPaths(deps.dataDir);
      const runStore = new RunStore(paths.dbPath);
      const artifacts = new ArtifactStore(paths);
      try {
        const run = runStore.getRun(runId);
        if (run === null) {
          stderr(`autopilot inspect: no run found with id ${runId}`);
          setExitCode(1);
          return;
        }

        const snapshot =
          run.taskSnapshotRef !== null
            ? await artifacts.readJson<TaskSnapshot>(run.id, run.taskSnapshotRef)
            : null;
        const runDir = paths.runDir(run.id);
        const verification = await readLatestArtifact(
          artifacts,
          run.id,
          runDir,
          isVerificationArtifact,
        );
        const review = await readLatestArtifact(artifacts, run.id, runDir, isReviewArtifact);

        const report: InspectReport = redact({
          runId: run.id,
          stage: run.stage,
          repository: run.repository,
          issueNumber: run.issueNumber,
          snapshot,
          transitions: runStore.transitions(run.id),
          attempts: runStore.listAttempts(run.id).map((a) => ({
            role: a.role,
            attemptNumber: a.attemptNumber,
            model: a.model,
            thinking: a.thinking,
          })),
          verification,
          review,
        }) as InspectReport;

        if (opts.json === true) {
          stdout(JSON.stringify(report, null, 2));
        } else {
          printHumanReport(report, stdout);
        }
        setExitCode(0);
      } catch (error) {
        stderr(
          `autopilot inspect: ${error instanceof Error ? error.message : String(error)}`,
        );
        setExitCode(1);
      } finally {
        runStore.close();
      }
    });
}

function printHumanReport(
  report: InspectReport,
  stdout: (text: string) => void,
): void {
  stdout(
    `Issue: ${report.repository.owner}/${report.repository.repo}#${String(report.issueNumber)}`,
  );
  stdout(`Run: ${report.runId}`);
  stdout(`Stage: ${report.stage}`);
  if (report.snapshot !== null) {
    stdout(`Objective: ${report.snapshot.objective}`);
  }
  stdout("Transitions:");
  for (const transition of report.transitions) {
    stdout(`  ${transition.from} -> ${transition.to}`);
  }
  stdout("Attempts:");
  for (const attempt of report.attempts) {
    stdout(
      `  ${attempt.role} #${String(attempt.attemptNumber)}: ${attempt.model} (${attempt.thinking})`,
    );
  }
  if (report.verification !== null) {
    stdout(`Verification evidence: ${JSON.stringify(report.verification)}`);
  }
  if (report.review !== null) {
    stdout(`Review evidence: ${JSON.stringify(report.review)}`);
  }
}
