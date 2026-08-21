import { describe, expect, it } from "vitest";
import {
  assertTransition,
  nextStage,
  ALL_RUN_STAGES,
  TERMINAL_STAGES,
} from "../../../src/workflow/state-machine.js";
import type { RunStage } from "../../../src/domain/contracts.js";

describe("assertTransition", () => {
  const legalEdges: Array<[RunStage, RunStage]> = [
    ["PREFLIGHT", "READINESS_CHECK"],
    ["READINESS_CHECK", "WORKSPACE_CREATION"],
    ["READINESS_CHECK", "NEEDS_REFINEMENT"],
    ["READINESS_CHECK", "FAILED"],
    ["WORKSPACE_CREATION", "IMPLEMENTATION"],
    ["WORKSPACE_CREATION", "FAILED"],
    ["IMPLEMENTATION", "VERIFICATION"],
    ["IMPLEMENTATION", "BLOCKED"],
    ["IMPLEMENTATION", "NEEDS_REFINEMENT"],
    ["IMPLEMENTATION", "FAILED"],
    ["VERIFICATION", "INDEPENDENT_REVIEW"],
    ["VERIFICATION", "IMPLEMENTATION"],
    ["VERIFICATION", "BLOCKED"],
    ["VERIFICATION", "FAILED"],
    ["INDEPENDENT_REVIEW", "PUBLICATION"],
    ["INDEPENDENT_REVIEW", "CORRECTION"],
    ["INDEPENDENT_REVIEW", "NEEDS_REFINEMENT"],
    ["INDEPENDENT_REVIEW", "BLOCKED"],
    ["INDEPENDENT_REVIEW", "FAILED"],
    ["CORRECTION", "IMPLEMENTATION"],
    ["CORRECTION", "BLOCKED"],
    ["CORRECTION", "FAILED"],
    ["PUBLICATION", "PR_OPEN"],
    ["PUBLICATION", "FAILED"],
    ["BLOCKED", "IMPLEMENTATION"],
    ["BLOCKED", "CORRECTION"],
  ];

  it.each(legalEdges)("allows %s -> %s", (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it("allows cancellation from every nonterminal, non-BLOCKED stage", () => {
    const cancellable = ALL_RUN_STAGES.filter(
      (stage) => !TERMINAL_STAGES.has(stage) && stage !== "BLOCKED",
    );
    for (const stage of cancellable) {
      expect(() => assertTransition(stage, "CANCELLED")).not.toThrow();
    }
  });

  it("rejects IMPLEMENTATION -> PUBLICATION (publication only after review approval)", () => {
    expect(() => assertTransition("IMPLEMENTATION", "PUBLICATION")).toThrow(
      "illegal transition",
    );
  });

  it("rejects VERIFICATION -> PUBLICATION (must pass through INDEPENDENT_REVIEW)", () => {
    expect(() => assertTransition("VERIFICATION", "PUBLICATION")).toThrow(
      "illegal transition",
    );
  });

  it.each(Array.from(TERMINAL_STAGES))(
    "rejects any outgoing edge from terminal stage %s",
    (terminal) => {
      for (const target of ALL_RUN_STAGES) {
        if (target === terminal) continue;
        expect(() => assertTransition(terminal, target)).toThrow(
          "illegal transition",
        );
      }
    },
  );

  it("rejects automatic-looking edges out of BLOCKED that assertTransition does not special-case (e.g. BLOCKED -> VERIFICATION)", () => {
    expect(() => assertTransition("BLOCKED", "VERIFICATION")).toThrow(
      "illegal transition",
    );
  });

  it("rejects an unknown reverse edge", () => {
    expect(() => assertTransition("CORRECTION", "PREFLIGHT")).toThrow(
      "illegal transition",
    );
  });
});

describe("nextStage", () => {
  it("moves READINESS_CHECK -> WORKSPACE_CREATION on READY", () => {
    expect(
      nextStage(
        { type: "READY" },
        { stage: "READINESS_CHECK", correctionCycles: 0 },
      ),
    ).toBe("WORKSPACE_CREATION");
  });

  it("moves READINESS_CHECK -> NEEDS_REFINEMENT on READINESS_FAILED", () => {
    expect(
      nextStage(
        { type: "READINESS_FAILED" },
        { stage: "READINESS_CHECK", correctionCycles: 0 },
      ),
    ).toBe("NEEDS_REFINEMENT");
  });

  it("moves WORKSPACE_CREATION -> IMPLEMENTATION on WORKSPACE_READY", () => {
    expect(
      nextStage(
        { type: "WORKSPACE_READY" },
        { stage: "WORKSPACE_CREATION", correctionCycles: 0 },
      ),
    ).toBe("IMPLEMENTATION");
  });

  it("moves IMPLEMENTATION -> VERIFICATION on IMPLEMENTER_COMPLETED", () => {
    expect(
      nextStage(
        { type: "IMPLEMENTER_COMPLETED" },
        { stage: "IMPLEMENTATION", correctionCycles: 0 },
      ),
    ).toBe("VERIFICATION");
  });

  it("moves IMPLEMENTATION -> BLOCKED on IMPLEMENTER_BLOCKED", () => {
    expect(
      nextStage(
        { type: "IMPLEMENTER_BLOCKED" },
        { stage: "IMPLEMENTATION", correctionCycles: 0 },
      ),
    ).toBe("BLOCKED");
  });

  it("moves VERIFICATION -> INDEPENDENT_REVIEW on VERIFICATION_PASSED", () => {
    expect(
      nextStage(
        { type: "VERIFICATION_PASSED" },
        { stage: "VERIFICATION", correctionCycles: 0 },
      ),
    ).toBe("INDEPENDENT_REVIEW");
  });

  it("moves VERIFICATION -> IMPLEMENTATION on VERIFICATION_FAILED (retry within budget)", () => {
    expect(
      nextStage(
        { type: "VERIFICATION_FAILED" },
        { stage: "VERIFICATION", correctionCycles: 0 },
      ),
    ).toBe("IMPLEMENTATION");
  });

  it("moves INDEPENDENT_REVIEW -> PUBLICATION on REVIEW_RESULT APPROVED", () => {
    expect(
      nextStage(
        { type: "REVIEW_RESULT", outcome: "APPROVED" },
        { stage: "INDEPENDENT_REVIEW", correctionCycles: 0 },
      ),
    ).toBe("PUBLICATION");
  });

  it("moves INDEPENDENT_REVIEW -> CORRECTION on REVIEW_RESULT CHANGES_REQUESTED when a cycle remains", () => {
    expect(
      nextStage(
        { type: "REVIEW_RESULT", outcome: "CHANGES_REQUESTED" },
        { correctionCycles: 0 },
      ),
    ).toBe("CORRECTION");
  });

  it("moves INDEPENDENT_REVIEW -> NEEDS_REFINEMENT on REVIEW_RESULT PRODUCT_AMBIGUITY", () => {
    expect(
      nextStage(
        { type: "REVIEW_RESULT", outcome: "PRODUCT_AMBIGUITY" },
        { stage: "INDEPENDENT_REVIEW", correctionCycles: 0 },
      ),
    ).toBe("NEEDS_REFINEMENT");
  });

  it("moves INDEPENDENT_REVIEW -> FAILED on REVIEW_RESULT FAILED", () => {
    expect(
      nextStage(
        { type: "REVIEW_RESULT", outcome: "FAILED" },
        { stage: "INDEPENDENT_REVIEW", correctionCycles: 0 },
      ),
    ).toBe("FAILED");
  });

  it("moves CORRECTION -> IMPLEMENTATION on CORRECTION_STARTED", () => {
    expect(
      nextStage(
        { type: "CORRECTION_STARTED" },
        { stage: "CORRECTION", correctionCycles: 1 },
      ),
    ).toBe("IMPLEMENTATION");
  });

  it("moves PUBLICATION -> PR_OPEN on PUBLISHED", () => {
    expect(
      nextStage(
        { type: "PUBLISHED" },
        { stage: "PUBLICATION", correctionCycles: 0 },
      ),
    ).toBe("PR_OPEN");
  });

  it("moves any nonterminal, non-BLOCKED stage -> CANCELLED on CANCELLED event", () => {
    const cancellable = ALL_RUN_STAGES.filter(
      (stage) => !TERMINAL_STAGES.has(stage) && stage !== "BLOCKED",
    );
    for (const stage of cancellable) {
      expect(nextStage({ type: "CANCELLED" }, { stage, correctionCycles: 0 })).toBe(
        "CANCELLED",
      );
    }
  });

  it("moves any nonterminal, non-BLOCKED stage -> FAILED on FATAL_ERROR", () => {
    // BLOCKED is excluded: it has no automatic outgoing edge at all, not
    // even FATAL_ERROR (see the dedicated BLOCKED tests below).
    const nonterminal = ALL_RUN_STAGES.filter(
      (stage) => !TERMINAL_STAGES.has(stage) && stage !== "BLOCKED",
    );
    for (const stage of nonterminal) {
      expect(nextStage({ type: "FATAL_ERROR" }, { stage, correctionCycles: 0 })).toBe(
        "FAILED",
      );
    }
  });

  it("allows RESUME from FAILED into a non-terminal stage", () => {
    expect(
      nextStage(
        { type: "RESUME", resumeTo: "INDEPENDENT_REVIEW" },
        { stage: "FAILED", correctionCycles: 0 },
      ),
    ).toBe("INDEPENDENT_REVIEW");
  });

  it("moves BLOCKED -> IMPLEMENTATION on RESUME when resuming to implementation", () => {
    expect(
      nextStage(
        { type: "RESUME", resumeTo: "IMPLEMENTATION" },
        { stage: "BLOCKED", correctionCycles: 0 },
      ),
    ).toBe("IMPLEMENTATION");
  });

  it("moves BLOCKED -> CORRECTION on RESUME when resuming to correction", () => {
    expect(
      nextStage(
        { type: "RESUME", resumeTo: "CORRECTION" },
        { stage: "BLOCKED", correctionCycles: 1 },
      ),
    ).toBe("CORRECTION");
  });

  it("throws when RESUME is sent from a non-BLOCKED stage", () => {
    expect(() =>
      nextStage(
        { type: "RESUME", resumeTo: "IMPLEMENTATION" },
        { stage: "IMPLEMENTATION", correctionCycles: 0 },
      ),
    ).toThrow("illegal transition");
  });

  it("throws when a non-RESUME event is sent while stage is BLOCKED (no automatic outgoing edge)", () => {
    expect(() =>
      nextStage(
        { type: "IMPLEMENTER_COMPLETED" },
        { stage: "BLOCKED", correctionCycles: 0 },
      ),
    ).toThrow("illegal transition");
  });

  it("throws for an event that does not apply to the current stage", () => {
    expect(() =>
      nextStage(
        { type: "VERIFICATION_PASSED" },
        { stage: "PREFLIGHT", correctionCycles: 0 },
      ),
    ).toThrow("illegal transition");
  });

  it("throws for events fired from a terminal stage", () => {
    expect(() =>
      nextStage(
        { type: "CANCELLED" },
        { stage: "FAILED", correctionCycles: 0 },
      ),
    ).toThrow("illegal transition");
  });
});
