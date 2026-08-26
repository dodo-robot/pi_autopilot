import { describe, expect, it } from "vitest";
import {
  BudgetTracker,
  fingerprintFailure,
  type Failure,
} from "../../../src/workflow/budgets.js";

const baseLimits = {
  implementation: { timeoutMinutes: 60, maxAttempts: 3 },
  review: { timeoutMinutes: 20, maxCorrectionCycles: 2 },
};

function makeFailure(overrides: Partial<Failure> = {}): Failure {
  return {
    stage: "VERIFICATION",
    command: "npm test",
    exitCode: 1,
    findings: ["src/a.ts: assertion"],
    ...overrides,
  };
}

describe("fingerprintFailure", () => {
  it("returns a 64-char hex sha256 digest", () => {
    const digest = fingerprintFailure(makeFailure());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same fingerprint for tool-identical failures with volatile noise", () => {
    const a = fingerprintFailure(
      makeFailure({
        findings: ["  src/a.ts:12: assertion failed (took 42ms)  "],
      }),
    );
    const b = fingerprintFailure(
      makeFailure({
        findings: ["src/a.ts:99: assertion failed (took 8371ms)"],
      }),
    );
    expect(a).toBe(b);
  });

  it("produces the same fingerprint regardless of findings order", () => {
    const a = fingerprintFailure(
      makeFailure({ findings: ["alpha broke", "beta broke"] }),
    );
    const b = fingerprintFailure(
      makeFailure({ findings: ["beta broke", "alpha broke"] }),
    );
    expect(a).toBe(b);
  });

  it("produces different fingerprints for unrelated failures", () => {
    const a = fingerprintFailure(makeFailure({ findings: ["assertion in a.ts"] }));
    const b = fingerprintFailure(
      makeFailure({ command: "npm run lint", findings: ["unused var in b.ts"] }),
    );
    expect(a).not.toBe(b);
  });

  it("produces different fingerprints for different exit codes", () => {
    const a = fingerprintFailure(makeFailure({ exitCode: 1 }));
    const b = fingerprintFailure(makeFailure({ exitCode: 2 }));
    expect(a).not.toBe(b);
  });

  it("produces different fingerprints for different stages", () => {
    const a = fingerprintFailure(makeFailure({ stage: "VERIFICATION" }));
    const b = fingerprintFailure(makeFailure({ stage: "IMPLEMENTATION" }));
    expect(a).not.toBe(b);
  });

  it("produces different fingerprints for findings that differ only by a substantive numeric literal", () => {
    const a = fingerprintFailure(
      makeFailure({ findings: ["expected 3 items, got 5"] }),
    );
    const b = fingerprintFailure(
      makeFailure({ findings: ["expected 3 items, got 7"] }),
    );
    expect(a).not.toBe(b);
  });

  it("still collapses genuinely volatile path/line-number differences to the same fingerprint", () => {
    const a = fingerprintFailure(
      makeFailure({ findings: ["src/a.ts:12:4: assertion failed"] }),
    );
    const b = fingerprintFailure(
      makeFailure({ findings: ["src/a.ts:99:1: assertion failed"] }),
    );
    expect(a).toBe(b);
  });
});

describe("BudgetTracker.recordFailure", () => {
  it("returns CONTINUE on the first failure", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 0 },
      baseLimits,
    );
    expect(tracker.recordFailure(makeFailure()).decision).toBe("CONTINUE");
  });

  it("blocks on a repeated normalized fingerprint (same failure twice)", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 0 },
      baseLimits,
    );
    const failure = makeFailure();
    tracker.recordFailure(failure);
    expect(tracker.recordFailure(failure).decision).toBe("BLOCK_REPEATED_FAILURE");
  });

  it("does not block on two distinct failures", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 0 },
      baseLimits,
    );
    tracker.recordFailure(makeFailure({ findings: ["first problem"] }));
    const result = tracker.recordFailure(
      makeFailure({ command: "npm run lint", findings: ["second problem"] }),
    );
    expect(result.decision).toBe("CONTINUE");
  });

  it("allows exactly maxAttempts implementation attempts before exhausting the budget", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 2, correctionCycles: 0 },
      baseLimits,
    );
    // Third distinct attempt failure is still within the 3-attempt ceiling...
    const first = tracker.recordFailure(
      makeFailure({ stage: "IMPLEMENTATION", findings: ["attempt 3 problem"] }),
    );
    expect(first.decision).toBe("CONTINUE");
  });

  it("blocks with BLOCK_BUDGET_EXHAUSTED once implementation attempts reach maxAttempts", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 3, correctionCycles: 0 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "IMPLEMENTATION", findings: ["attempt 4 problem"] }),
    );
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });

  it("blocks with BLOCK_BUDGET_EXHAUSTED once VERIFICATION failures reach the implementation attempt maxAttempts", () => {
    // A VERIFICATION-stage failure spends the same implementation attempt
    // budget as an IMPLEMENTATION-stage failure: a run whose verification
    // fails with a different finding every time (so the repeated-failure
    // fingerprint never fires) must still be bounded by maxAttempts.
    const tracker = new BudgetTracker(
      { implementationAttempts: 3, correctionCycles: 0 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "VERIFICATION", findings: ["attempt 4 verification problem"] }),
    );
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
    expect(result.reason).toContain("implementation attempts exhausted");
  });

  it("allows exactly maxAttempts VERIFICATION failures before exhausting the budget", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 2, correctionCycles: 0 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "VERIFICATION", findings: ["attempt 3 verification problem"] }),
    );
    expect(result.decision).toBe("CONTINUE");
  });

  it("blocks with BLOCK_BUDGET_EXHAUSTED once correction cycles reach maxCorrectionCycles", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 2 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "CORRECTION", findings: ["cycle 3 problem"] }),
    );
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });

  it("allows exactly maxCorrectionCycles (boundary is not-yet-exhausted)", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 1 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "CORRECTION", findings: ["cycle 2 problem"] }),
    );
    expect(result.decision).toBe("CONTINUE");
  });

  it("blocks with BLOCK_BUDGET_EXHAUSTED once ACCEPTANCE_VERIFICATION failures reach maxCorrectionCycles", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 2 },
      baseLimits,
    );
    const result = tracker.recordFailure(
      makeFailure({ stage: "ACCEPTANCE_VERIFICATION", findings: ["criterion 3 unmet"] }),
    );
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });

  it("shares the correction-cycle counter between INDEPENDENT_REVIEW and ACCEPTANCE_VERIFICATION failures", () => {
    // One CHANGES_REQUESTED plus one NOT_VERIFIED must together exhaust a
    // 2-cycle budget -- they are not two independent budgets. `counters` is
    // the same mutable object the tracker reads on every call, mirroring how
    // RunAttempt shares one counters object with its BudgetTracker (see
    // src/workflow/run-service.ts:396-407).
    const counters = { implementationAttempts: 0, correctionCycles: 0 };
    const tracker = new BudgetTracker(counters, baseLimits);

    const first = tracker.recordFailure(
      makeFailure({ stage: "INDEPENDENT_REVIEW", findings: ["review issue"] }),
    );
    expect(first.decision).toBe("CONTINUE");
    counters.correctionCycles += 1;

    const second = tracker.recordFailure(
      makeFailure({ stage: "ACCEPTANCE_VERIFICATION", findings: ["criterion unmet"] }),
    );
    expect(second.decision).toBe("CONTINUE");
    counters.correctionCycles += 1;

    const third = tracker.recordFailure(
      makeFailure({ stage: "ACCEPTANCE_VERIFICATION", findings: ["still unmet"] }),
    );
    expect(third.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });
});

describe("BudgetTracker.checkDeadline", () => {
  it("returns CONTINUE when elapsed time is within the stage timeout", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 0 },
      baseLimits,
    );
    const result = tracker.checkDeadline("IMPLEMENTATION", 10 * 60_000);
    expect(result.decision).toBe("CONTINUE");
  });

  it("returns BLOCK_BUDGET_EXHAUSTED when elapsed time exceeds the stage timeout", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 0 },
      baseLimits,
    );
    const result = tracker.checkDeadline("IMPLEMENTATION", 61 * 60_000);
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });

  it("uses the review timeout for CORRECTION/INDEPENDENT_REVIEW stages", () => {
    const tracker = new BudgetTracker(
      { implementationAttempts: 0, correctionCycles: 0 },
      baseLimits,
    );
    const result = tracker.checkDeadline("INDEPENDENT_REVIEW", 21 * 60_000);
    expect(result.decision).toBe("BLOCK_BUDGET_EXHAUSTED");
  });
});
