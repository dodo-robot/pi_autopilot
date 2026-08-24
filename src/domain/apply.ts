import { z } from "zod";
import type { BacklogPatchType, PatchPolicy } from "./reconciliation.js";
import type { RepositoryRef } from "./contracts.js";

/** Per-patch application outcome. `declineReason` is set only on a
 * `skippedBy: "user"` outcome when the human supplied a note. */
export const ApplyOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied") }),
  z.object({
    status: z.literal("skipped"),
    skippedBy: z.enum([
      "requires-approval",
      "idempotent",
      "user",
      "failed-to-fetch",
      "preview-only",
    ]),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);
export type ApplyOutcome = z.infer<typeof ApplyOutcomeSchema>;

export const ApplyEntrySchema = z.object({
  patchType: z.custom<BacklogPatchType>(),
  targetIssue: z.number().int().positive().nullable(),
  policy: z.custom<PatchPolicy>(),
  outcome: ApplyOutcomeSchema,
  detail: z.string(),
  appliedIssueNumber: z.number().int().positive().optional(),
  appliedIssueNumbers: z.array(z.number().int().positive()).optional(),
  declineReason: z.string().optional(),
});
export type ApplyEntry = z.infer<typeof ApplyEntrySchema>;

export const ApplyReportSchema = z.object({
  repository: z.custom<RepositoryRef>(),
  analysisId: z.string().min(1),
  appliedAt: z.string().min(1),
  aborted: z.boolean().default(false),
  staleness: z.object({
    staleAgeHours: z.number(),
    guardApplied: z.boolean(),
    overriddenByForce: z.boolean(),
  }),
  entries: z.array(ApplyEntrySchema),
  summary: z.object({
    applied: z.number().int(),
    skippedRequiresApproval: z.number().int(),
    skippedIdempotent: z.number().int(),
    skippedUser: z.number().int(),
    failed: z.number().int(),
    previewed: z.number().int(),
  }),
});
export type ApplyReport = z.infer<typeof ApplyReportSchema>;
