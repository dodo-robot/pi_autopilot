# Autonomous Development Orchestration for Pi

## 1. Background

The project currently uses:

* Pi as the development/coding agent.
* Superpowers for requirements exploration, brainstorming, specification, and implementation planning.
* GitHub Issues/Epics to represent planned development work.
* Git as the source-control system.

Existing projects may already contain:

* requirements documents,
* specifications generated through Superpowers,
* GitHub epics,
* GitHub tasks/issues,
* dependencies between tasks,
* partially completed work.

The current workflow still requires a human developer to decide which tasks are sufficiently specified, start agent sessions, supervise implementation, review failures, and determine what should happen next.

The objective of this project is to reduce that ongoing supervision by introducing an autonomous development orchestration capability around Pi.

---

# 2. Goal

Build a Pi-compatible system that can take an existing planned software project and autonomously progress it from refined GitHub tasks to completed, verified changes.

The desired high-level workflow is:

```text
Requirements / Specifications
        ↓
GitHub Epics + Tasks
        ↓
Refinement / Readiness
        ↓
Autonomous Execution
        ↓
Review
        ↓
Verification
        ↓
Merge / Completion
```

The system should be capable of running for extended periods without requiring routine human intervention.

Human involvement should primarily be required when the system encounters genuine product ambiguity, conflicting requirements, unsafe actions, or conditions it cannot resolve reliably.

---

# 3. Existing Workflow

Before this system is introduced, requirements may already have gone through a process similar to:

```text
Requirements Document
        ↓
Pi + Superpowers
        ↓
Brainstorming / Planning
        ↓
GitHub Epic
        ↓
GitHub Tasks
```

Therefore, the system MUST NOT assume that it is responsible for generating all epics and tasks from scratch.

It MUST support adopting an existing GitHub backlog.

Existing issues should be preserved whenever practical rather than recreated.

---

# 4. Primary Use Case

A developer has a repository containing an application and an existing set of GitHub epics/tasks.

The developer starts the autonomous development system.

The system:

1. Discovers relevant existing epics and tasks.
2. Determines whether the planned work is sufficiently defined for autonomous execution.
3. Refines tasks where additional engineering detail can be derived safely.
4. Identifies dependencies between tasks.
5. Identifies tasks that are currently executable.
6. Selects an executable task.
7. Creates an isolated development environment.
8. Starts an appropriate Pi agent.
9. Allows the agent to implement the task.
10. Validates the implementation.
11. Performs independent review.
12. Requests corrections when necessary.
13. Verifies that the task's requirements have actually been satisfied.
14. Integrates successful work.
15. Updates GitHub state.
16. Selects the next executable work.
17. Continues until no further work can safely progress.

---

# 5. Refinement Requirements

## 5.1 Existing backlog

The system MUST be capable of inspecting existing GitHub epics and tasks.

It MUST NOT automatically discard or regenerate existing planning artifacts simply because they were created before the autonomous system existed.

The system SHOULD augment existing issues when additional information is required.

Original issue content SHOULD remain available for historical and human context.

---

## 5.2 Epic analysis

Before executing tasks belonging to an epic, the system SHOULD determine whether:

* the epic represents a coherent outcome,
* all obvious implementation areas are represented,
* tasks overlap or duplicate each other,
* tasks appear obsolete,
* tasks are excessively large,
* important dependencies are missing,
* tasks can execute concurrently,
* task ordering is required,
* the epic conflicts with the current repository state.

The system MAY propose modifications to the epic/task structure.

Material changes to product scope MUST NOT be made silently.

---

## 5.3 Task refinement

A task intended for autonomous execution SHOULD contain enough information for an isolated agent to understand:

* the goal,
* relevant context,
* expected behavior,
* acceptance criteria,
* constraints,
* dependencies,
* validation expectations,
* relevant architectural context when necessary,
* known non-goals where useful.

The system MAY derive missing engineering details by inspecting:

* the repository,
* related issues,
* parent epics,
* specifications,
* requirements documents,
* previous implementation work.

---

# 6. Readiness Gate

The system MUST distinguish between:

```text
planned work
```

and:

```text
autonomously executable work
```

A task MUST pass a readiness check before the autonomous executor may claim it.

A readiness check SHOULD determine whether:

* the objective is unambiguous,
* acceptance criteria are testable,
* dependencies are satisfied or represented,
* the scope is reasonably bounded,
* validation is possible,
* required context can be located,
* execution would require product decisions not already specified.

Tasks that pass SHOULD enter a machine-recognizable ready state.

Example conceptual state:

```text
agent:ready
```

The exact GitHub representation is intentionally unspecified and may be determined during design.

---

# 7. Ambiguity Handling

The system MUST distinguish between ambiguity that can reasonably be resolved through engineering investigation and ambiguity requiring product judgment.

Examples of engineering ambiguity:

* which existing module owns a behavior,
* which internal API should be reused,
* which tests cover an area,
* whether a dependency already exists,
* which files require modification.

The system MAY autonomously resolve these questions.

Examples of product ambiguity:

* what behavior users should experience,
* which business rule should apply,
* whether a feature should support a particular workflow,
* which of multiple conflicting requirements is authoritative.

The system SHOULD stop affected work when unresolved product ambiguity would materially influence behavior.

Other independent work SHOULD continue whenever possible.

---

# 8. Autonomous Execution

Once a task has passed the readiness gate, the system SHOULD be able to execute it without human intervention.

Execution SHOULD occur in an isolated workspace.

Possible mechanisms include Git branches, Git worktrees, containers, or another isolation mechanism selected during design.

Multiple independent tasks MAY execute concurrently.

Two agents MUST NOT unintentionally modify the same execution workspace.

---

# 9. Agent Roles

The system SHOULD support multiple logical roles.

Possible roles include:

### Planner / Refiner

Responsible for understanding planned work and improving its executability.

### Implementer

Responsible for modifying the repository to satisfy a specific task.

### Reviewer

Responsible for independently evaluating an implementation against its task and engineering quality expectations.

### Verifier

Responsible for determining whether the requested behavior actually works and acceptance criteria are satisfied.

The design MAY combine or further separate these roles if there is a strong reason.

The system SHOULD avoid relying on one long-running conversational context for all roles.

---

# 10. Independent Evaluation

An agent that implements a task SHOULD NOT be the sole authority deciding that the task is complete.

Completion SHOULD require independent evaluation.

Reviewers and verifiers SHOULD receive the minimum context required to evaluate the result independently.

They SHOULD NOT require access to the implementer's entire reasoning history.

Relevant inputs may include:

* task specification,
* parent requirements,
* repository state,
* diff,
* commits,
* test output,
* acceptance criteria.

---

# 11. Structured Agent Communication

The orchestration system SHOULD NOT depend primarily on parsing arbitrary natural-language agent responses.

Agent executions SHOULD return structured outcomes where practical.

Conceptually, outcomes may include:

```text
COMPLETED
CHANGES_REQUESTED
BLOCKED
NEEDS_REFINEMENT
NEEDS_REPLAN
FAILED
```

Results SHOULD contain enough structured metadata for the orchestrator to decide the next state deterministically.

The exact protocol is to be determined during design.

---

# 12. State Management

The system MUST maintain durable workflow state.

A process restart MUST NOT require the entire project to be rediscovered from conversational memory.

The system SHOULD be able to reconstruct:

* which tasks are ready,
* which tasks are running,
* which tasks are blocked,
* which implementations await review,
* which tasks have failed,
* which tasks have completed,
* dependencies between tasks.

GitHub SHOULD remain an important durable source of project state.

Additional local persistence MAY be introduced if required.

---

# 13. Dependency Management

The system SHOULD represent task dependencies explicitly enough for scheduling decisions.

For example:

```text
Task A
 ├── Task B
 │     └── Task D
 │
 └── Task C
       └── Task E
```

After Task A completes, Tasks B and C may become executable concurrently.

The scheduler SHOULD prefer work whose dependencies are satisfied.

Blocked work SHOULD NOT unnecessarily prevent independent tasks from progressing.

---

# 14. Failure Handling

Autonomous agents may:

* crash,
* time out,
* produce incorrect implementations,
* repeatedly fail tests,
* become stuck,
* exhaust context,
* misunderstand requirements,
* encounter external failures.

The orchestration system MUST expect these conditions.

Failures SHOULD result in explicit workflow transitions rather than uncontrolled retry loops.

---

# 15. Budgets and Loop Protection

Every autonomous unit of work SHOULD have bounded execution.

Potential limits include:

* maximum implementation attempts,
* maximum review cycles,
* maximum replanning attempts,
* maximum execution duration,
* model/token budget,
* command execution limits.

Repeated identical or substantially similar failures SHOULD be detected where practical.

Exhausting a budget SHOULD move work into an explicit blocked or failed state rather than continuing indefinitely.

---

# 16. Recovery

The system SHOULD survive interruption.

After restart it SHOULD determine whether previously running work:

* completed,
* failed,
* remains active,
* became orphaned,
* needs to be retried.

Agent ownership of tasks SHOULD be recoverable.

Duplicate execution of the same task SHOULD be prevented where practical.

---

# 17. Repository Safety

Autonomous agents MUST NOT directly corrupt or destabilize the primary working tree.

Implementation SHOULD occur in isolated branches/workspaces.

Potentially destructive repository operations SHOULD be controlled.

The system SHOULD preserve sufficient information to investigate failed autonomous changes.

---

# 18. Merge Policy

The system MAY merge work automatically when configured to do so.

Automatic merge SHOULD only occur after required validation stages have succeeded.

Merge eligibility MAY depend on:

* tests,
* acceptance criteria,
* reviewer approval,
* verifier approval,
* repository status,
* branch state,
* policy configuration.

The system SHOULD support disabling automatic merge while retaining all other autonomous behavior.

---

# 19. Requirements Traceability

Where possible, the system SHOULD preserve relationships between:

```text
requirement
    ↓
specification
    ↓
epic
    ↓
task
    ↓
implementation
    ↓
verification
```

Agents SHOULD be able to locate higher-level context when required.

The system SHOULD avoid duplicating large requirement/specification documents into every task.

References to canonical repository artifacts are preferable where practical.

---

# 20. Plan Evolution

Plans may become stale as autonomous development progresses.

The system SHOULD be capable of detecting cases where:

* repository architecture changed,
* dependencies changed,
* completed work invalidated assumptions,
* requirements changed,
* planned implementation no longer matches reality.

The system SHOULD support replanning affected future work.

Work generated from outdated planning information SHOULD be identifiable.

---

# 21. Human Escalation

The target is minimal intervention, not the elimination of all human judgment.

The system SHOULD request human intervention when necessary.

Examples include:

* unresolved product decisions,
* contradictory requirements,
* security-sensitive decisions outside configured policy,
* repeated failures,
* inability to determine intended behavior,
* changes that materially expand scope.

Escalation of one task SHOULD NOT stop unrelated executable work.

---

# 22. Pi Integration

Pi is the intended agent runtime.

The solution SHOULD integrate naturally with Pi.

The design should investigate whether functionality belongs in:

* a Pi extension/plugin,
* an external orchestration process,
* reusable Pi skills,
* command-line utilities,
* or a combination of these.

The requirements intentionally do not prescribe the final architecture.

Pi sessions SHOULD be launchable programmatically for autonomous work.

The system SHOULD support role-specific agent sessions.

---

# 23. Superpowers Integration

Superpowers is already part of the development methodology.

The new system SHOULD reuse Superpowers concepts and skills where they provide value rather than reimplementing them unnecessarily.

Existing projects may already have been planned using Superpowers.

The system SHOULD therefore support both:

```text
new requirement
→ Superpowers
→ autonomous workflow
```

and:

```text
existing Superpowers-generated backlog
→ refinement/readiness
→ autonomous workflow
```

The design should determine where Superpowers ends and autonomous orchestration begins.

---

# 24. GitHub Integration

GitHub is the current system used to represent epics and tasks.

The solution SHOULD investigate using GitHub for:

* work discovery,
* task state,
* dependencies,
* agent ownership,
* execution status,
* review status,
* human escalation,
* completion state.

The system SHOULD minimize unnecessary duplication between GitHub and any internal persistence layer.

---

# 25. Observability

A developer SHOULD be able to understand what the autonomous system is doing without reading agent transcripts.

The system SHOULD expose information such as:

```text
Epic: Authentication overhaul

✓ #101 Session model
✓ #102 OAuth callback
● #103 Token refresh       IMPLEMENTING
● #104 Logout API          REVIEW
○ #105 Account UI          BLOCKED BY #103
! #106 Migration           NEEDS_REFINEMENT
```

Relevant agent decisions and failures SHOULD be inspectable.

Logs SHOULD make it possible to reconstruct why a workflow transition occurred.

---

# 26. Initial Scope

The first implementation SHOULD prioritize reliability over maximum autonomy or concurrency.

A reasonable initial milestone is:

```text
existing GitHub task
        ↓
refinement
        ↓
readiness validation
        ↓
ready
        ↓
isolated Pi implementation
        ↓
tests
        ↓
independent review
        ↓
verification
        ↓
PR / merge
        ↓
GitHub task completed
```

The first version MAY execute only one task at a time.

---

# 27. Out of Scope for Initial Version

Unless brainstorming identifies a strong requirement, the first version does not need:

* Kubernetes,
* distributed worker infrastructure,
* complex message queues,
* a dedicated web UI,
* arbitrary numbers of cooperating agents,
* sophisticated distributed locking,
* multi-machine execution,
* fully autonomous product design,
* replacement of GitHub,
* replacement of Superpowers.

The system should remain as simple as possible while supporting reliable autonomous execution.

---

# 28. Success Criteria

The project is successful when a developer can select an appropriately specified epic or set of tasks, start the system, and allow it to make meaningful progress without routine supervision.

For a suitable project, the expected experience should approach:

```text
Developer
   │
   ├── defines / approves requirements
   │
   ▼
Autonomous system starts
   │
   ├── refines backlog
   ├── identifies executable work
   ├── implements tasks
   ├── reviews changes
   ├── fixes issues
   ├── verifies behavior
   ├── integrates successful work
   └── continues through dependency graph
   │
   ▼
Developer returns later
   │
   ├── sees completed work
   ├── sees remaining work
   └── resolves only genuine escalations
```

The system SHOULD make progress without requiring the developer to continuously decide what the agents should do next.

---

# 29. Questions for Brainstorming

The brainstorming phase should explicitly investigate:

1. What functionality belongs inside a Pi extension versus an external supervisor?
2. Should GitHub be the complete workflow database or should local persistence also exist?
3. What is the minimum execution contract required before a task becomes autonomous?
4. How should existing GitHub issues be augmented without making them noisy?
5. How should task dependencies be represented?
6. Should refinement modify GitHub directly or first propose changes?
7. How should Superpowers skills be invoked from autonomous sessions?
8. What constitutes sufficient independent review?
9. Should verification be a separate Pi session from code review?
10. Which actions should agents be permitted to perform?
11. Which actions should only the orchestrator perform?
12. What should constitute a human escalation?
13. How should stale plans and requirements be detected?
14. How should crashed or abandoned Pi sessions be recovered?
15. How should agent execution results be represented structurally?
16. How should execution budgets be configured?
17. How should automatic merging be controlled?
18. How much concurrency is useful for the first production version?
19. How should the system expose its current state to the developer?
20. What is the smallest architecture that can reliably complete one epic unattended?

---

# 30. Design Principle

The system should optimize for:

**bounded autonomous execution based on explicit, durable project state**

rather than:

**one indefinitely running AI conversation attempting to manage the entire project.**

Autonomy should come from a reliable workflow that repeatedly gives agents well-defined reasoning and implementation jobs, observes their results, and advances durable state.

