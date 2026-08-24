import { z } from "zod";
import type { AutopilotConfig } from "../config/schema.js";

export const SchedulerPolicySchema = z.object({
  maxConcurrentRuns: z.number().int().positive(),
  idleTimeoutMinutes: z.number().int().nonnegative(),
  budgets: z.object({
    maxElapsedMinutes: z.number().int().nonnegative().nullable(),
    maxStartedRuns: z.number().int().nonnegative().nullable(),
    maxFailedRuns: z.number().int().nonnegative().nullable(),
  }),
});

export type SchedulerPolicy = z.infer<typeof SchedulerPolicySchema>;

export interface SchedulerCliOverrides {
  maxConcurrentRuns?: number;
  idleTimeoutMinutes?: number;
  maxElapsedMinutes?: number;
  maxStartedRuns?: number;
  maxFailedRuns?: number;
}

export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicy = {
  maxConcurrentRuns: 1,
  idleTimeoutMinutes: 0,
  budgets: {
    maxElapsedMinutes: null,
    maxStartedRuns: null,
    maxFailedRuns: null,
  },
};

export function parseOptionalPositiveInt(raw: string | undefined, flagName: string): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${flagName} '${raw}' (expected a positive integer)`);
  }
  return parsed;
}

export function parseOptionalNonNegativeInt(raw: string | undefined, flagName: string): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${flagName} '${raw}' (expected a non-negative integer)`);
  }
  return parsed;
}

export function resolveSchedulerPolicy(
  config: AutopilotConfig,
  overrides: SchedulerCliOverrides,
): SchedulerPolicy {
  return {
    maxConcurrentRuns: overrides.maxConcurrentRuns ?? config.scheduler.maxConcurrentRuns,
    idleTimeoutMinutes: overrides.idleTimeoutMinutes ?? config.scheduler.idleTimeoutMinutes,
    budgets: {
      maxElapsedMinutes: overrides.maxElapsedMinutes ?? config.scheduler.budgets.maxElapsedMinutes,
      maxStartedRuns: overrides.maxStartedRuns ?? config.scheduler.budgets.maxStartedRuns,
      maxFailedRuns: overrides.maxFailedRuns ?? config.scheduler.budgets.maxFailedRuns,
    },
  };
}
