import type {
  AutopilotConfig,
  RoleModelEntry,
  RoleModelOverride,
} from "../config/schema.js";
import { ThinkingLevelSchema } from "../config/schema.js";
import {
  DEFAULT_PI_MODEL,
  resolveRoleModel,
} from "../config/load-config.js";
import type { ResolvedRoleModel } from "../config/load-config.js";
import type { RepositoryContext } from "../github/repository-context.js";
import { assertRepositoryMatches } from "../github/repository-context.js";

/** Resolve a single issue reference to its number. */
export function resolveIssueRef(
  issueRef: string,
  ctx: RepositoryContext,
): { number: number } {
  const trimmed = issueRef.trim();
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare !== null) {
    return { number: Number(bare[1]) };
  }
  const qualified = /^([^/]+)\/([^/]+)#(\d+)$/.exec(trimmed);
  if (qualified !== null) {
    assertRepositoryMatches(ctx, {
      owner: qualified[1] ?? "",
      repo: qualified[2] ?? "",
    });
    return { number: Number(qualified[3]) };
  }
  throw new Error(
    `invalid issue reference '${issueRef}' (expected <number> or <owner>/<repo>#<number>)`,
  );
}

/** Resolve many refs, de-duping and preserving first-seen order. */
export function resolveIssueRefs(
  refs: string[],
  ctx: RepositoryContext,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ref of refs) {
    const { number } = resolveIssueRef(ref, ctx);
    if (!seen.has(number)) {
      seen.add(number);
      out.push(number);
    }
  }
  return out;
}

/** Resolve the refiner role model with CLI-override precedence. */
export function resolveRefinerModel(
  opts: { model?: string; thinking?: string },
  config: AutopilotConfig,
  piDefault: RoleModelEntry | undefined,
): ResolvedRoleModel {
  const override: RoleModelOverride = {};
  if (opts.model !== undefined) {
    override.model = opts.model;
  }
  if (opts.thinking !== undefined) {
    const parsed = ThinkingLevelSchema.safeParse(opts.thinking);
    if (!parsed.success) {
      throw new Error(
        `invalid thinking level '${opts.thinking}' (expected one of ${ThinkingLevelSchema.options.join(", ")})`,
      );
    }
    override.thinking = parsed.data;
  }
  return resolveRoleModel(
    "refiner",
    override.model !== undefined || override.thinking !== undefined
      ? override
      : null,
    config.agents,
    null,
    piDefault ?? DEFAULT_PI_MODEL,
  );
}

/**
 * Resolve the refiner session timeout in milliseconds. Precedence:
 * explicit flag, then the repository policy's
 * `budgets.refiner.timeoutMinutes`, then the built-in default.
 */
export function resolveRefinerTimeout(
  timeoutMinutes: number | undefined,
  config: AutopilotConfig,
): number {
  const minutes = timeoutMinutes ?? config.budgets.refiner.timeoutMinutes;
  return minutes * 60_000;
}
