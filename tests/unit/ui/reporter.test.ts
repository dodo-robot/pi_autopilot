import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FRAMES,
  Reporter,
  composeSpinner,
  formatDaemonStatus,
} from "../../../src/ui/reporter.js";
import { createInitialSchedulerState } from "../../../src/scheduler/state.js";

const CLEAR_LINE = "\r\x1b[2K";

describe("composeSpinner", () => {
  it("renders an ANSI repaint sequence when interactive", () => {
    expect(composeSpinner("refining issue #42", DEFAULT_FRAMES[0], true)).toBe(
      `${CLEAR_LINE}${DEFAULT_FRAMES[0]} refining issue #42`,
    );
  });

  it("renders a plain non-ANSI status line when piped", () => {
    expect(composeSpinner("refining issue #42", DEFAULT_FRAMES[0], false)).toBe(
      `${DEFAULT_FRAMES[0]} refining issue #42`,
    );
  });
});

describe("Reporter", () => {
  let emit: ReturnType<typeof vi.fn<(text: string) => void>>;
  let rawWrite: ReturnType<typeof vi.fn<(chunk: string) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    emit = vi.fn();
    rawWrite = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits lines verbatim through the emit sink", () => {
    const reporter = new Reporter({ emit, write: rawWrite, isTTY: false });
    reporter.line("→ resolving issue #42");
    expect(emit).toHaveBeenCalledExactlyOnceWith("→ resolving issue #42");
    expect(rawWrite).not.toHaveBeenCalled();
  });

  it("does not write live spinner bytes when piped (non-TTY)", () => {
    const reporter = new Reporter({ emit, write: rawWrite, isTTY: false });
    reporter.setSpinner("refining issue #42");
    vi.advanceTimersByTime(500);
    expect(rawWrite).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("commits the final spinner status on stopSpinner when requested", () => {
    const reporter = new Reporter({ emit, write: rawWrite, isTTY: false });
    reporter.setSpinner("refining issue #42");
    reporter.stopSpinner({ commit: "refining issue #42" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("refining issue #42");
  });

  it("animates the spinner on a TTY and clears it on stop", () => {
    const reporter = new Reporter({ emit, write: rawWrite, isTTY: true });
    reporter.setSpinner("implementing");
    // First tick writes a frame.
    vi.runOnlyPendingTimers();
    expect(rawWrite).toHaveBeenCalled();
    expect(rawWrite.mock.calls[0]?.[0]).toContain("\x1b[2K");
    expect(rawWrite.mock.calls[0]?.[0]).toContain("implementing");

    // A committed line while the spinner is active first clears the live line.
    reporter.line("→ phase: implementation");
    expect(rawWrite).toHaveBeenLastCalledWith(CLEAR_LINE);

    // Closing the spinner stops the interval and clears the line again.
    rawWrite.mockClear();
    reporter.close();
    expect(rawWrite).toHaveBeenCalledWith(CLEAR_LINE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the pending interval so the process is not held open", () => {
    const reporter = new Reporter({ emit, write: rawWrite, isTTY: true });
    reporter.setSpinner("working");
    expect(vi.getTimerCount()).toBe(1);
    reporter.close();
    expect(vi.getTimerCount()).toBe(0);
    // close is idempotent.
    reporter.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops animating after stopSpinner (no more repaints)", () => {
    const reporter = new Reporter({ emit, write: rawWrite, isTTY: true });
    reporter.setSpinner("refining");
    reporter.stopSpinner({ commit: "refinement complete" });
    // The ticker must be cancelled: clear the writes from the initial frames,
    // then advance time and assert nothing further is repainted — otherwise
    // the spinner erases a subsequent interactive prompt.
    rawWrite.mockClear();
    vi.advanceTimersByTime(1000);
    expect(rawWrite).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("formatDaemonStatus", () => {
  it("formats scheduler daemon status with summary and issue table", () => {
    const output = formatDaemonStatus({
      pid: 123,
      uptimeMs: 60_000,
      currentIssue: null,
      currentStage: null,
      currentStartedAt: null,
      remainingIssues: [],
      completedRuns: [],
      scheduler: createInitialSchedulerState({
        policy: { maxConcurrentRuns: 2, idleTimeoutMinutes: 0, budgets: { maxElapsedMinutes: 120, maxStartedRuns: 10, maxFailedRuns: 3 } },
        startedAt: "2026-08-24T00:00:00.000Z",
        issues: [
          { issueNumber: 1, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/a/**"], source: "issue-contract" }, initialState: "PENDING", reason: "ready" },
          { issueNumber: 2, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/b/**"], source: "issue-contract" }, initialState: "DEFERRED_DEPENDENCY", reason: "waiting for #1" },
          { issueNumber: 3, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/c/**"], source: "issue-contract" }, initialState: "DEFERRED_CONFLICT", reason: "conflicts with #1" },
          { issueNumber: 4, dependencies: [], workspaceScope: { kind: "paths", patterns: ["src/d/**"], source: "issue-contract" }, initialState: "DEFERRED_INVALID", reason: "cycle detected" },
        ],
      }),
    });

    expect(output).toContain("scheduler 0/2 active");
    expect(output).toContain("Active     (none)");
    expect(output).toContain("Pending    1 pending, 1 dependency-blocked, 1 conflict-blocked, 1 invalid");
    expect(output).toContain("Issue");
    expect(output).toContain("#1");
    expect(output).toContain("PENDING");
  });
});
