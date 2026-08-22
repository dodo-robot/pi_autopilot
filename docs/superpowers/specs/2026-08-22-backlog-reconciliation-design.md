# Pi Autopilot: Backlog Reconciliation Design

**Date:** 2026-08-22
**Status:** Approved in brainstorming; awaiting written-spec review

## 1. Purpose

M1 delivered a supervised single-issue runner. M2 delivered a read-only backlog
analyst (`autopilot analyze`) that classifies existing issues as READY,
NEEDS_REFINEMENT, BLOCKED, or AMBIGUOUS. Both assume the backlog itself is
roughly correct — that the epic's issues are the right issues, cover the right
requirements, and aren't stale, duplicated, or missing pieces.

That assumption breaks down for an existing project whose planning predates
Autopilot. Requirements drift, issues get created ad hoc, some tasks are
superseded by work that already landed, and nobody maintains a
requirement→issue map by hand. **Backlog Reconciliation** answers a different
question than `analyze`: not "is this issue ready to run" but "does the
backlog, taken as a whole, actually reflect the requirements, the
architecture, and the current repository — and if not, what should change?"

The output is a **structured, human-reviewable patch plan** against an
existing epic's issues, backed by a coverage map from requirements to backlog
items. Nothing is written to GitHub in this milestone; reconciliation is
dry-run only, exactly like `analyze` was on arrival.

## 2. Relationship to the existing roadmap

| Milestone | Outcome |
|---|---|
| M1 — Supervised Task Runner | One issue: check/prepare → isolated run → review/verify → PR. *(done)* |
| M2 — Refinement and Readiness | Analyze existing epics and tasks, record readiness, identify executable work. *(done)* |
| M3 — Durable Autonomous Runner | Background daemon, crash recovery, auto-resume, sequential queue. *(done)* |
| **Backlog Reconciliation** | **Patch-plan proposals against an existing epic's issues: coverage, staleness, missing work, dependency gaps — always dry-run.** *(this spec)* |
| M4 — Epic Scheduler | Explicit dependencies, controlled concurrency, workspace-conflict prevention, epic progress reporting. |
| M5 — Adaptive Planning and Governance | Staleness detection, replanning, richer escalation/security policy, optional auto-merge, end-to-end traceability. |

This is deliberately **not** slotted into the numbered sequence. It operates
at *plan time*, before an epic's issues enter the M1–M3 execution pipeline —
a precursor to M4's scheduler, which will want a backlog it can trust before
it starts making concurrency/ordering decisions. It also delivers a narrow
slice of what M5 eventually promises (staleness detection, requirement
traceability) without M5's heavier scope (auto-merge, escalation policy,
runtime replanning of in-flight work). M5 remains free to build on the
coverage model and patch types introduced here rather than duplicate them.

Applying proposed patches to GitHub (`apply-safe`/`apply-all`) is an explicit
next step after this milestone, not part of it (§10).

## 3. Scope decisions

Settled in brainstorming:

1. **New CLI command, not an `analyze` mode.** `autopilot reconcile <epic>` —
   `analyze` keeps answering per-issue readiness; `reconcile` answers a
   backlog-correctness question and emits a different artifact shape (a
   patch plan + coverage map, not a readiness report).
2. **Epic-checklist discovery only.** Reuses `analyze`'s existing mechanism
   (`collectEpicIssueRefs` / `resolveIssueSet`) — one epic issue's body
   checklist. No GitHub Projects v2 or label-based discovery in this
   milestone; `GitHubPort` needs no new read surface at all.
3. **Single reconciler session per epic.** One new `reconciler` Pi role, one
   bounded session per invocation, given the whole epic (all child issues)
   plus requirement/architecture doc text at once. Cross-issue reasoning
   (duplicates, splits) requires seeing the whole epic together; a
   screen-then-refine per-item approach (mirroring `BacklogAnalyst`'s cost
   optimization) is deferred until real epic sizes justify the added
   complexity of merging per-item outputs back into one plan.
4. **Reconciler-assigned requirement IDs.** Requirement documents are not
   assumed to carry stable `REQ-*` identifiers already. The reconciler
   assigns and maintains them itself, persisted only in the reconciliation
   artifact — source requirement documents are never rewritten.
5. **Dry-run only.** No `GitHubPort` mutation capability is exercised in this
   milestone, matching `extend_requirements.md`'s explicit instruction and
   `analyze`'s own M2 precedent.
6. **M1's subset of patch types.** `KEEP`, `ENRICH_ISSUE`, `CREATE_ISSUE`,
   `ADD_DEPENDENCY`, `MARK_STALE`, `NEEDS_HUMAN`. `SPLIT_ISSUE`,
   `MERGE_DUPLICATE`, `REMOVE_DEPENDENCY`, `MARK_READY` are documented but
   not implemented (§10).

## 4. Command interface

```text
autopilot reconcile <epic> [--requirements <path>...] [--json]
```

- `<epic>` — a bare issue number or `owner/repo#number`, same resolution
  rule as every other command (`resolveIssueRef`).
- `--requirements <path>` — repeatable; overrides
  `.pi/autopilot.yaml`'s `reconciliation.requirementsPaths` for this
  invocation. Paths are repository-relative.
- `--json` — emit the full `ReconciliationReport` instead of the
  human-readable dry-run report.

No `--apply` flag exists in this milestone — reconciliation is always
read-only against GitHub.

### 4.1 Exit codes

| Code | Meaning |
|---|---|
| `0` | Report generated (regardless of how many patches or `NEEDS_HUMAN` entries it contains) |
| `1` | Argument/infrastructure error — unresolvable epic ref, missing/unreadable requirement doc path, invalid config, session timeout or crash |

Unlike `analyze`, exit code does not encode "is there executable work" —
reconciliation's output is a plan for a human to review, not a scheduling
signal consumed by another command in this milestone.

## 5. Configuration

New optional section in `.pi/autopilot.yaml` (validated by
`src/config/schema.ts`):

```yaml
reconciliation:
  requirementsPaths:      # default: ["requirements.md"] if present, else []
    - requirements.md
    - docs/architecture/
```

Entries may be files or directories; directories are read non-recursively in
this milestone (one level of `*.md` files), matching the bounded-context
assumption in §6. A path that does not exist is a preflight error (§8), not a
silent skip — reconciliation never guesses that a project has no
requirements.

## 6. Contracts

### 6.1 Role and prompt

`RoleSchema` in `src/domain/contracts.ts` gains `"reconciler"`, alongside
`refiner`/`implementer`/`reviewer`/`brainstormer`.

`src/reconciliation/prompt.ts` (mirrors `src/readiness/prompt.ts`) builds the
reconciler prompt from:

- the repository ref,
- the epic issue (title, body, state),
- every child issue resolved from the epic checklist (title, body, state,
  updated-at),
- the concatenated text of every resolved requirements path,
- any prior `ReconciliationReport` for this epic (if one exists in the
  artifact store), so the model can see what it previously proposed and
  avoid re-deriving requirement IDs from scratch.

The session runs with the same sandboxing every other role already has:
worktree = repository root, `agentPolicy.protectedPaths` enforced, read-only
tool access (`allowedCommands: []`, matching the refiner — reconciliation
never needs to run project commands, only inspect files) so it can use its
own tools to look for existing implementations (the "does `UserRepository`
already exist" case from `extend_requirements.md`).

### 6.2 Raw LLM result

```ts
export const ReconciliationAmbiguityTypeSchema = z.enum([
  "ENGINEERING",
  "PRODUCT",
  "MISSING_CONTEXT",
  "CONFLICTING_REQUIREMENTS",
]);

export const CoverageEntrySchema = z.object({
  requirementId: z.string().min(1),        // reconciler-assigned, e.g. "REQ-AUTH-004"
  description: z.string().min(1),
  epic: z.number().int().positive().nullable(),
  issues: z.array(z.number().int().positive()),
  status: z.enum(["covered", "partial", "missing", "implemented"]),
  evidence: z.string(),                    // why this status — repo path, issue ref, etc.
});

export const IssueEnrichmentSchema = z.object({
  goal: z.string().min(1),
  sourceRequirements: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  validation: z.array(z.string()),
  relevantAreas: z.array(z.string()),
});

export const IssueSpecSchema = z.object({
  title: z.string().min(1),
  enrichment: IssueEnrichmentSchema,
});

export const BacklogPatchSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("KEEP"), issue: z.number().int().positive(), reason: z.string() }),
  z.object({
    type: z.literal("ENRICH_ISSUE"),
    issue: z.number().int().positive(),
    patch: IssueEnrichmentSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("CREATE_ISSUE"),
    epic: z.number().int().positive().nullable(),
    spec: IssueSpecSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("ADD_DEPENDENCY"),
    issue: z.number().int().positive(),
    dependsOn: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("MARK_STALE"),
    issue: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("NEEDS_HUMAN"),
    issue: z.number().int().positive().nullable(),
    ambiguityType: ReconciliationAmbiguityTypeSchema,
    reason: z.string().min(1),
    questions: z.array(z.string()).min(1),
  }),
]);
export type BacklogPatch = z.infer<typeof BacklogPatchSchema>;
```

`CoverageEntrySchema` and `BacklogPatchSchema` live in a new
`src/domain/reconciliation.ts`, mirroring how `BacklogReportSchema` lives in
`src/domain/backlog.ts` rather than `contracts.ts`.

`contracts.ts` adds the raw role-result schema alongside the others:

```ts
export const ReconcilerResultSchema = z.object({
  coverage: z.array(CoverageEntrySchema),
  patches: z.array(BacklogPatchSchema),
});
export type ReconcilerResult = z.infer<typeof ReconcilerResultSchema>;
```

...and joins the `RoleResultSchema` union.

### 6.3 Persisted report

```ts
export interface ReconciliationReport {
  repository: RepositoryRef;
  epicRef: number;
  requirementsPaths: string[];
  generatedAt: string;
  analysisId: string;
  coverage: CoverageEntry[];
  patches: (BacklogPatch & { policy: "auto-safe" | "requires-approval" })[];
  summary: {
    requirementsCovered: number;
    requirementsPartial: number;
    requirementsMissing: number;
    requirementsTotal: number;
    patchCounts: Record<BacklogPatch["type"], number>;
  };
}
```

Persisted via `ArtifactStore.writeJson(analysisId, "reconciliation-report.json", report)`
under a new namespace, e.g. `reconcile-<timestamp>-<epic>`, following the
existing `analyze-<timestamp>` convention.

## 7. Data flow

```
requirement/architecture docs (file reads, resolved from config/--requirements)
  + epic + child issues (GitHubPort.getIssue, epic-checklist resolution — unchanged from analyze)
  + repository (the reconciler session's own read-only tool access)
        ↓
  buildReconcilerPrompt()
        ↓
  Pi session (role: reconciler) → raw ReconcilerResult
        ↓
  zod validation (malformed/partial → single top-level NEEDS_HUMAN, §8)
        ↓
  idempotency pass (§7.1)
        ↓
  policy classification per patch (§7.2)
        ↓
  ReconciliationReport → ArtifactStore
        ↓
  CLI: human dry-run report, or --json
```

### 7.1 Idempotency

A second `reconcile` run over an unchanged epic must not keep re-proposing
already-applied enrichment (required by `extend_requirements.md` and tested
explicitly, §9). This is enforced deterministically, not left to the model:
for every `ENRICH_ISSUE` patch, the service renders the proposed managed
section (§7.3) and diffs it against the issue's *current* body. An identical
render (proposal already reflected in the issue) is downgraded to `KEEP`
before the patch is written into the report. The same principle applies to
`ADD_DEPENDENCY` (already-present dependency marker → `KEEP`) and
`CREATE_ISSUE` (a child issue whose title/goal already matches an existing
issue in the epic → downgraded to `KEEP` or `ENRICH_ISSUE` on that issue
instead, never a duplicate `CREATE_ISSUE`).

### 7.2 Patch-application policy

`src/reconciliation/patch-policy.ts`:

```ts
const AUTO_SAFE: ReadonlySet<BacklogPatch["type"]> = new Set([
  "ENRICH_ISSUE",
  "ADD_DEPENDENCY",
  "CREATE_ISSUE",
]);

export function classifyPatch(patch: BacklogPatch): "auto-safe" | "requires-approval" {
  return AUTO_SAFE.has(patch.type) ? "auto-safe" : "requires-approval";
}
```

`KEEP` carries no policy tag (it's a no-op, not a write). `MARK_STALE` and
`NEEDS_HUMAN` are always `requires-approval`. This classification is
**informational only** in this milestone — annotated on every patch in the
report so a human can scan for what would be auto-appliable, but nothing is
actually applied. It is the exact seam `apply-safe` (§10) plugs into.

### 7.3 Managed section reuse

`ENRICH_ISSUE` proposals render into a second managed section, distinct from
M1's execution-contract section:

```
<!-- autopilot-reconciliation:start -->
## Backlog reconciliation
...
<!-- autopilot-reconciliation:end -->
```

`src/readiness/refinement-section.ts`'s marker-scanning upsert logic
(ambiguous/unbalanced-marker detection, insert-vs-replace) is generalized
into a shared helper parameterized by marker pair + rendered content;
`refinement-section.ts` and the new `src/reconciliation/managed-section.ts`
both call it. `diffLines`/`renderUnifiedDiff` are already marker-agnostic and
are reused as-is for rendering the diff shown in the dry-run report.

## 8. Error handling

| Scenario | Behavior |
|---|---|
| Malformed/partial `ReconcilerResult`, reconciler session timeout, or session crash | `PiRunner.run()` already validates every role's raw output against `ROLE_SCHEMAS[role]` internally and throws `PiRunError` on anything invalid, on a nonzero exit, or on timeout — it never returns unparsed data to the caller. Reconciliation adds no separate handling: the thrown `PiRunError` propagates to the CLI's existing top-level catch, exit 1, exactly like every other role session failure in `check`/`analyze`/`prepare`. There is no seam for the service to intercept malformed output before `PiRunner` throws, so no `NEEDS_HUMAN`-downgrade path exists for this case (unlike the two rows below, which the *service* itself detects and can downgrade). |
| A child issue ref in the epic checklist can't be fetched | That ref becomes its own `NEEDS_HUMAN` entry; reconciliation continues over the rest of the epic (mirrors `BacklogAnalyst`'s `unresolved` tracking) rather than aborting |
| A configured/`--requirements` path doesn't exist or isn't readable | CLI preflight error, exit 1, before any Pi session starts — same "refuse to guess" precedent as a missing `.pi/autopilot.yaml` verify command |
| Reconciler session times out or crashes | Thrown error, exit 1, same handling as `check`/`analyze` session failures |
| Epic ref does not resolve to a real issue | Thrown error, exit 1, same as every other command's `resolveIssueRef` |

## 9. Testing

At minimum:

- **Contract schema tests** — valid/invalid `ReconcilerResult` and
  `BacklogPatch` parsing for every patch type.
- **Reconciler session failure propagation** — a fake `pi.run()` that throws
  `PiRunError` (malformed output, timeout, or crash) propagates unchanged out
  of `ReconciliationService.reconcile()` and out of the CLI command (exit 1),
  proving no swallowed-error path exists.
- **Coverage computation** — fixed fixture set exercising
  `covered`/`partial`/`missing`/`implemented` classification.
- **Idempotency** — a second `reconcile` run over an unchanged epic/issue
  set produces `KEEP` for previously proposed `ENRICH_ISSUE`/
  `ADD_DEPENDENCY`/`CREATE_ISSUE` patches, not repeated proposals.
- **Managed-section upsert** — original issue content preserved; the
  generalized marker-upsert helper behaves identically for both the
  refinement and reconciliation sections; ambiguous/unbalanced markers still
  raise rather than guess.
- **Oversized-task detection** — a fixture issue whose scope spans multiple
  independent behavioral outcomes produces a `NEEDS_HUMAN` or a documented
  split rationale (`SPLIT_ISSUE` itself is out of scope, §10, but the
  reconciler must still flag the issue rather than silently `KEEP`).
- **Ambiguity classification** — engineering vs. product vs. missing-context
  vs. conflicting-requirements fixtures each land the correct
  `ReconciliationAmbiguityType`.
- **Policy classification** — every M1 patch type maps to the correct
  `auto-safe`/`requires-approval` tag.
- **Dry-run causes zero GitHub mutations** — CLI e2e test (fake Pi + fake
  GitHub, same harness as M1/M2) asserts no `updateIssueBody`/
  `createIssueComment`/write call occurs for any patch type.
- **CLI e2e** — an epic with a mix of ready/duplicate-candidate/stale/
  missing-coverage issues produces the expected human dry-run report and
  the expected `--json` `ReconciliationReport` shape.

## 10. Out of scope for this milestone

Deliberately deferred:

- **`apply-safe`/`apply-all` patch application.** This milestone produces
  proposals only. The recommended next step: a `--apply-safe` flag on
  `reconcile` (or a separate `autopilot reconcile-apply <analysisId>`
  command) that re-fetches each `auto-safe`-classified patch's target
  issue, re-runs the same idempotency check against its *current* state
  (protecting against concurrent edits, same pattern as `prepare`'s
  updatedAt/body-hash guard), and applies only `ENRICH_ISSUE` (via the
  managed-section upsert already built here), `ADD_DEPENDENCY`, and
  `CREATE_ISSUE` (requires a new `GitHubPort.createIssue` method — the one
  GitHub-adapter extension this milestone doesn't need but the next one
  will). `MARK_STALE`/`NEEDS_HUMAN` stay proposal-only regardless of mode.
- **`SPLIT_ISSUE`, `MERGE_DUPLICATE`, `REMOVE_DEPENDENCY`, `MARK_READY`
  patch types.** Documented in `extend_requirements.md` as a fuller model;
  the schema's discriminated union is designed to extend cleanly, but
  implementing them (especially `SPLIT_ISSUE`'s child-issue creation and
  `MERGE_DUPLICATE`'s cross-issue content reconciliation) is real
  additional work best sequenced after `apply-safe` proves out the simpler
  patch types end to end.
- **GitHub Projects v2 / label-based discovery.** Epic-checklist discovery
  only (§3.2).
- **Daemon/queue integration.** `reconcile` is a manual, explicit command
  like `check`/`prepare`/`analyze` — it does not feed the M3 daemon in this
  milestone.
- **Screen-then-refine cost optimization** for large epics (Approach B
  considered and deferred in brainstorming, §3.3).

## 11. Acceptance criteria

Backlog Reconciliation is complete when:

1. `autopilot reconcile <epic>` resolves the epic's checklist issues (same
   mechanism as `analyze`), runs one reconciler session with requirement
   docs + full epic context, and produces a `ReconciliationReport`.
2. The report's `coverage` array correctly classifies fixture requirements
   as `covered`/`partial`/`missing`/`implemented`.
3. The report's `patches` array is limited to `KEEP`, `ENRICH_ISSUE`,
   `CREATE_ISSUE`, `ADD_DEPENDENCY`, `MARK_STALE`, `NEEDS_HUMAN`, each
   correctly zod-validated and each annotated with its policy
   classification.
4. A second `reconcile` run over an unchanged epic produces `KEEP` instead
   of repeating previously-proposed enrichments (idempotency, §7.1).
5. No GitHub mutation call occurs under any circumstance in this milestone.
6. A reconciler session that produces invalid output, times out, or crashes
   surfaces as a thrown `PiRunError` (exit 1) — the existing `PiRunner`
   behavior every other role session already relies on — never a silently
   fabricated plan.
7. `--json` emits the full `ReconciliationReport`; the default mode renders
   the human dry-run report in the `extend_requirements.md` example format
   (per-epic KEEP/ENRICH/CREATE/STALE sections + a coverage summary line).
8. The full M1–M3 suite remains green; `npm run typecheck`, `npm test`, and
   `npm run build` pass; the new reconciliation modules and CLI command are
   covered per §9.

## 12. Assumptions and open questions

- Requirement documents are assumed small enough (bounded by the same
  "epics are bounded in size" assumption `analyze` already makes) to embed
  directly in the reconciler prompt without chunking or retrieval. Revisit
  if real target-project requirement docs turn out to be large.
- `reconciliation.requirementsPaths` directories are read one level deep
  (non-recursive) in this milestone; revisit if real projects nest
  requirement docs deeper than that.
- The idempotency diff (§7.1) compares *rendered* proposal content against
  the issue's current body. If a human hand-edits the reconciliation section
  to something that isn't what the reconciler would have proposed, the next
  run will treat that as drift and may re-propose — there is no "human
  override wins permanently" marker in this milestone. Worth revisiting once
  `apply-safe` exists and edits become more common.
