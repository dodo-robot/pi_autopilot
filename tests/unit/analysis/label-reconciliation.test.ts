import { describe, expect, it } from "vitest";
import { reconcileReadyLabel } from "../../../src/analysis/label-reconciliation.js";

describe("reconcileReadyLabel", () => {
  it("skips when agent:in-progress is present, regardless of readiness", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: true }),
    ).toBe("skipped-in-progress");
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: true, hasInProgressLabel: true }),
    ).toBe("skipped-in-progress");
  });

  it("labels a ready issue missing the label", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: false }),
    ).toBe("labeled");
  });

  it("unlabels a non-ready issue carrying the label", () => {
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: true, hasInProgressLabel: false }),
    ).toBe("unlabeled");
  });

  it("leaves a ready issue that already has the label unchanged", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: true, hasInProgressLabel: false }),
    ).toBe("unchanged");
  });

  it("leaves a non-ready issue with no label unchanged", () => {
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: false, hasInProgressLabel: false }),
    ).toBe("unchanged");
  });
});
