import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FRAMES,
  Reporter,
  composeSpinner,
} from "../../../src/ui/reporter.js";

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
