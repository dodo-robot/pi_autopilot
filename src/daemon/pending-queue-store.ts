import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface PendingQueue {
  issues: number[];
}

export class PendingQueueStore {
  private readonly pendingQueuePath: string;
  private readonly daemonDir: string;
  private readonly tmpPath: string;

  constructor(deps: { pendingQueuePath: string; daemonDir: string }) {
    this.pendingQueuePath = deps.pendingQueuePath;
    this.daemonDir = deps.daemonDir;
    this.tmpPath = `${deps.pendingQueuePath}.tmp`;
  }

  private write(queue: PendingQueue): void {
    mkdirSync(this.daemonDir, { recursive: true });
    writeFileSync(this.tmpPath, JSON.stringify(queue, null, 2));
    renameSync(this.tmpPath, this.pendingQueuePath);
  }

  private read(): PendingQueue {
    if (!existsSync(this.pendingQueuePath)) return { issues: [] };
    const raw = readFileSync(this.pendingQueuePath, "utf8");
    return JSON.parse(raw) as PendingQueue;
  }

  /** Called by `queue add`: read-modify-atomic-write, appending to any
   * existing pending list. */
  append(issues: number[]): void {
    const current = this.read();
    this.write({ issues: [...current.issues, ...issues] });
  }

  /** Called by the daemon: read current contents, atomically reset to
   * `{ issues: [] }`, and return what was read. Always consumes everything
   * present at read time. */
  drainAll(): number[] {
    const current = this.read();
    this.write({ issues: [] });
    return current.issues;
  }
}
