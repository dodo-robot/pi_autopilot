import { describe, expect, it } from "vitest";
import type { GitHubIssue } from "../../../src/github/github-adapter.js";
import {
  screenIssue,
  REFINEMENT_START,
  REFINEMENT_END,
} from "../../../src/analysis/heuristic-screen.js";

function issue(body: string): GitHubIssue {
  return {
    number: 42,
    nodeId: "I_42",
    title: "Some task",
    body,
    updatedAt: "2026-08-20T00:00:00Z",
    state: "open",
    htmlUrl: "https://github.com/acme/widgets/issues/42",
  };
}

const CONTRACT_BODY = `${REFINEMENT_START}
## Autonomous execution contract

### Goal
Implement x.

### Acceptance criteria
- [ ] **ac1** It works

${REFINEMENT_END}
`;

describe("screenIssue", () => {
  it("classifies a full managed contract as READY", () => {
    const d = screenIssue({ issue: issue(CONTRACT_BODY), dependencies: [] });
    expect(d.classification).toBe("READY");
    expect(d.reasons).toContain("has managed execution contract");
  });

  it("classifies an unsatisfied explicit dependency as BLOCKED", () => {
    const body = "Depends on: #12\n\n## Acceptance criteria\n- [ ] x works";
    const d = screenIssue({
      issue: issue(body),
      dependencies: [{ issue: 12, satisfied: false }],
    });
    expect(d.classification).toBe("BLOCKED");
  });

  it("does NOT treat a bare #n reference as a dependency", () => {
    const body = "See #12 for background.\n\n## Acceptance criteria\n- [ ] x works";
    const d = screenIssue({
      issue: issue(body),
      dependencies: [{ issue: 12, satisfied: false }],
    });
    expect(d.classification).not.toBe("BLOCKED");
  });

  it("classifies an unresolved-decision phrase as AMBIGUOUS", () => {
    const d = screenIssue({
      issue: issue("Which behavior should win here?"),
      dependencies: [],
    });
    expect(d.classification).toBe("AMBIGUOUS");
  });

  it("classifies a partially specified body as CANDIDATE", () => {
    const body = "## Goal\nImplement login\n\n## Acceptance criteria\n- [ ] user can log in";
    const d = screenIssue({ issue: issue(body), dependencies: [] });
    expect(d.classification).toBe("CANDIDATE");
  });

  it("classifies a body missing everything as NEEDS_REFINEMENT", () => {
    const d = screenIssue({ issue: issue("Just a vague note."), dependencies: [] });
    expect(d.classification).toBe("NEEDS_REFINEMENT");
  });

  it("prefers BLOCKED over AMBIGUOUS", () => {
    const body = "Depends on: #12\n\nWhich behavior should win?";
    const d = screenIssue({
      issue: issue(body),
      dependencies: [{ issue: 12, satisfied: false }],
    });
    expect(d.classification).toBe("BLOCKED");
  });
});
