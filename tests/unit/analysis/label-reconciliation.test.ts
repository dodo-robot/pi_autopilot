import { describe, expect, it } from "vitest";
import { reconcileReadyLabel } from "../../../src/analysis/label-reconciliation.js";

describe("reconcileReadyLabel", () => {
  it("skips when agent:in-progress is present, regardless of readiness", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: true, hasSplitLabel: false }),
    ).toBe("skipped-in-progress");
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: true, hasInProgressLabel: true, hasSplitLabel: false }),
    ).toBe("skipped-in-progress");
  });

  it("labels a ready issue missing the label", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: false, hasSplitLabel: false }),
    ).toBe("labeled");
  });

  it("unlabels a non-ready issue carrying the label", () => {
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: true, hasInProgressLabel: false, hasSplitLabel: false }),
    ).toBe("unlabeled");
  });

  it("leaves a ready issue that already has the label unchanged", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: true, hasInProgressLabel: false, hasSplitLabel: false }),
    ).toBe("unchanged");
  });

  it("leaves a non-ready issue with no label unchanged", () => {
    expect(
      reconcileReadyLabel({ isReady: false, hasReadyLabel: false, hasInProgressLabel: false, hasSplitLabel: false }),
    ).toBe("unchanged");
  });

  it("skips when the split label is present, regardless of readiness or agent:ready state", () => {
    expect(
      reconcileReadyLabel({
        isReady: true,
        hasReadyLabel: false,
        hasInProgressLabel: false,
        hasSplitLabel: true,
      }),
    ).toBe("skipped-split");
    expect(
      reconcileReadyLabel({
        isReady: false,
        hasReadyLabel: true,
        hasInProgressLabel: false,
        hasSplitLabel: true,
      }),
    ).toBe("skipped-split");
  });

  it("unlabels a closed issue carrying a stale agent:ready label", () => {
    expect(
      reconcileReadyLabel({
        isClosed: true,
        isReady: true,
        hasReadyLabel: true,
        hasInProgressLabel: false,
        hasSplitLabel: false,
      }),
    ).toBe("unlabeled");
  });

  it("never labels a closed issue, even when it screens READY", () => {
    expect(
      reconcileReadyLabel({
        isClosed: true,
        isReady: true,
        hasReadyLabel: false,
        hasInProgressLabel: false,
        hasSplitLabel: false,
      }),
    ).toBe("unchanged");
  });

  it("strips agent:ready from a closed issue even when it is claimed or split", () => {
    // A closed issue is finished work: a lingering agent:ready is actively
    // misleading, so removing it wins over the skip guards.
    expect(
      reconcileReadyLabel({
        isClosed: true,
        isReady: false,
        hasReadyLabel: true,
        hasInProgressLabel: true,
        hasSplitLabel: true,
      }),
    ).toBe("unlabeled");
  });

  it("treats a missing isClosed as open, preserving existing behavior", () => {
    expect(
      reconcileReadyLabel({ isReady: true, hasReadyLabel: false, hasInProgressLabel: false, hasSplitLabel: false }),
    ).toBe("labeled");
  });

  it("prioritizes skipped-split over skipped-in-progress when both labels are present", () => {
    expect(
      reconcileReadyLabel({
        isReady: true,
        hasReadyLabel: false,
        hasInProgressLabel: true,
        hasSplitLabel: true,
      }),
    ).toBe("skipped-split");
  });
});
