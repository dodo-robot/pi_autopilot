import path from "node:path";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { ReconcilerResult } from "../domain/contracts.js";
import type {
  BacklogPatch,
  CoverageEntry,
  ReconciledPatch,
} from "../domain/reconciliation.js";
import { collectEpicIssueRefs, isEpicBody, resolveIssueSet } from "../analysis/issue-set.js";
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import type { AppPaths } from "../platform/paths.js";
import { applyIdempotencyDowngrades } from "./idempotency.js";
import { classifyPatch } from "./patch-policy.js";
import type { RequirementDoc } from "./prompt.js";
import { buildReconcilerPrompt } from "./prompt.js";

/** Structural Pi runner surface consumed by reconciliation (satisfied by
 * PiRunner). Injected via the constructor so tests can substitute a fake
 * without constructing the real service. */
export interface ReconcilerRunner {
  run(request: PiRunRequest): Promise<PiExecution>;
}

export interface ReconciliationServiceDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  github: GitHubPort;
  pi: ReconcilerRunner;
  artifacts: ArtifactStore;
  paths: AppPaths;
  reconcilerModel: ResolvedRoleModel;
  /** Reconciler session timeout in milliseconds. */
  reconcilerTimeoutMs?: number;
  /** Namespaces this analysis's artifacts and Pi session. */
  analysisId?: (epicRef: number) => string;
  /** Clock for report.generatedAt; injectable for deterministic tests. */
  now?: () => string;
}

export interface ReconciliationReport {
  repository: RepositoryRef;
  epicRef: number;
  requirementsPaths: string[];
  generatedAt: string;
  analysisId: string;
  coverage: CoverageEntry[];
  patches: ReconciledPatch[];
  summary: {
    requirementsCovered: number;
    requirementsPartial: number;
    requirementsMissing: number;
    requirementsTotal: number;
    patchCounts: Record<string, number>;
  };
}

const DEFAULT_RECONCILER_TIMEOUT_MS = 10 * 60_000;
const REPORT_ARTIFACT = "reconciliation-report.json";

/**
 * Runs one bounded reconciler session for an epic and produces a durable,
 * policy-annotated `ReconciliationReport`. Strictly read-only: never
 * mutates GitHub. A `PiRunError` from the reconciler session (malformed
 * output, timeout, or crash) is never caught here — it propagates to the
 * caller exactly like every other role session failure in this codebase.
 */
export class ReconciliationService {
  private readonly reconcilerTimeoutMs: number;
  private readonly analysisId: (epicRef: number) => string;
  private readonly now: () => string;

  constructor(private readonly deps: ReconciliationServiceDeps) {
    this.reconcilerTimeoutMs =
      deps.reconcilerTimeoutMs ?? DEFAULT_RECONCILER_TIMEOUT_MS;
    this.analysisId =
      deps.analysisId ?? ((epicRef) => `reconcile-${Date.now()}-${epicRef}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async reconcile(
    epicRef: number,
    requirementDocs: RequirementDoc[],
  ): Promise<ReconciliationReport> {
    const repository = this.deps.repository.repository;
    const analysisId = this.analysisId(epicRef);
    const analysisDir = this.deps.paths.runDir(analysisId);

    const epic = await this.deps.github.getIssue(epicRef);
    if (!isEpicBody(epic.body)) {
      throw new Error(
        `issue #${epicRef} does not look like an epic (no checklist of issue references found)`,
      );
    }

    const { issues: epicIssueRefs } = collectEpicIssueRefs(epic.body);
    const uniqueRefs = [...new Set(epicIssueRefs)];
    const { issues, missing } = await resolveIssueSet(
      uniqueRefs,
      epicRef,
      this.deps.github,
      repository,
    );

    const prompt = buildReconcilerPrompt({ repository, epic, issues, requirementDocs });

    const execution = await this.deps.pi.run({
      role: "reconciler",
      model: this.deps.reconcilerModel,
      prompt,
      worktree: this.deps.repository.root,
      allowedCommands: [],
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(analysisDir, "session"),
      diagnosticsDir: path.join(analysisDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.reconcilerTimeoutMs,
    });

    const raw = execution.result as ReconcilerResult;

    const missingPatches: BacklogPatch[] = missing.map((ref) => ({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "MISSING_CONTEXT",
      reason: `epic #${epicRef} references issue #${ref}, which could not be fetched`,
      questions: [
        `Does issue #${ref} still exist? Update or remove it from epic #${epicRef}'s checklist.`,
      ],
    }));

    const issueLikes: Array<{ number: number; title: string; body: string }> =
      issues.map((issue: GitHubIssue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
      }));

    const downgraded = applyIdempotencyDowngrades(
      [...raw.patches, ...missingPatches],
      issueLikes,
    );

    const patches: ReconciledPatch[] = downgraded.map((patch) => ({
      ...patch,
      policy: classifyPatch(patch),
    }));

    const patchCounts: Record<string, number> = {};
    for (const patch of patches) {
      patchCounts[patch.type] = (patchCounts[patch.type] ?? 0) + 1;
    }

    const summary = {
      requirementsCovered: raw.coverage.filter(
        (entry) => entry.status === "covered" || entry.status === "implemented",
      ).length,
      requirementsPartial: raw.coverage.filter((entry) => entry.status === "partial").length,
      requirementsMissing: raw.coverage.filter((entry) => entry.status === "missing").length,
      requirementsTotal: raw.coverage.length,
      patchCounts,
    };

    const report: ReconciliationReport = {
      repository,
      epicRef,
      requirementsPaths: requirementDocs.map((doc) => doc.path),
      generatedAt: this.now(),
      analysisId,
      coverage: raw.coverage,
      patches,
      summary,
    };

    await this.deps.artifacts.writeJson(analysisId, REPORT_ARTIFACT, report);
    return report;
  }
}
