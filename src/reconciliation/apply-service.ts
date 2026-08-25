import type { BacklogPatchType, PatchPolicy, ReconciledPatch } from "../domain/reconciliation.js";
import { BacklogPatchSchema } from "../domain/reconciliation.js";
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
  askQuestion,
  confirmMenu,
  renderCreatePreview,
  renderDependencyPreview,
  renderEnrichPreview,
  renderMergeDuplicatePreview,
  renderNeedsHumanPreview,
  renderRemoveDependencyPreview,
  renderSplitPreview,
  type MenuAnswer,
  type QuestionAnswer,
} from "./apply-preview.js";
import { renderReconciliationSection, upsertReconciliationSection } from "./managed-section.js";
import { splitAlreadyApplied, upsertSplitSection } from "./managed-split-section.js";
import { AGENT_READY_LABEL, SPLIT_LABEL } from "../analysis/label-reconciliation.js";
import type { ReconciliationReport } from "./reconciliation-service.js";
import { RefinementSectionError } from "../readiness/refinement-section.js";

export const REPORT_ARTIFACT = "reconciliation-report.json";
export const APPLY_ARTIFACT = "reconciliation-apply.json";

/** Leading marker of the comment `applyNeedsHumanFresh` posts with every
 * answered NEEDS_HUMAN question. Used both to build the comment and, via
 * `GitHubPort.findIssueCommentByMarker`, as the idempotency anchor that stops
 * a re-run from posting a duplicate answer comment. */
export const NEEDS_HUMAN_ANSWER_MARKER = "**Reconciliation NEEDS_HUMAN answered**";

const DEFAULT_STALE_HOURS = 168;
const TASK_LABEL = "task";
const TASK_LABEL_COLOR = "e4e669";
const SPLIT_LABEL_COLOR = "fbca04";

/**
 * requires-approval patch types still offerable through the interactive
 * confirm menu (never under --yes or a prior "all" answer). NEEDS_HUMAN is
 * also offerable but through its own per-question prompt, not this menu —
 * see the `patch.type === "NEEDS_HUMAN"` branch in apply(). Every other
 * requires-approval type (MARK_STALE) is hard-skipped before prepare() ever
 * runs.
 */
const OFFERABLE_REQUIRES_APPROVAL: ReadonlySet<BacklogPatchType> = new Set([
  "REMOVE_DEPENDENCY",
  "SPLIT_ISSUE",
  "MERGE_DUPLICATE",
  "NEEDS_HUMAN",
]);

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
  /** Interactive NEEDS_HUMAN question prompt. Only consulted when opts.yes and opts.previewOnly are false. */
  askQuestion?: (question: string, recommendation: string) => Promise<QuestionAnswer>;
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
  private readonly askQuestion: (question: string, recommendation: string) => Promise<QuestionAnswer>;
  private readonly onPreview: (text: string) => void;

  constructor(private readonly deps: ApplyServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.confirm = deps.confirmMenu ?? ((prompt: string) => confirmMenu(prompt));
    this.askQuestion = deps.askQuestion ?? ((question, recommendation) => askQuestion(question, recommendation));
    this.onPreview = deps.onPreview ?? (() => {});
  }

  async apply(analysisId: string, opts: ApplyOptions): Promise<ApplyReport> {
    const report = await this.deps.artifacts.readJson<ReconciliationReport>(
      analysisId,
      REPORT_ARTIFACT,
    );
    this.assertValidReport(report, analysisId);

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
        prepared = await this.prepare(patch, report.epicRef);
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
      } else if (prepared.patch.type === "NEEDS_HUMAN") {
        // No accept/reject decision here: every question always gets an
        // answer (typed override or accepted recommendation), so there's
        // nothing for the generic [y/n/a/q] menu to ask. The actual
        // per-question prompting happens inside applyFresh() below.
        this.onPreview(prepared.previewText);
        summary.previewed += 1;
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
    // A preview-only or aborted run records no (or only partial) durable human
    // decisions; repointing the index at it would erase the declines from the
    // last real apply, silently losing the steering signal.
    if (opts.previewOnly !== true && !aborted) {
      await this.deps.artifacts.writeLatestApply(
        report.repository.owner,
        report.repository.repo,
        report.epicRef,
        {
          analysisId,
          epicRef: report.epicRef,
          repository: report.repository,
          appliedAt: this.now(),
        },
      );
    }
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

  /**
   * Reject a stored reconciliation report that no longer matches the current
   * patch schema (e.g. a pre-recommendation report whose NEEDS_HUMAN
   * questions are plain strings). Without this, a stale-format report would
   * load via the raw `JSON.parse as T` cast and silently render "undefined"
   * fields or post corrupt writes instead of failing cleanly.
   */
  private assertValidReport(report: ReconciliationReport, analysisId: string): void {
    for (const patch of report.patches) {
      const parsed = BacklogPatchSchema.safeParse(patch);
      if (!parsed.success) {
        throw new Error(
          `stored report for ${analysisId} is incompatible with this version (patch #${patch.type}: ${parsed.error.issues[0]?.message ?? "validation failed"}); re-run reconcile to regenerate it`,
        );
      }
    }
  }

  private async prepare(patch: ReconciledPatch, epicRef: number): Promise<Prepared> {
    switch (patch.type) {
      case "CREATE_ISSUE":
        return this.prepareCreate(patch);
      case "ENRICH_ISSUE":
        return this.prepareEnrich(patch);
      case "ADD_DEPENDENCY":
        return this.prepareDependency(patch);
      case "REMOVE_DEPENDENCY":
        return this.prepareRemoveDependency(patch);
      case "SPLIT_ISSUE":
        return this.prepareSplit(patch, epicRef);
      case "MERGE_DUPLICATE":
        return this.prepareMergeDuplicate(patch);
      case "NEEDS_HUMAN":
        return this.prepareNeedsHuman(patch);
      case "KEEP":
      case "MARK_STALE":
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

  private async prepareSplit(
    patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
    epicRef: number,
  ): Promise<Prepared> {
    let current: GitHubIssue;
    try {
      current = await this.deps.github.getIssue(patch.issue);
    } catch (error) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "failed-to-fetch", error instanceof Error ? error.message : String(error)),
      };
    }

    if (splitAlreadyApplied(current.body, patch.children)) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", "already split into the proposed children"),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `split #${patch.issue} into ${patch.children.length} issues`),
      previewText: renderSplitPreview(patch),
      applyFresh: () => this.applySplitFresh(patch, epicRef),
    };
  }

  private async applySplitFresh(
    patch: Extract<ReconciledPatch, { type: "SPLIT_ISSUE" }>,
    epicRef: number,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.issue);
    if (splitAlreadyApplied(current.body, patch.children)) {
      return skipEntry(patch, "idempotent", "already split into the proposed children");
    }

    await this.deps.github.ensureLabel(TASK_LABEL, TASK_LABEL_COLOR);
    await this.deps.github.ensureLabel(SPLIT_LABEL, SPLIT_LABEL_COLOR);

    const childRefs: Array<{ number: number; title: string }> = [];
    for (const child of patch.children) {
      const existing = await this.deps.github.findIssueByTitle(child.title);
      const issue =
        existing ??
        (await this.deps.github.createIssue({
          title: child.title,
          body: renderReconciliationSection(child.enrichment),
          labels: [TASK_LABEL],
        }));
      await this.linkIssueToEpic(epicRef, issue);
      childRefs.push({ number: issue.number, title: issue.title });
    }

    await this.deps.github.updateIssueBody(
      patch.issue,
      upsertSplitSection(current.body, childRefs),
    );

    try {
      await this.deps.github.addLabel(patch.issue, SPLIT_LABEL);
      const labels = await this.deps.github.listLabels(patch.issue);
      if (labels.includes(AGENT_READY_LABEL)) {
        await this.deps.github.removeLabel(patch.issue, AGENT_READY_LABEL);
      }
    } catch {
      // best-effort: label-write failures never fail an otherwise-successful split
    }

    return {
      ...entryBase(patch, `split #${patch.issue} into ${childRefs.length} issues`),
      outcome: { status: "applied" },
      appliedIssueNumbers: childRefs.map((ref) => ref.number),
    };
  }

  private prepareNeedsHuman(
    patch: Extract<ReconciledPatch, { type: "NEEDS_HUMAN" }>,
  ): Prepared {
    // No GitHub write target: there's nowhere to post the answers, so this
    // stays a hard skip exactly like MARK_STALE/KEEP — same as before this
    // patch type became otherwise offerable.
    if (patch.issue === null) {
      return { kind: "skip", entry: skipEntry(patch, "requires-approval") };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `answer ${patch.questions.length} question(s) on #${patch.issue}`),
      previewText: renderNeedsHumanPreview(patch),
      applyFresh: () => this.applyNeedsHumanFresh(patch, patch.issue!),
    };
  }

  private async applyNeedsHumanFresh(
    patch: Extract<ReconciledPatch, { type: "NEEDS_HUMAN" }>,
    issue: number,
  ): Promise<ApplyEntry> {
    // Idempotency anchor: if a prior apply already posted the answer comment
    // for this question set, skip rather than prompt again and post a
    // duplicate (mirrors the closed-state re-check in applyMergeDuplicateFresh
    // and the marker re-check in the split/enrich paths). Re-invoking apply
    // over the same analysisId is therefore safe and resumes cleanly.
    const existing = await this.deps.github.findIssueCommentByMarker(
      issue,
      NEEDS_HUMAN_ANSWER_MARKER,
    );
    if (existing !== null) {
      return skipEntry(
        patch,
        "idempotent",
        `answer comment already posted to #${issue}`,
      );
    }

    const answers: Array<{ question: string; answer: string; accepted: boolean }> = [];
    for (const q of patch.questions) {
      const result = await this.askQuestion(q.question, q.recommendation);
      answers.push({ question: q.question, answer: result.answer, accepted: result.accepted });
    }

    const body = [
      NEEDS_HUMAN_ANSWER_MARKER,
      "",
      ...answers.flatMap((a) => [
        `Q: ${a.question}`,
        `A: ${a.answer}${a.accepted ? " (recommendation accepted)" : " (override)"}`,
        "",
      ]),
    ].join("\n").trimEnd();

    await this.deps.github.createIssueComment(issue, body);

    return {
      ...entryBase(patch, `posted ${answers.length} answer(s) to #${issue}`),
      outcome: { status: "applied" },
      appliedIssueNumber: issue,
    };
  }

  private async prepareMergeDuplicate(
    patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
  ): Promise<Prepared> {
    let current: GitHubIssue;
    try {
      current = await this.deps.github.getIssue(patch.duplicate);
    } catch (error) {
      return {
        kind: "skip",
        entry: skipEntry(patch, "failed-to-fetch", error instanceof Error ? error.message : String(error)),
      };
    }

    if (current.state === "closed") {
      return {
        kind: "skip",
        entry: skipEntry(patch, "idempotent", `already closed as a duplicate of #${patch.keep}`),
      };
    }

    return {
      kind: "write",
      patch,
      entryBase: entryBase(patch, `close #${patch.duplicate} as a duplicate of #${patch.keep}`),
      previewText: renderMergeDuplicatePreview(patch),
      applyFresh: () => this.applyMergeDuplicateFresh(patch),
    };
  }

  private async applyMergeDuplicateFresh(
    patch: Extract<ReconciledPatch, { type: "MERGE_DUPLICATE" }>,
  ): Promise<ApplyEntry> {
    const current = await this.deps.github.getIssue(patch.duplicate);
    if (current.state === "closed") {
      return skipEntry(patch, "idempotent", `already closed as a duplicate of #${patch.keep}`);
    }

    await this.deps.github.createIssueComment(patch.duplicate, `Duplicate of #${patch.keep}.`);
    await this.deps.github.closeIssue(patch.duplicate);

    return {
      ...entryBase(patch, `closed #${patch.duplicate} as a duplicate of #${patch.keep}`),
      outcome: { status: "applied" },
      appliedIssueNumber: patch.duplicate,
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

    await this.deps.github.ensureLabel(TASK_LABEL, TASK_LABEL_COLOR);

    const created = await this.deps.github.createIssue({
      title: patch.spec.title,
      body: renderReconciliationSection(patch.spec.enrichment),
      labels: [TASK_LABEL],
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
    SPLIT_ISSUE: 4,
    MERGE_DUPLICATE: 5,
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
