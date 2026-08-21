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
