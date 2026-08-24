import { writeFile, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { BootstrapperResult } from "../domain/contracts.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { PiRunError } from "../pi/pi-runner.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import type { AppPaths } from "../platform/paths.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import { AnswerPump } from "./answer-pump.js";
import { buildBootstrapperPrompt } from "./bootstrapper-prompt.js";
import { proposeConfig } from "./config-proposer.js";
import { checkSize, formatSizeError } from "./size-checker.js";
import type { SizeFail } from "./size-checker.js";
import { PlanStore, generatePlanId } from "./plan-store.js";
import { renderPlan } from "./plan-renderer.js";
import type { BootstrapPlan } from "./types.js";
import type { PendingQuestion } from "./answer-pump.js";

export interface BootstrapperRunner {
  run(request: PiRunRequest): Promise<PiExecution>;
}

export interface BootstrapServiceDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  pi: BootstrapperRunner;
  artifacts: ArtifactStore;
  paths: AppPaths;
  bootstrapperModel: ResolvedRoleModel;
  bootstrapperTimeoutMs?: number;
  planId?: string;
  now?: () => string;
  hasExistingConfig?: boolean;
  /**
   * Test seam / override for answering bootstrapper HITL questions. Defaults to
   * a console prompt on stdin when not provided.
   */
  onQuestion?: (question: PendingQuestion) => Promise<string>;
}

export class BootstrapSizeError extends Error {
  constructor(
    message: string,
    public readonly sizeResult: SizeFail,
  ) {
    super(message);
    this.name = "BootstrapSizeError";
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Path to the superpowers brainstorming skill injected into the bootstrapper
 * session via `--skill`. It lives outside the worktree; `skillPaths` must also
 * allow-list its directory so any guarded read works.
 */
const BRAINSTORMING_SKILL =
  "/home/dodo/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming/SKILL.md";

/**
 * Default operator-facing HITL handler: prints the bootstrapper's question to
 * stdout and reads a single-line answer from stdin. Used when the service is
 * not given an `onQuestion` override.
 */
function defaultQuestionHandler(_askDir: string): (question: string, context: string) => Promise<string> {
  return async (question: string, context: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (context && context.length > 0) {
        process.stdout.write(`\n[bootstrapper] ${context}\n`);
      }
      process.stdout.write(`\n[bootstrapper asks] ${question}`);
      const answer = await rl.question("\nAnswer> ");
      return answer.trim();
    } finally {
      rl.close();
    }
  };
}

export class BootstrapService {
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(private readonly deps: BootstrapServiceDeps) {
    this.timeoutMs = deps.bootstrapperTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async plan(requirementDocs: RequirementDoc[]): Promise<{ planId: string; markdownPath: string }> {
    const threshold = (this.deps.config as { bootstrap?: { tokenThreshold?: number } }).bootstrap?.tokenThreshold ?? 80_000;
    const sizeResult = checkSize(requirementDocs, threshold);
    if (!sizeResult.ok) {
      throw new BootstrapSizeError(formatSizeError(sizeResult), sizeResult);
    }

    const planId = this.deps.planId ?? generatePlanId();
    const analysisDir = this.deps.paths.runDir(planId);
    const hasExistingConfig = this.deps.hasExistingConfig ?? false;

    const prompt = buildBootstrapperPrompt({
      repository: this.deps.repository.repository,
      requirementDocs,
      hasExistingConfig,
    });

    const skillConfig = (this.deps.config as { bootstrap?: { skillPaths?: string[] } }).bootstrap?.skillPaths ?? [];
    // Load the brainstorming skill into the session. Derive its SKILL.md from
    // the configured skillPaths directory when available, else the built-in
    // default location.
    const firstSkillDir = skillConfig.length > 0 ? skillConfig[0] : undefined;
    const brainstormingSkill =
      firstSkillDir !== undefined
        ? path.join(firstSkillDir, "SKILL.md")
        : BRAINSTORMING_SKILL;
    // The guard must allow reads of the injected skill directory even when the
    // operator has not configured skillPaths, so the session can re-read the
    // skill if it needs to. skillPaths defaults to just the skill parent dir.
    const guardSkillPaths =
      skillConfig.length > 0
        ? skillConfig
        : [path.dirname(brainstormingSkill)];
    const askDir = path.join(analysisDir, "diagnostics", "ask");
    const pump = new AnswerPump({
      askDir,
      promptFn: this.deps.onQuestion
        ? async (question, context) => await this.deps.onQuestion!({ seq: 0, question, context })
        : defaultQuestionHandler(askDir),
    });
    pump.start();

    let execution: PiExecution;
    try {
      execution = await this.deps.pi.run({
        role: "bootstrapper",
        model: this.deps.bootstrapperModel,
        prompt,
        worktree: this.deps.repository.root,
        allowedCommands: [],
        protectedPaths: this.deps.config.agentPolicy.protectedPaths,
        sessionDir: path.join(analysisDir, "session"),
        diagnosticsDir: path.join(analysisDir, "diagnostics"),
        env: safeProcessEnv(),
        timeoutMs: this.timeoutMs,
        skills: [brainstormingSkill],
        skillPaths: guardSkillPaths,
      });
    } catch (error) {
      if (error instanceof PiRunError && /timed out/.test(error.message)) {
        // Option A: a slow / timed-out HITL session loses nothing. Persist a
        // resume pointer so the operator can fork the pi session and continue
        // from where the bootstrapper left off (answers already given are in
        // the ask/ transcript; the conversation is in session/*.jsonl).
        await this.writeResumePointer(planId, analysisDir, askDir);
      }
      throw error;
    } finally {
      pump.stop();
    }

    const raw = execution.result as BootstrapperResult;
    const configYaml = hasExistingConfig ? null : proposeConfig(this.deps.bootstrapperModel.model);

    const plan: BootstrapPlan = {
      planId,
      createdAt: this.now(),
      requirementDocs: requirementDocs.map((d) => d.path),
      proposedConfig: hasExistingConfig ? null : configYaml,
      projectBoard: raw.projectBoard,
      epics: raw.epics.map((e) => ({
        title: e.title,
        description: e.description,
        labels: ["epic"],
        issues: e.issues.map((i) => ({
          title: i.title,
          body: i.body,
          labels: ["task"],
          requirementRef: i.requirementRef,
        })),
      })),
      dependencies: raw.dependencies,
      tracks: raw.tracks,
      applyState: {
        epicsCreated: false,
        issuesCreated: false,
        checklistsPatched: false,
        addedToBoard: false,
        configWritten: false,
      },
    };

    const store = new PlanStore(this.deps.artifacts);
    await store.save(plan);

    const md = renderPlan(plan, typeof configYaml === "string" ? configYaml : null);
    const markdownPath = path.join(analysisDir, "bootstrap-plan.md");
    await writeFile(markdownPath, md, "utf8");

    return { planId, markdownPath };
  }

  /**
   * Persist a human-readable resume pointer for a timed-out bootstrapper
   * session, so the operator can fork the saved pi session and continue where
   * the bootstrapper left off rather than losing accumulated HITL progress.
   */
  private async writeResumePointer(
    planId: string,
    analysisDir: string,
    askDir: string,
  ): Promise<void> {
    const sessionDir = path.join(analysisDir, "session");
    let sessionFile = "";
    try {
      const files = await readdir(sessionDir);
      sessionFile = files.filter((f) => f.endsWith(".jsonl"))[0] ?? "";
    } catch {
      sessionFile = "";
    }
    const pointer = [
      `Bootstrap plan ${planId} was interrupted by the session timeout before completing.`,
      ``,
      `The conversation and your answers are preserved on disk. To continue manually:`,
      ``,
      `  session (fork with pi):  ${path.join(sessionDir, sessionFile) || "(none written yet)"}`,
      `  questions/answers:       ${askDir}`,
      ``,
      `Resume the bootstrapper conversation by forking the pi session, e.g.:`,
      ``,
      `  pi --fork ${path.join(sessionDir, sessionFile) || "<session-path>"} \\`,
      `     --tools read,grep,find,ls,submit_result,ask_human \\`,
      `     --extension <path-to-guard-extension> "Continue where you left off."`,
      ``,
      `Alternatively, re-run autopilot bootstrap --plan for this batch (it will`,
      `start a fresh session, but you can reuse this transcript).`,
      ``,
    ].join("\n");
    await writeFileSync(path.join(analysisDir, "RESUME.txt"), pointer, "utf8");
  }
}
