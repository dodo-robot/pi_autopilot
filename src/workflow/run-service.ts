import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_PI_MODEL,
  loadRepositoryConfig,
  resolveRoleModel,
} from "../config/load-config.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type {
  AutopilotConfig,
  RoleModelEntry,
  RoleModelOverride,
} from "../config/schema.js";
import type {
  ImplementerResult,
  ReviewerResult,
  RunStage,
  TaskSnapshot,
} from "../domain/contracts.js";
import type { GitHubPort } from "../github/github-adapter.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { resolveRepositoryContext, safeProcessEnv } from "../github/repository-context.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import type { RunRecord } from "../domain/contracts.js";
import { RunStore } from "../persistence/run-store.js";
import type { PiExecution, PiRunRequest } from "../pi/pi-runner.js";
import { PiRunError, PiRunner } from "../pi/pi-runner.js";
import { appPaths } from "../platform/paths.js";
import type { AppPaths } from "../platform/paths.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import { ProcessRunner as ProcessRunnerImpl } from "../platform/process-runner.js";
import { Publisher } from "../publication/publisher.js";
import type { PublicationResult } from "../publication/publisher.js";
import { ReadinessService, sha256 } from "../readiness/readiness-service.js";
import type { VerificationEvidence } from "../verification/verification-runner.js";
import { VerificationRunner } from "../verification/verification-runner.js";
import { BudgetTracker } from "./budgets.js";
import type { BudgetCounters } from "./budgets.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { Workspace } from "../workspace/workspace-manager.js";

export class RunServiceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunServiceError";
  }
}

/** Structural Pi runner surface consumed by the run service (satisfied by PiRunner). */
export interface RunPiRunner {
  run(request: PiRunRequest): Promise<PiExecution>;
}

/** Per-role model/thinking overrides supplied by the caller (e.g. CLI flags). */
export interface RunOverrides {
  refiner?: RoleModelOverride;
  implementer?: RoleModelOverride;
  reviewer?: RoleModelOverride;
}

export interface RunSummary {
  runId: string;
  stage: RunStage;
  repository: { owner: string; repo: string };
  issueNumber: number;
  publication: PublicationResult | null;
  reason: string | null;
}

export interface RunServiceDeps {
  /** Repository root to operate on; defaults to the current working directory. */
  cwd?: string;
  /** Optional foreground progress sink for human-visible execution updates. */
  onProgress?: (text: string) => void;
  processRunner?: ProcessRunner;
  /** Override the application data directory (tests use a temp dir). */
  dataDir?: string;
  /** Override the Pi executable used for role sessions. */
  piCommand?: string;
  piDefaultModel?: RoleModelEntry;
  /** Test seam: resolve the repository context (tests use a fixture repo). */
  createRepositoryContext?: (
    cwd: string,
    runner: ProcessRunner,
  ) => Promise<RepositoryContext>;
  /** Test seam: construct the GitHub port bound to the resolved repository. */
  createGitHub?: (
    ctx: RepositoryContext,
    runner: ProcessRunner,
  ) => Promise<GitHubPort>;
  /** Test seam: construct the Pi runner used for every role session. */
  createPi?: (runner: ProcessRunner) => RunPiRunner;
  /** Test seam: deterministic run ids. */
  idFactory?: () => string;
}

/** Resolution of one reviewer session, consumed only by `runImplementationLoop`. */
type ReviewOutcome =
  | { kind: "approved"; review: Extract<ReviewerResult, { outcome: "APPROVED" }> }
  | { kind: "changes-requested"; review: Extract<ReviewerResult, { outcome: "CHANGES_REQUESTED" }> }
  | { kind: "terminal"; summary: RunSummary };

const DEFAULT_ROLE_TIMEOUT_MS = 60 * 60_000;

function analysisId(issueNumber: number): string {
  return `run-readiness-${issueNumber}`;
}

/**
 * Orchestrates one GitHub issue end to end: readiness, an isolated
 * workspace, bounded implementation, deterministic verification, an
 * independent review with bounded corrections, and idempotent publication.
 * The orchestrator alone owns every transition, commit, push, and GitHub
 * mutation; Pi agents only ever return a structured, schema-validated
 * result for their bounded role.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps = {}) {}

  async start(issueNumber: number, overrides: RunOverrides = {}): Promise<RunSummary> {
    const runner = this.deps.processRunner ?? new ProcessRunnerImpl();
    const ctx =
      this.deps.createRepositoryContext !== undefined
        ? await this.deps.createRepositoryContext(this.deps.cwd ?? process.cwd(), runner)
        : await resolveRepositoryContext(this.deps.cwd ?? process.cwd(), runner);
    const config = await loadRepositoryConfig(ctx.root);

    const github =
      this.deps.createGitHub !== undefined
        ? await this.deps.createGitHub(ctx, runner)
        : await GitHubAdapter.create(ctx.root, runner);

    const pi: RunPiRunner =
      this.deps.createPi !== undefined
        ? this.deps.createPi(runner)
        : new PiRunner(runner, this.deps.piCommand);

    const paths: AppPaths = appPaths(this.deps.dataDir);
    const artifacts = new ArtifactStore(paths);
    const runStore = new RunStore(paths.dbPath);

    const piDefault = this.deps.piDefaultModel ?? DEFAULT_PI_MODEL;
    const refinerModel = resolveRoleModel(
      "refiner",
      overrides.refiner ?? null,
      config.agents,
      null,
      piDefault,
    );
    const implementerModel = resolveRoleModel(
      "implementer",
      overrides.implementer ?? null,
      config.agents,
      null,
      piDefault,
    );
    const reviewerModel = resolveRoleModel(
      "reviewer",
      overrides.reviewer ?? null,
      config.agents,
      null,
      piDefault,
    );

    try {
      const active = runStore.getActiveRunForIssue(
        ctx.repository.owner,
        ctx.repository.repo,
        issueNumber,
      );
      if (active !== null) {
        throw new RunServiceError(
          `an active run already exists for ${ctx.repository.owner}/${ctx.repository.repo}#${issueNumber} (run ${active.id}, stage ${active.stage})`,
        );
      }

      const runId = this.deps.idFactory?.() ?? randomUUID();
      const run = runStore.createRun({
        id: runId,
        repository: ctx.repository,
        issueNumber,
      });

      const runner2 = new RunAttempt({
        run,
        runStore,
        artifacts,
        paths,
        github,
        pi,
        processRunner: runner,
        repository: ctx,
        config,
        refinerModel,
        implementerModel,
        reviewerModel,
        ...(this.deps.onProgress === undefined ? {} : { onProgress: this.deps.onProgress }),
      });

      return await runner2.execute();
    } finally {
      runStore.close();
    }
  }

  /**
   * Administrative resume: continue a `BLOCKED` run with a fresh,
   * transcript-free correction session in its preserved workspace. Only
   * a run currently in `BLOCKED` may be resumed — this is the sole
   * quiescent stage with a legal `RESUME` exit (see `state-machine.ts`);
   * any other stage (including every terminal stage) is rejected before
   * anything else runs. The frozen task snapshot and existing worktree
   * are reused exactly as they were left; readiness and workspace
   * creation are never re-entered.
   */
  async resume(runId: string, overrides: RunOverrides = {}): Promise<RunSummary> {
    const runner = this.deps.processRunner ?? new ProcessRunnerImpl();
    const ctx =
      this.deps.createRepositoryContext !== undefined
        ? await this.deps.createRepositoryContext(this.deps.cwd ?? process.cwd(), runner)
        : await resolveRepositoryContext(this.deps.cwd ?? process.cwd(), runner);
    const config = await loadRepositoryConfig(ctx.root);

    const github =
      this.deps.createGitHub !== undefined
        ? await this.deps.createGitHub(ctx, runner)
        : await GitHubAdapter.create(ctx.root, runner);

    const pi: RunPiRunner =
      this.deps.createPi !== undefined
        ? this.deps.createPi(runner)
        : new PiRunner(runner, this.deps.piCommand);

    const paths: AppPaths = appPaths(this.deps.dataDir);
    const artifacts = new ArtifactStore(paths);
    const runStore = new RunStore(paths.dbPath);

    const piDefault = this.deps.piDefaultModel ?? DEFAULT_PI_MODEL;
    const refinerModel = resolveRoleModel(
      "refiner",
      overrides.refiner ?? null,
      config.agents,
      null,
      piDefault,
    );
    const implementerModel = resolveRoleModel(
      "implementer",
      overrides.implementer ?? null,
      config.agents,
      null,
      piDefault,
    );
    const reviewerModel = resolveRoleModel(
      "reviewer",
      overrides.reviewer ?? null,
      config.agents,
      null,
      piDefault,
    );

    try {
      const run = runStore.getRun(runId);
      if (run === null) {
        throw new RunServiceError(`no run found with id ${runId}`);
      }
      if (run.stage !== "BLOCKED") {
        throw new RunServiceError(
          `cannot resume run ${runId}: stage is ${run.stage}, not BLOCKED`,
        );
      }
      if (run.taskSnapshotRef === null) {
        throw new RunServiceError(
          `cannot resume run ${runId}: no task snapshot was ever recorded`,
        );
      }

      const snapshot = await artifacts.readJson<TaskSnapshot>(
        runId,
        run.taskSnapshotRef,
      );

      const workspaceManager = new WorkspaceManager({
        processRunner: runner,
        repository: ctx,
        policy: config.workspace,
      });
      const workspace = workspaceManager.locate({
        runId,
        issueNumber: run.issueNumber,
        title: snapshot.objective,
        baseBranch: config.workspace.baseBranch,
      });
      const status = await workspaceManager.inspect(workspace);
      if (!status.exists) {
        throw new RunServiceError(
          `cannot resume run ${runId}: workspace no longer exists at ${workspace.path}`,
        );
      }

      const existingAttempts = runStore.listAttempts(runId);
      const initialCounters: BudgetCounters = {
        implementationAttempts: existingAttempts.filter((a) => a.role === "implementer").length,
        correctionCycles: existingAttempts.filter((a) => a.role === "reviewer").length,
      };
      const initialAttemptSequence = existingAttempts.length;

      const attempt = new RunAttempt({
        run,
        runStore,
        artifacts,
        paths,
        github,
        pi,
        processRunner: runner,
        repository: ctx,
        config,
        refinerModel,
        implementerModel,
        reviewerModel,
        initialCounters,
        initialAttemptSequence,
      });

      return await attempt.executeResume(snapshot, workspace);
    } finally {
      runStore.close();
    }
  }
}

interface RunAttemptDeps {
  run: RunRecord;
  runStore: RunStore;
  artifacts: ArtifactStore;
  paths: AppPaths;
  github: GitHubPort;
  pi: RunPiRunner;
  processRunner: ProcessRunner;
  repository: RepositoryContext;
  config: AutopilotConfig;
  refinerModel: ResolvedRoleModel;
  implementerModel: ResolvedRoleModel;
  reviewerModel: ResolvedRoleModel;
  onProgress?: (text: string) => void;
  /**
   * Preloaded budget counters for a resumed run (attempts/cycles already
   * consumed before the interruption). Defaults to zero for a fresh run
   * started by `start()`.
   */
  initialCounters?: BudgetCounters;
  /**
   * The next attempt sequence number to assign (one past the highest
   * persisted attempt). Defaults to 0 for a fresh run.
   */
  initialAttemptSequence?: number;
}

/** One run's execution, from readiness through publication. */
class RunAttempt {
  private stage: RunStage;
  private readonly runId: string;
  private attemptSequence: number;
  /**
   * Single mutable counters object shared with `BudgetTracker`, which
   * reads `this.counters` by reference on every `recordFailure` call.
   * Constructing a fresh `BudgetTracker` per check (or snapshotting this
   * object into one) would silently freeze the budget at its initial
   * (zero) state, since `BudgetTracker` never re-reads its constructor
   * argument's fields — it must be the same object instance that this
   * class mutates in place as attempts and correction cycles accrue.
   * A resumed run seeds these from `initialCounters` (attempts/cycles
   * already consumed before the interruption) instead of starting at zero.
   */
  private readonly counters: BudgetCounters;
  private readonly budgets: BudgetTracker;

  constructor(private readonly deps: RunAttemptDeps) {
    this.stage = deps.run.stage;
    this.runId = deps.run.id;
    this.attemptSequence = deps.initialAttemptSequence ?? 0;
    this.counters = deps.initialCounters ?? {
      implementationAttempts: 0,
      correctionCycles: 0,
    };
    this.budgets = new BudgetTracker(this.counters, deps.config.budgets);
  }

  private transition(to: RunStage, evidenceRef: string | null): void {
    this.deps.runStore.transition(this.runId, this.stage, to, evidenceRef);
    this.stage = to;
  }

  private summary(
    overrides: Partial<Pick<RunSummary, "publication" | "reason">> = {},
  ): RunSummary {
    return {
      runId: this.runId,
      stage: this.stage,
      repository: this.deps.repository.repository,
      issueNumber: this.deps.run.issueNumber,
      publication: overrides.publication ?? null,
      reason: overrides.reason ?? null,
    };
  }

  async execute(): Promise<RunSummary> {
    return await this.runFailClosed(() => this.run());
  }

  /**
   * Administrative resume: launch one fresh correction attempt in the
   * preserved workspace for a run that was `BLOCKED`. Never re-enters
   * readiness or workspace creation — the frozen task snapshot and the
   * existing worktree are reused exactly as they were left. Wraps the
   * same fail-closed error handling as `execute()`.
   */
  async executeResume(
    snapshot: TaskSnapshot,
    workspace: Workspace,
  ): Promise<RunSummary> {
    return await this.runFailClosed(() => {
      const workspaceManager = new WorkspaceManager({
        processRunner: this.deps.processRunner,
        repository: this.deps.repository,
        policy: this.deps.config.workspace,
      });
      const verificationRunner = new VerificationRunner({
        processRunner: this.deps.processRunner,
        artifacts: this.deps.artifacts,
        workspaceManager,
      });

      this.transition("IMPLEMENTATION", null);

      return this.runImplementationLoop(
        snapshot,
        workspace,
        workspaceManager,
        verificationRunner,
        buildResumeCorrectionPrompt(snapshot),
      );
    });
  }

  /**
   * Fail closed for ANY thrown error, not just a malformed/abnormal role
   * session (PiRunError): a GitHubError, WorkspaceError,
   * VerificationRunnerError, PublicationError, RunStoreError, or a bare
   * git/fs error from any dependency can surface here too. Leaving the
   * run parked at a non-terminal stage would make it permanently "active"
   * (see `RunStore.getActiveRunForIssue`), blocking any retry for this
   * issue forever and putting it out of reach of admin resume (which only
   * acts on BLOCKED runs). Persist FAILED from whatever stage the run was
   * in, then rethrow so the caller still observes the original error.
   * Shared by `execute()` and `executeResume()`, the only two entry
   * points that can leave a run running.
   */
  private async runFailClosed(
    body: () => Promise<RunSummary>,
  ): Promise<RunSummary> {
    try {
      return await body();
    } catch (error) {
      this.transition("FAILED", null);
      if (error instanceof PiRunError) {
        return this.summary({ reason: error.message });
      }
      throw error;
    }
  }

  private async run(): Promise<RunSummary> {
    this.transition("READINESS_CHECK", null);

    const readiness = new ReadinessService({
      repository: this.deps.repository,
      config: this.deps.config,
      github: this.deps.github,
      pi: this.deps.pi,
      artifacts: this.deps.artifacts,
      paths: this.deps.paths,
      refinerModel: this.deps.refinerModel,
      analysisId: () => analysisId(this.deps.run.issueNumber),
    });

    const report = await readiness.check(this.deps.run.issueNumber);
    if (report.status !== "READY" || report.snapshot === null) {
      const ref = await this.deps.artifacts.writeJson(
        this.runId,
        "readiness-report.json",
        report,
      );
      this.transition("NEEDS_REFINEMENT", ref.relative);
      return this.summary({ reason: "readiness gate did not pass" });
    }

    const snapshot = report.snapshot;
    const snapshotRef = await this.deps.artifacts.writeJson(
      this.runId,
      "task-snapshot.json",
      snapshot,
    );
    this.deps.runStore.setTaskSnapshotRef(this.runId, snapshotRef.relative);
    this.transition("WORKSPACE_CREATION", snapshotRef.relative);

    const workspaceManager = new WorkspaceManager({
      processRunner: this.deps.processRunner,
      repository: this.deps.repository,
      policy: this.deps.config.workspace,
    });

    const workspace = await workspaceManager.create({
      runId: this.runId,
      issueNumber: this.deps.run.issueNumber,
      title: snapshot.objective,
      baseBranch: this.deps.config.workspace.baseBranch,
    });

    const verificationRunner = new VerificationRunner({
      processRunner: this.deps.processRunner,
      artifacts: this.deps.artifacts,
      workspaceManager,
    });

    const setup = await verificationRunner.runSetup(workspace, this.runId, {
      commands: this.deps.config.commands.setup,
      timeoutMs: DEFAULT_ROLE_TIMEOUT_MS,
    });
    if (!setup.passed) {
      const ref = await this.deps.artifacts.writeJson(
        this.runId,
        "setup-result.json",
        setup,
      );
      this.transition("BLOCKED", ref.relative);
      return this.summary({ reason: "setup commands failed" });
    }

    this.transition("IMPLEMENTATION", null);

    return await this.runImplementationLoop(snapshot, workspace, workspaceManager, verificationRunner);
  }

  /**
   * Drives implementation -> verification -> review, looping back into a
   * fresh correction session on a failed verification or a
   * CHANGES_REQUESTED review, until the run is approved, blocked, or
   * otherwise reaches a terminal stage. A single loop (rather than nested
   * recursive loops) keeps the two independent budgets (implementation
   * attempts, review correction cycles) and the BLOCKED-quiescence rule
   * easy to verify: every path that consumes either budget runs through
   * the same budget check before looping.
   */
  private async runImplementationLoop(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    workspaceManager: WorkspaceManager,
    verificationRunner: VerificationRunner,
    initialPrompt?: string,
  ): Promise<RunSummary> {
    let prompt = initialPrompt ?? buildImplementerPrompt(snapshot);

    for (;;) {
      const implementerResult = await this.launchImplementer(snapshot, workspace, prompt);
      const implementerOutcome = await this.handleImplementerResult(implementerResult);
      if (implementerOutcome !== null) return implementerOutcome;

      const verification = await this.runVerification(workspace, verificationRunner);
      if (!verification.passed) {
        const blocked = await this.handleVerificationFailure(verification);
        if (blocked !== null) return blocked;
        prompt = buildVerificationCorrectionPrompt(snapshot, verification);
        continue;
      }

      const reviewOutcome = await this.runReview(snapshot, workspace, verification);
      if (reviewOutcome.kind === "terminal") return reviewOutcome.summary;
      if (reviewOutcome.kind === "approved") {
        return await this.publishRun(
          snapshot,
          workspace,
          workspaceManager,
          verification,
          reviewOutcome.review,
          implementerResult,
        );
      }
      // CHANGES_REQUESTED with budget remaining: loop back for one more
      // correction attempt, transitioning back through IMPLEMENTATION.
      this.transition("IMPLEMENTATION", null);
      prompt = buildReviewCorrectionPrompt(snapshot, reviewOutcome.review);
    }
  }

  /**
   * Launch a bounded implementer session. On the first attempt the run is
   * already in IMPLEMENTATION (set by `execute`); every subsequent attempt
   * (a correction) transitions CORRECTION -> IMPLEMENTATION first, so each
   * correction cycle is visible in the persisted transition history.
   */
  private async launchImplementer(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    prompt: string,
  ): Promise<ImplementerResult> {
    this.counters.implementationAttempts += 1;
    const attemptDir = path.join(
      this.deps.paths.runDir(this.runId),
      `implementer-${String(this.counters.implementationAttempts)}`,
    );
    // A PiRunError here means the session exited abnormally or submitted a
    // result that failed schema validation: an orchestrator-level failure,
    // not a role outcome. It propagates to execute()'s top-level catch,
    // which persists it as FAILED.
    const execution = await this.deps.pi.run({
      role: "implementer",
      model: this.deps.implementerModel,
      prompt,
      worktree: workspace.path,
      allowedCommands: this.deps.config.agentPolicy.allowedCommands,
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(attemptDir, "session"),
      diagnosticsDir: path.join(attemptDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.deps.config.budgets.implementation.timeoutMinutes * 60_000,
    });
    this.emitImplementerProgress(execution.sessionDir);
    this.attemptSequence += 1;
    this.deps.runStore.recordAttempt({
      runId: this.runId,
      role: "implementer",
      attemptNumber: this.attemptSequence,
      model: this.deps.implementerModel.model,
      thinking: this.deps.implementerModel.thinking,
    });
    return execution.result as ImplementerResult;
  }

  private emitImplementerProgress(sessionDir: string): void {
    const sink = this.deps.onProgress;
    if (sink === undefined) return;
    sink(`Implementer session: ${sessionDir}`);
    try {
      const entries = require("node:fs").readdirSync(sessionDir).sort();
      const jsonl = entries.find((name: string) => name.endsWith(".jsonl"));
      if (jsonl === undefined) return;
      const raw = require("node:fs").readFileSync(path.join(sessionDir, jsonl), "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const entry = JSON.parse(line) as any;
        const content = entry?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type === "text" && typeof part.text === "string") {
            const firstLine = part.text.trim().split("\n")[0];
            if (firstLine.length > 0) sink(`[implementer] ${firstLine}`);
          }
          if (part?.type === "toolCall") {
            const toolName = part.name;
            const toolPath = part.arguments?.path;
            sink(
              `[implementer] tool: ${String(toolName)}${typeof toolPath === "string" ? ` ${toolPath}` : ""}`,
            );
          }
        }
      }
    } catch {
      // Best-effort visibility only; never fail the run for progress rendering.
    }
  }

  /** Returns a terminal RunSummary if the implementer result ends the run, else null. */
  private async handleImplementerResult(
    result: ImplementerResult,
  ): Promise<RunSummary | null> {
    if (result.outcome === "COMPLETED") {
      this.transition("VERIFICATION", null);
      return null;
    }
    const ref = await this.deps.artifacts.writeJson(
      this.runId,
      `implementer-result-${String(this.counters.implementationAttempts)}.json`,
      result,
    );
    if (result.outcome === "BLOCKED") {
      this.transition("BLOCKED", ref.relative);
      return this.summary({ reason: result.reason });
    }
    if (result.outcome === "NEEDS_REFINEMENT") {
      this.transition("NEEDS_REFINEMENT", ref.relative);
      return this.summary({ reason: result.reason });
    }
    if (result.outcome === "NEEDS_REPLAN") {
      // Ruling (M1, deliberate): NEEDS_REPLAN maps to BLOCKED, not to any
      // form of automatic retry or re-planning. M1 has no dynamic
      // replanning capability (deferred to M5 per spec Section 16); when
      // an implementer signals that the frozen task snapshot cannot be
      // satisfied as written, it must stop explicitly rather than guess.
      // BLOCKED is the correct M1 terminal here because it is quiescent
      // and requires human intervention (admin RESUME) to continue --
      // re-planning the task is a human action, out of scope for this
      // milestone's automatic orchestration.
      this.transition("BLOCKED", ref.relative);
      return this.summary({ reason: result.reason });
    }
    // FAILED
    this.transition("FAILED", ref.relative);
    return this.summary({ reason: result.reason });
  }

  private async runVerification(
    workspace: Workspace,
    verificationRunner: VerificationRunner,
  ): Promise<VerificationEvidence> {
    return await verificationRunner.runVerification(workspace, this.runId, {
      commands: this.deps.config.commands.verify,
      timeoutMs: this.deps.config.budgets.review.timeoutMinutes * 60_000,
    });
  }

  /** Returns a terminal RunSummary if the budget is exhausted, else null (continue with a correction). */
  private async handleVerificationFailure(
    verification: VerificationEvidence,
  ): Promise<RunSummary | null> {
    const ref = await this.deps.artifacts.writeJson(
      this.runId,
      `verification-${String(this.counters.implementationAttempts)}.json`,
      verification,
    );

    const findings = verification.commands
      .filter((c) => c.timedOut || c.exitCode !== 0)
      .map((c) => `${c.command}: exit ${String(c.exitCode)}${c.timedOut ? " (timed out)" : ""}`);
    const decision = this.budgets.recordFailure({
      stage: "VERIFICATION",
      command: verification.commands.map((c) => c.command).join(" && "),
      exitCode: verification.commands.find((c) => c.exitCode !== 0)?.exitCode ?? 1,
      findings,
    });

    if (decision.decision === "CONTINUE") {
      this.transition("IMPLEMENTATION", ref.relative);
      return null;
    }

    this.transition("BLOCKED", ref.relative);
    return this.summary({ reason: decision.reason });
  }

  /**
   * Launch exactly one fresh, transcript-free reviewer session and resolve
   * it to one of: an approval, a terminal outcome (persisted here), or a
   * budgeted CHANGES_REQUESTED decision. Never loops itself; the caller
   * (`runImplementationLoop`) owns re-entering IMPLEMENTATION for another
   * correction attempt, keeping every correction cycle's budget check and
   * stage transition in exactly one place.
   */
  private async runReview(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    verification: VerificationEvidence,
  ): Promise<ReviewOutcome> {
    this.transition("INDEPENDENT_REVIEW", null);
    const review = await this.launchReviewer(snapshot, workspace, verification);

    if (review.outcome === "APPROVED") {
      return { kind: "approved", review };
    }

    const ref = await this.deps.artifacts.writeJson(
      this.runId,
      `review-${String(this.counters.correctionCycles)}.json`,
      review,
    );

    if (review.outcome === "PRODUCT_AMBIGUITY") {
      this.transition("NEEDS_REFINEMENT", ref.relative);
      return { kind: "terminal", summary: this.summary({ reason: review.reason }) };
    }
    if (review.outcome === "FAILED") {
      this.transition("FAILED", ref.relative);
      return { kind: "terminal", summary: this.summary({ reason: review.reason }) };
    }

    // CHANGES_REQUESTED: bounded by the review-correction budget
    // (review.maxCorrectionCycles), a counter independent of the
    // implementation-attempt budget that bounds verification-driven retries.
    const findings = review.findings.map(
      (f) => `${f.severity}:${f.criterionId}:${f.path}:${String(f.line)}:${f.requestedChange}`,
    );
    const decision = this.budgets.recordFailure({
      stage: "INDEPENDENT_REVIEW",
      command: "review",
      exitCode: 1,
      findings,
    });

    if (decision.decision !== "CONTINUE") {
      this.transition("BLOCKED", ref.relative);
      return { kind: "terminal", summary: this.summary({ reason: decision.reason }) };
    }

    this.counters.correctionCycles += 1;
    this.transition("CORRECTION", ref.relative);
    return { kind: "changes-requested", review };
  }

  private async launchReviewer(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    verification: VerificationEvidence,
  ): Promise<ReviewerResult> {
    const attemptDir = path.join(
      this.deps.paths.runDir(this.runId),
      `reviewer-${String(this.counters.correctionCycles)}`,
    );
    // See the comment in launchImplementer: a PiRunError propagates to
    // execute()'s top-level catch, which persists it as FAILED.
    const execution = await this.deps.pi.run({
      role: "reviewer",
      model: this.deps.reviewerModel,
      prompt: buildReviewerPrompt(snapshot, verification),
      worktree: workspace.path,
      allowedCommands: [],
      protectedPaths: this.deps.config.agentPolicy.protectedPaths,
      sessionDir: path.join(attemptDir, "session"),
      diagnosticsDir: path.join(attemptDir, "diagnostics"),
      env: safeProcessEnv(),
      timeoutMs: this.deps.config.budgets.review.timeoutMinutes * 60_000,
    });
    this.attemptSequence += 1;
    this.deps.runStore.recordAttempt({
      runId: this.runId,
      role: "reviewer",
      attemptNumber: this.attemptSequence,
      model: this.deps.reviewerModel.model,
      thinking: this.deps.reviewerModel.thinking,
    });
    return execution.result as ReviewerResult;
  }

  private async publishRun(
    snapshot: TaskSnapshot,
    workspace: Workspace,
    workspaceManager: WorkspaceManager,
    verification: VerificationEvidence,
    review: Extract<ReviewerResult, { outcome: "APPROVED" }>,
    implementerResult: ImplementerResult,
  ): Promise<RunSummary> {
    const issue = await this.deps.github.getIssue(this.deps.run.issueNumber);
    const materialChange =
      issue.updatedAt !== snapshot.issue.updatedAt ||
      sha256(issue.body) !== snapshot.sourceBodyHash;

    if (materialChange) {
      const ref = await this.deps.artifacts.writeJson(
        this.runId,
        "publication-blocked.json",
        { reason: "source issue changed materially before publication" },
      );
      this.transition("BLOCKED", ref.relative);
      return this.summary({
        reason: "source issue changed materially before publication",
      });
    }

    this.transition("PUBLICATION", null);

    const publisher = new Publisher({
      github: this.deps.github,
      workspaceManager,
      runStore: this.deps.runStore,
      processRunner: this.deps.processRunner,
    });

    const implementationSummary =
      implementerResult.outcome === "COMPLETED" ? implementerResult.summary : "";

    const publication = await publisher.publish({
      runId: this.runId,
      issueNumber: this.deps.run.issueNumber,
      workspace,
      taskSnapshot: snapshot,
      review,
      verification,
      implementationSummary,
      config: {
        baseBranch: this.deps.config.workspace.baseBranch,
        draftPr: this.deps.config.publication.draftPr,
      },
    });

    this.transition("PR_OPEN", null);
    return this.summary({ publication });
  }
}

function buildImplementerPrompt(snapshot: TaskSnapshot): string {
  const resultExample = {
    outcome: "COMPLETED",
    summary: "Brief description of what was implemented",
    changedPaths: ["path/to/file1.py", "path/to/file2.py"],
    commandsAttempted: ["uv run pytest"],
    unresolvedProblems: [],
    evidenceLocations: []
  };
  
  return [
    "You are the implementer for a bounded, supervised task.",
    "",
    "IMPORTANT: When you finish implementing the task, you MUST call",
    "submit_result with a JSON payload like this:",
    JSON.stringify(resultExample, null, 2),
    "",
    "All fields are required. Use outcome BLOCKED if you cannot proceed,",
    "NEEDS_REFINEMENT if requirements are unclear, or NEEDS_REPLAN if the",
    "approach is fundamentally wrong.",
    "",
    "Implement exactly the task snapshot below:",
    JSON.stringify(snapshot, null, 2),
  ].join("\n\n");
}

/**
 * Prompt for an administratively resumed run: a fresh implementer session
 * with no access to any prior transcript, told only the frozen task
 * snapshot (the run was BLOCKED, so there is no verification/review
 * evidence from the interrupted attempt to hand it — that evidence, if
 * still valid, is reconciled separately by `RecoveryService`).
 */
function buildResumeCorrectionPrompt(snapshot: TaskSnapshot): string {
  const resultExample = {
    outcome: "COMPLETED",
    summary: "Brief description",
    changedPaths: ["file1.py"],
    commandsAttempted: ["uv run pytest"],
    unresolvedProblems: [],
    evidenceLocations: []
  };
  
  return [
    "You are the implementer resuming a bounded, supervised task after an",
    "administrative pause. Continue exactly the task snapshot below using",
    "only the current worktree state. You have no access to any prior",
    "session transcript.",
    "",
    "IMPORTANT: When you finish, you MUST call submit_result with all",
    "required fields:",
    JSON.stringify(resultExample, null, 2),
    "",
    "Task snapshot:",
    JSON.stringify(snapshot, null, 2),
  ].join("\n\n");
}

function buildVerificationCorrectionPrompt(
  snapshot: TaskSnapshot,
  verification: VerificationEvidence,
): string {
  const resultExample = {
    outcome: "COMPLETED",
    summary: "Fixed verification issues",
    changedPaths: ["file1.py"],
    commandsAttempted: ["uv run pytest"],
    unresolvedProblems: [],
    evidenceLocations: []
  };
  
  return [
    "You are the implementer continuing a bounded, supervised task.",
    "The previous verification run failed. Fix the issues using only the",
    "current worktree state and the verification evidence below. You have",
    "no access to any prior session transcript.",
    "",
    "IMPORTANT: When you finish fixing the issues, you MUST call",
    "submit_result with all required fields:",
    JSON.stringify(resultExample, null, 2),
    "",
    "Task snapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "Verification evidence:",
    JSON.stringify(verification, null, 2),
  ].join("\n\n");
}

function buildReviewCorrectionPrompt(
  snapshot: TaskSnapshot,
  review: Extract<ReviewerResult, { outcome: "CHANGES_REQUESTED" }>,
): string {
  const resultExample = {
    outcome: "COMPLETED",
    summary: "Addressed reviewer feedback",
    changedPaths: ["file1.py"],
    commandsAttempted: ["uv run pytest"],
    unresolvedProblems: [],
    evidenceLocations: []
  };
  
  return [
    "You are the implementer continuing a bounded, supervised task.",
    "An independent reviewer requested changes. Address the findings below",
    "using only the current worktree state. You have no access to any prior",
    "session transcript.",
    "",
    "IMPORTANT: When you finish addressing the review, you MUST call",
    "submit_result with all required fields:",
    JSON.stringify(resultExample, null, 2),
    "",
    "Task snapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "Review findings:",
    JSON.stringify(review, null, 2),
  ].join("\n\n");
}

function buildReviewerPrompt(
  snapshot: TaskSnapshot,
  verification: VerificationEvidence,
): string {
  return [
    "You are an independent reviewer for a bounded, supervised task.",
    "You have not seen any implementer transcript or reasoning. Evaluate",
    "only the current worktree diff against the task snapshot and the",
    "deterministic verification evidence below.",
    JSON.stringify(snapshot, null, 2),
    JSON.stringify(verification, null, 2),
  ].join("\n\n");
}
