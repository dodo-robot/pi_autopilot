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
try { unlinkSync(pidPath); } catch {}
process.exit(0);
