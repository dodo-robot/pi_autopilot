# Pi Autopilot M3 — Durable Autonomous Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a background daemon (`autopilot start` / `autopilot stop`) that works through an ordered queue of GitHub issues one at a time, auto-resumes after crashes, and reports state via the extended `autopilot status` command.

**Architecture:** `autopilot start` resolves an issue queue (explicit list or from a prior `analyze` report), writes `queue.json`, and spawns a detached `node` child process (`daemon-entry.ts`) that immediately exits. The child writes its own PID file, runs `RecoveryService` for crash reconciliation, then loops through the queue calling `RunService` for each issue. Control is via SIGTERM (`autopilot stop`) and file-polling (`autopilot status`). No IPC sockets. No concurrency (M4).

**Tech Stack:** Node.js / TypeScript, `node:child_process` (spawn/detach), `node:fs` (atomic rename), `node:os`, Vitest, Commander.js. All other infrastructure (RunService, RecoveryService, RunStore, ArtifactStore, BacklogReport) is unchanged from M1/M2.

**Spec:** `docs/superpowers/specs/2026-08-21-pi-autopilot-m3-design.md`

## Global Constraints

- TypeScript strict mode; `npm run typecheck` must pass after every task.
- `npm test` (Vitest) must stay green after every task — never break existing M1/M2 tests.
- `npm run build` must pass at the end of every task.
- All new files live under `src/daemon/` or `src/commands/`; follow the existing import style (`.js` extensions, named exports, `type` imports).
- Dependency injection pattern: every new class/function that touches the filesystem, spawns processes, or calls RunService accepts a `deps` parameter with injectable overrides — same pattern as `RunServiceDeps`, `RecoveryServiceDeps`, etc.
- Daemon data files live at `path.join(dataDir, "daemon", ...)` where `dataDir` defaults to `defaultDataDir()` from `src/platform/paths.ts` and is overridable via `AUTOPILOT_DATA_DIR` env var (exactly like the rest of the app).
- No new prod dependencies. Use only Node.js built-ins.
- Commit after every task with a conventional commit message (`feat:`, `test:`, `fix:`).

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/daemon/pid-file.ts` | **Create** | Write / read / delete PID file; staleness check via signal 0 |
| `src/daemon/queue-store.ts` | **Create** | Atomic read/write of `queue.json`; `DaemonQueue` type |
| `src/daemon/log-file.ts` | **Create** | Timestamped log line writes; 10 MB rotation |
| `src/daemon/daemon-runner.ts` | **Create** | Main loop: reconcile → pop → RunService → record; SIGTERM handling |
| `src/daemon/daemon-entry.ts` | **Create** | Child process entry point: bootstrap deps, call `DaemonRunner.run()` |
| `src/commands/start.ts` | **Create** | Queue resolution, live-daemon guard, spawn child, exit |
| `src/commands/stop.ts` | **Create** | Read PID, SIGTERM, wait-poll, report |
| `src/commands/status.ts` | **Modify** | Add daemon block (PID, uptime, current issue, queue, done) |
| `src/ui/reporter.ts` | **Modify** | Add `formatDaemonStatus()` renderer |
| `src/cli.ts` | **Modify** | Register `start` and `stop` commands |
| `src/platform/paths.ts` | **Modify** | Add `daemonDir`, `pidPath`, `queuePath`, `logPath` to `AppPaths` |
| `tests/unit/daemon/pid-file.test.ts` | **Create** | Unit tests for PidFile |
| `tests/unit/daemon/queue-store.test.ts` | **Create** | Unit tests for QueueStore |
| `tests/unit/daemon/log-file.test.ts` | **Create** | Unit tests for LogFile |
| `tests/unit/daemon/daemon-runner.test.ts` | **Create** | Unit tests for DaemonRunner loop logic |
| `tests/unit/commands/start.test.ts` | **Create** | Unit tests for start command |
| `tests/unit/commands/stop.test.ts` | **Create** | Unit tests for stop command |
| `tests/unit/commands/status-daemon.test.ts` | **Create** | Unit tests for status daemon block extension |
| `tests/integration/daemon/daemon-lifecycle.test.ts` | **Create** | Integration: spawn real daemon, stop, crash-recover |

---

## Task 1: Extend `AppPaths` with daemon paths

**Files:**
- Modify: `src/platform/paths.ts`
- Test: `tests/unit/daemon/pid-file.test.ts` (will use these paths in Task 2)

**Interfaces:**
- Produces:
  ```ts
  // Added to AppPaths interface and appPaths() return value:
  readonly daemonDir: string;       // <dataDir>/daemon
  readonly pidPath: string;         // <dataDir>/daemon/pid
  readonly queuePath: string;       // <dataDir>/daemon/queue.json
  readonly logPath: string;         // <dataDir>/daemon/daemon.log
  ```

- [ ] **Step 1: Add fields to the `AppPaths` interface**

In `src/platform/paths.ts`, add four readonly fields to the `AppPaths` interface:

```ts
export interface AppPaths {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly runsDir: string;
  readonly daemonDir: string;   // <-- add
  readonly pidPath: string;     // <-- add
  readonly queuePath: string;   // <-- add
  readonly logPath: string;     // <-- add
  runDir(runId: string): string;
  artifactPath(runId: string, relative: string): string;
  issuePointerPath(owner: string, repo: string, issueNumber: number): string;
}
```

- [ ] **Step 2: Populate the fields in `appPaths()`**

In the `appPaths()` function body, add the four values to the returned object:

```ts
const daemonDir = path.join(dataDir, "daemon");
return {
  dataDir,
  dbPath,
  runsDir,
  daemonDir,
  pidPath: path.join(daemonDir, "pid"),
  queuePath: path.join(daemonDir, "queue.json"),
  logPath: path.join(daemonDir, "daemon.log"),
  // ... existing methods unchanged
};
```

- [ ] **Step 3: Run typecheck to catch any callers that destructure `AppPaths`**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck
```

Expected: no errors (the fields are additive; no existing code breaks).

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm test
```

Expected: all tests pass (no logic changed).

- [ ] **Step 5: Commit**

```bash
git add src/platform/paths.ts
git commit -m "feat(paths): add daemon dir, pidPath, queuePath, logPath to AppPaths"
```

---

## Task 2: `PidFile` — write, read, delete, staleness check

**Files:**
- Create: `src/daemon/pid-file.ts`
- Test: `tests/unit/daemon/pid-file.test.ts`

**Interfaces:**
- Consumes: `AppPaths.pidPath` (string), `AppPaths.daemonDir` (string)
- Produces:
  ```ts
  export interface PidFileDeps {
    pidPath: string;
    daemonDir: string;
    /** Injectable for tests: replaces process.kill(pid, 0). Default: process.kill */
    sendSignal?: (pid: number, signal: number | NodeJS.Signals) => void;
    /** Injectable for tests: replaces fs.mkdirSync / writeFileSync / unlinkSync / readFileSync */
    fs?: {
      mkdirSync(path: string, opts: { recursive: boolean }): void;
      writeFileSync(path: string, data: string): void;
      readFileSync(path: string, encoding: "utf8"): string;
      unlinkSync(path: string): void;
      existsSync(path: string): boolean;
    };
  }

  export class PidFile {
    constructor(deps: PidFileDeps);
    /** Write current process.pid to the PID file. Creates daemonDir if needed. */
    write(): void;
    /** Write an explicit PID (used by daemon-entry to write its own PID). */
    writePid(pid: number): void;
    /** Read and return the PID, or null if the file does not exist. */
    read(): number | null;
    /** Delete the PID file. No-op if already absent. */
    delete(): void;
    /**
     * Return true if a live process owns the PID file.
     * Returns false if the file is absent or the PID is stale (ESRCH).
     * Deletes a stale PID file as a side effect.
     */
    isLive(): boolean;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/daemon/pid-file.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PidFile } from "../../../src/daemon/pid-file.js";

describe("PidFile", () => {
  let tmpDir: string;
  let pidPath: string;
  let daemonDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "pid-test-"));
    daemonDir = path.join(tmpDir, "daemon");
    pidPath = path.join(daemonDir, "pid");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("write() creates daemonDir and writes current pid", () => {
    const pf = new PidFile({ pidPath, daemonDir });
    pf.write();
    const pf2 = new PidFile({ pidPath, daemonDir });
    expect(pf2.read()).toBe(process.pid);
  });

  it("writePid() writes an explicit pid", () => {
    const pf = new PidFile({ pidPath, daemonDir });
    pf.writePid(99999);
    expect(pf.read()).toBe(99999);
  });

  it("read() returns null when file does not exist", () => {
    const pf = new PidFile({ pidPath, daemonDir });
    expect(pf.read()).toBeNull();
  });

  it("delete() removes the file", () => {
    const pf = new PidFile({ pidPath, daemonDir });
    pf.write();
    pf.delete();
    expect(pf.read()).toBeNull();
  });

  it("delete() is a no-op when file is absent", () => {
    const pf = new PidFile({ pidPath, daemonDir });
    expect(() => pf.delete()).not.toThrow();
  });

  it("isLive() returns true when process exists", () => {
    const sendSignal = vi.fn(); // doesn't throw → process exists
    const pf = new PidFile({ pidPath, daemonDir, sendSignal });
    pf.writePid(12345);
    expect(pf.isLive()).toBe(true);
    expect(sendSignal).toHaveBeenCalledWith(12345, 0);
  });

  it("isLive() returns false and deletes file when process is gone (ESRCH)", () => {
    const sendSignal = vi.fn().mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    });
    const pf = new PidFile({ pidPath, daemonDir, sendSignal });
    pf.writePid(99999);
    expect(pf.isLive()).toBe(false);
    expect(pf.read()).toBeNull(); // stale file deleted
  });

  it("isLive() returns false when file is absent", () => {
    const pf = new PidFile({ pidPath, daemonDir });
    expect(pf.isLive()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/pid-file.test.ts
```

Expected: FAIL — `pid-file.ts` does not exist.

- [ ] **Step 3: Implement `src/daemon/pid-file.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface PidFileDeps {
  pidPath: string;
  daemonDir: string;
  sendSignal?: (pid: number, signal: number | NodeJS.Signals) => void;
  fs?: {
    mkdirSync(path: string, opts: { recursive: boolean }): void;
    writeFileSync(path: string, data: string): void;
    readFileSync(path: string, encoding: "utf8"): string;
    unlinkSync(path: string): void;
    existsSync(path: string): boolean;
  };
}

export class PidFile {
  private readonly pidPath: string;
  private readonly daemonDir: string;
  private readonly sendSignal: (pid: number, signal: number | NodeJS.Signals) => void;
  private readonly fns: NonNullable<PidFileDeps["fs"]>;

  constructor(deps: PidFileDeps) {
    this.pidPath = deps.pidPath;
    this.daemonDir = deps.daemonDir;
    this.sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
    this.fns = deps.fs ?? {
      mkdirSync,
      writeFileSync,
      readFileSync,
      unlinkSync,
      existsSync,
    };
  }

  write(): void {
    this.writePid(process.pid);
  }

  writePid(pid: number): void {
    this.fns.mkdirSync(this.daemonDir, { recursive: true });
    this.fns.writeFileSync(this.pidPath, String(pid));
  }

  read(): number | null {
    if (!this.fns.existsSync(this.pidPath)) return null;
    const raw = this.fns.readFileSync(this.pidPath, "utf8").trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  delete(): void {
    if (!this.fns.existsSync(this.pidPath)) return;
    this.fns.unlinkSync(this.pidPath);
  }

  isLive(): boolean {
    const pid = this.read();
    if (pid === null) return false;
    try {
      this.sendSignal(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        this.delete();
        return false;
      }
      // EPERM means process exists but we can't signal it — still live
      return true;
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/pid-file.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/pid-file.ts tests/unit/daemon/pid-file.test.ts
git commit -m "feat(daemon): add PidFile with write, read, delete, staleness check"
```

---

## Task 3: `QueueStore` — atomic read/write of `queue.json`

**Files:**
- Create: `src/daemon/queue-store.ts`
- Test: `tests/unit/daemon/queue-store.test.ts`

**Interfaces:**
- Consumes: `AppPaths.queuePath` (string), `AppPaths.daemonDir` (string)
- Produces:
  ```ts
  import type { RepositoryRef } from "../domain/contracts.js";

  export interface CompletedRun {
    issueNumber: number;
    outcome: "PR_OPEN" | "BLOCKED" | "NEEDS_REFINEMENT" | "FAILED";
    completedAt: string;  // ISO 8601
    runId: string;
  }

  export interface DaemonQueue {
    repository: RepositoryRef;
    issues: number[];           // immutable ordered list
    currentIndex: number;       // index of issue currently running or next to run
    startedAt: string;          // ISO 8601
    completedRuns: CompletedRun[];
  }

  export class QueueStore {
    constructor(deps: { queuePath: string; daemonDir: string });
    /** Write queue atomically (write .tmp, rename). Creates daemonDir. */
    write(queue: DaemonQueue): void;
    /** Read queue. Returns null if file does not exist. Throws on invalid JSON. */
    read(): DaemonQueue | null;
    /** Return true if the queue file exists. */
    exists(): boolean;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/daemon/queue-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
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
    const { existsSync } = await import("node:fs");
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
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(queuePath, "not-json");
    const qs = new QueueStore({ queuePath, daemonDir });
    expect(() => qs.read()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/queue-store.test.ts
```

Expected: FAIL — `queue-store.ts` does not exist.

- [ ] **Step 3: Implement `src/daemon/queue-store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RepositoryRef } from "../domain/contracts.js";

export interface CompletedRun {
  issueNumber: number;
  outcome: "PR_OPEN" | "BLOCKED" | "NEEDS_REFINEMENT" | "FAILED";
  completedAt: string;
  runId: string;
}

export interface DaemonQueue {
  repository: RepositoryRef;
  issues: number[];
  currentIndex: number;
  startedAt: string;
  completedRuns: CompletedRun[];
}

export class QueueStore {
  private readonly queuePath: string;
  private readonly daemonDir: string;
  private readonly tmpPath: string;

  constructor(deps: { queuePath: string; daemonDir: string }) {
    this.queuePath = deps.queuePath;
    this.daemonDir = deps.daemonDir;
    this.tmpPath = `${deps.queuePath}.tmp`;
  }

  write(queue: DaemonQueue): void {
    mkdirSync(this.daemonDir, { recursive: true });
    writeFileSync(this.tmpPath, JSON.stringify(queue, null, 2));
    renameSync(this.tmpPath, this.queuePath);
  }

  read(): DaemonQueue | null {
    if (!existsSync(this.queuePath)) return null;
    const raw = readFileSync(this.queuePath, "utf8");
    return JSON.parse(raw) as DaemonQueue;
  }

  exists(): boolean {
    return existsSync(this.queuePath);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/queue-store.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/queue-store.ts tests/unit/daemon/queue-store.test.ts
git commit -m "feat(daemon): add QueueStore with atomic write and DaemonQueue type"
```

---

## Task 4: `LogFile` — timestamped writes and 10 MB rotation

**Files:**
- Create: `src/daemon/log-file.ts`
- Test: `tests/unit/daemon/log-file.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class LogFile {
    constructor(deps: { logPath: string; daemonDir: string; maxBytes?: number });
    /** Append a timestamped INFO line. Rotates if file exceeds maxBytes. */
    info(message: string): void;
    /** Append a timestamped ERROR line. Rotates if file exceeds maxBytes. */
    error(message: string): void;
  }
  ```
  Format: `2026-08-21T10:45:00.000Z [INFO]  message\n`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/daemon/log-file.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LogFile } from "../../../src/daemon/log-file.js";

describe("LogFile", () => {
  let tmpDir: string;
  let daemonDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "log-test-"));
    daemonDir = path.join(tmpDir, "daemon");
    logPath = path.join(daemonDir, "daemon.log");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("info() creates daemonDir and writes a timestamped line", () => {
    const lf = new LogFile({ logPath, daemonDir });
    lf.info("daemon started pid=123");
    const content = readFileSync(logPath, "utf8");
    expect(content).toMatch(/\[INFO\]\s+daemon started pid=123/);
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("error() writes an ERROR line", () => {
    const lf = new LogFile({ logPath, daemonDir });
    lf.error("something went wrong");
    const content = readFileSync(logPath, "utf8");
    expect(content).toMatch(/\[ERROR\]\s+something went wrong/);
  });

  it("appends successive lines", () => {
    const lf = new LogFile({ logPath, daemonDir });
    lf.info("first");
    lf.info("second");
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("rotates when file exceeds maxBytes", () => {
    mkdirSync(daemonDir, { recursive: true });
    // Write 5 bytes of existing content — trigger rotation at maxBytes=4
    writeFileSync(logPath, "hello");
    const lf = new LogFile({ logPath, daemonDir, maxBytes: 4 });
    lf.info("new entry after rotation");
    // Rotated file should exist
    const rotated = readFileSync(`${logPath}.1`, "utf8");
    expect(rotated).toBe("hello");
    // Fresh log only has the new line
    const fresh = readFileSync(logPath, "utf8");
    expect(fresh).toMatch(/new entry after rotation/);
    expect(fresh).not.toContain("hello");
  });

  it("overwrites .1 when rotating again", () => {
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(`${logPath}.1`, "old-rotated");
    writeFileSync(logPath, "hello");
    const lf = new LogFile({ logPath, daemonDir, maxBytes: 4 });
    lf.info("trigger rotation");
    expect(readFileSync(`${logPath}.1`, "utf8")).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/log-file.test.ts
```

Expected: FAIL — `log-file.ts` does not exist.

- [ ] **Step 3: Implement `src/daemon/log-file.ts`**

```ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class LogFile {
  private readonly logPath: string;
  private readonly daemonDir: string;
  private readonly maxBytes: number;

  constructor(deps: { logPath: string; daemonDir: string; maxBytes?: number }) {
    this.logPath = deps.logPath;
    this.daemonDir = deps.daemonDir;
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  info(message: string): void {
    this.append("INFO", message);
  }

  error(message: string): void {
    this.append("ERROR", message);
  }

  private append(level: string, message: string): void {
    mkdirSync(this.daemonDir, { recursive: true });
    this.maybeRotate();
    const line = `${new Date().toISOString()} [${level}]  ${message}\n`;
    appendFileSync(this.logPath, line);
  }

  private maybeRotate(): void {
    if (!existsSync(this.logPath)) return;
    const { size } = statSync(this.logPath);
    if (size <= this.maxBytes) return;
    renameSync(this.logPath, `${this.logPath}.1`);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/log-file.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/log-file.ts tests/unit/daemon/log-file.test.ts
git commit -m "feat(daemon): add LogFile with timestamped writes and 10MB rotation"
```

---

## Task 5: `DaemonRunner` — main loop with SIGTERM and reconciliation

**Files:**
- Create: `src/daemon/daemon-runner.ts`
- Test: `tests/unit/daemon/daemon-runner.test.ts`

**Interfaces:**
- Consumes:
  - `PidFile` from Task 2
  - `QueueStore`, `DaemonQueue`, `CompletedRun` from Task 3
  - `LogFile` from Task 4
  - `RunService.start(issueNumber, overrides)` → `Promise<RunSummary>` (from `src/workflow/run-service.ts`)
  - `RecoveryService.reconcile(runId)` → `Promise<RecoveryReport>` and `RecoveryService.resume(runId, overrides)` → `Promise<RunSummary>` (from `src/workflow/recovery-service.ts`)
  - `RunStore.listNonterminalRuns()` → `RunRecord[]` (from `src/persistence/run-store.ts`)
- Produces:
  ```ts
  export interface DaemonRunnerDeps {
    pidFile: PidFile;
    queueStore: QueueStore;
    logFile: LogFile;
    runService: {
      start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
      resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
    };
    recoveryService: {
      reconcile(runId: string): Promise<{ runId: string; stage: string; actions: unknown[] }>;
      resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
    };
    runStore: {
      listNonterminalRuns(): Array<{ id: string; issueNumber: number; stage: string }>;
      transition(runId: string, from: string, to: string, evidenceRef: string | null): void;
    };
    overrides: RunOverrides;
    /** Injectable for tests: replaces process.on("SIGTERM",...) */
    registerSignalHandler?: (signal: string, handler: () => void) => void;
    /** Injectable for tests: replaces process.exit(0) */
    exit?: (code: number) => void;
  }

  export class DaemonRunner {
    constructor(deps: DaemonRunnerDeps);
    /** Run the daemon loop to completion. Resolves when queue exhausted or SIGTERM processed. */
    run(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/daemon/daemon-runner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DaemonRunner } from "../../../src/daemon/daemon-runner.js";
import type { DaemonRunnerDeps } from "../../../src/daemon/daemon-runner.js";

function makeDeps(overrides: Partial<DaemonRunnerDeps> = {}): DaemonRunnerDeps {
  return {
    pidFile: {
      writePid: vi.fn(),
      delete: vi.fn(),
    } as any,
    queueStore: {
      read: vi.fn().mockReturnValue({
        repository: { owner: "acme", repo: "widgets" },
        issues: [28, 29],
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        completedRuns: [],
      }),
      write: vi.fn(),
    } as any,
    logFile: {
      info: vi.fn(),
      error: vi.fn(),
    } as any,
    runService: {
      start: vi.fn().mockResolvedValue({
        runId: "run-abc",
        stage: "PR_OPEN",
        repository: { owner: "acme", repo: "widgets" },
        issueNumber: 28,
        publication: null,
        reason: null,
      }),
      resume: vi.fn(),
    },
    recoveryService: {
      reconcile: vi.fn().mockResolvedValue({ runId: "run-x", stage: "BLOCKED", actions: [] }),
      resume: vi.fn(),
    },
    runStore: {
      listNonterminalRuns: vi.fn().mockReturnValue([]),
      transition: vi.fn(),
    },
    overrides: {},
    registerSignalHandler: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
}

describe("DaemonRunner", () => {
  it("runs through all issues and records outcomes", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "BLOCKED", issueNumber: 29, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    const runner = new DaemonRunner(deps);
    await runner.run();

    expect(deps.runService.start).toHaveBeenCalledTimes(2);
    expect(deps.runService.start).toHaveBeenNthCalledWith(1, 28, {});
    expect(deps.runService.start).toHaveBeenNthCalledWith(2, 29, {});
    // queue written twice (once per issue completion)
    expect(deps.queueStore.write).toHaveBeenCalledTimes(2);
    // pid file deleted on clean exit
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("skips BLOCKED/NEEDS_REFINEMENT and continues to next issue", async () => {
    const deps = makeDeps();
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ runId: "run-1", stage: "NEEDS_REFINEMENT", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null })
      .mockResolvedValueOnce({ runId: "run-2", stage: "PR_OPEN", issueNumber: 29, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null });

    await new DaemonRunner(deps).run();
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
  });

  it("handles empty queue without calling RunService", async () => {
    const deps = makeDeps();
    (deps.queueStore.read as ReturnType<typeof vi.fn>).mockReturnValue({
      repository: { owner: "acme", repo: "widgets" },
      issues: [],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      completedRuns: [],
    });
    await new DaemonRunner(deps).run();
    expect(deps.runService.start).not.toHaveBeenCalled();
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("stops after current issue when SIGTERM is received between issues", async () => {
    let sigtermHandler: (() => void) | undefined;
    const registerSignalHandler = vi.fn().mockImplementation((_sig: string, handler: () => void) => {
      sigtermHandler = handler;
    });
    const deps = makeDeps({ registerSignalHandler });
    (deps.runService.start as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        sigtermHandler?.(); // fire SIGTERM while issue 28 is "running"
        return { runId: "run-1", stage: "PR_OPEN", issueNumber: 28, repository: { owner: "acme", repo: "widgets" }, publication: null, reason: null };
      });

    await new DaemonRunner(deps).run();
    // Should have run issue 28 (completed the stage), but not 29
    expect(deps.runService.start).toHaveBeenCalledTimes(1);
    expect(deps.pidFile.delete).toHaveBeenCalled();
  });

  it("auto-resumes a nonterminal run before the queue", async () => {
    const deps = makeDeps();
    (deps.runStore.listNonterminalRuns as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "run-interrupted", issueNumber: 27, stage: "BLOCKED" },
    ]);
    (deps.recoveryService.resume as ReturnType<typeof vi.fn>).mockResolvedValue({
      runId: "run-interrupted",
      stage: "PR_OPEN",
      issueNumber: 27,
      repository: { owner: "acme", repo: "widgets" },
      publication: null,
      reason: null,
    });

    await new DaemonRunner(deps).run();
    // resume called before queue issues
    expect(deps.recoveryService.resume).toHaveBeenCalledWith("run-interrupted", {});
    // then queue issues run
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
  });

  it("marks interrupted run FAILED and continues when resume throws", async () => {
    const deps = makeDeps();
    (deps.runStore.listNonterminalRuns as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "run-bad", issueNumber: 27, stage: "FAILED" },
    ]);
    (deps.recoveryService.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("worktree missing"),
    );

    await new DaemonRunner(deps).run();
    // transition called to mark FAILED
    expect(deps.runStore.transition).toHaveBeenCalled();
    // queue still runs
    expect(deps.runService.start).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```

Expected: FAIL — `daemon-runner.ts` does not exist.

- [ ] **Step 3: Implement `src/daemon/daemon-runner.ts`**

```ts
import type { RunOverrides, RunSummary } from "../workflow/run-service.js";
import type { PidFile } from "./pid-file.js";
import type { QueueStore, CompletedRun } from "./queue-store.js";
import type { LogFile } from "./log-file.js";

export interface DaemonRunnerDeps {
  pidFile: Pick<PidFile, "writePid" | "delete">;
  queueStore: Pick<QueueStore, "read" | "write">;
  logFile: Pick<LogFile, "info" | "error">;
  runService: {
    start(issueNumber: number, overrides: RunOverrides): Promise<RunSummary>;
    resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
  };
  recoveryService: {
    reconcile(runId: string): Promise<{ runId: string; stage: string; actions: unknown[] }>;
    resume(runId: string, overrides: RunOverrides): Promise<RunSummary>;
  };
  runStore: {
    listNonterminalRuns(): Array<{ id: string; issueNumber: number; stage: string }>;
    transition(runId: string, from: string, to: string, evidenceRef: string | null): void;
  };
  overrides: RunOverrides;
  registerSignalHandler?: (signal: string, handler: () => void) => void;
  exit?: (code: number) => void;
}

export class DaemonRunner {
  private stopRequested = false;
  private readonly deps: DaemonRunnerDeps;

  constructor(deps: DaemonRunnerDeps) {
    this.deps = deps;
  }

  async run(): Promise<void> {
    const { pidFile, queueStore, logFile, runStore, recoveryService, runService, overrides } =
      this.deps;
    const registerSignal =
      this.deps.registerSignalHandler ??
      ((sig: string, handler: () => void) => process.on(sig, handler));
    const exit = this.deps.exit ?? ((code: number) => process.exit(code));

    registerSignal("SIGTERM", () => {
      logFile.info("SIGTERM received — finishing current stage");
      this.stopRequested = true;
    });
    registerSignal("SIGINT", () => {
      logFile.info("SIGINT received — finishing current stage");
      this.stopRequested = true;
    });

    const queue = queueStore.read();
    if (queue === null) {
      logFile.error("no queue found — exiting");
      exit(1);
      return;
    }

    logFile.info(
      `daemon started pid=${process.pid} queue=[${queue.issues.join(",")}]`,
    );

    // --- Crash reconciliation ---
    const nonterminal = runStore.listNonterminalRuns();
    for (const run of nonterminal) {
      logFile.info(`reconciliation: found interrupted run ${run.id} issue=${run.issueNumber}`);
      try {
        const summary = await recoveryService.resume(run.id, overrides);
        logFile.info(
          `reconciliation: resumed run ${run.id} → outcome=${summary.stage}`,
        );
      } catch (err) {
        logFile.error(
          `reconciliation: resume failed for ${run.id} — marking FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          runStore.transition(run.id, run.stage, "FAILED", null);
        } catch {
          // best-effort
        }
      }
    }
    if (nonterminal.length === 0) {
      logFile.info("reconciliation: no interrupted runs found");
    }

    // --- Main queue loop ---
    while (queue.currentIndex < queue.issues.length && !this.stopRequested) {
      const issueNumber = queue.issues[queue.currentIndex]!;
      logFile.info(`starting run issue=${issueNumber}`);

      let summary: RunSummary;
      try {
        summary = await runService.start(issueNumber, overrides);
      } catch (err) {
        logFile.error(
          `run failed for issue=${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary = {
          runId: `failed-${issueNumber}`,
          stage: "FAILED",
          repository: queue.repository,
          issueNumber,
          publication: null,
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      logFile.info(`run complete issue=${issueNumber} outcome=${summary.stage}`);

      const completed: CompletedRun = {
        issueNumber,
        outcome: summary.stage as CompletedRun["outcome"],
        completedAt: new Date().toISOString(),
        runId: summary.runId,
      };
      queue.completedRuns.push(completed);
      queue.currentIndex += 1;
      queueStore.write(queue);
    }

    if (this.stopRequested) {
      logFile.info("daemon exiting cleanly after stage boundary");
    } else {
      logFile.info(
        `queue exhausted — ${queue.completedRuns.length} run(s) completed`,
      );
    }

    pidFile.delete();
    exit(0);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/daemon/daemon-runner.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/daemon-runner.ts tests/unit/daemon/daemon-runner.test.ts
git commit -m "feat(daemon): add DaemonRunner main loop with SIGTERM handling and reconciliation"
```

---

## Task 6: `daemon-entry.ts` — child process bootstrap

**Files:**
- Create: `src/daemon/daemon-entry.ts`

**Interfaces:**
- Consumes: `DaemonRunner`, `PidFile`, `QueueStore`, `LogFile` from prior tasks; `RunService`, `RecoveryService`, `RunStore`, `ArtifactStore`, `AppPaths` from M1.
- Produces: a runnable Node.js entry point at `dist/daemon/daemon-entry.js` after build.

No unit test for this file — it is thin bootstrap glue tested via the integration test in Task 9. Its only job is to wire production deps and call `DaemonRunner.run()`.

- [ ] **Step 1: Implement `src/daemon/daemon-entry.ts`**

```ts
/**
 * Daemon child process entry point.
 *
 * Spawned detached by `autopilot start`. Writes its own PID file, wires
 * production dependencies, and calls DaemonRunner.run().
 *
 * Accepts configuration via environment variables injected by `start`:
 *   AUTOPILOT_DATA_DIR      — override for the data directory (standard)
 *   AUTOPILOT_DAEMON_CWD   — working directory of the repository to operate on
 */
import path from "node:path";
import { appPaths } from "../platform/paths.js";
import { RunStore } from "../persistence/run-store.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { RunService } from "../workflow/run-service.js";
import { RecoveryService } from "../workflow/recovery-service.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { GitHubAdapter } from "../github/github-adapter.js";
import { resolveRepositoryContext, safeProcessEnv } from "../github/repository-context.js";
import { ProcessRunner } from "../platform/process-runner.js";
import { PidFile } from "./pid-file.js";
import { QueueStore } from "./queue-store.js";
import { LogFile } from "./log-file.js";
import { DaemonRunner } from "./daemon-runner.js";

async function main(): Promise<void> {
  const cwd = process.env.AUTOPILOT_DAEMON_CWD ?? process.cwd();
  const paths = appPaths();
  const logFile = new LogFile({ logPath: paths.logPath, daemonDir: paths.daemonDir });
  const pidFile = new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir });

  // Write our own PID (never the parent's)
  pidFile.writePid(process.pid);

  try {
    const env = safeProcessEnv();
    const repository = await resolveRepositoryContext({ cwd, env });
    const processRunner = new ProcessRunner();
    const github = new GitHubAdapter({ token: env.GITHUB_TOKEN ?? "" });
    const runStore = new RunStore(paths.dbPath);
    const artifactStore = new ArtifactStore(paths);
    const workspaceManager = new WorkspaceManager({ cwd, processRunner });

    // Read overrides written by `autopilot start` into the queue file
    const queueStore = new QueueStore({ queuePath: paths.queuePath, daemonDir: paths.daemonDir });
    const queue = queueStore.read();
    if (queue === null) {
      logFile.error("daemon-entry: no queue.json found — exiting");
      process.exit(1);
    }

    const runService = new RunService({
      cwd,
      dataDir: paths.dataDir,
      processRunner,
    });

    const recoveryService = new RecoveryService({
      runStore,
      artifacts: artifactStore,
      paths,
      workspaceManager,
      github,
      processRunner,
      repository,
      baseBranch: "main",
      runService,
    });

    const runner = new DaemonRunner({
      pidFile,
      queueStore,
      logFile,
      runService: {
        start: (issueNumber, overrides) => runService.start(issueNumber, overrides),
        resume: (runId, overrides) => runService.resume(runId, overrides),
      },
      recoveryService: {
        reconcile: (runId) => recoveryService.reconcile(runId),
        resume: (runId, overrides) => recoveryService.resume(runId, overrides),
      },
      runStore: {
        listNonterminalRuns: () => runStore.listNonterminalRuns(),
        transition: (id, from, to, ref) => runStore.transition(id, from as any, to as any, ref),
      },
      overrides: {},
    });

    await runner.run();
  } catch (err) {
    logFile.error(`daemon fatal error: ${err instanceof Error ? err.message : String(err)}`);
    pidFile.delete();
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`daemon-entry uncaught: ${err}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run typecheck and build**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm run build
```

Expected: no errors. `dist/daemon/daemon-entry.js` is emitted.

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm test
```

Expected: all existing tests pass (no new tests yet for this file).

- [ ] **Step 4: Commit**

```bash
git add src/daemon/daemon-entry.ts
git commit -m "feat(daemon): add daemon-entry child process bootstrap"
```

---

## Task 7: `autopilot stop` command

**Files:**
- Create: `src/commands/stop.ts`
- Test: `tests/unit/commands/stop.test.ts`

**Interfaces:**
- Consumes: `PidFile` from Task 2, `AppPaths` from Task 1
- Produces:
  ```ts
  export interface StopCommandDeps {
    dataDir?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    setExitCode?: (code: number) => void;
    /** Injectable: replaces process.kill(pid, "SIGTERM"). */
    sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
    /** Injectable: replaces setInterval polling. */
    waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  }

  export function registerStopCommand(program: Command, deps?: StopCommandDeps): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/commands/stop.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerStopCommand } from "../../../src/commands/stop.js";
import type { StopCommandDeps } from "../../../src/commands/stop.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeDeps(tmpDir: string, overrides: Partial<StopCommandDeps> = {}): StopCommandDeps {
  return {
    dataDir: tmpDir,
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    sendSignal: vi.fn(),
    waitForExit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

async function runStop(deps: StopCommandDeps, args: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStopCommand(program, deps);
  await program.parseAsync(["stop", ...args], { from: "user" });
}

describe("stop command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "stop-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 with message when no PID file exists", async () => {
    const deps = makeDeps(tmpDir);
    await runStop(deps);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no daemon running"));
  });

  it("exits 1 with message when PID file is stale (ESRCH)", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "99999");
    const sendSignal = vi.fn().mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    });
    const deps = makeDeps(tmpDir, { sendSignal });
    await runStop(deps);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no daemon running"));
  });

  it("sends SIGTERM and exits 0 when daemon stops", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "12345");
    const deps = makeDeps(tmpDir, {
      waitForExit: vi.fn().mockResolvedValue(true),
    });
    await runStop(deps);
    expect(deps.sendSignal).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(deps.setExitCode).not.toHaveBeenCalledWith(1);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("stopped"));
  });

  it("exits 1 when daemon does not stop within timeout", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "12345");
    const deps = makeDeps(tmpDir, {
      waitForExit: vi.fn().mockResolvedValue(false),
    });
    await runStop(deps);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining("did not stop within"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/stop.test.ts
```

Expected: FAIL — `stop.ts` does not exist.

- [ ] **Step 3: Implement `src/commands/stop.ts`**

```ts
import { Command } from "commander";
import { appPaths } from "../platform/paths.js";
import { PidFile } from "../daemon/pid-file.js";

export interface StopCommandDeps {
  dataDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
}

const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

function defaultWaitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      try {
        process.kill(pid, 0);
        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve(false);
        }
      } catch {
        clearInterval(interval);
        resolve(true);
      }
    }, POLL_INTERVAL_MS);
  });
}

export function registerStopCommand(program: Command, deps: StopCommandDeps = {}): void {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
  const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
  const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
  const waitForExit = deps.waitForExit ?? defaultWaitForExit;

  program
    .command("stop")
    .description("Stop the running daemon")
    .action(async () => {
      const paths = appPaths(deps.dataDir);
      const pidFile = new PidFile({
        pidPath: paths.pidPath,
        daemonDir: paths.daemonDir,
        sendSignal,
      });

      if (!pidFile.isLive()) {
        stderr("no daemon running");
        setExitCode(1);
        return;
      }

      const pid = pidFile.read()!;
      sendSignal(pid, "SIGTERM");

      const stopped = await waitForExit(pid, STOP_TIMEOUT_MS);
      if (stopped) {
        stdout(`daemon stopped (PID ${pid})`);
      } else {
        stderr(`daemon did not stop within ${STOP_TIMEOUT_MS / 1000}s (PID ${pid}) — kill manually`);
        setExitCode(1);
      }
    });
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/stop.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stop.ts tests/unit/commands/stop.test.ts
git commit -m "feat(commands): add autopilot stop command"
```

---

## Task 8: `autopilot start` command

**Files:**
- Create: `src/commands/start.ts`
- Test: `tests/unit/commands/start.test.ts`

**Interfaces:**
- Consumes: `PidFile`, `QueueStore`, `AppPaths`, `resolveIssueRefs` from `src/commands/args.ts`, `parseBacklogReport` from `src/domain/backlog.ts`, `resolveRepositoryContext` from `src/github/repository-context.ts`.
- Produces:
  ```ts
  export interface StartCommandDeps {
    dataDir?: string;
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    setExitCode?: (code: number) => void;
    /** Injectable: replaces the real spawn+detach. Receives daemonEntryPath and envVars. */
    spawnDaemon?: (daemonEntryPath: string, env: Record<string, string>) => { pid: number };
    /** Injectable: replaces resolveRepositoryContext for tests. */
    resolveContext?: typeof import("../github/repository-context.js").resolveRepositoryContext;
    /** Injectable: replaces GitHub issue resolution. */
    verifyIssues?: (issueNumbers: number[]) => Promise<void>;
  }

  export function registerStartCommand(program: Command, deps?: StartCommandDeps): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/commands/start.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerStartCommand } from "../../../src/commands/start.js";
import type { StartCommandDeps } from "../../../src/commands/start.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BacklogReport } from "../../../src/domain/backlog.js";

const REPO = { owner: "acme", repo: "widgets" };

function fakeContext() {
  return {
    repository: REPO,
    remote: "https://github.com/acme/widgets.git",
    cwd: "/repo",
  };
}

function writeAnalyzeReport(dataDir: string, report: Partial<BacklogReport> & { executable: number[] }) {
  const full: BacklogReport = {
    repository: REPO,
    requestedRefs: report.executable,
    generatedAt: new Date().toISOString(),
    scope: { totalIssues: report.executable.length, analyzed: report.executable.length, unresolved: 0 },
    issues: [],
    executable: report.executable,
    needsWork: [],
    summary: { ready: report.executable.length, needsRefinement: 0, blocked: 0, ambiguous: 0, skipped: 0, unresolved: 0 },
    refinerSessions: 0,
    ...report,
  };
  const runId = `analyze-${Date.now()}`;
  const runsDir = path.join(dataDir, "runs", runId);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(path.join(runsDir, "backlog-report.json"), JSON.stringify(full));
}

function makeDeps(tmpDir: string, overrides: Partial<StartCommandDeps> = {}): StartCommandDeps {
  return {
    dataDir: tmpDir,
    cwd: "/repo",
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    spawnDaemon: vi.fn().mockReturnValue({ pid: 12345 }),
    resolveContext: vi.fn().mockResolvedValue(fakeContext()),
    verifyIssues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function runStart(deps: StartCommandDeps, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program, deps);
  await program.parseAsync(["start", ...args], { from: "user" });
}

describe("start command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "start-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("spawns daemon with explicit issue list", async () => {
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["28", "29", "30"]);
    expect(deps.spawnDaemon).toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("daemon started"));
  });

  it("exits 1 when a daemon is already running", async () => {
    const daemonDir = path.join(tmpDir, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(path.join(daemonDir, "pid"), "12345");
    // sendSignal doesn't throw → PID is "live"
    const deps = makeDeps(tmpDir);
    // Override PidFile.isLive indirectly by providing a real sendSignal that succeeds
    // We do this by supplying a fake spawnDaemon — but we need isLive to return true.
    // Simplest approach: pre-write the PID file and mock sendSignal on the PidFile
    // via an env that makes the process "exist". Use a real PID (our own process).
    writeFileSync(path.join(daemonDir, "pid"), String(process.pid));
    await runStart(deps, ["28"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("already running"));
    expect(deps.spawnDaemon).not.toHaveBeenCalled();
  });

  it("uses --from-analyze to load the executable list", async () => {
    writeAnalyzeReport(tmpDir, { executable: [101, 102] });
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["--from-analyze"]);
    expect(deps.spawnDaemon).toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("daemon started"));
  });

  it("exits 1 when --from-analyze finds no report", async () => {
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["--from-analyze"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining("no analyze report found"),
    );
  });

  it("exits 1 when --from-analyze report has empty executable list", async () => {
    writeAnalyzeReport(tmpDir, { executable: [] });
    const deps = makeDeps(tmpDir);
    await runStart(deps, ["--from-analyze"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no READY issues"));
  });

  it("exits 1 when no issues provided and no --from-analyze", async () => {
    const deps = makeDeps(tmpDir);
    await runStart(deps, []);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/start.test.ts
```

Expected: FAIL — `start.ts` does not exist.

- [ ] **Step 3: Implement `src/commands/start.ts`**

```ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { appPaths } from "../platform/paths.js";
import { PidFile } from "../daemon/pid-file.js";
import { QueueStore } from "../daemon/queue-store.js";
import { parseBacklogReport } from "../domain/backlog.js";
import { resolveRepositoryContext, safeProcessEnv } from "../github/repository-context.js";
import { resolveIssueRefs } from "./args.js";

export interface StartCommandDeps {
  dataDir?: string;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  spawnDaemon?: (daemonEntryPath: string, env: Record<string, string>) => { pid: number };
  resolveContext?: typeof resolveRepositoryContext;
  verifyIssues?: (issueNumbers: number[]) => Promise<void>;
}

/** Find the most recent backlog-report.json in the runs directory (by generatedAt). */
function findLatestBacklogReport(runsDir: string): ReturnType<typeof parseBacklogReport> | null {
  if (!existsSync(runsDir)) return null;
  let latest: ReturnType<typeof parseBacklogReport> | null = null;
  for (const runId of readdirSync(runsDir)) {
    const reportPath = path.join(runsDir, runId, "backlog-report.json");
    if (!existsSync(reportPath)) continue;
    try {
      const report = parseBacklogReport(JSON.parse(readFileSync(reportPath, "utf8")));
      if (latest === null || report.generatedAt > latest.generatedAt) {
        latest = report;
      }
    } catch {
      // skip malformed reports
    }
  }
  return latest;
}

function defaultSpawnDaemon(daemonEntryPath: string, env: Record<string, string>): { pid: number } {
  const child = spawn(process.execPath, [daemonEntryPath], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  return { pid: child.pid! };
}

export function registerStartCommand(program: Command, deps: StartCommandDeps = {}): void {
  const stdout = deps.stdout ?? ((t: string) => process.stdout.write(`${t}\n`));
  const stderr = deps.stderr ?? ((t: string) => process.stderr.write(`${t}\n`));
  const setExitCode = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
  const spawnDaemon = deps.spawnDaemon ?? defaultSpawnDaemon;
  const resolveFn = deps.resolveContext ?? resolveRepositoryContext;

  program
    .command("start")
    .description("Start the autonomous daemon over a queue of issues")
    .argument("[issues...]", "issue numbers (bare or owner/repo#number)")
    .option("--from-analyze [report-id]", "use executable list from a prior analyze report")
    .option("--refiner-timeout <minutes>", "override refiner timeout in minutes")
    .option("--refiner-model <model>")
    .option("--refiner-thinking <level>")
    .option("--implementer-model <model>")
    .option("--implementer-thinking <level>")
    .option("--reviewer-model <model>")
    .option("--reviewer-thinking <level>")
    .action(async (issueArgs: string[], opts: Record<string, string | boolean | undefined>) => {
      const cwd = deps.cwd ?? process.cwd();
      const paths = appPaths(deps.dataDir);
      const pidFile = new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir });
      const queueStore = new QueueStore({ queuePath: paths.queuePath, daemonDir: paths.daemonDir });

      // --- Guard: already running ---
      if (pidFile.isLive()) {
        const pid = pidFile.read();
        stderr(`daemon already running (PID ${pid}) — use autopilot stop first`);
        setExitCode(1);
        return;
      }

      // --- Resolve issue queue ---
      let issues: number[];

      if (opts["from-analyze"] !== undefined) {
        const report = findLatestBacklogReport(paths.runsDir);
        if (report === null) {
          stderr("no analyze report found — run autopilot analyze first");
          setExitCode(1);
          return;
        }
        if (report.executable.length === 0) {
          stderr(`no READY issues in report (generatedAt ${report.generatedAt})`);
          setExitCode(1);
          return;
        }
        issues = report.executable;
      } else if (issueArgs.length > 0) {
        try {
          const ctx = await resolveFn({ cwd, env: safeProcessEnv() });
          issues = resolveIssueRefs(issueArgs, ctx);
        } catch (err) {
          stderr(`start: ${err instanceof Error ? err.message : String(err)}`);
          setExitCode(1);
          return;
        }
      } else {
        stderr("start: provide issue numbers or --from-analyze");
        setExitCode(1);
        return;
      }

      // --- Write queue ---
      const ctx = await resolveFn({ cwd, env: safeProcessEnv() }).catch(() => null);
      queueStore.write({
        repository: ctx?.repository ?? { owner: "unknown", repo: "unknown" },
        issues,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        completedRuns: [],
      });

      // --- Spawn daemon ---
      const daemonEntryPath = fileURLToPath(
        new URL("../daemon/daemon-entry.js", import.meta.url),
      );
      const env: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
        ),
        AUTOPILOT_DAEMON_CWD: cwd,
      };
      if (deps.dataDir !== undefined) env.AUTOPILOT_DATA_DIR = deps.dataDir;

      const { pid } = spawnDaemon(daemonEntryPath, env);
      stdout(`daemon started (PID ${pid}) — queue: [${issues.join(", ")}]`);
      stdout(`use 'autopilot status' to monitor and 'autopilot stop' to stop`);
    });
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/start.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/start.ts tests/unit/commands/start.test.ts
git commit -m "feat(commands): add autopilot start command with explicit list and --from-analyze"
```

---

## Task 9: Extend `autopilot status` with daemon block

**Files:**
- Modify: `src/commands/status.ts`
- Modify: `src/ui/reporter.ts`
- Test: `tests/unit/commands/status-daemon.test.ts`

**Interfaces:**
- Consumes: `PidFile`, `QueueStore`, `DaemonQueue` from prior tasks; `AppPaths.pidPath`, `AppPaths.queuePath`.
- The existing `status <run-id>` command stays unchanged. This task adds a **new** `status` subcommand invocation with no argument that prints the daemon overview.
- Produces new `reporter.ts` function:
  ```ts
  export function formatDaemonStatus(opts: {
    pid: number;
    uptimeMs: number;
    currentIssue: number | null;
    currentStage: string | null;
    currentStartedAt: string | null;
    remainingIssues: number[];
    completedRuns: CompletedRun[];
  }): string;
  ```

Note: `status` currently requires `<run-id>`. In M3, running `autopilot status` with no argument prints the daemon overview (if a daemon is running) or a "no daemon running" message. Running it with `<run-id>` continues to work exactly as today. Implement this by making the argument optional.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/commands/status-daemon.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "../../../src/commands/status.js";
import type { StatusCommandDeps } from "../../../src/commands/status.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonQueue } from "../../../src/daemon/queue-store.js";

function makeDeps(tmpDir: string, overrides: Partial<StatusCommandDeps> = {}): StatusCommandDeps {
  return {
    dataDir: tmpDir,
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    ...overrides,
  };
}

function writePid(tmpDir: string, pid: number): void {
  const daemonDir = path.join(tmpDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(path.join(daemonDir, "pid"), String(pid));
}

function writeQueue(tmpDir: string, queue: DaemonQueue): void {
  const daemonDir = path.join(tmpDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(path.join(daemonDir, "queue.json"), JSON.stringify(queue));
}

async function runStatus(deps: StatusCommandDeps, args: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program, deps);
  await program.parseAsync(["status", ...args], { from: "user" });
}

describe("status command — daemon block", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "status-daemon-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints 'no daemon running' when PID file is absent", async () => {
    const deps = makeDeps(tmpDir);
    await runStatus(deps);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("no daemon running"));
  });

  it("prints daemon block when PID file is live", async () => {
    // Write our own PID so isLive() returns true
    writePid(tmpDir, process.pid);
    writeQueue(tmpDir, {
      repository: { owner: "acme", repo: "widgets" },
      issues: [28, 29, 30],
      currentIndex: 1,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedRuns: [
        { issueNumber: 28, outcome: "PR_OPEN", completedAt: new Date().toISOString(), runId: "run-1" },
      ],
    });
    const deps = makeDeps(tmpDir);
    await runStatus(deps);
    const output = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n");
    expect(output).toMatch(/Daemon\s+running/);
    expect(output).toMatch(/PID/);
    expect(output).toMatch(/Queue.*#29.*#30/);
    expect(output).toMatch(/Done.*#28.*PR_OPEN/);
  });

  it("existing status <run-id> still works", async () => {
    // We can't easily test this without a real RunStore, so just verify
    // parsing doesn't throw when a run-id argument is given.
    const deps = makeDeps(tmpDir);
    // Should try to look up the run and print not-found
    await runStatus(deps, ["nonexistent-run-id"]);
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/status-daemon.test.ts
```

Expected: FAIL — status command has no daemon block yet.

- [ ] **Step 3: Add `formatDaemonStatus` to `src/ui/reporter.ts`**

Append to the existing `reporter.ts`:

```ts
import type { CompletedRun } from "../daemon/queue-store.js";

export function formatDaemonStatus(opts: {
  pid: number;
  uptimeMs: number;
  currentIssue: number | null;
  currentStage: string | null;
  remainingIssues: number[];
  completedRuns: CompletedRun[];
}): string {
  const uptimeSec = Math.floor(opts.uptimeMs / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const uptime =
    h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const lines: string[] = [];
  lines.push(`Daemon    running  PID ${opts.pid}  uptime ${uptime}`);

  if (opts.currentIssue !== null) {
    lines.push(
      `Current   #${opts.currentIssue}  [${opts.currentStage ?? "..."}]`,
    );
  }

  if (opts.remainingIssues.length > 0) {
    lines.push(
      `Queue     ${opts.remainingIssues.map((n) => `#${n}`).join(" ")}  (${opts.remainingIssues.length} remaining)`,
    );
  } else {
    lines.push("Queue     (empty)");
  }

  if (opts.completedRuns.length > 0) {
    const done = opts.completedRuns
      .map((r) => `#${r.issueNumber} → ${r.outcome}`)
      .join("  ");
    lines.push(`Done      ${done}`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Extend `src/commands/status.ts`**

Make the `<run-id>` argument optional. When called with no argument, show the daemon block. When called with a run-id, behave exactly as today.

Find the `.argument("<run-id>", ...)` line in the existing `registerStatusCommand` and change it to `.argument("[run-id]", ...)`. Then add a daemon-overview branch at the top of the action handler:

```ts
// At the top of the action handler, before the existing run lookup:
if (runId === undefined) {
  // Daemon overview mode
  const paths = appPaths(deps.dataDir);
  const pidFile = new PidFile({ pidPath: paths.pidPath, daemonDir: paths.daemonDir });
  if (!pidFile.isLive()) {
    stdout("no daemon running");
    return;
  }
  const pid = pidFile.read()!;
  const queueStore = new QueueStore({ queuePath: paths.queuePath, daemonDir: paths.daemonDir });
  const queue = queueStore.read();
  if (queue === null) {
    stdout(`daemon running (PID ${pid}) but no queue found`);
    return;
  }
  const currentIssue = queue.issues[queue.currentIndex] ?? null;
  const remainingIssues = queue.issues.slice(queue.currentIndex + 1);
  const startedAt = new Date(queue.startedAt).getTime();
  const uptimeMs = Date.now() - startedAt;
  stdout(formatDaemonStatus({
    pid,
    uptimeMs,
    currentIssue: currentIssue ?? null,
    currentStage: null, // stage is in RunStore; omit for now (M4 can add)
    remainingIssues,
    completedRuns: queue.completedRuns,
  }));
  return;
}
// ... existing run lookup logic below unchanged
```

Also add imports for `PidFile`, `QueueStore`, and `formatDaemonStatus` at the top of `status.ts`.

- [ ] **Step 5: Run tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/unit/commands/status-daemon.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run full suite + typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/status.ts src/ui/reporter.ts tests/unit/commands/status-daemon.test.ts
git commit -m "feat(commands): extend status with daemon block (PID, uptime, queue, done)"
```

---

## Task 10: Wire `start` and `stop` into `cli.ts`

**Files:**
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `StartCommandDeps`, `registerStartCommand` from Task 8; `StopCommandDeps`, `registerStopCommand` from Task 7.

- [ ] **Step 1: Add imports and register commands in `src/cli.ts`**

Add at the top of `cli.ts` alongside the other imports:

```ts
import type { StartCommandDeps } from "./commands/start.js";
import { registerStartCommand } from "./commands/start.js";
import type { StopCommandDeps } from "./commands/stop.js";
import { registerStopCommand } from "./commands/stop.js";
```

Extend `CliDeps`:

```ts
export type CliDeps = CheckCommandDeps &
  PrepareCommandDeps &
  AnalyzeCommandDeps &
  RunCommandDeps &
  StatusCommandDeps &
  InspectCommandDeps &
  ResumeCommandDeps &
  RunsCommandDeps &
  AbandonCommandDeps &
  StartCommandDeps &   // <-- add
  StopCommandDeps;     // <-- add
```

Add registration calls in `buildProgram()` alongside the other `register*` calls:

```ts
registerStartCommand(program, deps);
registerStopCommand(program, deps);
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run full suite and build**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm test && npm run build
```

Expected: all 388+ tests pass, build succeeds.

- [ ] **Step 4: Smoke-test the CLI help**

```bash
cd /Users/andrea.dodero/pi_autopilot
node dist/cli.js --help
```

Expected: `start` and `stop` appear in the command list.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): register start and stop commands"
```

---

## Task 11: Integration test — daemon lifecycle

**Files:**
- Create: `tests/integration/daemon/daemon-lifecycle.test.ts`

This is the acceptance-criteria test. It spawns the real daemon via the `start` command against a fake `RunService` shim (using the `AUTOPILOT_DATA_DIR` env override) and exercises: start → status → stop, crash-recover, and queue exhaustion.

Because spawning real child processes in tests is slow and environment-sensitive, this test uses a **test-only daemon entry shim** that accepts an injectable `RunService` path via an environment variable rather than spinning up a full Pi session. The shim is a minimal Node.js script.

- [ ] **Step 1: Create the test daemon shim**

Create `tests/integration/daemon/fake-daemon-entry.mjs`:

```js
/**
 * Test-only daemon entry shim. Replaces the real daemon-entry.ts in
 * integration tests. Reads the queue, runs a fake "RunService" that
 * immediately returns the outcome specified in FAKE_OUTCOME env var
 * (default: PR_OPEN), and exits.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const dataDir =
  process.env.AUTOPILOT_DATA_DIR ??
  path.join(homedir(), ".local", "share", "pi-autopilot");

const daemonDir = path.join(dataDir, "daemon");
const pidPath = path.join(daemonDir, "pid");
const queuePath = path.join(daemonDir, "queue.json");
const logPath = path.join(daemonDir, "daemon.log");

function log(msg) {
  mkdirSync(daemonDir, { recursive: true });
  const line = `${new Date().toISOString()} [INFO]  ${msg}\n`;
  try {
    const { size } = (existsSync(logPath) ? { size: readFileSync(logPath).length } : { size: 0 });
    process.stdout.write(line);
  } catch {}
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

mkdirSync(daemonDir, { recursive: true });
writeFileSync(pidPath, String(process.pid));
log(`fake-daemon started pid=${process.pid}`);

const queue = JSON.parse(readFileSync(queuePath, "utf8"));
const fakeOutcome = process.env.FAKE_OUTCOME ?? "PR_OPEN";
const delayMs = Number(process.env.FAKE_DELAY_MS ?? "50");

let stopRequested = false;
process.on("SIGTERM", () => {
  log("SIGTERM received");
  stopRequested = true;
});

for (let i = queue.currentIndex; i < queue.issues.length; i++) {
  if (stopRequested) break;
  const issueNumber = queue.issues[i];
  log(`starting run issue=${issueNumber}`);
  // Simulate work
  await new Promise((r) => setTimeout(r, delayMs));
  queue.completedRuns.push({
    issueNumber,
    outcome: fakeOutcome,
    completedAt: new Date().toISOString(),
    runId: `fake-run-${issueNumber}`,
  });
  queue.currentIndex = i + 1;
  atomicWrite(queuePath, JSON.stringify(queue, null, 2));
  log(`run complete issue=${issueNumber} outcome=${fakeOutcome}`);
}

log("queue exhausted");
try { require("node:fs").unlinkSync(pidPath); } catch {}
try { writeFileSync(pidPath, ""); } catch {} // leave empty for tests that check deletion
process.exit(0);
```

- [ ] **Step 2: Write the integration test**

Create `tests/integration/daemon/daemon-lifecycle.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the integration tests**

```bash
cd /Users/andrea.dodero/pi_autopilot
npx vitest run tests/integration/daemon/daemon-lifecycle.test.ts
```

Expected: all tests pass (may take a few seconds per test due to process spawning).

- [ ] **Step 4: Run full suite + typecheck + build**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck && npm test && npm run build
```

Expected: all tests pass, typecheck clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/daemon/
git commit -m "test(daemon): add integration tests for daemon lifecycle"
```

---

## Task 12: Final verification pass

- [ ] **Step 1: Run the full suite**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm test
```

Expected: all tests pass (388 existing + new daemon/start/stop/status-daemon/integration tests).

- [ ] **Step 2: Typecheck**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Production build**

```bash
cd /Users/andrea.dodero/pi_autopilot
npm run build
```

Expected: build succeeds; `dist/daemon/daemon-entry.js` exists.

- [ ] **Step 4: Smoke test help output**

```bash
cd /Users/andrea.dodero/pi_autopilot
node dist/cli.js --help
node dist/cli.js start --help
node dist/cli.js stop --help
node dist/cli.js status --help
```

Expected: `start`, `stop`, and the updated `status` descriptions are present.

- [ ] **Step 5: Check acceptance criteria against spec**

Cross-reference each of the 11 acceptance criteria in `docs/superpowers/specs/2026-08-21-pi-autopilot-m3-design.md §10`:

1. `start <list>` resolves and spawns → covered by Task 8 unit tests + Task 11 integration test.
2. `start --from-analyze` loads executable list → Task 8 unit tests.
3. Sequential queue, one at a time → Task 5 unit tests + Task 11 integration test.
4. Outcome recorded in queue.json, visible in status → Task 3 (QueueStore) + Task 9 (status).
5. Auto-resume on crash, FAILED on non-resumable → Task 5 unit tests (reconciliation scenarios).
6. `stop` sends SIGTERM, daemon exits cleanly → Task 7 unit tests + Task 11 integration.
7. SIGTERM never kills mid-flight stage → Task 5 (flag checked between issues, not inside run).
8. `start` exits 1 if daemon already running → Task 8 unit tests.
9. Stale PID cleaned transparently → Task 2 (PidFile.isLive ESRCH) + Task 8 integration.
10. `status` renders daemon block → Task 9 unit tests.
11. M1+M2 suite green, typecheck, build pass → this step.

- [ ] **Step 6: Final commit**

```bash
cd /Users/andrea.dodero/pi_autopilot
git log --oneline -15
```

Confirm all task commits are present, then tag the milestone:

```bash
git tag m3-complete
```

---

## Self-Review Notes

**Spec coverage check:**
- §4.1 `--refiner-timeout` and all model/thinking flags → wired in `start.ts` options. ✓
- §5.1 `generatedAt` sort for latest report → `findLatestBacklogReport` sorts by `generatedAt`. ✓
- §5.2 PID written by child, not parent → `daemon-entry.ts` calls `pidFile.writePid(process.pid)`. ✓
- §5.4 flush queue + delete PID on SIGTERM → `DaemonRunner.run()` writes queue and calls `pidFile.delete()` on exit. ✓
- §7.1 EPERM treated as "live" → `PidFile.isLive()` handles EPERM. ✓
- §8 stale PID in `start` → `PidFile.isLive()` deletes stale file; `start` calls `isLive()` before spawning. ✓
- §8 `stop` timeout message → `stop.ts` prints exact message from spec. ✓
- §9 out-of-scope items → none introduced. ✓
- §10 AC #7 "never mid-flight" → SIGTERM flag is checked in the `while` loop condition, not inside `runService.start()`. ✓

**Type consistency:** `CompletedRun.outcome` is `"PR_OPEN" | "BLOCKED" | "NEEDS_REFINEMENT" | "FAILED"` in Task 3 and cast from `RunSummary.stage` (which is `RunStage`) in `DaemonRunner` — the cast is safe because only these four stages are terminal and reachable from a `RunService.start()` call.
