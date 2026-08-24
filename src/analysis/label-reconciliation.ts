export const AGENT_READY_LABEL = "agent:ready";
export const AGENT_IN_PROGRESS_LABEL = "agent:in-progress";
export const SPLIT_LABEL = "split";

export type LabelAction = "labeled" | "unlabeled" | "unchanged" | "skipped-in-progress" | "skipped-split";

/**
 * Decide what `discover` should do to an issue's `agent:ready` label given
 * its computed readiness and current label state. Never considers writing
 * `agent:in-progress` — that label is owned exclusively by the daemon's
 * just-in-time claim/release lifecycle (see `daemon-runner.ts`). An issue
 * already carrying `agent:in-progress` is always left alone: it is either
 * genuinely being worked right now, or stuck there from a past BLOCKED/
 * FAILED run — in both cases not `discover`'s to touch. An issue carrying
 * the `split` label is a SPLIT_ISSUE tracking checklist, not a task — it
 * is always skipped ahead of every other check, since it can never be a
 * real "ready to run" candidate regardless of its content.
 */
export function reconcileReadyLabel(input: {
  isReady: boolean;
  hasReadyLabel: boolean;
  hasInProgressLabel: boolean;
  hasSplitLabel: boolean;
}): LabelAction {
  if (input.hasSplitLabel) return "skipped-split";
  if (input.hasInProgressLabel) return "skipped-in-progress";
  if (input.isReady && !input.hasReadyLabel) return "labeled";
  if (!input.isReady && input.hasReadyLabel) return "unlabeled";
  return "unchanged";
}
