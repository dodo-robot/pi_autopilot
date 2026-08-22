import { z } from "zod";
import {
  BacklogPatchSchema,
  CoverageEntrySchema,
} from "./reconciliation.js";

/** Logical agent roles the orchestrator can launch. */
export const RoleSchema = z.enum([
  "refiner",
  "implementer",
  "reviewer",
  "brainstormer",
  "reconciler",
]);
export type Role = z.infer<typeof RoleSchema>;

/** Explicit workflow stages a run can occupy. */
export const RunStageSchema = z.enum([
  "PREFLIGHT",
  "READINESS_CHECK",
  "WORKSPACE_CREATION",
  "IMPLEMENTATION",
  "VERIFICATION",
  "INDEPENDENT_REVIEW",
  "CORRECTION",
  "PUBLICATION",
  "PR_OPEN",
  "NEEDS_REFINEMENT",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]);
export type RunStage = z.infer<typeof RunStageSchema>;

export const RepositoryRefSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const IssueRefSchema = z.object({
  number: z.number().int().positive(),
  nodeId: z.string(),
  updatedAt: z.string(),
});
export type IssueRef = z.infer<typeof IssueRefSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const DependencySchema = z.object({
  issue: z.number().int().positive(),
  satisfied: z.boolean(),
});
export type TaskDependency = z.infer<typeof DependencySchema>;

export const AmbiguitySchema = z.object({
  type: z.enum(["ENGINEERING", "PRODUCT"]),
  description: z.string().min(1),
});
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

/**
 * Permissive execution contract produced by the refiner. Allows missing or
 * empty readiness fields so unready issues can still be analyzed and
 * rendered by `prepare`. Promotion to the strict immutable
 * {@link TaskSnapshotSchema} happens only after deterministic readiness
 * checks pass.
 */
export const TaskDraftSchema = z.object({
  schemaVersion: z.literal(1),
  repository: RepositoryRefSchema,
  issue: IssueRefSchema,
  objective: z.string(),
  context: z.string(),
  expectedBehavior: z.array(z.string()),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  validation: z.array(z.string()),
  dependencies: z.array(DependencySchema),
  canonicalReferences: z.array(z.string()),
  sourceBodyHash: z.string(),
});
export type TaskDraft = z.infer<typeof TaskDraftSchema>;

/**
 * Strict, immutable execution contract frozen for a run. Every readiness
 * field must be populated and testable.
 */
export const TaskSnapshotSchema = TaskDraftSchema.extend({
  objective: z.string().min(1),
  expectedBehavior: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  validation: z.array(z.string()).min(1),
  sourceBodyHash: z.string().min(1),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

export const RefinerResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("READY"),
    taskDraft: TaskDraftSchema,
    missingInformation: z.array(z.string()),
    dependencies: z.array(DependencySchema),
    ambiguities: z.array(AmbiguitySchema),
  }),
  z.object({
    outcome: z.literal("NEEDS_REFINEMENT"),
    taskDraft: TaskDraftSchema,
    missingInformation: z.array(z.string()),
    dependencies: z.array(DependencySchema),
    ambiguities: z.array(AmbiguitySchema),
    suggestions: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("PRODUCT_AMBIGUITY"),
    taskDraft: TaskDraftSchema,
    missingInformation: z.array(z.string()),
    dependencies: z.array(DependencySchema),
    ambiguities: z.array(AmbiguitySchema),
  }),
  z.object({
    outcome: z.literal("FAILED"),
    reason: z.string().min(1),
    taskDraft: TaskDraftSchema,
  }),
]);
export type RefinerResult = z.infer<typeof RefinerResultSchema>;

export const ImplementerResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("COMPLETED"),
    summary: z.string().min(1),
    changedPaths: z.array(z.string()),
    commandsAttempted: z.array(z.string()),
    unresolvedProblems: z.array(z.string()),
    evidenceLocations: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("BLOCKED"),
    reason: z.string().min(1),
    unresolvedProblems: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("NEEDS_REFINEMENT"),
    reason: z.string().min(1),
    missingInformation: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("NEEDS_REPLAN"),
    reason: z.string().min(1),
  }),
  z.object({
    outcome: z.literal("FAILED"),
    reason: z.string().min(1),
  }),
]);
export type ImplementerResult = z.infer<typeof ImplementerResultSchema>;

export const ReviewerFindingSchema = z.object({
  severity: z.enum(["critical", "important", "minor"]),
  criterionId: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative(),
  evidence: z.string(),
  requestedChange: z.string().min(1),
});
export type ReviewerFinding = z.infer<typeof ReviewerFindingSchema>;

export const CriterionResultSchema = z.object({
  criterionId: z.string().min(1),
  passed: z.boolean(),
  notes: z.string(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const ReviewerResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("APPROVED"),
    criteriaResults: z.array(CriterionResultSchema),
    findings: z.array(ReviewerFindingSchema),
  }),
  z.object({
    outcome: z.literal("CHANGES_REQUESTED"),
    criteriaResults: z.array(CriterionResultSchema),
    findings: z.array(ReviewerFindingSchema),
  }),
  z.object({
    outcome: z.literal("PRODUCT_AMBIGUITY"),
    reason: z.string().min(1),
  }),
  z.object({
    outcome: z.literal("FAILED"),
    reason: z.string().min(1),
  }),
]);
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;

export const BrainstormerResultSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(3),
});
export type BrainstormerResult = z.infer<typeof BrainstormerResultSchema>;

export const ReconcilerResultSchema = z.object({
  coverage: z.array(CoverageEntrySchema),
  patches: z.array(BacklogPatchSchema),
});
export type ReconcilerResult = z.infer<typeof ReconcilerResultSchema>;

/** Union of all role results; runners narrow by the session role. */
export const RoleResultSchema = z.union([
  RefinerResultSchema,
  ImplementerResultSchema,
  ReviewerResultSchema,
  BrainstormerResultSchema,
  ReconcilerResultSchema,
]);
export type RoleResult = z.infer<typeof RoleResultSchema>;

/** Durable run record shape consumed by persistence and recovery. */
export const RunRecordSchema = z.object({
  id: z.string().min(1),
  repository: RepositoryRefSchema,
  issueNumber: z.number().int().positive(),
  stage: RunStageSchema,
  taskSnapshotRef: z.string().nullable(),
  resumeAt: RunStageSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
