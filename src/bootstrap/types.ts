import { z } from "zod";

export const BootstrapIssueSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()).default(["task"]),
  requirementRef: z.object({ doc: z.string(), section: z.string() }).optional(),
  /** Filled in by apply-service after GitHub issue creation. */
  githubNumber: z.number().int().positive().optional(),
  /** Filled in by apply-service after GitHub issue creation. */
  githubNodeId: z.string().optional(),
});
export type BootstrapIssue = z.infer<typeof BootstrapIssueSchema>;

export const BootstrapEpicSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  labels: z.array(z.string()).default(["epic"]),
  issues: z.array(BootstrapIssueSchema),
  /** Filled in by apply-service after GitHub epic creation. */
  githubNumber: z.number().int().positive().optional(),
  /** Filled in by apply-service after GitHub epic creation. */
  githubNodeId: z.string().optional(),
});
export type BootstrapEpic = z.infer<typeof BootstrapEpicSchema>;

export const DependencyRefSchema = z.object({
  from: z.string().min(1),   // "epic:<title>" or "issue:<title>"
  to: z.string().min(1),
  reason: z.string(),
});
export type DependencyRef = z.infer<typeof DependencyRefSchema>;

export const TrackSchema = z.object({
  wave: z.number().int().positive(),
  issues: z.array(z.string().min(1)),  // issue/epic titles
});
export type Track = z.infer<typeof TrackSchema>;

export const ApplyStateSchema = z.object({
  boardId: z.string().optional(),
  boardTitle: z.string().optional(),
  epicsCreated: z.boolean().default(false),
  issuesCreated: z.boolean().default(false),
  checklistsPatched: z.boolean().default(false),
  addedToBoard: z.boolean().default(false),
  configWritten: z.boolean().default(false),
});
export type ApplyState = z.infer<typeof ApplyStateSchema>;

export const BootstrapPlanSchema = z.object({
  planId: z.string().min(1),
  createdAt: z.string(),
  requirementDocs: z.array(z.string()),
  proposedConfig: z.unknown().nullable(),
  projectBoard: z.object({
    title: z.string().min(1),
    columns: z.array(z.string()),
  }),
  epics: z.array(BootstrapEpicSchema),
  dependencies: z.array(DependencyRefSchema),
  tracks: z.array(TrackSchema),
  applyState: ApplyStateSchema.default({
    epicsCreated: false,
    issuesCreated: false,
    checklistsPatched: false,
    addedToBoard: false,
    configWritten: false,
  }),
});
export type BootstrapPlan = z.infer<typeof BootstrapPlanSchema>;
