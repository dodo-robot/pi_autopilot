import { z } from "zod";
import type { RepositoryRef } from "./contracts.js";

export type ScreenClassification =
  | "READY"
  | "NEEDS_REFINEMENT"
  | "BLOCKED"
  | "AMBIGUOUS"
  | "CANDIDATE"
  | "SKIPPED";

export type BacklogClassification =
  | "READY"
  | "NEEDS_REFINEMENT"
  | "BLOCKED"
  | "AMBIGUOUS"
  | "SKIPPED";

export const BacklogReportSchema = z.object({
  repository: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  epicRef: z.number().int().positive().nullable(),
  requestedRefs: z.array(z.number().int().positive()),
  generatedAt: z.string().min(1),
  analysisId: z.string().min(1),
  scope: z.object({
    totalIssues: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  issues: z.array(
    z.object({
      issueNumber: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      classification: z.enum([
        "READY",
        "NEEDS_REFINEMENT",
        "BLOCKED",
        "AMBIGUOUS",
        "SKIPPED",
      ]),
      screen: z.object({
        classification: z.enum([
          "READY",
          "NEEDS_REFINEMENT",
          "BLOCKED",
          "AMBIGUOUS",
          "CANDIDATE",
          "SKIPPED",
        ]),
        reasons: z.array(z.string()),
      }),
      readiness: z
        .object({
          analysisId: z.string().min(1),
          status: z.enum(["READY", "NEEDS_REFINEMENT"]),
        })
        .nullable(),
      // Keep in sync with LabelAction in ../analysis/label-reconciliation.ts
      labelAction: z
        .enum(["labeled", "unlabeled", "unchanged", "skipped-in-progress"])
        .optional(),
    }),
  ),
  executable: z.array(z.number().int().positive()),
  needsWork: z.array(z.number().int().positive()),
  summary: z.object({
    ready: z.number().int().nonnegative(),
    needsRefinement: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  refinerSessions: z.number().int().nonnegative(),
});
export type BacklogReport = z.infer<typeof BacklogReportSchema>;

export function parseBacklogReport(input: unknown): BacklogReport {
  return BacklogReportSchema.parse(input);
}

export interface ScreenDecision {
  classification: ScreenClassification;
  reasons: string[];
}

export interface HeuristicScreenResult extends ScreenDecision {}
