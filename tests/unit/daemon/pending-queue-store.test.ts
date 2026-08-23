import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingQueueStore } from "../../../src/daemon/pending-queue-store.js";

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(): PendingQueueStore {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pending-queue-test-"));
  const daemonDir = path.join(tmpDir, "daemon");
  return new PendingQueueStore({
    pendingQueuePath: path.join(daemonDir, "queue-pending.json"),
    daemonDir,
  });
}

describe("PendingQueueStore", () => {
  it("drainAll returns an empty array when no file exists yet", () => {
    const store = makeStore();
    expect(store.drainAll()).toEqual([]);
  });

  it("append then drainAll round-trips the issue numbers", () => {
    const store = makeStore();
    store.append([42, 43]);
    expect(store.drainAll()).toEqual([42, 43]);
  });

  it("multiple appends accumulate before a drain", () => {
    const store = makeStore();
    store.append([1]);
    store.append([2, 3]);
    expect(store.drainAll()).toEqual([1, 2, 3]);
  });

  it("drainAll empties the file so a second drain returns nothing new", () => {
    const store = makeStore();
    store.append([42]);
    expect(store.drainAll()).toEqual([42]);
    expect(store.drainAll()).toEqual([]);
  });

  it("append after a drain starts a fresh list", () => {
    const store = makeStore();
    store.append([1]);
    store.drainAll();
    store.append([2]);
    expect(store.drainAll()).toEqual([2]);
  });
});
