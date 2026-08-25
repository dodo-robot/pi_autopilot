import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/persistence/artifact-store.js";
import { appPaths } from "../../../src/platform/paths.js";

const pointer = {
  analysisId: "reconcile-1-12",
  epicRef: 12,
  repository: { owner: "acme", repo: "widgets" },
  appliedAt: "2026-08-25T00:00:00.000Z",
};

describe("ArtifactStore latest-apply pointer", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a latest-apply pointer and points it at the newest apply per epic", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    dirs.push(dataDir);
    const store = new ArtifactStore(appPaths(dataDir));

    await store.writeLatestApply("acme", "widgets", 12, pointer);
    expect(await store.readLatestApply("acme", "widgets", 12)).toEqual(pointer);

    // A second write for the same epic replaces the pointer.
    const newer = { ...pointer, analysisId: "reconcile-2-12", appliedAt: "2026-08-25T01:00:00.000Z" };
    await store.writeLatestApply("acme", "widgets", 12, newer);
    expect(await store.readLatestApply("acme", "widgets", 12)).toEqual(newer);
  });

  it("returns null when the pointer was never written, and tolerates a corrupt pointer", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    dirs.push(dataDir);
    const store = new ArtifactStore(appPaths(dataDir));

    expect(await store.readLatestApply("acme", "widgets", 99)).toBeNull();

    // Corrupt the file on disk to emulate a torn write.
    await store.writeLatestApply("acme", "widgets", 12, pointer);
    const target = appPaths(dataDir).latestApplyPath("acme", "widgets", 12);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, "not json{{");
    expect(await store.readLatestApply("acme", "widgets", 12)).toBeNull();
  });

  it("rejects unsafe pointer segments and non-positive epic numbers", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    dirs.push(dataDir);
    const paths = appPaths(dataDir);
    expect(() => paths.latestApplyPath("..", "widgets", 12)).toThrow(/unsafe pointer segment/);
    expect(() => paths.latestApplyPath("acme", "widgets", 0)).toThrow(/unsafe epic number/);
  });
});
