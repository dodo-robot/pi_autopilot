You are extending an existing Pi-based autonomous development orchestration system.

The system already supports, or is being designed to support:

* requirements/specification ingestion,
* epic and task generation,
* task refinement,
* readiness checks,
* autonomous implementation,
* review,
* verification,
* GitHub-backed workflow state.

I want you to add a new **backlog reconciliation mode** for existing projects.

## Goal

Implement a planning workflow that can take:

* original product requirements,
* architecture documents,
* ADRs or other technical documents,
* an existing GitHub Project / epic / issue backlog,
* and the current repository state,

then review the existing backlog and produce a structured set of proposed changes.

The system must **patch and enrich the existing backlog instead of regenerating it from scratch**.

The intended workflow is:

```text id="u5u3a5"
requirements + architecture docs
              +
       existing GH backlog
              +
        current repository
              ↓
      reconciliation planner
              ↓
      structured patch plan
              ↓
          policy layer
              ↓
     GitHub updates / proposals
              ↓
       readiness validation
              ↓
          agent:ready
```

## Core behavior

The reconciliation planner must inspect existing epics and issues and classify each relevant work item using actions such as:

```text id="g38mpm"
KEEP
ENRICH
SPLIT
MERGE_DUPLICATE
ADD_DEPENDENCY
REMOVE_DEPENDENCY
MARK_STALE
CREATE_MISSING
MARK_READY
NEEDS_HUMAN
```

Do not let the LLM perform arbitrary GitHub writes directly.

The LLM should produce a structured patch plan.

A deterministic application/policy layer should decide which patches are allowed to be applied automatically.

## Requirements traceability

Requirements should be traceable to backlog items.

Prefer stable requirement identifiers where available, e.g.:

```text id="v7g0ag"
REQ-AUTH-001
REQ-BILLING-004
REQ-SEC-012
```

The planner should be able to build or update a mapping such as:

```text id="zzu9km"
Requirement → Epic → Issue → Implementation
```

and identify:

* requirements with no corresponding work,
* requirements only partially covered,
* tasks with no apparent requirement or architectural justification,
* tasks whose implementation already exists,
* tasks made stale by newer requirements or repository changes.

## Requirement coverage model

Introduce an explicit coverage representation.

For example:

```text id="l0nksq"
REQ-001 → Epic #10 → Issues #11, #12 → covered
REQ-002 → Epic #10 → Issue #13      → partial
REQ-003 → no issue                  → missing
REQ-004 → Issue #21                 → implemented
```

The reconciliation process should report missing and partial coverage.

## Structured patch model

Define a typed patch protocol.

A possible direction is:

```ts id="fozhlf"
type BacklogPatch =
  | {
      type: "KEEP";
      issue: number;
      reason?: string;
    }
  | {
      type: "ENRICH_ISSUE";
      issue: number;
      patch: IssueEnrichment;
      reason: string;
    }
  | {
      type: "CREATE_ISSUE";
      epic?: number;
      spec: IssueSpec;
      reason: string;
    }
  | {
      type: "ADD_DEPENDENCY";
      issue: number;
      dependsOn: number;
      reason: string;
    }
  | {
      type: "REMOVE_DEPENDENCY";
      issue: number;
      dependsOn: number;
      reason: string;
    }
  | {
      type: "SPLIT_ISSUE";
      issue: number;
      children: IssueSpec[];
      reason: string;
    }
  | {
      type: "MARK_STALE";
      issue: number;
      reason: string;
    }
  | {
      type: "MARK_READY";
      issue: number;
      reason: string;
    }
  | {
      type: "NEEDS_HUMAN";
      issue?: number;
      reason: string;
      questions: string[];
    };
```

You may improve this model if the existing codebase suggests a better abstraction.

## Issue execution contract

When enriching an issue for autonomous execution, prefer adding a machine-owned execution section rather than replacing existing human-authored content.

A refined issue should support fields conceptually equivalent to:

```yaml id="62p6cc"
goal: >
  Bounded description of the intended outcome.

source_requirements:
  - REQ-AUTH-004

acceptance_criteria:
  - ...

constraints:
  - ...

dependencies:
  - 123

validation:
  - npm test -- auth
  - npm run typecheck

relevant_areas:
  - src/auth/

non_goals:
  - ...

refinement_version: 1
```

Preserve the original issue body and historical context.

## Existing implementation detection

The reconciler should use the current repository as evidence.

For example, if GitHub says:

```text id="zt21b8"
Create UserRepository abstraction
```

but an equivalent abstraction already exists in the repository, the system should be able to propose:

```text id="75e7c2"
MARK_STALE
```

with repository evidence.

Likewise, it should detect tasks that appear already implemented or superseded.

Do not assume issue state alone accurately represents implementation state.

## Task size and splitting

The planner should identify tasks that are too large for one autonomous coding-agent session.

The preferred unit is the **smallest independently implementable and verifiable behavioral outcome**, not the smallest possible code edit.

A task is probably small enough when:

* it has one primary outcome,
* it can reasonably fit within one isolated agent execution,
* acceptance criteria are independently testable,
* dependencies are known,
* scope is bounded,
* it does not require unresolved product decisions.

Avoid splitting into meaningless implementation trivia such as:

```text id="t80u7a"
create class
add method
import class
```

Prefer behavioral slices such as:

```text id="c48xko"
Reject revoked sessions during authentication
```

## Ambiguity handling

Classify ambiguities.

At minimum distinguish:

```ts id="7nif2g"
type AmbiguityType =
  | "ENGINEERING"
  | "PRODUCT"
  | "MISSING_CONTEXT"
  | "CONFLICTING_REQUIREMENTS";
```

The system may autonomously investigate and resolve engineering ambiguity.

It must not silently make product decisions when requirements are insufficient.

Product ambiguity or conflicting requirements should produce a `NEEDS_HUMAN` patch/proposal.

## Dry-run behavior

Implement reconciliation so it can run without mutating GitHub.

The initial/default mode should support a dry run that produces a human-readable summary and the underlying structured patch plan.

Conceptually:

```text id="2jjlnd"
plan reconcile --dry-run
```

Example output:

```text id="f77ln7"
Epic #12 — Authentication

KEEP
  #15 OAuth callback

ENRICH
  #16 Create user from GitHub identity
    + missing failure acceptance criterion
    + dependency on #15

SPLIT
  #17 Implement session management
    → Persist sessions
    → Validate sessions
    → Revoke sessions

CREATE
  Admin session revocation endpoint

STALE
  #21 Store OAuth token in browser

COVERAGE
  14/15 requirements covered
  REQ-AUTH-009 is currently uncovered
```

## Patch-application policy

Separate proposal generation from application.

Introduce a deterministic policy layer.

Support the concept of different application modes such as:

```text id="rcnkca"
dry-run
apply-safe
apply-all
```

`apply-safe` should automatically apply only low-risk additive operations.

A reasonable initial policy could permit:

```text id="esqabj"
ENRICH_ISSUE
ADD_DEPENDENCY
CREATE_ISSUE
MARK_READY
```

while requiring explicit approval or proposal-only handling for:

```text id="pu22p7"
SPLIT_ISSUE
MERGE_DUPLICATE
MARK_STALE
destructive changes
```

Adjust the exact policy based on the repository's existing abstractions.

## GitHub integration

Reuse the existing GitHub integration rather than creating parallel infrastructure.

The reconciler should work with existing:

* epics,
* issues,
* labels,
* project fields,
* parent relationships,
* dependencies,

where those concepts already exist in the project.

Do not introduce a second source of truth unless necessary.

If local persistence is required, keep GitHub as the durable project-facing state.

## Architecture

Keep the LLM responsible for:

* interpreting requirements,
* comparing requirement intent to backlog state,
* identifying gaps,
* proposing decomposition,
* reasoning about repository evidence.

Keep deterministic code responsible for:

* state transitions,
* GitHub writes,
* policy enforcement,
* validation of structured outputs,
* duplicate protection,
* retries,
* destructive-operation restrictions.

The desired boundary is:

```text id="bc3153"
LLM reasoning
     ↓
typed reconciliation result
     ↓
validation
     ↓
policy engine
     ↓
GitHub adapter
```

not:

```text id="ry1g61"
LLM directly mutates GitHub however it wants
```

## Integration with the existing autonomous workflow

The reconciler should feed into the existing refinement/readiness pipeline.

The final lifecycle should be approximately:

```text id="cvk5ec"
documents
    ↓
existing backlog reconciliation
    ↓
epic/task patches
    ↓
task refinement
    ↓
readiness checker
    ↓
agent:ready
    ↓
autonomous implementation
    ↓
review
    ↓
verification
    ↓
merge
```

Do not duplicate readiness logic unnecessarily.

If the existing system already has a task-refinement or readiness abstraction, integrate with it.

## Implementation approach

Before coding:

1. Inspect the existing repository architecture.
2. Identify current abstractions for:

   * GitHub access,
   * task state,
   * Pi/LLM invocation,
   * structured agent outputs,
   * configuration,
   * CLI commands,
   * persistence.
3. Propose the smallest clean extension to the existing architecture.
4. Prefer adapting existing abstractions over introducing a separate framework.

Then implement the feature incrementally.

## Suggested first milestone

The first milestone does not need every patch type.

Implement one end-to-end reconciliation path:

```text id="8v26ft"
requirements docs
      +
existing GitHub epic + issues
      +
current repo
      ↓
LLM reconciliation
      ↓
typed patch plan
      ↓
dry-run report
```

Initially support at least:

```text id="7d5v9i"
KEEP
ENRICH_ISSUE
CREATE_ISSUE
ADD_DEPENDENCY
MARK_STALE
NEEDS_HUMAN
```

Do not mutate GitHub in the first milestone unless the existing architecture makes dry-run + mutation trivial to separate.

Once dry-run behavior and tests are solid, add safe patch application.

## Testing

Add tests covering at minimum:

* parsing/validation of structured reconciliation output,
* missing requirement detection,
* partial requirement coverage,
* preserving existing issue content during enrichment,
* creating a missing task proposal,
* detecting oversized-task split recommendations,
* engineering vs product ambiguity classification,
* policy rejection of unsafe/destructive patches,
* dry-run causing zero GitHub mutations,
* idempotency where practical.

A second reconciliation run over unchanged inputs should not continually propose the same already-applied enrichment.

## Non-goals for this change

Do not:

* rewrite the whole autonomous orchestration system,
* delete and regenerate existing GitHub boards,
* replace Superpowers,
* introduce distributed worker infrastructure,
* introduce unnecessary queues or services,
* implement arbitrary autonomous product decision-making.

## Deliverables

At completion, provide:

1. the implemented code,
2. tests,
3. concise documentation of the reconciliation flow,
4. an example dry-run command,
5. an example reconciliation report,
6. explanation of new types/modules,
7. any assumptions or unresolved design questions,
8. recommended next step for adding `apply-safe`.

Keep the implementation simple and aligned with the existing repository architecture.

If this prompt conflicts with existing architectural conventions in the repository, preserve the intent but adapt the implementation to the codebase rather than forcing these example types or filenames.
