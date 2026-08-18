#!/usr/bin/env node
/**
 * Controllable fake Pi executable for the M1 acceptance suite.
 *
 * This is a real, compiled, standalone executable — it is invoked exactly
 * like the real `pi` CLI via `PiRunner`'s `piCommand` override (a
 * constructor-injection seam that already exists for tests), never through
 * an environment-controlled production backdoor. It reads the guard
 * envelope PiRunner wrote (`AUTOPILOT_GUARD_CONFIG`) to learn the role and
 * result path.
 *
 * Unlike `tests/fixtures/pi/fake-pi.mjs` (whose behavior is chosen entirely
 * by a `SCENARIO:<name>` marker embedded in the prompt), this fake needs to
 * script attempt-by-attempt behavior across an entire supervised run
 * (implementer attempt 1 fails verification, attempt 2 passes; reviewer
 * requests changes twice, then approves; etc.). PiRunner's real
 * environment plumbing (`safeProcessEnv`) deliberately does not forward
 * arbitrary test environment variables into the sandboxed session process,
 * so the scenario FILE PATH itself travels the same way the marker does:
 * embedded in the prompt text as `FAKE_PI_SCENARIO:<path>`. The test
 * harness embeds this marker once, in the GitHub issue body — every
 * subsequent role prompt (refiner, implementer, reviewer) is built from
 * either that issue body or the frozen task snapshot the refiner derived
 * from it, so the marker round-trips through the entire run.
 *
 * A scenario is a list of steps, each optionally scoped to a role and/or a
 * 1-based attempt number for that role. Steps without an explicit
 * `attempt` match every attempt of that role that no more specific step
 * claims. If no step matches, the fake falls back to a valid default
 * result for the envelope's role.
 *
 * Steps may also mutate the worktree (write files) before completing, to
 * simulate real implementer edits, and/or declare a `policyAttempt` — a
 * command or path the role attempts that is evaluated against the real
 * `src/security/command-policy.ts` functions before anything else
 * happens, so a scripted destructive-command or protected-path attempt
 * is denied exactly as the production guard extension would deny it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertWorkspacePath,
  evaluateShellCommand,
} from "../security/command-policy.js";

export type FakeRole = "refiner" | "implementer" | "reviewer";

export type FakeAction =
  | "result"
  | "malformed"
  | "omit"
  | "timeout"
  | "exit-nonzero"
  | "exit-nonzero-after-result";

export interface FakeMutation {
  /** Relative-to-worktree (or absolute) path -> file contents to write. */
  writeFiles?: Record<string, string>;
}

export interface FakePolicyAttempt {
  /** A bash command line to evaluate against the envelope's allowedCommands. */
  command?: string;
  /** A path to evaluate against the envelope's protectedPaths/worktree bounds. */
  path?: string;
}

export interface FakeStep {
  /** Restrict this step to one role. Omit to match any role. */
  role?: FakeRole;
  /** Restrict this step to the Nth (1-based) attempt seen for that role. */
  attempt?: number;
  action: FakeAction;
  /** Structured payload to submit when action is "result". */
  payload?: unknown;
  /** Worktree mutation applied before completing (any action). */
  mutate?: FakeMutation;
  /**
   * A command or path this step's role attempts, evaluated against the
   * REAL `src/security/command-policy.ts` functions (the same module the
   * production guard extension calls from inside a real Pi session) using
   * the envelope's `allowedCommands`/`protectedPaths`. Demonstrates, at
   * the acceptance level, that the orchestrator's policy configuration
   * reaches the guard and would reject the attempt; the real-time
   * tool-call interception itself is unit/integration-tested separately
   * (`tests/unit/pi/guard-extension.test.ts`,
   * `tests/unit/security/command-policy.test.ts`) since it requires a
   * live Pi `tool_call` event this standalone fake never receives.
   */
  policyAttempt?: FakePolicyAttempt;
  /** Milliseconds to sleep before completing (any action). */
  sleepMs?: number;
}

export interface FakeScenario {
  steps: FakeStep[];
}

interface GuardEnvelope {
  worktree: string;
  role: FakeRole;
  resultPath: string;
  allowedCommands: string[];
  protectedPaths: string[];
}

/**
 * Marker embedded in the prompt carrying the scenario file's path. Stops
 * before JSON/Markdown punctuation (`"`, `,`, backtick, closing brackets)
 * so the marker survives being embedded inside a JSON string value (e.g.
 * `TaskSnapshot.context`) without swallowing the closing quote.
 */
const SCENARIO_MARKER = /FAKE_PI_SCENARIO:([^\s"',`)}\]]+)/;

const DEFAULT_PAYLOADS: Record<FakeRole, unknown> = {
  refiner: {
    outcome: "READY",
    taskDraft: {
      schemaVersion: 1,
      repository: { owner: "acme", repo: "widgets" },
      issue: { number: 42, nodeId: "I_42", updatedAt: "2026-08-18T00:00:00Z" },
      objective: "Implement token refresh validation",
      context: "The auth module owns session refresh.",
      expectedBehavior: ["Expired refresh tokens are rejected"],
      acceptanceCriteria: [
        { id: "ac1", text: "A refresh with an expired token returns 401" },
      ],
      constraints: [],
      nonGoals: [],
      validation: ["npm test"],
      dependencies: [],
      canonicalReferences: [],
      sourceBodyHash: "will-be-overwritten",
    },
    missingInformation: [],
    dependencies: [],
    ambiguities: [],
  },
  implementer: {
    outcome: "COMPLETED",
    summary: "implemented the task",
    changedPaths: ["src/example.ts"],
    commandsAttempted: ["npm test"],
    unresolvedProblems: [],
    evidenceLocations: [],
  },
  reviewer: {
    outcome: "APPROVED",
    criteriaResults: [{ criterionId: "ac1", passed: true, notes: "verified" }],
    findings: [],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvelope(): GuardEnvelope {
  const envelopePath = process.env.AUTOPILOT_GUARD_CONFIG;
  if (envelopePath === undefined || envelopePath.length === 0) {
    throw new Error("fake-pi: AUTOPILOT_GUARD_CONFIG is not set");
  }
  const parsed = JSON.parse(readFileSync(envelopePath, "utf8")) as Partial<GuardEnvelope>;
  if (
    typeof parsed.worktree !== "string" ||
    typeof parsed.resultPath !== "string" ||
    typeof parsed.role !== "string"
  ) {
    throw new Error("fake-pi: malformed guard envelope");
  }
  return {
    worktree: parsed.worktree,
    role: parsed.role as FakeRole,
    resultPath: parsed.resultPath,
    allowedCommands: Array.isArray(parsed.allowedCommands) ? parsed.allowedCommands : [],
    protectedPaths: Array.isArray(parsed.protectedPaths) ? parsed.protectedPaths : [],
  };
}

/**
 * Evaluate a scripted policy attempt against the REAL command-policy
 * module using the envelope's configured allowlist/protected paths.
 * Returns a denial reason, or null when the policy would allow it.
 */
function evaluatePolicyAttempt(
  envelope: GuardEnvelope,
  attempt: FakePolicyAttempt | undefined,
): string | null {
  if (attempt === undefined) return null;
  if (attempt.command !== undefined) {
    const decision = evaluateShellCommand(attempt.command, envelope.allowedCommands);
    if (!decision.allowed) return decision.reason ?? "command denied by policy";
  }
  if (attempt.path !== undefined) {
    try {
      assertWorkspacePath(envelope.worktree, attempt.path, envelope.protectedPaths);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

/** Extract the scenario file path from the `FAKE_PI_SCENARIO:<path>` prompt marker. */
function findScenarioPath(prompt: string): string | null {
  const match = SCENARIO_MARKER.exec(prompt);
  return match?.[1] ?? null;
}

function loadScenario(scenarioPath: string | null): FakeScenario | null {
  if (scenarioPath === null || !existsSync(scenarioPath)) return null;
  return JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeScenario;
}

/**
 * Tracks how many times each role has been invoked, in a small counter
 * file alongside the scenario file, since every attempt is a fresh
 * process with no in-memory state to share across invocations.
 */
function nextAttemptNumber(scenarioPath: string | null, role: FakeRole): number {
  if (scenarioPath === null) return 1;
  const counterPath = `${scenarioPath}.attempts.json`;
  let counters: Record<string, number> = {};
  if (existsSync(counterPath)) {
    counters = JSON.parse(readFileSync(counterPath, "utf8")) as Record<string, number>;
  }
  const next = (counters[role] ?? 0) + 1;
  counters[role] = next;
  writeFileSync(counterPath, JSON.stringify(counters), "utf8");
  return next;
}

/** Log every invocation for post-hoc diagnosis (mirrors real Pi session logs). */
function logInvocation(
  scenarioPath: string | null,
  role: FakeRole,
  attempt: number,
  action: FakeAction,
): void {
  if (scenarioPath === null) return;
  const logPath = `${scenarioPath}.log.jsonl`;
  appendFileSync(
    logPath,
    `${JSON.stringify({ role, attempt, action, pid: process.pid, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

function selectStep(
  scenario: FakeScenario | null,
  role: FakeRole,
  attempt: number,
): FakeStep | null {
  if (scenario === null) return null;
  // Prefer an exact role+attempt match.
  const exact = scenario.steps.find(
    (step) => step.role === role && step.attempt === attempt,
  );
  if (exact !== undefined) return exact;
  // Fall back to a role-only step scoped to no particular attempt (matches
  // every attempt of that role that no more specific step claims).
  const roleOnly = scenario.steps.find(
    (step) => step.role === role && step.attempt === undefined,
  );
  if (roleOnly !== undefined) return roleOnly;
  // Fall back to a role-agnostic step (rare; mostly for simple smoke tests).
  const anyRole = scenario.steps.find(
    (step) => step.role === undefined && step.attempt === attempt,
  );
  return anyRole ?? null;
}

function applyMutation(worktree: string, mutate: FakeMutation | undefined): void {
  if (mutate?.writeFiles === undefined) return;
  for (const [relative, contents] of Object.entries(mutate.writeFiles)) {
    const target = path.isAbsolute(relative) ? relative : path.join(worktree, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
}

function writeResult(resultPath: string, payload: string): void {
  writeFileSync(resultPath, payload, { flag: "wx", mode: 0o600 });
}

/** Refiner prompt line: `Issue: #<number> (updated <ISO timestamp>)`. */
const PROMPT_ISSUE_LINE = /^Issue: #(\d+) \(updated ([^)]+)\)$/m;

/**
 * A real refiner echoes back the exact issue it was asked to analyze, not
 * a value scripted in advance. A scenario's refiner payload is written
 * once but reused across `check`/`prepare`/`run` invocations that may see
 * a different `updatedAt` each time (e.g. after `prepare` mutates the
 * issue body). Patch `taskDraft.issue.updatedAt` from the live prompt so
 * the deterministic material-change check in `run-service.ts` compares
 * against what the issue actually was at analysis time, exactly as the
 * real orchestrator would receive it.
 */
function withLiveIssueFields(role: FakeRole, prompt: string, payload: unknown): unknown {
  if (role !== "refiner" || typeof payload !== "object" || payload === null) {
    return payload;
  }
  const match = PROMPT_ISSUE_LINE.exec(prompt);
  if (match === null) return payload;
  const updatedAt = match[2];
  const draft = (payload as { taskDraft?: { issue?: { updatedAt?: string } } }).taskDraft;
  if (draft?.issue === undefined) return payload;
  return {
    ...payload,
    taskDraft: { ...draft, issue: { ...draft.issue, updatedAt } },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const prompt = args.at(-1) ?? "";

  // Mirror Pi's session behavior: create the session directory.
  const sessionDirIndex = args.indexOf("--session-dir");
  if (sessionDirIndex >= 0 && args[sessionDirIndex + 1] !== undefined) {
    mkdirSync(args[sessionDirIndex + 1]!, { recursive: true });
  }

  const envelope = loadEnvelope();
  const scenarioPath = findScenarioPath(prompt);
  const attempt = nextAttemptNumber(scenarioPath, envelope.role);
  const scenario = loadScenario(scenarioPath);
  const step = selectStep(scenario, envelope.role, attempt);
  const action: FakeAction = step?.action ?? "result";

  logInvocation(scenarioPath, envelope.role, attempt, action);
  console.log(
    JSON.stringify({ type: "diagnostic", role: envelope.role, attempt, action }),
  );

  // If this step attempts something the real command-policy module would
  // deny, stop exactly like a real session would after its tool call is
  // blocked: report BLOCKED and never perform the mutation, regardless of
  // what the step otherwise scripted.
  const denialReason = evaluatePolicyAttempt(envelope, step?.policyAttempt);
  if (denialReason !== null) {
    writeResult(
      envelope.resultPath,
      JSON.stringify({
        outcome: "BLOCKED",
        reason: `autopilot policy denied the attempt: ${denialReason}`,
        unresolvedProblems: [denialReason],
      }),
    );
    return;
  }

  if (step?.sleepMs !== undefined) {
    await sleep(step.sleepMs);
  }
  if (step?.mutate !== undefined) {
    applyMutation(envelope.worktree, step.mutate);
  }

  switch (action) {
    case "malformed":
      writeResult(envelope.resultPath, "{ not valid json");
      return;
    case "omit":
      return;
    case "timeout":
      await sleep(step?.sleepMs ?? 30_000);
      return;
    case "exit-nonzero":
      process.exit(2);
      return;
    case "exit-nonzero-after-result": {
      const payload = withLiveIssueFields(
        envelope.role,
        prompt,
        step?.payload ?? DEFAULT_PAYLOADS[envelope.role],
      );
      writeResult(envelope.resultPath, JSON.stringify(payload));
      process.exit(2);
      return;
    }
    case "result":
    default: {
      const payload = withLiveIssueFields(
        envelope.role,
        prompt,
        step?.payload ?? DEFAULT_PAYLOADS[envelope.role],
      );
      writeResult(envelope.resultPath, JSON.stringify(payload));
      return;
    }
  }
}

void main();
