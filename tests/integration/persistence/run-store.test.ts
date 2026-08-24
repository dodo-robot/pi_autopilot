import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryRef } from "../../../src/domain/contracts.js";
import { RunStore } from "../../../src/persistence/run-store.js";

const repo: RepositoryRef = { owner: "acme", repo: "widgets" };

describe("RunStore", () => {
  let dir: string;
  let dbPath: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "autopilot-store-"));
    dbPath = path.join(dir, "autopilot.db");
    store = new RunStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a run in PREFLIGHT and reads it back", () => {
    const run = store.createRun({ repository: repo, issueNumber: 42 });
    expect(run).toMatchObject({
      repository: repo,
      issueNumber: 42,
      stage: "PREFLIGHT",
      taskSnapshotRef: null,
    });
    expect(store.getRun(run.id)).toEqual(run);
  });

  it("transitions a run with compare-and-set and records the event", () => {
    const run = store.createRun({ repository: repo, issueNumber: 42 });
    const t = store.transition(
      run.id,
      "PREFLIGHT",
      "READINESS_CHECK",
      "runs/x/task-snapshot.json",
    );
    expect(t.to).toBe("READINESS_CHECK");
    expect(t.evidenceRef).toBe("runs/x/task-snapshot.json");
    expect(store.getRun(run.id)?.stage).toBe("READINESS_CHECK");
    expect(store.transitions(run.id).map((entry) => entry.to)).toEqual([
      "READINESS_CHECK",
    ]);
  });

  it("rejects a stale compare-and-set transition", () => {
    const run = store.createRun({ repository: repo, issueNumber: 42 });
    store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
    expect(() => store.transition(run.id, "PREFLIGHT", "FAILED", null)).toThrow(
      /stale stage/,
    );
  });

  it("allows only one active run per issue", () => {
    const first = store.createRun({ repository: repo, issueNumber: 42 });
    expect(() =>
      store.createRun({ repository: repo, issueNumber: 42 }),
    ).toThrow(/active run already exists/);
    store.transition(first.id, "PREFLIGHT", "PR_OPEN", null);
    const second = store.createRun({ repository: repo, issueNumber: 42 });
    expect(second.id).not.toBe(first.id);
  });

  it("keeps a blocked run holding the issue slot until abandoned", () => {
    const run = store.createRun({ repository: repo, issueNumber: 7 });
    store.transition(run.id, "PREFLIGHT", "BLOCKED", null);
    expect(() =>
      store.createRun({ repository: repo, issueNumber: 7 }),
    ).toThrow(/active run already exists/);
  });

  it("persists across restart", () => {
    const run = store.createRun({ repository: repo, issueNumber: 42 });
    store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
    store.close();
    store = new RunStore(dbPath);
    const reloaded = store.getRun(run.id);
    expect(reloaded?.stage).toBe("READINESS_CHECK");
  });

  it("lists only nonterminal runs and finds active runs by issue", () => {
    const a = store.createRun({ repository: repo, issueNumber: 1 });
    const b = store.createRun({
      repository: { owner: "acme", repo: "other" },
      issueNumber: 2,
    });
    store.transition(a.id, "PREFLIGHT", "PR_OPEN", null);
    expect(store.listNonterminalRuns().map((r) => r.id)).toEqual([b.id]);
    expect(store.getActiveRunForIssue("acme", "widgets", 1)).toBeNull();
    expect(store.getActiveRunForIssue("acme", "other", 2)?.id).toBe(b.id);
  });

  it("reports whether an issue has a successful PR_OPEN run", () => {
    const run = store.createRun({ repository: { owner: "acme", repo: "widgets" }, issueNumber: 42 });
    store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
    store.transition(run.id, "READINESS_CHECK", "WORKSPACE_CREATION", null);
    store.transition(run.id, "WORKSPACE_CREATION", "IMPLEMENTATION", null);
    store.transition(run.id, "IMPLEMENTATION", "VERIFICATION", null);
    store.transition(run.id, "VERIFICATION", "INDEPENDENT_REVIEW", null);
    store.transition(run.id, "INDEPENDENT_REVIEW", "PUBLICATION", null);
    store.transition(run.id, "PUBLICATION", "PR_OPEN", null);

    expect(store.hasSuccessfulPrOpenForIssue("acme", "widgets", 42)).toBe(true);
    expect(store.hasSuccessfulPrOpenForIssue("acme", "widgets", 43)).toBe(false);
  });

  it("records attempts with unique attempt numbers per run", () => {
    const run = store.createRun({ repository: repo, issueNumber: 42 });
    const attempt = store.recordAttempt({
      runId: run.id,
      role: "implementer",
      attemptNumber: 1,
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });
    expect(attempt).toMatchObject({
      runId: run.id,
      role: "implementer",
      attemptNumber: 1,
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });
    expect(() =>
      store.recordAttempt({
        runId: run.id,
        role: "reviewer",
        attemptNumber: 1,
        model: "openai/gpt-5.2",
        thinking: "high",
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("persists resume_at for a FAILED transition", () => {
    const run = store.createRun({ repository: repo, issueNumber: 1 });
    store.transition(run.id, "PREFLIGHT", "INDEPENDENT_REVIEW", null);
    store.transition(run.id, "INDEPENDENT_REVIEW", "FAILED", null, {
      resumeAt: "INDEPENDENT_REVIEW",
    });
    const reloaded = store.getRun(run.id)!;
    expect(reloaded.resumeAt).toBe("INDEPENDENT_REVIEW");
  });

  it("leaves resume_at null when a run is created without a resumeAt", () => {
    const run = store.createRun({ repository: repo, issueNumber: 2 });
    store.close();
    store = new RunStore(dbPath);
    const reloaded = store.getRun(run.id)!;
    expect(reloaded.resumeAt).toBeNull();
  });

  it("leaves resume_at null across a non-FAILED transition without opts", () => {
    const run = store.createRun({ repository: repo, issueNumber: 3 });
    store.transition(run.id, "PREFLIGHT", "READINESS_CHECK", null);
    store.close();
    store = new RunStore(dbPath);
    const reloaded = store.getRun(run.id)!;
    expect(reloaded.resumeAt).toBeNull();
  });

  it("records the frozen task snapshot reference", () => {
    const run = store.createRun({ repository: repo, issueNumber: 42 });
    const updated = store.setTaskSnapshotRef(
      run.id,
      "runs/abc/task-snapshot.json",
    );
    expect(updated.taskSnapshotRef).toBe("runs/abc/task-snapshot.json");
    expect(store.getRun(run.id)?.taskSnapshotRef).toBe(
      "runs/abc/task-snapshot.json",
    );
  });

  it("returns the most recent run for an issue regardless of stage", () => {
    const first = store.createRun({ repository: repo, issueNumber: 42 });
    store.transition(first.id, "PREFLIGHT", "FAILED", null);
    const second = store.createRun({ repository: repo, issueNumber: 42 });
    expect(
      store.getMostRecentRunForIssue("acme", "widgets", 42)?.id,
    ).toBe(second.id);
  });

  it("returns null when no run exists for an issue", () => {
    expect(store.getMostRecentRunForIssue("acme", "widgets", 999)).toBeNull();
  });

  it("drops a run and its child records in a transaction", () => {
    const run = store.createRun({ repository: repo, issueNumber: 1 });
    store.transition(run.id, "PREFLIGHT", "FAILED", null);
    store.recordAttempt({
      runId: run.id,
      role: "implementer",
      attemptNumber: 1,
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });

    store.dropRun(run.id);

    expect(store.getRun(run.id)).toBeNull();
    expect(store.listAttempts(run.id)).toEqual([]);
    expect(store.transitions(run.id)).toEqual([]);
    expect(
      store.getMostRecentRunForIssue("acme", "widgets", 1),
    ).toBeNull();
  });

  it("dropRun is a no-op for an unknown run id", () => {
    expect(() => store.dropRun("does-not-exist")).not.toThrow();
  });

  it("lists runs newest first with a limit and issue filter", () => {
    const a = store.createRun({ repository: repo, issueNumber: 42 });
    store.transition(a.id, "PREFLIGHT", "READINESS_CHECK", null);
    store.transition(a.id, "READINESS_CHECK", "FAILED", null, {
      resumeAt: "READINESS_CHECK",
    });
    const b = store.createRun({ repository: repo, issueNumber: 43 });
    const c = store.createRun({ repository: { owner: "acme", repo: "other" }, issueNumber: 7 });

    // Newest (by updated_at) first — c and b were created after a, so they sort first.
    const all = store.listRuns();
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);

    expect(store.listRuns({ limit: 2 }).map((r) => r.id)).toEqual([c.id, b.id]);
    expect(store.listRuns({ issue: { owner: "acme", repo: "widgets", issueNumber: 42 } }).map((r) => r.id)).toEqual([a.id]);
  });

  it("migrates a pre-existing database by adding the resume_at column", () => {
    // A DB created before the resume_at column existed has runs WITHOUT the
    // column. Opening it through RunStore must ALTER TABLE to add resume_at
    // (idempotent) so reads don't blow up parsing an undefined stage.
    const legacyPath = path.join(dir, "legacy.db");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        stage TEXT NOT NULL,
        task_snapshot_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO runs (id, owner, repo, issue_number, stage, created_at, updated_at)
      VALUES ('legacy-1', 'acme', 'widgets', 42, 'FAILED', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
    `);
    raw.close();

    // Reopen through RunStore: migrate must add the column, not just CREATE IF NOT EXISTS.
    const legacyStore = new RunStore(legacyPath);
    const col = legacyStore.listRuns();
    const run = col.find((r) => r.id === "legacy-1");
    expect(run).toMatchObject({ id: "legacy-1", stage: "FAILED", resumeAt: null });
    legacyStore.close();
  });
});
