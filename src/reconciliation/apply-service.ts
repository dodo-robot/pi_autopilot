import type { BacklogPatchType, PatchPolicy, ReconciledPatch } from "../domain/reconciliation.js";
import type { ApplyEntry, ApplyReport } from "../domain/apply.js";
import type { RepositoryRef } from "../domain/contracts.js";
import type { GitHubIssue, GitHubPort } from "../github/github-adapter.js";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { collectEpicIssueRefs } from "../analysis/issue-set.js";
import {
  appendDependencyToBody,
  bodyAlreadyDependsOn,
  removeManagedDependencyFromBody,
} from "./apply-dependency.js";
import {
  confirmMenu,
  renderCreatePreview,
  renderDependencyPreview,
  renderEnrichPreview,
  renderRemoveDependencyPreview,
  type MenuAnswer,
} from "./apply-preview.js";
import { renderReconciliationSection, upsertReconciliationSection } from "./managed-section.js";
import type { ReconciliationReport } from "./reconciliation-service.js";
import { RefinementSectionError } from "../readiness/refinement-section.js";

export const REPORT_ARTIFACT = "reconciliation-report.json";
export const APPLY_ARTIFACT = "reconciliation-apply.json";

const DEFAULT_STALE_HOURS = 168;

/**
 * requires-approval patch types still offerable through the interactive
 * confirm menu (never under --yes or a prior "all" answer). Every other
 * requires-approval type (MARK_STALE, NEEDS_HUMAN) is hard-skipped before
 * prepare() ever runs.
 */
const OFFERABLE_REQUIRES_APPROVAL: ReadonlySet<BacklogPatchType> = new Set(["REMOVE_DEPENDENCY"]);

export interface ApplyOptions {
  /** Unattended: apply auto-safe patches and skip requires-approval patches. */
  yes: boolean;
  /** Bypass the stored-report staleness guard. */
  force?: boolean;
  /** Render/apply-decision previews without mutating GitHub. */
  previewOnly?: boolean;
}

export interface ApplyServiceDeps {
  github: GitHubPort;
  artifacts: ArtifactStore;
  repository: RepositoryRef;
  /** Staleness window in hours. Undefined uses 168; null/negative disables it. */
  reportStaleAfterHours?: number | null;
  /** Interactive menu. Only consulted when opts.yes and opts.previewOnly are false. */
  confirmMenu?: (prompt: string) => Promise<MenuAnswer>;
  /** Receives rendered preview text before a patch is offered or previewed. */
  onPreview?: (text: string) => void;
  now?: () => string;
}

type Decision = "apply" | "skip-user" | "all" | "abort";

type EntryBase = {
  patchType: BacklogPatchType;
  targetIssue: number | null;
  policy: PatchPolicy;
  detail: string;
};

type Prepared =
  | { kind: "skip"; entry: ApplyEntry }
  | {
      kind: "write";
      patch: ReconciledPatch;
      entryBase: EntryBase;
      previewText: string;
      applyFresh: () => Promise<ApplyEntry>;
    };

interface ExistingIssueMatch {
  number: number;
  title: string;
  epicLinked: boolean;
}

export class ApplyService {
  private readonly now: () => string;
  private readonly confirm: (prompt: string) => Promise<MenuAnswer>;
  private readonly onPreview: (text: string) => void;

  constructor(private readonly deps: ApplyServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.confirm = deps.confirmMenu ?? ((prompt: string) => confirmMenu(prompt));
    this.onPreview = deps.onPreview ?? (() => {});
  }

  async apply(analysisId: string, opts: ApplyOptions): Promise<ApplyReport> {
    const report = await this.deps.artifacts.readJson<ReconciliationReport>(
      analysisId,
      REPORT_ARTIFACT,
    );

    const staleAgeHours =
      (Date.parse(this.now()) - Date.parse(report.generatedAt)) / (60 * 60 * 1000);
    const windowHours = this.stalenessWindowHours();
    const guardActive = windowHours !== null;
    const stale = windowHours !== null && staleAgeHours > windowHours;
    if (stale && opts.force !== true) {
      throw new Error(
        `stored report for ${analysisId} is ${Math.round(staleAgeHours)}h old ` +
          `(> ${windowHours}h); re-run reconcile or pass --force`,
      );
    }

    const entries: ApplyEntry[] = [];
    const summary = emptySummary();
    let allRemaining = false;
    let aborted = false;

    for (const patch of sortPatches(report.patches)) {
      if (patch.policy === "requires-approval" && !OFFERABLE_REQUIRES_APPROVAL.has(patch.type)) {
        recordEntry(entries, summary, skipEntry(patch, "requires-approval"));
        continue;
      }

      let prepared: Prepared;
      try {
        prepared = await this.prepare(patch);
      } catch (error) {
        recordEntry(entries, summary, failedEntry(patch, error));
        continue;
      }

      if (prepared.kind === "skip") {
        recordEntry(entries, summary, prepared.entry);
        continue;
      }

      if (opts.previewOnly === true) {
        this.onPreview(prepared.previewText);
        summary.previewed += 1;
        recordEntry(
          entries,
          summary,
          skipEntry(prepared.patch, "preview-only", `${prepared.entryBase.detail}; preview-only`),
        );
        continue;
      }

      let decision: Decision;
      if (opts.yes && prepared.patch.policy !== "auto-safe") {
        // requires-approval patches are never auto-applied under --yes;
        // an unattended run always needs a human at the prompt for these.
        recordEntry(entries, summary, skipEntry(prepared.patch, "requires-approval"));
        continue;
      } else if (opts.yes || (allRemaining && prepared.patch.policy === "auto-safe")) {
        decision = "apply";
      } else {
        this.onPreview(prepared.previewText);
        summary.previewed += 1;
        const answer = await this.confirm(this.promptLabel(prepared.patch));
        decision =
          answer === "apply"
            ? "apply"
            : answer === "skip"
              ? "skip-user"
              : answer === "all"
                ? "all"
                : "abort";
      }

      if (decision === "abort") {
        aborted = true;
        break;
      }
      if (decision === "skip-user") {
        recordEntry(entries, summary, skipEntry(prepared.patch, "user"));
        continue;
      }
      if (decision === "all") {
        allRemaining = true;
      }

      recordEntry(entries, summary, await this.write(prepared));
    }

    const result: ApplyReport = {
      repository: this.deps.repository,
      analysisId,
      appliedAt: this.now(),
      aborted,
      staleness: {
        staleAgeHours,
        guardApplied: guardActive,
        overriddenByForce: stale && opts.force === true,
      },
      entries,
      summary,
    };

    await this.deps.artifacts.writeJson(analysisId, APPLY_ARTIFACT, result);
    return result;
  }

  private stalenessWindowHours(): number | null {
    const value = this.deps.reportStaleAfterHours;
    if (value === undefined) return DEFAULT_STALE_HOURS;
    if (value === null || value < 0) return null;
    return value;
  }

  private promptLabel(patch: ReconciledPatch): string {
    const target = "issue" in patch && patch.issue !== null ? ` #${patch.issue}` : "";
    return `apply ${patch.type}${target}? [y] apply / [n] skip / [a] all / [q] abort `;
  }

  private async prepare(patch: ReconciledPatch): Promise<Prepared> {
    switch (patch.type) {
      case "CREATE_ISSUE":
        return this.prepareCreate(patch);
      case "ENRICH_ISSUE":
        return this.prepareEnrich(patch);
      case "ADD_DEPENDENCY":
        return this.prepareDependency(patch);
      case "REMOVE_DEPENDENCY":
        return this.prepareRemoveDependency(patch);
      case "KEEP":
      case "MARK_STALE":
      case "NEEDS_HUMAN":
        return { kind: "skip", entry: skipEntry(patch, "requires-approval") };
    }
  }

  private async prepareCreate(
    patch: Extract<ReconciledPatch, { type: "CREATE_ISSUE" }>,
  ): Promise<Prepared> {
    const existing = await this.findExistingIssueWithTitle(patch.epic, patch.spec.title);
    if (existing !== null) {
      if (patch.epic === null || existing.epicLinked) {
        return {
          kind: "skip",
          entry: skipEntry(patch, "idempotent", `already exists as #${existing.number}`),
        };
      }
      return {
        kind: "write",
        patch,
        entryBase: entryBase(
          patch,
          `link existing #${existing.number} "${existing.title}" to epic #${patch.epic}`,
        ),
        previewText: renderLinkExistingPreview(existing, patch.epic),
        applyFresh: () => this.applyCreateFresh(patch),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `create issue "${patch.spec.title}"`),
      previewText: renderCreatePreview(patch),
      applyFresh: () => this.applyCreateFresh(patch),
    };
  }

  private async prepareEnrich(
    patch: Extract<ReconciledPatch, { type: "ENRICH_ISSUE" }>,
  ): Promise<Prepared> {
    const current = await this.getIssueOrSkipped(patch);
    if (isApplyEntry(current)) return { kind: "skip", entry: current };

    const proposed = this.upsertOrSkip(current.body, patch);
    if (isApplyEntry(proposed)) return { kind: "skip", entry: proposed };
    if (proposed === current.body) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", "already reflects the proposed enrichment"),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `enrich issue #${patch.issue}`),
      previewText: renderEnrichPreview(current.body, proposed),
      applyFresh: () => this.applyEnrichFresh(patch),
    };
  }

  private async prepareDependency(
    patch: Extract<ReconciledPatch, { type: "ADD_DEPENDENCY" }>,
  ): Promise<Prepared> {
    const current = await this.getIssueOrSkipped(patch);
    if (isApplyEntry(current)) return { kind: "skip", entry: current };

    if (bodyAlreadyDependsOn(current.body, patch.dependsOn)) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", `already depends on #${patch.dependsOn}`),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `add dependency #${patch.dependsOn} to #${patch.issue}`),
      previewText: renderDependencyPreview(current.body, patch.dependsOn),
      applyFresh: () => this.applyDependencyFresh(patch),
    };
  }

  private async prepareRemoveDependency(
    patch: Extract<ReconciledPatch, { type: "REMOVE_DEPENDENCY" }>,
  ): Promise<Prepared> {
    const current = await this.getIssueOrSkipped(patch);
    if (isApplyEntry(current)) return { kind: "skip", entry: current };

    if (!bodyAlreadyDependsOn(current.body, patch.dependsOn)) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", `dependency #${patch.dependsOn} is not recorded; nothing to remove`),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `remove dependency #${patch.dependsOn} from #${patch.issue}`),
      previewText: renderRemoveDependencyPreview(current.body, patch.dependsOn),
      applyFresh: () => this.applyRemoveDependencyFresh(patch),
    };
  }

  private async getIssueOrSkipped(
    patch: Extract<ReconciledPatch, { type: "ENRICH_ISSUE" | "ADD_DEPENDENCY" | "REMOVE_DEPENDENCY" }>,
  ): Promise<GitHubIssue | ApplyEntry> {
    try {
      return await this.deps.github.getIssue(patch.issue);
    } catch (error) {
      return skipEntry(
        patch,
        "failed-to-fetch",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private upsertOrSkip(
    body: string,
    patch: Extract<ReconciledPatch, { type: "ENRICH_ISSUE" }>,
  ): string | ApplyEntry {
    try {
      return upsertReconciliationSection(body, patch.patch);
    } catch (error) {
      if (error instanceof RefinementSectionError) {
        return skipEntry(
          patch,
          "idempotent",
          `body has ambiguous managed-section markers: ${error.message}`,
        );
      }
      throw error;
    }
  }

  private async write(prepared: Extract<Prepared, { kind: "write" }>): Promise<ApplyEntry> {
    try {
      return await prepared.applyFresh();
    } catch (error) {
      return {
        ...prepared.entryBase,
        outcome: {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async applyCreateFresh(
    patch: Extract<ReconciledPatch, { type: "CREATE_ISSUE" }>,
  ): Promise<ApplyEntry> {
    const existing = await this.findExistingIssueWithTitle(patch.epic, patch.spec.title);
    if (existing !== null) {
      if (patch.epic === null || existing.epicLinked) {
        return skipEntry(patch, "idempotent", `already exists as #${existing.number}`);
      }
      try {
        await this.linkIssueToEpic(patch.epic, existing);
      } catch (error) {
        return failedEntry(
          patch,
          error,
          `found existing #${existing.number} "${existing.title}" but failed to link it to epic #${patch.epic}`,
          existing.number,
        );
      }
      return {
        ...entryBase(patch, `linked existing #${existing.number} "${existing.title}" to epic #${patch.epic}`),
        outcome: { status: "applied" },
        appliedIssueNumber: existing.number,
      };
    }

    const created = await this.deps.github.createIssue({
      title: patch.spec.title,
      body: renderReconciliationSection(patch.spec.enrichment),
      labels: ["task"],
    });

    try {
      if (patch.epic !== null) await this.linkIssueToEpic(patch.epic, created);
    } catch (error) {
      return failedEntry(
        patch,
        error,
        `created #${created.number} "${created.title}" but failed to link it to epic #${patch.epic}`,
        created.number,
      );
    }

    return {
      ...entryBase(patch, `created #${created.number} "${created.title}"`),
      outcome: { status: "applied" },
      appliedIssueNumber: created.number,
    };
  }

  private async applyEnrichFresh(
    patch: Extract<ReconciledPatch, { type: "ENRICH_ISSUE" }>,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.issue);
    const proposed = this.upsertOrSkip(current.body, patch);
    if (isApplyEntry(proposed)) return proposed;
    if (proposed === current.body) {
      return skipEntry(patch, "idempotent", "already reflects the proposed enrichment");
    }
    await this.deps.github.updateIssueBody(patch.issue, proposed);
    return { ...entryBase(patch, `enriched issue #${patch.issue}`), outcome: { status: "applied" } };
  }

  private async applyDependencyFresh(
    patch: Extract<ReconciledPatch, { type: "ADD_DEPENDENCY" }>,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.issue);
    if (bodyAlreadyDependsOn(current.body, patch.dependsOn)) {
      return skipEntry(patch, "idempotent", `already depends on #${patch.dependsOn}`);
    }
    await this.deps.github.updateIssueBody(
      patch.issue,
      appendDependencyToBody(current.body, patch.dependsOn),
    );
    return {
      ...entryBase(patch, `added dependency #${patch.dependsOn} to #${patch.issue}`),
      outcome: { status: "applied" },
    };
  }

  private async applyRemoveDependencyFresh(
    patch: Extract<ReconciledPatch, { type: "REMOVE_DEPENDENCY" }>,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.issue);
    if (!bodyAlreadyDependsOn(current.body, patch.dependsOn)) {
      return skipEntry(patch, "idempotent", `dependency #${patch.dependsOn} is not recorded; nothing to remove`);
    }
    await this.deps.github.updateIssueBody(
      patch.issue,
      removeManagedDependencyFromBody(current.body, patch.dependsOn),
    );
    return {
      ...entryBase(patch, `removed dependency #${patch.dependsOn} from #${patch.issue}`),
      outcome: { status: "applied" },
    };
  }

  private async findExistingIssueWithTitle(
    epicNumber: number | null,
    title: string,
  ): Promise<ExistingIssueMatch | null> {
    const existing = await this.deps.github.findIssueByTitle(title);
    if (existing === null) return null;

    if (epicNumber !== null && existing.number === epicNumber) {
      return { number: existing.number, title: existing.title, epicLinked: true };
    }

    let epicLinked = false;
    if (epicNumber !== null) {
      const epic = await this.deps.github.getIssue(epicNumber);
      epicLinked = collectEpicIssueRefs(epic.body).issues.includes(existing.number);
    }

    return { number: existing.number, title: existing.title, epicLinked };
  }

  private async linkIssueToEpic(epicNumber: number, issue: Pick<GitHubIssue, "number" | "title">): Promise<void> {
    const epic = await this.deps.github.getIssue(epicNumber);
    if (collectEpicIssueRefs(epic.body).issues.includes(issue.number)) return;
    const separator = epic.body.endsWith("\n") || epic.body.length === 0 ? "" : "\n";
    await this.deps.github.updateIssueBody(
      epicNumber,
      `${epic.body}${separator}- [ ] #${issue.number} ${issue.title}`,
    );
  }

}

function renderLinkExistingPreview(existing: ExistingIssueMatch, epicNumber: number): string {
  return `existing issue: #${existing.number} ${existing.title}\nwill append to epic #${epicNumber} checklist`;
}

function sortPatches(patches: ReconciledPatch[]): ReconciledPatch[] {
  const rank: Partial<Record<BacklogPatchType, number>> = {
    CREATE_ISSUE: 0,
    ENRICH_ISSUE: 1,
    ADD_DEPENDENCY: 2,
    REMOVE_DEPENDENCY: 3,
  };
  return [...patches].sort((a, b) => (rank[a.type] ?? 10) - (rank[b.type] ?? 10));
}

function emptySummary(): ApplyReport["summary"] {
  return {
    applied: 0,
    skippedRequiresApproval: 0,
    skippedIdempotent: 0,
    skippedUser: 0,
    failed: 0,
    previewed: 0,
  };
}

function entryBase(patch: ReconciledPatch, detail: string = patch.reason): EntryBase {
  return {
    patchType: patch.type,
    targetIssue: "issue" in patch ? patch.issue : null,
    policy: patch.policy,
    detail,
  };
}

function skipEntry(
  patch: ReconciledPatch,
  skippedBy: "requires-approval" | "idempotent" | "user" | "failed-to-fetch" | "preview-only",
  detail = patch.reason,
): ApplyEntry {
  return {
    ...entryBase(patch, detail),
    outcome: { status: "skipped", skippedBy },
  };
}

function failedEntry(
  patch: ReconciledPatch,
  error: unknown,
  detail = patch.reason,
  appliedIssueNumber?: number,
): ApplyEntry {
  return {
    ...entryBase(patch, detail),
    outcome: { status: "failed", error: error instanceof Error ? error.message : String(error) },
    ...(appliedIssueNumber === undefined ? {} : { appliedIssueNumber }),
  };
}

function recordEntry(
  entries: ApplyEntry[],
  summary: ApplyReport["summary"],
  entry: ApplyEntry,
): void {
  entries.push(entry);
  switch (entry.outcome.status) {
    case "applied":
      summary.applied += 1;
      break;
    case "skipped":
      if (entry.outcome.skippedBy === "requires-approval") {
        summary.skippedRequiresApproval += 1;
      } else if (entry.outcome.skippedBy === "idempotent") {
        summary.skippedIdempotent += 1;
      } else if (entry.outcome.skippedBy === "user") {
        summary.skippedUser += 1;
      }
      break;
    case "failed":
      summary.failed += 1;
      break;
  }
}

function isApplyEntry(value: GitHubIssue | ApplyEntry | string): value is ApplyEntry {
  return typeof value === "object" && value !== null && "outcome" in value;
}
