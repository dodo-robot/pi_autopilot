import { createHash } from "node:crypto";
import path from "node:path";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type {
  Ambiguity,
  RefinerResult,
  RepositoryRef,
  TaskDependency,
  TaskDraft,
  TaskSnapshot,
} from "../domain/contracts.js";
import { TaskSnapshotSchema } from "../domain/contracts.js";
import type { GitHubPort } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { safeProcessEnv } from "../github/repository-context.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { AppPaths } from "../platform/paths.js";
import { buildRefinerPrompt } from "./prompt.js";

export const GAP_CODES = [
  "NO_OBJECTIVE",
  "NO_EXPECTED_BEHAVIOR",
  "NO_TESTABLE_ACCEPTANCE_CRITERIA",
  "NO_VALIDATION",
  "MANUAL_ONLY_VALIDATION",
  "UNSATISFIED_DEPENDENCIES",
  "PRODUCT_AMBIGUITY",
  "REFINER_FAILED",
  "INCOMPLETE_INFORMATION",
  "INVALID_SNAPSHOT",
] as const;
export type GapCode = (typeof GAP_CODES)[number];

export type ReadinessStatus = "READY" | "NEEDS_REFINEMENT";

export interface ReadinessGap {
  code: GapCode;
  message: string;
  suggestion: string;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  /** The refiner's advisory outcome; the deterministic gate is authoritative. */
  outcome: RefinerResult["outcome"];
  repository: RepositoryRef;
  issueNumber: number;
  sourceBodyHash: string;
  gaps: ReadinessGap[];
  missingInformation: string[];
  suggestions: string[];
  ambiguities: Ambiguity[];
  dependencies: TaskDependency[];
  draft: TaskDraft;
  /** Present only when status is READY. */
  snapshot: TaskSnapshot | null;
  refinerModel: ResolvedRoleModel;
  /** Namespace under which this analysis's artifacts were stored. */
  analysisId: string;
  createdAt: string;
}

/** Structural Pi runner surface consumed by readiness (satisfied by PiRunner). */
export interface RefinerRunner {
  run(request: PiRunRequest): Promise<PiExecution>;
}

export interface ReadinessServiceDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  github: GitHubPort;
  pi: RefinerRunner;
  artifacts: ArtifactStore;
  paths: AppPaths;
  refinerModel: ResolvedRoleModel;
  /** Refiner session timeout in milliseconds. */
  refinerTimeoutMs?: number;
  /** Namespaces this analysis's artifacts and Pi session. */
  analysisId?: (issueNumber: number) => string;
  /** Clock for report.createdAt; injectable for deterministic tests. */
  now?: () => string;
}

const DEFAULT_REFINER_TIMEOUT_MS = 5 * 60_000;
const REPORT_ARTIFACT = "readiness-report.json";
const SNAPSHOT_ARTIFACT = "task-snapshot.json";

/** Manual-only validation wording that cannot be executed by an orchestrator. */
const MANUAL_ONLY_PATTERN = /manual|manually|visual|by eye|human|click|browser/i;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Deterministic readiness gate. The refiner's outcome is advisory only; a
 * draft must actually satisfy every rule for the task to become ready.
 */
export function computeReadinessGaps(
  refiner: RefinerResult,
  draft: TaskDraft,
): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  const missingInformation =
    refiner.outcome === "FAILED" ? [] : refiner.missingInformation;
  const ambiguities = refiner.outcome === "FAILED" ? [] : refiner.ambiguities;

  if (refiner.outcome === "FAILED") {
    gaps.push({
      code: "REFINER_FAILED",
      message: `the refiner failed: ${refiner.reason}`,
      suggestion:
        "retry `autopilot check`; if the failure persists, inspect the refiner diagnostics",
    });
  }

  if (refiner.outcome === "NEEDS_REFINEMENT" || missingInformation.length > 0) {
    gaps.push({
      code: "INCOMPLETE_INFORMATION",
      message: "the issue lacks information required for an execution contract",
      suggestion:
        "run `autopilot prepare <issue>` to draft the missing sections and review them",
    });
  }

  if (draft.objective.trim().length === 0) {
    gaps.push({
      code: "NO_OBJECTIVE",
      message: "the execution contract has no objective",
      suggestion: "state the concrete outcome the task must produce",
    });
  }

  if (draft.expectedBehavior.length === 0) {
    gaps.push({
      code: "NO_EXPECTED_BEHAVIOR",
      message: "the execution contract lists no expected behavior",
      suggestion: "describe the observable behavior after implementation",
    });
  }

  if (draft.acceptanceCriteria.length === 0) {
    gaps.push({
      code: "NO_TESTABLE_ACCEPTANCE_CRITERIA",
      message: "the execution contract has no acceptance criteria",
      suggestion: "add at least one testable acceptance criterion",
    });
  }

  if (draft.validation.length === 0) {
    gaps.push({
      code: "NO_VALIDATION",
      message: "the execution contract defines no validation expectation",
      suggestion: "name commands or automated checks that prove completion",
    });
  } else if (draft.validation.every((entry) => MANUAL_ONLY_PATTERN.test(entry))) {
    gaps.push({
      code: "MANUAL_ONLY_VALIDATION",
      message: "all validation expectations are manual-only",
      suggestion:
        "name automated commands or checks; manual-only checks are not sufficient",
    });
  }

  const unsatisfied = draft.dependencies.filter(
    (dependency) => !dependency.satisfied,
  );
  if (unsatisfied.length > 0) {
    gaps.push({
      code: "UNSATISFIED_DEPENDENCIES",
      message: `blocked by unresolved dependencies: #${unsatisfied
        .map((dependency) => dependency.issue)
        .join(", #")}`,
      suggestion:
        "resolve or represent the dependencies before autonomous execution",
    });
  }

  const productAmbiguities = ambiguities.filter(
    (ambiguity) => ambiguity.type === "PRODUCT",
  );
  if (refiner.outcome === "PRODUCT_AMBIGUITY" || productAmbiguities.length > 0) {
    gaps.push({
      code: "PRODUCT_AMBIGUITY",
      message:
        "unresolved product ambiguity would materially influence the implementation",
      suggestion:
        "resolve the product decision(s) before autonomous execution (see ambiguities)",
    });
  }

  return gaps;
}

/**
 * Runs a bounded refiner session for one GitHub issue and applies the
 * deterministic readiness gate. `check` is strictly read-only: it never
 * mutates GitHub. The report and any promoted snapshot are persisted as
 * run-independent artifacts for later `prepare`/`run` use.
 */
export class ReadinessService {
  private readonly refinerTimeoutMs: number;
  private readonly analysisId: (issueNumber: number) => string;
  private readonly now: () => string;

  constructor(private readonly deps: ReadinessServiceDeps) {
    this.refinerTimeoutMs = deps.refinerTimeoutMs ?? DEFAULT_REFINER_TIMEOUT_MS;
    this.analysisId =
      deps.analysisId ??
      ((issueNumber) => `check-${Date.now()}-${issueNumber}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async check(issueNumber: number): Promise<ReadinessReport> {
    const issue = await this.deps.github.getIssue(issueNumber);
    const sourceBodyHash = sha256(issue.body);
    const analysisId = this.analysisId(issueNumber);
    const analysisDir = this.deps.paths.runDir(analysisId);

    const prompt = buildRefinerPrompt({
      repository: this.deps.repository.repository,
      issue,
      config: this.deps.config,
      sourceBodyHash,
    });

    const execution = await this.deps.pi.run({
      role: "refiner",
      model: this.deps.refinerModel,
      prompt,
      worktree: this.deps.repository.root,
      allowedCommands: [],
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(analysisDir, "session"),
      diagnosticsDir: path.join(analysisDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.refinerTimeoutMs,
    });
    const refiner = execution.result as RefinerResult;

    // The orchestrator owns the source body hash; the refiner's copy is
    // never trusted for the immutable snapshot.
    const draft: TaskDraft = { ...refiner.taskDraft, sourceBodyHash };

    const gaps = computeReadinessGaps(refiner, draft);
    let status: ReadinessStatus =
      refiner.outcome === "READY" && gaps.length === 0
        ? "READY"
        : "NEEDS_REFINEMENT";

    let snapshot: TaskSnapshot | null = null;
    if (status === "READY") {
      const parsed = TaskSnapshotSchema.safeParse(draft);
      if (parsed.success) {
        snapshot = parsed.data;
      } else {
        gaps.push({
          code: "INVALID_SNAPSHOT",
          message: "the draft does not satisfy the strict task snapshot schema",
          suggestion:
            "run `autopilot prepare <issue>` to regenerate the execution contract",
        });
        status = "NEEDS_REFINEMENT";
      }
    }

    const report: ReadinessReport = {
      status,
      outcome: refiner.outcome,
      repository: this.deps.repository.repository,
      issueNumber,
      sourceBodyHash,
      gaps,
      missingInformation:
        refiner.outcome === "FAILED" ? [] : refiner.missingInformation,
      suggestions:
        refiner.outcome === "NEEDS_REFINEMENT" ? refiner.suggestions : [],
      ambiguities: refiner.outcome === "FAILED" ? [] : refiner.ambiguities,
      dependencies: refiner.outcome === "FAILED" ? [] : refiner.dependencies,
      draft,
      snapshot,
      refinerModel: this.deps.refinerModel,
      analysisId,
      createdAt: this.now(),
    };

    await this.deps.artifacts.writeJson(analysisId, REPORT_ARTIFACT, report);
    if (snapshot !== null) {
      await this.deps.artifacts.writeJson(analysisId, SNAPSHOT_ARTIFACT, snapshot);
    }
    return report;
  }
}
