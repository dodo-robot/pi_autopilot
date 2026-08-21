import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { QueueStore } from "../../../src/daemon/queue-store.js";
import type { DaemonQueue } from "../../../src/daemon/queue-store.js";

const REPO = { owner: "acme", repo: "widgets" };

function makeQueue(overrides: Partial<DaemonQueue> = {}): DaemonQueue {
  return {
    repository: REPO,
    issues: [28, 29, 30],
    currentIndex: 0,
    startedAt: "2026-08-21T10:00:00.000Z",
    completedRuns: [],
    ...overrides,
  };
}

describe("QueueStore", () => {
  let tmpDir: string;
  let queuePath: string;
  let daemonDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "queue-test-"));
    daemonDir = path.join(tmpDir, "daemon");
    queuePath = path.join(daemonDir, "queue.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("write() creates daemonDir and persists queue", () => {
    const qs = new QueueStore({ queuePath, daemonDir });
    qs.write(makeQueue());
    const result = qs.read();
    expect(result).not.toBeNull();
    expect(result?.issues).toEqual([28, 29, 30]);
    expect(result?.currentIndex).toBe(0);
  });

  it("write() is atomic (no .tmp file left behind)", () => {
    const qs = new QueueStore({ queuePath, daemonDir });
    qs.write(makeQueue());
    expect(existsSync(`${queuePath}.tmp`)).toBe(false);
  });

  it("read() returns null when file does not exist", () => {
    const qs = new QueueStore({ queuePath, daemonDir });
    expect(qs.read()).toBeNull();
  });

  it("exists() returns false before write and true after", () => {
    const qs = new QueueStore({ queuePath, daemonDir });
    expect(qs.exists()).toBe(false);
    qs.write(makeQueue());
    expect(qs.exists()).toBe(true);
  });

  it("write() round-trips completedRuns", () => {
    const qs = new QueueStore({ queuePath, daemonDir });
    const q = makeQueue({
      currentIndex: 1,
      completedRuns: [
        { issueNumber: 28, outcome: "PR_OPEN", completedAt: "2026-08-21T11:00:00.000Z", runId: "run-abc" },
      ],
    });
    qs.write(q);
    const result = qs.read();
    expect(result?.completedRuns).toHaveLength(1);
    expect(result?.completedRuns[0]?.outcome).toBe("PR_OPEN");
    expect(result?.currentIndex).toBe(1);
  });

  it("read() throws on corrupted JSON", () => {
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(queuePath, "not-json");
    const qs = new QueueStore({ queuePath, daemonDir });
    expect(() => qs.read()).toThrow();
  });
});
