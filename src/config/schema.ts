import { z } from "zod";

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const RoleModelEntrySchema = z.object({
  model: z.string().min(1),
  thinking: ThinkingLevelSchema,
});
export type RoleModelEntry = z.infer<typeof RoleModelEntrySchema>;

/** Per-role model configuration. Missing roles fall through to defaults. */
export const RoleAgentsConfigSchema = z
  .object({
    refiner: RoleModelEntrySchema.optional(),
    implementer: RoleModelEntrySchema.optional(),
    reviewer: RoleModelEntrySchema.optional(),
    brainstormer: RoleModelEntrySchema.optional(),
    reconciler: RoleModelEntrySchema.optional(),
    bootstrapper: RoleModelEntrySchema.optional(),
  })
  .prefault({});
export type RoleAgentsConfig = z.infer<typeof RoleAgentsConfigSchema>;

/** Partial model override supplied per command via CLI flags. */
export interface RoleModelOverride {
  model?: string;
  thinking?: ThinkingLevel;
}

const OptionalNonNegativeIntSchema = z.number().int().nonnegative().nullable().default(null);

export const SchedulerConfigSchema = z
  .object({
    maxConcurrentRuns: z.number().int().positive().default(1),
    idleTimeoutMinutes: z.number().int().nonnegative().default(0),
    budgets: z
      .object({
        maxElapsedMinutes: OptionalNonNegativeIntSchema,
        maxStartedRuns: OptionalNonNegativeIntSchema,
        maxFailedRuns: OptionalNonNegativeIntSchema,
      })
      .prefault({}),
  })
  .prefault({});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

/** Versioned repository policy file (`.pi/autopilot.yaml`). */
export const AutopilotConfigSchema = z.object({
  version: z.literal(1),
  workspace: z
    .object({
      baseBranch: z.string().default("main"),
      branchPrefix: z.string().default("autopilot/"),
      requireCleanCheckout: z.boolean().default(true),
      retainBlockedWorktree: z.boolean().default(true),
    })
    .prefault({}),
  commands: z.object({
    setup: z.array(z.string()).default([]),
    verify: z
      .array(z.string())
      .min(1, "commands.verify must contain at least one command"),
  }),
  agents: RoleAgentsConfigSchema,
  agentPolicy: z
    .object({
      allowedCommands: z
        .array(z.string())
        .default(["npm", "npx", "node", "rg", "find"]),
      protectedPaths: z.array(z.string()).default([]),
      // Declared for a later milestone; not enforced in M1.
      allowNetwork: z.boolean().default(false),
    })
    .prefault({}),
  budgets: z
    .object({
      refiner: z
        .object({
          timeoutMinutes: z.number().int().positive().default(5),
        })
        .prefault({}),
      reconciler: z
        .object({
          timeoutMinutes: z.number().int().positive().default(10),
        })
        .prefault({}),
      implementation: z
        .object({
          timeoutMinutes: z.number().int().positive().default(60),
          maxAttempts: z.number().int().positive().default(3),
        })
        .prefault({}),
      review: z
        .object({
          timeoutMinutes: z.number().int().positive().default(20),
          maxCorrectionCycles: z.number().int().nonnegative().default(2),
        })
        .prefault({}),
    })
    .prefault({}),
  publication: z
    .object({
      draftPr: z.boolean().default(false),
      issueComment: z.enum(["concise"]).default("concise"),
      autoMerge: z.boolean().default(false),
    })
    .prefault({}),
  reconciliation: z
    .object({
      requirementsPaths: z.array(z.string()).optional(),
      reportStaleAfterHours: z.number().int().nullable().default(168),
    })
    .prefault({}),
  bootstrap: z
    .object({
      tokenThreshold: z.number().int().positive().default(80_000),
      requirementsPaths: z.array(z.string()).optional(),
    })
    .prefault({}),
  scheduler: SchedulerConfigSchema,
});
export type AutopilotConfig = z.infer<typeof AutopilotConfigSchema>;
