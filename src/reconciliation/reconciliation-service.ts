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
import { APPLY_ARTIFACT } from "./apply-service.js";
import type { ApplyReport, DeclinedPatch } from "../domain/apply.js";
import { extractDeclines } from "./steering.js";

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

function isClosed(issue: GitHubIssue): boolean {
  return issue.state.toLowerCase() === "closed";
}

function patchReferencesClosedIssue(patch: BacklogPatch, closedIssueNumbers: Set<number>): boolean {
  switch (patch.type) {
    case "CREATE_ISSUE":
      return false;
    case "MERGE_DUPLICATE":
      return closedIssueNumbers.has(patch.keep) || closedIssueNumbers.has(patch.duplicate);
    case "ADD_DEPENDENCY":
    case "REMOVE_DEPENDENCY":
      return closedIssueNumbers.has(patch.issue) || closedIssueNumbers.has(patch.dependsOn);
    case "NEEDS_HUMAN":
      return patch.issue !== null && closedIssueNumbers.has(patch.issue);
    case "KEEP":
    case "ENRICH_ISSUE":
    case "SPLIT_ISSUE":
    case "MARK_STALE":
      return closedIssueNumbers.has(patch.issue);
  }
}

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

    if (isClosed(epic)) {
      throw new Error(`epic #${epicRef} is closed; reconcile only operates on open epics`);
    }

    const { issues: epicIssueRefs, unresolvedProseLines } = collectEpicIssueRefs(epic.body);
    const uniqueRefs = [...new Set(epicIssueRefs)];
    // `resolveIssueSet` already drops closed checklist issues and reports them
    // under `skipped`; only open issues reach the reconciler.
    const { issues: activeIssues, missing, skipped } = await resolveIssueSet(
      uniqueRefs,
      epicRef,
      this.deps.github,
      repository,
    );

    const closedIssueNumbers = new Set(
      skipped.filter((entry) => entry.reason === "closed").map((entry) => entry.issue),
    );

    const latestApply = await this.deps.artifacts.readLatestApply(
      repository.owner,
      repository.repo,
      epicRef,
    );
    let applySteering: DeclinedPatch[] | undefined;
    if (latestApply !== null) {
      const applyReport = await this.deps.artifacts.readJson<ApplyReport>(
        latestApply.analysisId,
        APPLY_ARTIFACT,
      );
      applySteering = extractDeclines(applyReport);
    }

    // priorReport intentionally not wired in this milestone — see design spec §6.1 note; the idempotency guarantee (§7.1) doesn't depend on it, only REQ-ID stability across repeated runs does.
    const prompt = buildReconcilerPrompt({
      repository,
      epic,
      issues: activeIssues,
      requirementDocs,
      ...(applySteering !== undefined && applySteering.length > 0 ? { applySteering } : {}),
    });

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
        {
          question: `Does issue #${ref} still exist? Update or remove it from epic #${epicRef}'s checklist.`,
          recommendation: `Remove the reference to #${ref} from epic #${epicRef}'s checklist — a fetch failure usually means the issue was deleted or the repository changed.`,
        },
      ],
    }));

    const proseLinePatches: BacklogPatch[] = unresolvedProseLines.map((lineNumber) => ({
      type: "NEEDS_HUMAN",
      issue: null,
      ambiguityType: "MISSING_CONTEXT",
      reason: `epic #${epicRef}'s checklist line ${lineNumber} has no issue reference`,
      questions: [
        {
          question: `Line ${lineNumber} of epic #${epicRef}'s checklist doesn't reference a GitHub issue — does it need one created, or should the line be removed/clarified?`,
          recommendation: `Review line ${lineNumber} manually and either create the missing issue and link it, or remove/clarify the line if it's stale.`,
        },
      ],
    }));

    const issueLikes: Array<{ number: number; title: string; body: string; state: string }> =
      activeIssues.map((issue: GitHubIssue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));

    const downgraded = applyIdempotencyDowngrades(
      [...raw.patches, ...missingPatches, ...proseLinePatches],
      issueLikes,
    );

    const patches: ReconciledPatch[] = downgraded
      .filter((patch) => !patchReferencesClosedIssue(patch, closedIssueNumbers))
      .map((patch) => ({
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
