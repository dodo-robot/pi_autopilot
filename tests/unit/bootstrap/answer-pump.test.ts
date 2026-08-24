import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sleep } from "../../../src/bootstrap/answer-pump.js";

const dirs: string[] = [];

function makeAskDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ap-pump-"));
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function writeQuestion(dir: string, seq: number, question: string): string {
  const file = path.join(dir, `${String(seq).padStart(3, "0")}-question.json`);
  writeFileSync(file, JSON.stringify({ seq, question, context: "ctx" }), "utf8");
  return file;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("AnswerPump", () => {
  it("answers a single question via the prompt and writes the answer file", async () => {
    const dir = makeAskDir();
    const answered: Array<{ question: string }> = [];
    const { AnswerPump } = await import("../../../src/bootstrap/answer-pump.js");
    const pump = new AnswerPump({
      askDir: dir,
      promptFn: async (q) => {
        answered.push({ question: q });
        return "M1 only";
      },
    });
    pump.start();
    writeQuestion(dir, 0, "Which scope?");
    // Wait for the pump to see it, prompt, and write the answer.
    await sleep(300);
    const answerFile = path.join(dir, "000-answer.json");
    expect(existsSync(answerFile)).toBe(true);
    expect(JSON.parse(readFileSync(answerFile, "utf8"))).toMatchObject({ answer: "M1 only" });
    expect(answered).toEqual([{ question: "Which scope?" }]);
    pump.stop();
  });

  it("answers multiple questions in sequence", async () => {
    const dir = makeAskDir();
    const { AnswerPump } = await import("../../../src/bootstrap/answer-pump.js");
    const pump = new AnswerPump({
      askDir: dir,
      promptFn: async (q) => `answer:${q.length}`,
    });
    pump.start();
    writeQuestion(dir, 0, "Q1");
    await sleep(250);
    writeQuestion(dir, 1, "Q2 longer");
    await sleep(250);
    const answers = [0, 1].map((i) =>
      JSON.parse(readFileSync(path.join(dir, `${String(i).padStart(3, "0")}-answer.json`), "utf8")),
    );
    expect(answers[0]).toMatchObject({ answer: "answer:2" });
    expect(answers[1]).toMatchObject({ answer: "answer:9" });
    pump.stop();
  });

  it("does not answer the same question twice", async () => {
    const dir = makeAskDir();
    const { AnswerPump } = await import("../../../src/bootstrap/answer-pump.js");
    let calls = 0;
    const pump = new AnswerPump({
      askDir: dir,
      promptFn: async () => {
        calls += 1;
        return "a";
      },
    });
    pump.start();
    writeQuestion(dir, 0, "Q");
    await sleep(250);
    // The pump should not re-ask once 000-answer.json exists.
    await sleep(250);
    expect(JSON.parse(readFileSync(path.join(dir, "000-answer.json"), "utf8"))).toMatchObject({
      answer: "a",
    });
    expect(calls).toBe(1);
    pump.stop();
  });
});
