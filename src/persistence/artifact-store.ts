import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../platform/paths.js";

/** Stable reference to an artifact inside a run's artifact directory. */
export interface ArtifactRef {
  runId: string;
  /** Path relative to the run's artifact directory. */
  relative: string;
}

const EVENTS_FILE = "events.jsonl";

/**
 * Persists run artifacts as atomic files. JSON payloads are written to a
 * temporary sibling file and renamed into place so readers never observe a
 * partially written artifact.
 */
export class ArtifactStore {
  constructor(private readonly paths: AppPaths) {}

  async writeJson(
    runId: string,
    relative: string,
    data: unknown,
  ): Promise<ArtifactRef> {
    const target = this.paths.artifactPath(runId, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, target);
    return { runId, relative };
  }

  async readJson<T = unknown>(runId: string, relative: string): Promise<T> {
    const raw = await readFile(this.paths.artifactPath(runId, relative), "utf8");
    return JSON.parse(raw) as T;
  }

  /** Append one event line to the run's JSONL event log. */
  async appendEvent(runId: string, event: unknown): Promise<void> {
    const target = this.paths.artifactPath(runId, EVENTS_FILE);
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
  }
}
