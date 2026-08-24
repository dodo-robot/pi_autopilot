import { readFileSync, writeFileSync, realpathSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertWorkspacePath,
  evaluateShellCommand,
} from "../security/command-policy.js";

/**
 * Guard envelope written by the orchestrator before launching Pi. Contains
 * only the configuration the guard needs — no secrets.
 */
interface GuardEnvelope {
  worktree: string;
  role: string;
  resultPath: string;
  allowedCommands: string[];
  protectedPaths: string[];
  allowedTools: string[];
  /**
   * Absolute path allow-list for reads of skill files that live outside the
   * worktree (e.g. ~/.pi/agent/.../skills). Only reads are permitted here;
   * these paths are never writable by any role.
   */
  skillPaths: string[];
}

/** Built-in tools the guard intercepts. */
const GUARDED_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
];

function fail(message: string): never {
  throw new Error(`autopilot guard: ${message}`);
}

/**
 * Read and validate the guard envelope. The extension refuses to load when
 * the envelope is missing or malformed so an unguarded Pi session can never
 * start.
 */
function loadEnvelope(): GuardEnvelope {
  const envelopePath = process.env.AUTOPILOT_GUARD_CONFIG;
  if (!envelopePath || envelopePath.length === 0) {
    fail("AUTOPILOT_GUARD_CONFIG is not set; refusing to run unguarded");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(envelopePath, "utf8"));
  } catch (error) {
    fail(`cannot read guard envelope ${envelopePath}: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    fail("invalid guard envelope: not an object");
  }

  const env = parsed as Partial<GuardEnvelope>;
  if (typeof env.worktree !== "string" || env.worktree.length === 0) {
    fail("invalid guard envelope: worktree missing");
  }
  if (typeof env.resultPath !== "string" || env.resultPath.length === 0) {
    fail("invalid guard envelope: resultPath missing");
  }
  if (
    !Array.isArray(env.allowedCommands) ||
    env.allowedCommands.some((entry) => typeof entry !== "string")
  ) {
    fail("invalid guard envelope: allowedCommands missing");
  }
  if (!Array.isArray(env.protectedPaths)) {
    fail("invalid guard envelope: protectedPaths missing");
  }
  if (
    !Array.isArray(env.allowedTools) ||
    env.allowedTools.some((entry) => typeof entry !== "string")
  ) {
    fail("invalid guard envelope: allowedTools missing");
  }
  if (env.skillPaths !== undefined &&
    (!Array.isArray(env.skillPaths) ||
      env.skillPaths.some((entry) => typeof entry !== "string"))
  ) {
    fail("invalid guard envelope: skillPaths must be a string array");
  }

  return {
    worktree: env.worktree,
    role: typeof env.role === "string" ? env.role : "implementer",
    resultPath: env.resultPath,
    allowedCommands: env.allowedCommands as string[],
    protectedPaths: env.protectedPaths as string[],
    allowedTools: env.allowedTools as string[],
    skillPaths: (env.skillPaths as string[]) ?? [],
  };
}

/**
 * Returns true when `candidate` resolves to a path under one of the allow-listed
 * skill paths. The worktree root is resolved to realpath so symlinked skills
 * (e.g. ~/.pi on a symlinked home) compare correctly.
 */
function isSkillPath(worktree: string, skillPaths: string[], candidate: string): boolean {
  if (skillPaths.length === 0) return false;
  let candidateAbs: string;
  if (path.isAbsolute(candidate)) {
    candidateAbs = candidate;
  } else {
    candidateAbs = path.join(realpathSync(worktree), candidate);
  }
  const resolved = realpathSync(candidateAbs);
  for (const raw of skillPaths) {
    const base = realpathSync(raw);
    if (resolved === base || resolved.startsWith(`${base}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Pi guard extension. Blocks disallowed tool calls, exposes a `submit_result`
 * tool, and exposes an `ask_human` tool that surfaces a question and blocks
 * until an operator answers. Loaded by Pi sessions via `--extension`.
 */
export default function guardExtension(pi: ExtensionAPI): void {
  const envelope = loadEnvelope();

  pi.on("tool_call", async (event) => {
    const toolName = event.toolName;
    if (!GUARDED_TOOLS.includes(toolName)) {
      return undefined;
    }

    if (!envelope.allowedTools.includes(toolName)) {
      return {
        block: true,
        reason: `autopilot policy: tool '${toolName}' is not enabled for role '${envelope.role}'`,
      };
    }

    if (toolName === "bash") {
      const input = event.input as { command?: unknown };
      if (typeof input.command !== "string") {
        return { block: true, reason: "autopilot policy: bash command must be a string" };
      }
      const decision = evaluateShellCommand(input.command, envelope.allowedCommands);
      if (!decision.allowed) {
        return {
          block: true,
          reason: `autopilot policy: ${decision.reason}`,
        };
      }
      return undefined;
    }

    const input = event.input as { path?: unknown };
    if (input.path === undefined || input.path === "") {
      // Tool defaults to the session cwd, which is inside the worktree.
      return undefined;
    }
    if (typeof input.path !== "string") {
      return { block: true, reason: "autopilot policy: tool path must be a string" };
    }

    // A read of a skill path that is explicitly allow-listed is permitted even
    // though it lives outside the worktree (e.g. ~/.pi/agent/.../skills). This
    // is read-only; skill paths are never writable.
    if (isSkillPath(envelope.worktree, envelope.skillPaths, input.path)) {
      return undefined;
    }

    try {
      assertWorkspacePath(envelope.worktree, input.path, envelope.protectedPaths);
    } catch (error) {
      return {
        block: true,
        reason: `autopilot policy: ${(error as Error).message}`,
      };
    }
    return undefined;
  });

  pi.registerTool({
    name: "submit_result",
    label: "Submit role result",
    description:
      "Submit the final structured result for this role exactly once. " +
      "Call it exactly once, with the complete JSON payload, when the role's work is finished.",
    parameters: Type.Object({
      payload: Type.String({
        description: "The complete structured result as a JSON string",
      }),
    }),
    async execute(_id, params) {
      try {
        writeFileSync(envelope.resultPath, params.payload, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Result rejected: ${(error as Error).message}`,
            },
          ],
          details: { submitted: false },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: "Result accepted" }],
        details: { submitted: true },
      };
    },
  });

  pi.registerTool({
    name: "ask_human",
    label: "Ask the operator a question",
    description:
      "Ask the human operator a short clarifying question and block until they " +
      "answer. Call it whenever you need to resolve a genuinely ambiguous product " +
      "decision before continuing. It returns the operator's reply; the session " +
      "pauses until then.",
    parameters: Type.Object({
      question: Type.String({
        description: "The question to ask the operator",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional surrounding context the operator should see",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const askDir = path.join(path.dirname(envelope.resultPath), "ask");
      mkdirSync(askDir, { recursive: true });
      // Pick the next index. Concurrent questions must not collide (the flag
      // "wx" makes each write atomic), so probe for the next free slot.
      let index = 0;
      for (;;) {
        const probe = path.join(askDir, `${String(index).padStart(3, "0")}-question.json`);
        const answerProbe = path.join(askDir, `${String(index).padStart(3, "0")}-answer.json`);
        if (!existsSync(probe) && !existsSync(answerProbe)) break;
        index += 1;
      }
      const seq = String(index).padStart(3, "0");
      const questionFile = path.join(askDir, `${seq}-question.json`);
      const answerFile = path.join(askDir, `${seq}-answer.json`);
      try {
        writeFileSync(
          questionFile,
          JSON.stringify({
            seq: index,
            question: params.question,
            context: params.context ?? "",
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        return {
          content: [{ type: "text", text: "Failed to write question." }],
          details: { asked: false, seq: index },
          isError: true,
        };
      }
      // Block until the operator's answer arrives. Honor the abort signal.
      for (;;) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Question aborted." }],
            details: { asked: false, seq: index },
            isError: true,
          };
        }
        if (existsSync(answerFile)) {
          let answer: string;
          try {
            const raw = readFileSync(answerFile, "utf8");
            answer = (JSON.parse(raw) as { answer: string }).answer;
          } catch {
            answer = "";
          }
          return {
            content: [{ type: "text", text: answer }],
            details: { asked: true, seq: index },
            isError: false,
          };
        }
        await sleep(150);
      }
    },
  });
}
