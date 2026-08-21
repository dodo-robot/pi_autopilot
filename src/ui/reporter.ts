export const DEFAULT_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Erase the current line and return carriage to its start. */
const CLEAR_LINE = "\r\x1b[2K";

/** A spinner prefix for a blink phase. */
function framePrefix(frame: string, isTTY: boolean): string {
  return isTTY ? `${CLEAR_LINE}${frame} ` : `${frame} `;
}

/**
 * Compose a single spinner display line for the given frame and terminal
 * mode. Interactive terminals receive an ANSI repaint sequence; piped output
 * receives a plain, non-ANSI line so downstream consumers (pipes, CI logs,
 * `--json` capture) stay clean.
 */
export function composeSpinner(text: string, frame: string, isTTY: boolean): string {
  return `${framePrefix(frame, isTTY)}${text}`;
}

export interface ReporterDeps {
  /** Committed-line writer; the caller is responsible for the trailing newline. */
  emit: (text: string) => void;
  /** Raw chunk writer used to repaint the live spinner on a TTY. */
  write: (chunk: string) => void;
  /** Whether the destination is an interactive terminal (animation on). */
  isTTY: boolean;
}

export interface ReporterOptions {
  frames?: readonly string[];
  intervalMs?: number;
}

/**
 * Build a TTY-aware reporter bound to the given committed-line writer. The
 * live spinner repaints to `process.stdout`; pass a `depsIsTTY` override for
 * tests (e.g. a pegged terminal) that should not touch the real process
 * stream when non-interactive.
 */
export function createReporter(emit: (text: string) => void, depsIsTTY?: boolean): Reporter {
  return new Reporter({
    emit,
    write: (chunk) => process.stdout.write(chunk),
    isTTY: depsIsTTY ?? process.stdout.isTTY === true,
  });
}

interface StopOptions {
  /** Commit this text as a permanent line after the spinner stops. */
  commit?: string;
}

/**
 * Foreground feedback for human-visible command progress: committed lines
 * plus a single live spinner line. The spinner animates only when output is
 * attached to an interactive terminal; piped/non-interactive output degrades
 * to committed lines with no ANSI. All timers are cleared on {@link close},
 * so an abandoned reporter never keeps the process alive.
 */
export class Reporter {
  private readonly frames: readonly string[];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private spinnerText: string | null = null;

  constructor(
    private readonly deps: ReporterDeps,
    options: ReporterOptions = {},
  ) {
    this.frames = options.frames ?? DEFAULT_FRAMES;
    this.intervalMs = options.intervalMs ?? 80;
  }

  /** Commit a permanent, non-animated line. */
  line(text: string): void {
    this.clearLive();
    this.deps.emit(text);
  }

  /** Set or update the live spinner status line. */
  setSpinner(text: string): void {
    this.spinnerText = text;
    if (!this.deps.isTTY) return;
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
    this.tick();
  }

  /** Stop the spinner; optionally promote its final state to a committed line. */
  stopSpinner(options: StopOptions = {}): void {
    this.clearLive();
    this.cancelTimer();
    if (options.commit !== undefined) {
      this.deps.emit(options.commit);
    }
  }

  /** Stop the spinner and guarantee no timers remain (idempotent). */
  close(): void {
    this.clearLive();
    this.cancelTimer();
    this.spinnerText = null;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const text = this.spinnerText;
    if (text === null) return;
    const frame =
      this.frames[this.frameIndex % this.frames.length] ?? this.frames[0] ?? "";
    this.frameIndex += 1;
    this.deps.write(composeSpinner(text, frame, this.deps.isTTY));
  }

  private clearLive(): void {
    if (this.deps.isTTY && this.timer !== null) {
      this.deps.write(CLEAR_LINE);
    }
  }
}
