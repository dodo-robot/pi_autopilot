import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface PendingQuestion {
  seq: number;
  question: string;
  context: string;
}

export interface AnswerPumpOptions {
  /** Directory where the guarded `ask_human` tool writes `NNN-question.json`. */
  askDir: string;
  /**
   * Prompts the operator for an answer to one question. Returns the answer text.
   * Swappable so tests avoid real stdin and a future UI can replace the console.
   */
  promptFn: (question: string, context: string) => Promise<string>;
  pollIntervalMs?: number;
}

/**
 * Watches a run's `ask` directory for question files written by the guard's
 * `ask_human` tool and answers them (one at a time, in sequence) by writing a
 * corresponding `NNN-answer.json`. Runs concurrently with the pi child while
 * `BootstrapService` awaits it. Each question is answered exactly once.
 */
export class AnswerPump {
  private readonly askDir: string;
  private readonly promptFn: AnswerPumpOptions["promptFn"];
  private readonly pollIntervalMs: number;
  private stopping = false;
  private started = false;
  private readonly answeredSeqs = new Set<number>();

  constructor(options: AnswerPumpOptions) {
    this.askDir = options.askDir;
    this.promptFn = options.promptFn;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
  }

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  /** Stop polling after the current answer (if any) completes. */
  stop(): void {
    this.stopping = true;
  }

  private async run(): Promise<void> {
    mkdirSync(this.askDir, { recursive: true });
    while (!this.stopping) {
      await this.pollOnce();
      await sleep(this.pollIntervalMs);
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.askDir === undefined || !existsSync(this.askDir)) return;
    // Find the lowest unanswered question index, guarding against both files
    // appearing mid-loop. Answer strictly in ascending seq order so the model
    // always receives its answers in the order it asked.
    for (let seq = 0; ; seq += 1) {
      const questionFile = path.join(this.askDir, `${String(seq).padStart(3, "0")}-question.json`);
      const answerFile = path.join(this.askDir, `${String(seq).padStart(3, "0")}-answer.json`);
      if (!existsSync(questionFile)) break; // no further questions yet
      if (existsSync(answerFile)) continue; // already answered
      if (this.answeredSeqs.has(seq)) continue;
      await this.answer(seq, questionFile);
      return; // answered one; loop returns to the top for the next poll
    }
  }

  private async answer(seq: number, questionFile: string): Promise<void> {
    let pending: PendingQuestion;
    try {
      pending = JSON.parse(readFileSync(questionFile, "utf8")) as PendingQuestion;
    } catch {
      return; // malformed or half-written; retry next tick
    }
    try {
      const answer = await this.promptFn(pending.question, pending.context);
      this.answeredSeqs.add(seq);
      writeFileSync(
        path.join(this.askDir, `${String(seq).padStart(3, "0")}-answer.json`),
        JSON.stringify({ answer }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      // Prompt failed (e.g. no usable stdin). Do not mark answered so the next
      // tick retries; the caller's default console handler surfaces the error.
    }
  }
}
