import { z } from "zod";

export const ReviewReportStatusSchema = z.enum(["pending", "succeeded", "failed"]);

export const ReviewEvidenceRefSchema = z
  .object({
    session_id: z.string().min(1),
    event_id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    step_id: z.string().min(1),
    actor_id: z.string().min(1)
  })
  .strict();

export type ReviewEvidenceRef = z.infer<typeof ReviewEvidenceRefSchema>;

export const ReviewEvidenceLocatorSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    speaker: z.string().min(1),
    snippet: z.string().min(1)
  })
  .strict();

export const ReviewEvidenceSummarySchema = z
  .object({
    answer_count: z.number().int().nonnegative(),
    cited_answer_count: z.number().int().nonnegative(),
    coverage: z.enum(["sufficient", "insufficient"]),
    confidence: z.enum(["high", "medium", "low"])
  })
  .strict();

export const ReviewCredibilityCheckSchema = z
  .object({
    kind: z.enum(["evidence_gap", "off_topic", "contradiction"]),
    severity: z.enum(["info", "warning"]),
    message: z.string().min(1),
    evidence_refs: z.array(ReviewEvidenceRefSchema).optional()
  })
  .strict();

export const ReviewDimensionSchema = z
  .object({
    name: z.string().min(1),
    conclusion: z.string().min(1),
    evidence_refs: z.array(ReviewEvidenceRefSchema)
  })
  .strict();

export const ReviewKeyMomentSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    evidence_ref: ReviewEvidenceRefSchema,
    evidence_locator: ReviewEvidenceLocatorSchema.optional()
  })
  .strict();

export const ReviewRecommendationSchema = z
  .object({
    text: z.string().min(1),
    evidence_refs: z.array(ReviewEvidenceRefSchema).min(1).optional(),
    uncertainty_note: z.string().min(1).optional()
  })
  .strict()
  .refine((value) => value.evidence_refs !== undefined || value.uncertainty_note !== undefined, {
    message: "Review recommendation must reference evidence or uncertainty."
  });

const ReviewReportBaseSchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    created_at: z.string().min(1)
  })
  .strict();

export const PendingReviewReportSchema = ReviewReportBaseSchema.extend({
  status: z.literal("pending")
}).strict();

export const FailedReviewReportSchema = ReviewReportBaseSchema.extend({
  status: z.literal("failed"),
  completed_at: z.string().min(1),
  error_message: z.string().min(1)
}).strict();

export const SucceededReviewReportSchema = ReviewReportBaseSchema.extend({
  status: z.literal("succeeded"),
  summary: z.string().min(1),
  dimensions: z.array(ReviewDimensionSchema).min(1),
  key_moments: z.array(ReviewKeyMomentSchema).min(1),
  recommendations: z.array(ReviewRecommendationSchema).min(1),
  evidence_refs: z.array(ReviewEvidenceRefSchema).min(1),
  evidence_summary: ReviewEvidenceSummarySchema.optional(),
  credibility_checks: z.array(ReviewCredibilityCheckSchema).optional(),
  uncertainty_notes: z.array(z.string().min(1)).min(1),
  completed_at: z.string().min(1)
}).strict();

export const ReviewReportSchema = z.discriminatedUnion("status", [
  PendingReviewReportSchema,
  FailedReviewReportSchema,
  SucceededReviewReportSchema
]);

export type ReviewDimension = z.infer<typeof ReviewDimensionSchema>;
export type ReviewCredibilityCheck = z.infer<typeof ReviewCredibilityCheckSchema>;
export type ReviewEvidenceLocator = z.infer<typeof ReviewEvidenceLocatorSchema>;
export type ReviewEvidenceSummary = z.infer<typeof ReviewEvidenceSummarySchema>;
export type ReviewKeyMoment = z.infer<typeof ReviewKeyMomentSchema>;
export type ReviewRecommendation = z.infer<typeof ReviewRecommendationSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type SucceededReviewReport = z.infer<typeof SucceededReviewReportSchema>;
