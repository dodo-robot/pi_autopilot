import type { ResolvedRoleModel } from "../config/load-config.js";
import type { AutopilotConfig } from "../config/schema.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import type { AppPaths } from "../platform/paths.js";
import type { ReadinessReport, ReadinessStatus } from "../readiness/readiness-service.js";
import {
  type BacklogClassification,
  type BacklogReport,
  type ScreenClassification,
  parseBacklogReport,
} from "../domain/backlog.js";
import { screenIssue, type ScreenDependency } from "./heuristic-screen.js";
import {
  collectEpicIssueRefs,
  resolveIssueSet,
} from "./issue-set.js";

/** Structural readiness surface consumed by the analyst (satisfied by the M1
 * `ReadinessService`). Injected via the constructor so tests can substitute a
 * fake refiner runner without constructing the real service. */
export interface ReadinessPort {
  check(issueNumber: number): Promise<ReadinessReport>;
}

export interface BacklogAnalystDeps {
  repository: RepositoryContext;
  config: AutopilotConfig;
  github: GitHubPort;
  readiness: ReadinessPort;
  artifacts: ArtifactStore;
  paths: AppPaths;
  refinerModel: ResolvedRoleModel;
  refinerTimeoutMs?: number;
  /** Namespace under which this analysis's report is persisted. */
  analysisId?: string;
  /** Clock for report.generatedAt; injectable for deterministic tests. */
  now?: () => string;
}

export interface AnalyzeIssuesArgs {
  /** Epic issue number whose checklist is merged into the analyzed set. */
  epicRef: number | null;
  /** Explicitly requested issue numbers, preserved in order. */
  requestedRefs: number[];
  /** Refine every analyzable issue, not just screen CANDIDATEs. */
  deep?: boolean;
}

/** Screen classification → final backlog classification for non-refined
 * issues. READY stays READY, every other screen outcome is preserved as a
 * backlog classification (CANDIDATE is absent here: it always refines). */
function mapScreenToClassification(
  screen: ScreenClassification,
): BacklogClassification {
  // CANDIDATE always refines, so it never reaches this helper; defensively
  // treat it as NEEDS_REFINEMENT to keep the mapping total over the screen
  // enum.
  return screen === "CANDIDATE" ? "NEEDS_REFINEMENT" : screen;
}

/** Map a refiner gate outcome back to a backlog classification. The
 * deterministic readiness gate is authoritative within its two outcomes;
 * the screen classification is advisory and ignored here. */
function mapReadinessToClassification(
  status: ReadinessStatus,
  _screenClassification: ScreenClassification,
): BacklogClassification {
  return status;
}

interface SummaryRow {
  classification: BacklogClassification;
}

export interface BacklogSummary {
  ready: number;
  needsRefinement: number;
  blocked: number;
  ambiguous: number;
  skipped: number;
  unresolved: number;
}

/** Count rows by their final classification into the report's summary shape. */
export function summarizeReports(rows: SummaryRow[]): BacklogSummary {
  const summary: BacklogSummary = {
    ready: 0,
    needsRefinement: 0,
    blocked: 0,
    ambiguous: 0,
    skipped: 0,
    unresolved: 0,
  };
  for (const row of rows) {
    const key = row.classification;
    switch (key) {
      case "READY":
        summary.ready += 1;
        break;
      case "NEEDS_REFINEMENT":
        summary.needsRefinement += 1;
        break;
      case "BLOCKED":
        summary.blocked += 1;
        break;
      case "AMBIGUOUS":
        summary.ambiguous += 1;
        break;
      case "SKIPPED":
        summary.skipped += 1;
        break;
    }
  }
  return summary;
}

/**
 * Read-only backlog analysis: triage each issue with the deterministic
 * screen, spend a refiner session only on screen CANDIDATEs (or on every
 * analyzable issue under `--deep`), apply the M1 readiness gate, and persist
 * a durable `BacklogReport`. Never mutates GitHub.
 */
export class BacklogAnalyst {
  private readonly analysisId: string;
  private readonly now: () => string;

  constructor(private readonly deps: BacklogAnalystDeps) {
    this.analysisId = deps.analysisId ?? `analyze-${Date.now()}`;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async analyzeIssues({
    epicRef,
    requestedRefs,
    deep = false,
  }: AnalyzeIssuesArgs): Promise<BacklogReport> {
    const repo = this.deps.repository.repository;
    const analysisId = this.analysisId;

    let totalRefs = requestedRefs;
    let unresolvedCount = 0;
    if (epicRef !== null) {
      const epic = await this.deps.github.getIssue(epicRef);
      const { issues: epicIssueRefs, unresolvedProseLines } = collectEpicIssueRefs(
        epic.body,
      );
      const merged: number[] = [];
      for (const n of [...requestedRefs, ...epicIssueRefs]) {
        if (!merged.includes(n)) merged.push(n);
      }
      totalRefs = merged;
      unresolvedCount = unresolvedProseLines.length;
    }

    const set = await resolveIssueSet(totalRefs, epicRef, this.deps.github, repo);

    const rows: BacklogReport["issues"] = [];
    let refinerSessions = 0;
    const executable: number[] = [];
    const needsWork: number[] = [];

    for (const issue of set.issues) {
      const screenDeps = await this.resolveScreenDependencies(issue);
      const screen = screenIssue({ issue, dependencies: screenDeps });

      const shouldRefine = deep || screen.classification === "CANDIDATE";
      let classification: BacklogClassification;
      let readiness: {
        analysisId: string;
        status: ReadinessStatus;
      } | null = null;

      if (screen.classification === "SKIPPED") {
        classification = "SKIPPED";
      } else if (shouldRefine) {
        refinerSessions += 1;
        const report = await this.deps.readiness.check(issue.number);
        readiness = { analysisId: report.analysisId, status: report.status };
        classification = mapReadinessToClassification(
          report.status,
          screen.classification,
        );
      } else {
        classification = mapScreenToClassification(screen.classification);
      }

      rows.push({
        issueNumber: issue.number,
        title: issue.title,
        url: issue.htmlUrl,
        classification,
        screen: {
          classification: screen.classification,
          reasons: screen.reasons,
        },
        readiness,
      });

      if (classification === "READY") {
        executable.push(issue.number);
      } else if (classification !== "SKIPPED") {
        needsWork.push(issue.number);
      }
    }

    const totalIssues = totalRefs.length;
    const analyzed = rows.filter((r) => r.classification !== "SKIPPED").length;
    const unresolvedTotal = unresolvedCount + set.missing.length;

    const report: BacklogReport = {
      repository: repo,
      epicRef: epicRef ?? null,
      requestedRefs: totalRefs,
      generatedAt: this.now(),
      analysisId,
      scope: {
        totalIssues,
        analyzed,
        unresolved: unresolvedTotal,
      },
      issues: rows,
      executable,
      needsWork,
      summary: { ...summarizeReports(rows), unresolved: unresolvedTotal },
      refinerSessions,
    };

    await this.deps.artifacts.writeJson(analysisId, "backlog-report.json", report);
    return parseBacklogReport(report);
  }

  /**
   * Resolve explicit dependency markers in an issue body to satisfaction
   * states for the screen. Only refs explicitly marked as dependencies are
   * material (matching the screen's rule-2 data); bare `#n` background refs
   * are ignored. A failure to fetch a dependency is treated as unsatisfied
   * (conservative → BLOCKED).
   */
  async resolveScreenDependencies(
    issue: GitHubIssue,
  ): Promise<ScreenDependency[]> {
    const body = issue.body ?? "";
    const deps = new Map<number, ScreenDependency>();
    const record = (n: number) => {
      if (!deps.has(n)) deps.set(n, { issue: n, satisfied: false });
    };

    // Managed refinement-section rendering: `- #<n> (unsatisfied)`.
    const managedPattern = /- #(\d+) \(unsatisfied\)/g;
    for (const match of body.matchAll(managedPattern)) record(Number(match[1]));

    // Explicit dependency line at line start.
    const linePattern = /^[ \t]*(?:depends?\s+on\b|dependency)\b\s*:?\s*#?\s*(\d+)/gim;
    for (const match of body.matchAll(linePattern)) record(Number(match[1]));

    for (const dep of deps.values()) {
      try {
        const target = await this.deps.github.getIssue(dep.issue);
        dep.satisfied = target.state === "closed";
      } catch {
        dep.satisfied = false;
      }
    }

    return [...deps.values()];
  }
}
