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
