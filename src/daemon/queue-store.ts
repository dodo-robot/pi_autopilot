import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RepositoryRef } from "../domain/contracts.js";
import type { RunOverrides } from "../workflow/run-service.js";

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
  overrides?: RunOverrides;
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
