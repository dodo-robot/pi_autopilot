import { readFileSync, writeFileSync } from "node:fs";
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

  return {
    worktree: env.worktree,
    role: typeof env.role === "string" ? env.role : "implementer",
    resultPath: env.resultPath,
    allowedCommands: env.allowedCommands as string[],
    protectedPaths: env.protectedPaths as string[],
    allowedTools: env.allowedTools as string[],
  };
}

/**
 * Pi guard extension. Blocks disallowed tool calls and exposes a
 * `submit_result` tool that persists the role's structured outcome exactly
 * once. Loaded by the orchestrator's Pi sessions via `--extension`.
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
}
