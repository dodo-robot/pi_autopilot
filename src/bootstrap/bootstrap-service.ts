import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { BootstrapperResult } from "../domain/contracts.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import type { AppPaths } from "../platform/paths.js";
import type { RequirementDoc } from "../reconciliation/prompt.js";
import { buildBootstrapperPrompt } from "./bootstrapper-prompt.js";
import { proposeConfig } from "./config-proposer.js";
import { checkSize, formatSizeError } from "./size-checker.js";
import type { SizeFail } from "./size-checker.js";
import { PlanStore, generatePlanId } from "./plan-store.js";
import { renderPlan } from "./plan-renderer.js";
import type { BootstrapPlan } from "./types.js";

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

    const execution = await this.deps.pi.run({
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
    });

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
}
