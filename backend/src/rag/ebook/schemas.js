import { z } from "zod";

export const RouteSchema = z.object({
  mode: z.enum(["direct", "single_retrieval", "multi_hop"]),
  reason: z.string(),
});

const PlanItemSchema = z.object({
  question: z.string(),
  purpose: z.string(),
  dependsOn: z.array(z.number().int()).max(8),
  introducedAssumptions: z.array(z.string()).max(8),
});

export const DecomposeSchema = z.object({
  sub_questions: z.array(PlanItemSchema).min(1).max(8),
  reason: z.string(),
});

export const RewriteSchema = z.object({
  needsRewrite: z.boolean(),
  rewrittenQuery: z.string(),
  resolvedEntities: z.array(z.string()).max(4),
  supportingEvidenceIndexes: z.array(z.number().int()).max(6),
  hasConflictingEvidence: z.boolean(),
  reason: z.string(),
});

const CoverageSchema = z.object({
  planIndex: z.number().int().min(1).max(8),
  hasRelevantEvidence: z.boolean(),
  isSufficient: z.boolean(),
  hasConflictingEvidence: z.boolean(),
  supportedByWeb: z.boolean().optional(),
  supportingEvidenceIndexes: z.array(z.number().int()).max(6),
  missing: z.string(),
  reason: z.string(),
});

export const EvaluateSchema = z.object({
  isSufficient: z.boolean(),
  coverage: z.array(CoverageSchema).max(8),
  nextAction: z.enum(["retrieve", "web_search", "generate"]),
  missing: z.array(z.string()).max(6),
  nextPlanItemAddressesGap: z.boolean(),
  reason: z.string(),
  web_query: z.string().optional(),
});
