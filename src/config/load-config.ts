import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Role } from "../domain/contracts.js";
import {
  AutopilotConfigSchema,
  type AutopilotConfig,
  type RoleAgentsConfig,
  type RoleModelEntry,
  type RoleModelOverride,
  type ThinkingLevel,
} from "./schema.js";

const CONFIG_FILENAME = ".pi/autopilot.yaml";

/**
 * Load and validate the versioned repository policy file. Verification
 * commands are mandatory; a repository without them cannot run.
 */
export async function loadRepositoryConfig(root: string): Promise<AutopilotConfig> {
  const configPath = path.join(root, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`missing repository config: ${configPath}`, { cause: error });
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    throw new Error(`invalid YAML in ${configPath}`, { cause: error });
  }

  const parsed = AutopilotConfigSchema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid autopilot config: ${details}`);
  }
  return parsed.data;
}

export type ModelSource = "cli" | "repository" | "user" | "pi-default";

/**
 * Fallback Pi default model used when neither the repository role
 * configuration nor user defaults resolve a role. Mirrors the M1 design's
 * example configuration; the operator can override it per repository or
 * per command.
 */
export const DEFAULT_PI_MODEL: RoleModelEntry = {
  model: "anthropic/claude-sonnet-4",
  thinking: "high",
};

export interface ResolvedRoleModel {
  model: string;
  thinking: ThinkingLevel;
  source: ModelSource;
}

/**
 * Resolve the model for a role with strict precedence:
 * CLI override > repository role configuration > user defaults > Pi default.
 * The Pi default is injected by the caller rather than discovered here.
 * The reported source is the highest-precedence layer that contributed at
 * least one field.
 */
export function resolveRoleModel(
  role: Role,
  cli: RoleModelOverride | null,
  repo: RoleAgentsConfig | null,
  user: RoleAgentsConfig | null,
  piDefault: RoleModelEntry,
): ResolvedRoleModel {
  const repoEntry = repo?.[role];
  const userEntry = user?.[role];

  let model = piDefault.model;
  let thinking = piDefault.thinking;
  let source: ModelSource = "pi-default";

  if (userEntry) {
    model = userEntry.model;
    thinking = userEntry.thinking;
    source = "user";
  }
  if (repoEntry) {
    model = repoEntry.model;
    thinking = repoEntry.thinking;
    source = "repository";
  }
  if (cli && (cli.model !== undefined || cli.thinking !== undefined)) {
    if (cli.model !== undefined) model = cli.model;
    if (cli.thinking !== undefined) thinking = cli.thinking;
    source = "cli";
  }
  return { model, thinking, source };
}
