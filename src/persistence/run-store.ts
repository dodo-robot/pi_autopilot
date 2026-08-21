import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import type {
  RepositoryRef,
  Role,
  RunRecord,
  RunStage,
} from "../domain/contracts.js";
import { RoleSchema, RunStageSchema } from "../domain/contracts.js";

export class RunStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunStoreError";
  }
}

/**
 * Stages that permanently end a run and release its per-issue active slot.
 * `BLOCKED` is deliberately absent: a blocked run still owns the issue until
 * it is resumed or abandoned.
 */
export const TERMINAL_STAGES: readonly RunStage[] = [
  "PR_OPEN",
  "NEEDS_REFINEMENT",
  "FAILED",
  "CANCELLED",
];

export function isTerminalStage(stage: RunStage): boolean {
  return (TERMINAL_STAGES as readonly string[]).includes(stage);
}

const TERMINAL_STAGE_SQL = TERMINAL_STAGES.map((s) => `'${s}'`).join(", ");

export interface CreateRunInput {
  id?: string;
  repository: RepositoryRef;
  issueNumber: number;
  taskSnapshotRef?: string | null;
  resumeAt?: RunStage | null;
  createdAt?: string;
}

export interface CreateAttemptInput {
  id?: string;
  runId: string;
  role: Role;
  attemptNumber: number;
  model: string;
  thinking: ThinkingLevel;
  sessionId?: string | null;
  startedAt?: string;
}

export interface AttemptRecord {
  id: string;
  runId: string;
  role: Role;
  attemptNumber: number;
  model: string;
  thinking: ThinkingLevel;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  resultRef: string | null;
}

export interface TransitionRecord {
  id: number;
  runId: string;
  from: RunStage;
  to: RunStage;
  evidenceRef: string | null;
  createdAt: string;
}

/** Durable publication evidence for one run: commit, branch, PR, and comment identity. */
export interface PublicationRecord {
  id: number;
  runId: string;
  commitSha: string | null;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  commentMarker: string | null;
  commentId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Partial publication fields to persist; only provided fields are written. */
export interface RecordPublicationInput {
  branch?: string;
  commitSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  commentMarker?: string | null;
  commentId?: number | null;
}

interface RunRow {
  id: string;
  owner: string;
  repo: string;
  issue_number: number;
  stage: string;
  task_snapshot_ref: string | null;
  resume_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  run_id: string;
  role: string;
  attempt_number: number;
  model: string;
  thinking: string;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  result_ref: string | null;
}

interface TransitionRow {
  id: number;
  run_id: string;
  from_stage: string;
  to_stage: string;
  evidence_ref: string | null;
  created_at: string;
}

interface PublicationRow {
  id: number;
  run_id: string;
  commit_sha: string | null;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  comment_marker: string | null;
  comment_id: number | null;
  created_at: string;
  updated_at: string;
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    repository: { owner: row.owner, repo: row.repo },
    issueNumber: row.issue_number,
    stage: RunStageSchema.parse(row.stage),
    taskSnapshotRef: row.task_snapshot_ref,
    resumeAt:
      row.resume_at === null ? null : RunStageSchema.parse(row.resume_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttemptRow(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    role: RoleSchema.parse(row.role),
    attemptNumber: row.attempt_number,
    model: row.model,
    thinking: ThinkingLevelSchema.parse(row.thinking),
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    resultRef: row.result_ref,
  };
}

function mapTransitionRow(row: TransitionRow): TransitionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    from: RunStageSchema.parse(row.from_stage),
    to: RunStageSchema.parse(row.to_stage),
    evidenceRef: row.evidence_ref,
    createdAt: row.created_at,
  };
}

function mapPublicationRow(row: PublicationRow): PublicationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    commitSha: row.commit_sha,
    branch: row.branch,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    commentMarker: row.comment_marker,
    commentId: row.comment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const errcode = (error as { errcode?: unknown }).errcode;
  return (
    code === "ERR_SQLITE_ERROR" &&
    (errcode === 1555 /* SQLITE_CONSTRAINT */ ||
      /UNIQUE constraint failed/i.test(error.message))
  );
}

/**
 * Durable run state backed by SQLite. Stage transitions are
 * compare-and-set and recorded transactionally with their evidence.
 */
export class RunStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(dbPath: string, options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createRun(input: CreateRunInput): RunRecord {
    const id = input.id ?? randomUUID();
    const now = input.createdAt ?? this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO runs
             (id, owner, repo, issue_number, stage, task_snapshot_ref, resume_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.repository.owner,
          input.repository.repo,
          input.issueNumber,
          "PREFLIGHT",
          input.taskSnapshotRef ?? null,
          input.resumeAt ?? null,
          now,
          now,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RunStoreError(
          `active run already exists for ${input.repository.owner}/${input.repository.repo}#${input.issueNumber}`,
          { cause: error },
        );
      }
      throw error;
    }
    const run = this.getRun(id);
    if (run === null) throw new RunStoreError(`failed to create run ${id}`);
    return run;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  /**
   * Compare-and-set stage transition. Throws when the run is not in the
   * expected source stage; the transition row is inserted in the same
   * transaction as the stage update.
   */
  transition(
    runId: string,
    from: RunStage,
    to: RunStage,
    evidenceRef: string | null,
    opts?: { resumeAt?: RunStage },
  ): TransitionRecord {
    const fromParsed = RunStageSchema.parse(from);
    const toParsed = RunStageSchema.parse(to);
    const now = this.now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE runs SET stage = ?, updated_at = ?
           WHERE id = ? AND stage = ?`,
        )
        .run(toParsed, now, runId, fromParsed);
      if (Number(result.changes) !== 1) {
        throw new RunStoreError(
          `stale stage transition: expected ${fromParsed} but run ${runId} is not in that stage`,
        );
      }
      if (toParsed === "FAILED" && opts?.resumeAt !== undefined) {
        this.setRunResumeAt(runId, opts.resumeAt);
      }
      const inserted = this.db
        .prepare(
          `INSERT INTO transitions (run_id, from_stage, to_stage, evidence_ref, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, fromParsed, toParsed, evidenceRef, now);
      this.db.exec("COMMIT");
      return {
        id: Number(inserted.lastInsertRowid),
        runId,
        from: fromParsed,
        to: toParsed,
        evidenceRef,
        createdAt: now,
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // No active transaction to roll back.
      }
      if (error instanceof RunStoreError) throw error;
      throw new RunStoreError(`failed to transition run ${runId}`, {
        cause: error,
      });
    }
  }

  /** Record the non-terminal stage a run failed from, for later resume-at-stage. */
  setRunResumeAt(runId: string, stage: RunStage): void {
    this.db
      .prepare(
        `UPDATE runs SET resume_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(stage, this.now(), runId);
  }

  recordAttempt(input: CreateAttemptInput): AttemptRecord {
    const id = input.id ?? randomUUID();
    const role = RoleSchema.parse(input.role);
    const thinking = ThinkingLevelSchema.parse(input.thinking);
    const startedAt = input.startedAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO attempts
           (id, run_id, role, attempt_number, model, thinking, session_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        role,
        input.attemptNumber,
        input.model,
        thinking,
        input.sessionId ?? null,
        startedAt,
      );
    const attempt = this.getAttempt(id);
    if (attempt === null) throw new RunStoreError(`failed to create attempt ${id}`);
    return attempt;
  }

  setTaskSnapshotRef(runId: string, ref: string): RunRecord {
    const result = this.db
      .prepare(
        `UPDATE runs SET task_snapshot_ref = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(ref, this.now(), runId);
    if (Number(result.changes) !== 1) {
      throw new RunStoreError(`no run found with id ${runId}`);
    }
    const run = this.getRun(runId);
    if (run === null) throw new RunStoreError(`no run found with id ${runId}`);
    return run;
  }

  getActiveRunForIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE owner = ? AND repo = ? AND issue_number = ?
           AND stage NOT IN (${TERMINAL_STAGE_SQL})
         LIMIT 1`,
      )
      .get(owner, repo, issueNumber) as RunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  /**
   * The most recently updated run for an issue, regardless of its stage
   * (terminal runs included). `--fresh` uses this to locate the run record
   * (and its worktree) to drop for a clean restart.
   */
  getMostRecentRunForIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): RunRecord | null {
    // ORDER BY updated_at DESC breaks ties with rowid DESC. SQLite's rowid
    // ascends with insertion order, so when two runs for an issue share the
    // same updated_at the later-inserted one is preferred. SQLite-specific;
    // on other databases with a separate autoincrement column the second
    // key would instead reference that column.
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE owner = ? AND repo = ? AND issue_number = ?
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(owner, repo, issueNumber) as RunRow | undefined;
    return row === undefined ? null : mapRunRow(row);
  }

  /**
   * Delete a run and every row that references it (review findings,
   * verification runs, attempts, transitions, publications) in one
   * transaction. Intended for the explicit `--fresh` discard path.
   */
  dropRun(runId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM review_findings WHERE run_id = ?`).run(runId);
      this.db.prepare(`DELETE FROM verification_runs WHERE run_id = ?`).run(runId);
      this.db.prepare(`DELETE FROM attempts WHERE run_id = ?`).run(runId);
      this.db.prepare(`DELETE FROM transitions WHERE run_id = ?`).run(runId);
      this.db.prepare(`DELETE FROM publications WHERE run_id = ?`).run(runId);
      this.db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // rollback itself failed; propagate the original error
      }
      throw error;
    }
  }

  listNonterminalRuns(): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE stage NOT IN (${TERMINAL_STAGE_SQL})
         ORDER BY created_at`,
      )
      .all() as unknown as RunRow[];
    return rows.map(mapRunRow);
  }

  transitions(runId: string): TransitionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM transitions WHERE run_id = ? ORDER BY id`,
      )
      .all(runId) as unknown as TransitionRow[];
    return rows.map(mapTransitionRow);
  }

  /** Every attempt recorded for a run, in the order they were launched. */
  listAttempts(runId: string): AttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_number`,
      )
      .all(runId) as unknown as AttemptRow[];
    return rows.map(mapAttemptRow);
  }

  /**
   * Record or update the publication evidence for a run. Idempotent by
   * `run_id`: the first call must supply `branch` and inserts a new row;
   * every subsequent call merges only the fields it provides onto the
   * existing row, so callers can persist commit SHA, then PR identity,
   * then comment identity as each becomes durable, without clobbering
   * fields recorded earlier.
   */
  recordPublication(
    runId: string,
    input: RecordPublicationInput,
  ): PublicationRecord {
    const now = this.now();
    const existing = this.getPublication(runId);

    if (existing === null) {
      if (input.branch === undefined) {
        throw new RunStoreError(
          `cannot record publication for run ${runId}: branch is required on first write`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO publications
             (run_id, commit_sha, branch, pr_number, pr_url, comment_marker, comment_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.commitSha ?? null,
          input.branch,
          input.prNumber ?? null,
          input.prUrl ?? null,
          input.commentMarker ?? null,
          input.commentId ?? null,
          now,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE publications SET
             commit_sha = ?, branch = ?, pr_number = ?, pr_url = ?,
             comment_marker = ?, comment_id = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(
          input.commitSha !== undefined ? input.commitSha : existing.commitSha,
          input.branch ?? existing.branch,
          input.prNumber !== undefined ? input.prNumber : existing.prNumber,
          input.prUrl !== undefined ? input.prUrl : existing.prUrl,
          input.commentMarker !== undefined
            ? input.commentMarker
            : existing.commentMarker,
          input.commentId !== undefined ? input.commentId : existing.commentId,
          now,
          runId,
        );
    }

    const record = this.getPublication(runId);
    if (record === null) {
      throw new RunStoreError(`failed to record publication for run ${runId}`);
    }
    return record;
  }

  getPublication(runId: string): PublicationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM publications WHERE run_id = ?`)
      .get(runId) as PublicationRow | undefined;
    return row === undefined ? null : mapPublicationRow(row);
  }

  private getAttempt(id: string): AttemptRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM attempts WHERE id = ?`)
      .get(id) as AttemptRow | undefined;
    return row === undefined ? null : mapAttemptRow(row);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        stage TEXT NOT NULL,
        task_snapshot_ref TEXT,
        resume_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_unique
        ON runs(owner, repo, issue_number)
        WHERE stage NOT IN (${TERMINAL_STAGE_SQL});
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        role TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        model TEXT NOT NULL,
        thinking TEXT NOT NULL,
        session_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        outcome TEXT,
        result_ref TEXT,
        UNIQUE(run_id, attempt_number)
      );
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        from_stage TEXT NOT NULL,
        to_stage TEXT NOT NULL,
        evidence_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verification_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt_id TEXT REFERENCES attempts(id),
        tree_hash TEXT,
        passed INTEGER NOT NULL,
        policy_hash TEXT,
        created_at TEXT NOT NULL,
        evidence_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt_id TEXT REFERENCES attempts(id),
        criterion_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        evidence TEXT NOT NULL,
        requested_change TEXT NOT NULL,
        disposition TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        commit_sha TEXT,
        branch TEXT NOT NULL,
        pr_number INTEGER,
        pr_url TEXT,
        comment_marker TEXT,
        comment_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id)
      );
    `);
  }
}
