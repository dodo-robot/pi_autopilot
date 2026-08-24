import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const SHIM_PATH = fileURLToPath(
  new URL("./fake-daemon-entry.mjs", import.meta.url),
);

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "daemon-lifecycle-"));
  return dir;
}

function writeQueue(dataDir: string, issues: number[]): void {
  const daemonDir = path.join(dataDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(
    path.join(daemonDir, "queue.json"),
    JSON.stringify({
      repository: { owner: "acme", repo: "widgets" },
      issues,
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      completedRuns: [],
    }),
  );
}

function spawnFakeDaemon(
  dataDir: string,
  opts: { fakeOutcome?: string; fakeDelayMs?: number } = {},
): { pid: number; wait(): Promise<number> } {
  const child = spawn(process.execPath, [SHIM_PATH], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AUTOPILOT_DATA_DIR: dataDir,
      FAKE_OUTCOME: opts.fakeOutcome ?? "PR_OPEN",
      FAKE_DELAY_MS: String(opts.fakeDelayMs ?? 50),
    },
  });
  child.unref();
  return {
    pid: child.pid!,
    wait: () =>
      new Promise((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
        // If already exited, ref to get the event
        child.ref();
      }),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("daemon lifecycle (integration)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("works through a queue and writes completedRuns", async () => {
    writeQueue(dataDir, [28, 29]);
    const { wait } = spawnFakeDaemon(dataDir);
    const exitCode = await wait();
    expect(exitCode).toBe(0);

    const queue = JSON.parse(
      readFileSync(path.join(dataDir, "daemon", "queue.json"), "utf8"),
    );
    expect(queue.completedRuns).toHaveLength(2);
    expect(queue.completedRuns[0].outcome).toBe("PR_OPEN");
    expect(queue.completedRuns[1].outcome).toBe("PR_OPEN");
    expect(queue.currentIndex).toBe(2);
  });

  it("stops cleanly after current issue on SIGTERM", async () => {
    writeQueue(dataDir, [28, 29, 30]);
    const { pid, wait } = spawnFakeDaemon(dataDir, { fakeDelayMs: 200 });

    // Wait for daemon to start and pick up first issue
    await waitUntil(() => isProcessAlive(pid));
    // Give it a moment to start running the first issue
    await new Promise((r) => setTimeout(r, 80));

    process.kill(pid, "SIGTERM");
    const exitCode = await wait();
    expect(exitCode).toBe(0);

    const queue = JSON.parse(
      readFileSync(path.join(dataDir, "daemon", "queue.json"), "utf8"),
    );
    // Should have completed at most 1 issue (the one in-flight when SIGTERM arrived)
    expect(queue.completedRuns.length).toBeLessThan(3);
  });

  it("handles an empty queue without error", async () => {
    writeQueue(dataDir, []);
    const { wait } = spawnFakeDaemon(dataDir);
    const exitCode = await wait();
    expect(exitCode).toBe(0);

    const queue = JSON.parse(
      readFileSync(path.join(dataDir, "daemon", "queue.json"), "utf8"),
    );
    expect(queue.completedRuns).toHaveLength(0);
  });

  it("picks up an issue added via queue add while the daemon is mid-run", async () => {
    writeQueue(dataDir, [28, 29]);
    const { pid, wait } = spawnFakeDaemon(dataDir, { fakeDelayMs: 200 });

    // Wait for daemon to start and pick up first issue
    await waitUntil(() => isProcessAlive(pid));
    // Give it a moment to start running the first issue
    await new Promise((r) => setTimeout(r, 80));

    // Inject a new issue via queue-pending.json while daemon is running
    const daemonDir = path.join(dataDir, "daemon");
    const queuePendingPath = path.join(daemonDir, "queue-pending.json");
    writeFileSync(
      queuePendingPath,
      JSON.stringify({ issues: [99] }),
    );

    const exitCode = await wait();
    expect(exitCode).toBe(0);

    const queue = JSON.parse(
      readFileSync(path.join(dataDir, "daemon", "queue.json"), "utf8"),
    );
    // Should have completed all three issues: 28, 29, and the mid-run added 99
    expect(queue.completedRuns).toHaveLength(3);
    const completedIssues = queue.completedRuns.map((r) => r.issueNumber);
    expect(completedIssues).toContain(28);
    expect(completedIssues).toContain(29);
    expect(completedIssues).toContain(99);
  });
});

