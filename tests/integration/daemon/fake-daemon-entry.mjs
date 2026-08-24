/**
 * Test-only daemon entry shim. Replaces the real daemon-entry.ts in
 * integration tests. Reads the queue, runs a fake "RunService" that
 * immediately returns the outcome specified in FAKE_OUTCOME env var
 * (default: PR_OPEN), and exits.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const dataDir =
  process.env.AUTOPILOT_DATA_DIR ??
  path.join(homedir(), ".local", "share", "pi-autopilot");

const daemonDir = path.join(dataDir, "daemon");
const pidPath = path.join(daemonDir, "pid");
const queuePath = path.join(daemonDir, "queue.json");
const queuePendingPath = path.join(daemonDir, "queue-pending.json");
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

function drainPendingQueue(queue) {
  if (!existsSync(queuePendingPath)) return false;
  const pending = JSON.parse(readFileSync(queuePendingPath, "utf8"));
  const newIssues = pending.issues.filter(
    (issueNum) => !queue.issues.includes(issueNum)
  );
  if (newIssues.length === 0) {
    atomicWrite(queuePendingPath, JSON.stringify({ issues: [] }));
    return false;
  }
  queue.issues.push(...newIssues);
  atomicWrite(queuePath, JSON.stringify(queue, null, 2));
  atomicWrite(queuePendingPath, JSON.stringify({ issues: [] }));
  log(`drained ${newIssues.length} issue(s) from pending queue: ${newIssues.join(", ")}`);
  return true;
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

// Drain pending queue once before starting the main loop
drainPendingQueue(queue);

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
  if (queue.scheduler !== undefined) {
    const schedulerIssue = queue.scheduler.issues.find((issue) => issue.issueNumber === issueNumber);
    if (schedulerIssue !== undefined) {
      schedulerIssue.state = "COMPLETED";
      schedulerIssue.outcome = fakeOutcome;
      schedulerIssue.runId = `fake-run-${issueNumber}`;
    }
    queue.scheduler.lastUpdatedAt = new Date().toISOString();
  }
  atomicWrite(queuePath, JSON.stringify(queue, null, 2));
  log(`run complete issue=${issueNumber} outcome=${fakeOutcome}`);
  // Drain pending queue after each iteration
  drainPendingQueue(queue);
}

log("queue exhausted");
try { unlinkSync(pidPath); } catch {}
process.exit(0);
