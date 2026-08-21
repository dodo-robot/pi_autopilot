# Brainstormer Role in `autopilot prepare`

**Date:** 2026-08-21
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

`autopilot prepare` currently handles underspecified issues reactively: the refiner runs, returns `NEEDS_REFINEMENT` or `PRODUCT_AMBIGUITY`, and then asks the operator narrow fill-in-the-blank questions about the specific gaps it noticed. This catches structural gaps (missing acceptance criteria, no validation command) but misses **intent gaps** — unstated constraints, wrong-problem-being-solved, assumptions the operator has been carrying for weeks that never made it into the issue.

This spec adds a **Brainstormer role**: a short, focused Pi session that triggers when the refiner signals the issue is underspecified, asks the operator 2-3 open-ended intent-level questions tailored to the specific issue and the gaps the refiner surfaced, and feeds the answers back into a second refiner pass as enriched clarifications.

## 2. Trigger conditions

The brainstormer triggers when the refiner's first pass returns any of:

- `outcome: "NEEDS_REFINEMENT"` — issue lacks information required for an execution contract
- `outcome: "PRODUCT_AMBIGUITY"` — unresolved product decision would materially influence implementation

It does **not** trigger when:

- The refiner returns `READY` on the first pass
- A reusable snapshot is found (fast path — no refiner call at all)
- `--json` mode is active (no stdin available)

## 3. Flow

```
autopilot prepare <issue>
  │
  ├─ [fast path] reusable READY snapshot? → diff → approve → done
  │
  └─ fresh: refiner runs (pass 1)
       │
       ├─ READY → diff → approve → done           (unchanged)
       │
       └─ NEEDS_REFINEMENT or PRODUCT_AMBIGUITY
            │
            └─ brainstormer runs (new Pi session)
                 │  reads: issue body + refiner gaps (missingInformation + ambiguities)
                 │  outputs: 2-3 targeted intent questions via submit_result
                 │
                 └─ operator answers each question in terminal (one at a time)
                      │
                      └─ refiner reruns with brainstorm Q&A as clarifications (pass 2)
                           │
                           ├─ READY → diff → approve → done
                           │
                           └─ still NEEDS_REFINEMENT / PRODUCT_AMBIGUITY
                                │
                                └─ existing narrow clarification loop (fallback, unchanged)
```

## 4. Brainstormer role contract

### 4.1 Tool allowlist

`read`, `grep`, `find`, `ls`, `submit_result` — identical to the refiner. The brainstormer is read-only.

### 4.2 Output schema

The brainstormer calls `submit_result` exactly once with:

```typescript
{
  questions: Array<{
    id: string;   // e.g. "q1", "q2", "q3"
    text: string; // the question to show the operator
  }>  // 1–3 items; never empty
}
```

Validated by `BrainstormerResultSchema` (Zod). A result with zero questions or more than three is rejected as invalid.

### 4.3 Prompt

The brainstormer prompt receives:

- Repository owner/repo
- Issue number, title, body
- Refiner pass-1 gaps: `missingInformation[]`, `ambiguities[]`, `suggestions[]`
- Instruction to inspect the repository's guidance files (`AGENTS.md`, `CLAUDE.md`, `README*`) for context
- Instruction to produce 2-3 open-ended questions focused on **intent, scope, and success criteria** — not on the structural gaps the refiner already surfaced (those are handled by the clarification loop)
- Instruction to never ask questions that can be answered by reading the repo

The prompt explicitly forbids the brainstormer from drafting the execution contract itself — that remains the refiner's job.

### 4.4 Timeout

Uses the same `refinerTimeoutMs` budget as the refiner (from policy `budgets.refiner.timeoutMinutes` or the `--refiner-timeout` flag). Configurable separately in a future iteration if needed.

## 5. Integration in `prepare.ts`

### 5.1 New seam: `runBrainstormer`

A private `runBrainstormer(issue, report, deps, reporter)` function added to `prepare.ts`:

1. Builds the brainstormer prompt from the issue and the pass-1 report
2. Calls `readiness.brainstorm(issueNumber, report)` — new method on `ReadinessService` (§6)
3. Returns the question array

### 5.2 New seam in `PrepareCommandDeps`

```typescript
interface PrepareCommandDeps extends CheckCommandDeps {
  confirm?: (prompt: string) => Promise<boolean>;
  answer?: (prompt: string) => Promise<string>;
  // NEW:
  runBrainstormer?: (
    issue: GitHubIssue,
    report: ReadinessReport,
  ) => Promise<Array<{ id: string; text: string }>>;
}
```

Tests inject `runBrainstormer` to avoid spawning real Pi sessions.

### 5.3 Placement in `runPrepare`

```typescript
// After pass-1 refiner, before the existing clarification loop:
if (
  report.status !== "READY" &&
  opts.json !== true &&
  (report.outcome === "NEEDS_REFINEMENT" || report.outcome === "PRODUCT_AMBIGUITY")
) {
  reporter?.setSpinner(`brainstorming ${ref}`);
  const questions = await runBrainstormer(issue, report, deps, reporter);
  reporter?.stopSpinner({ commit: `brainstorm complete (${questions.length} question${questions.length === 1 ? "" : "s"})` });

  const brainstormAnswers: Array<{ question: string; answer: string }> = [];
  for (const q of questions) {
    reporter?.stopSpinner();
    const answer = await askAnswer(`${q.text}\n\nAnswer (or 'cancel'): `);
    if (answer.trim().toLowerCase() === "cancel") {
      return { ...cancelledOutcome };
    }
    brainstormAnswers.push({ question: q.text, answer: answer.trim() });
  }

  report = await refine(brainstormAnswers); // pass 2
}
// existing narrow clarification loop follows unchanged
```

## 6. `ReadinessService` changes

New method `brainstorm(issueNumber, report)`:

- Builds the brainstormer prompt
- Calls `this.deps.pi.run({ role: "brainstormer", ... })`
- Returns `BrainstormerResult.questions`
- Persists the brainstormer result as an artifact (`brainstormer-result.json`) under the same `analysisId` namespace as the pass-1 report, for diagnostics

The `ReadinessServiceDeps` interface gains an optional test seam:

```typescript
brainstorm?: (issueNumber: number, report: ReadinessReport) => Promise<BrainstormerResult>;
```

## 7. `domain/contracts.ts` changes

```typescript
// Role union
export const RoleSchema = z.enum(["refiner", "implementer", "reviewer", "brainstormer"]);

// New schema
export const BrainstormerResultSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
    })
  ).min(1).max(3),
});
export type BrainstormerResult = z.infer<typeof BrainstormerResultSchema>;
```

## 8. `pi-runner.ts` changes

```typescript
const ROLE_SCHEMAS: Record<Role, z.ZodType> = {
  refiner: RefinerResultSchema,
  implementer: ImplementerResultSchema,
  reviewer: ReviewerResultSchema,
  brainstormer: BrainstormerResultSchema,   // NEW
};

const ROLE_TOOLS: Record<Role, string[]> = {
  refiner: READ_ONLY_TOOLS,
  reviewer: READ_ONLY_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
  brainstormer: READ_ONLY_TOOLS,            // NEW
};
```

## 9. New file: `src/readiness/brainstormer-prompt.ts`

Builds the brainstormer prompt. Accepts:

```typescript
interface BrainstormerPromptInput {
  repository: RepositoryRef;
  issue: GitHubIssue;
  refinerGaps: {
    missingInformation: string[];
    ambiguities: Ambiguity[];
    suggestions: string[];
  };
}
```

Returns a `string`. Follows the same pattern as `src/readiness/prompt.ts`.

## 10. Files touched

| File | Change |
|------|--------|
| `src/domain/contracts.ts` | Add `"brainstormer"` to `RoleSchema`; add `BrainstormerResultSchema` |
| `src/pi/pi-runner.ts` | Add `brainstormer` to `ROLE_SCHEMAS` and `ROLE_TOOLS` |
| `src/readiness/brainstormer-prompt.ts` | **New** — builds the brainstormer prompt |
| `src/readiness/readiness-service.ts` | Add `brainstorm()` method; add optional test seam to deps |
| `src/commands/prepare.ts` | Add `runBrainstormer()` call between pass-1 and clarification loop; add `runBrainstormer` seam to `PrepareCommandDeps` |
| `tests/unit/commands/prepare.test.ts` | New cases: brainstormer triggered on `NEEDS_REFINEMENT`, triggered on `PRODUCT_AMBIGUITY`, answers fed to pass-2 refiner, skipped when pass-1 is `READY`, skipped in `--json` mode, cancel during brainstorm Q&A |
| `tests/unit/readiness/brainstormer-prompt.test.ts` | **New** — prompt shape/content tests |

## 11. What does NOT change

- The fast path (reused snapshot) is untouched
- `--json` mode skips the brainstormer entirely
- The existing narrow clarification loop remains as a fallback after pass 2
- `check` command is untouched — brainstormer is `prepare`-only
- `RunService` and all `run`/`start` command paths are untouched

## 12. Out of scope

- Separate timeout budget for the brainstormer (uses refiner timeout for now)
- Brainstormer triggering inside `check` (read-only command, no stdin)
- More than 3 questions per brainstorm session
- Retrying the brainstormer if its Pi session fails (caller falls through to the existing clarification loop)
