import { z } from "zod";

/**
 * Ambiguity classification for reconciliation NEEDS_HUMAN patches. Distinct
 * from the refiner's two-value AmbiguitySchema in contracts.ts —
 * reconciliation reasons about backlog- and requirement-level ambiguity
 * (missing context, conflicting requirement documents), not just per-issue
 * engineering/product ambiguity.
 */
export const ReconciliationAmbiguityTypeSchema = z.enum([
  "ENGINEERING",
  "PRODUCT",
  "MISSING_CONTEXT",
  "CONFLICTING_REQUIREMENTS",
]);
export type ReconciliationAmbiguityType = z.infer<
  typeof ReconciliationAmbiguityTypeSchema
>;

export const CoverageStatusSchema = z.enum([
  "covered",
  "partial",
  "missing",
  "implemented",
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/** One requirement's traceability row: requirement -> epic -> issues. */
export const CoverageEntrySchema = z.object({
  requirementId: z.string().min(1),
  description: z.string().min(1),
  epic: z.number().int().positive().nullable(),
  issues: z.array(z.number().int().positive()),
  status: CoverageStatusSchema,
  evidence: z.string(),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

/**
 * Machine-owned execution-contract content for an ENRICH_ISSUE/CREATE_ISSUE
 * patch. Rendered into the reconciliation managed section
 * (src/reconciliation/managed-section.ts); never replaces human-authored
 * issue content.
 */
export const IssueEnrichmentSchema = z.object({
  goal: z.string().min(1),
  sourceRequirements: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  validation: z.array(z.string()),
  relevantAreas: z.array(z.string()),
});
export type IssueEnrichment = z.infer<typeof IssueEnrichmentSchema>;

export const IssueSpecSchema = z.object({
  title: z.string().min(1),
  enrichment: IssueEnrichmentSchema,
});
export type IssueSpec = z.infer<typeof IssueSpecSchema>;

/** Deterministic apply-safety classification, assigned by
 * src/reconciliation/patch-policy.ts — never by the LLM. */
export const PatchPolicySchema = z.enum(["auto-safe", "requires-approval"]);
export type PatchPolicy = z.infer<typeof PatchPolicySchema>;

/**
 * Structured reconciliation patch. This union implements every variant
 * documented in docs/resources/extend_requirements.md's "Structured patch
 * model" (KEEP/ENRICH_ISSUE/CREATE_ISSUE/ADD_DEPENDENCY/REMOVE_DEPENDENCY/
 * SPLIT_ISSUE/MERGE_DUPLICATE/MARK_STALE/NEEDS_HUMAN). MARK_READY is
 * deliberately excluded — see
 * docs/superpowers/specs/2026-08-24-reconciliation-remove-dependency-design.md §6.
 */
export const BacklogPatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("KEEP"),
    issue: z.number().int().positive(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("ENRICH_ISSUE"),
    issue: z.number().int().positive(),
    patch: IssueEnrichmentSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("CREATE_ISSUE"),
    epic: z.number().int().positive().nullable(),
    spec: IssueSpecSchema,
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("ADD_DEPENDENCY"),
    issue: z.number().int().positive(),
    dependsOn: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("REMOVE_DEPENDENCY"),
    issue: z.number().int().positive(),
    dependsOn: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("SPLIT_ISSUE"),
    issue: z.number().int().positive(),
    children: z.array(IssueSpecSchema).min(2),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("MERGE_DUPLICATE"),
    keep: z.number().int().positive(),
    duplicate: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("MARK_STALE"),
    issue: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("NEEDS_HUMAN"),
    issue: z.number().int().positive().nullable(),
    ambiguityType: ReconciliationAmbiguityTypeSchema,
    reason: z.string().min(1),
    questions: z.array(z.string()).min(1),
  }),
]);
export type BacklogPatch = z.infer<typeof BacklogPatchSchema>;
export type BacklogPatchType = BacklogPatch["type"];

/** A patch annotated with its deterministic apply-safety classification —
 * the shape persisted in a ReconciliationReport's `patches` array. */
export type ReconciledPatch = BacklogPatch & { policy: PatchPolicy };
