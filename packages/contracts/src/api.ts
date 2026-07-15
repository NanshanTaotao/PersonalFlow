import { z } from "zod";

import {
  BranchTreeNodeSchema,
  BranchTreeResponseSchema,
  CreateSessionForkRequestSchema,
  WithdrawUserInputRequestSchema
} from "./session-branch";
import { FailedReviewReportSchema, PendingReviewReportSchema, SucceededReviewReportSchema } from "./review";
import { NormalizedScenarioV1Schema } from "./scenario";
import { SessionStatusSchema, SessionViewSchema } from "./session-view";

export { BranchTreeResponseSchema, CreateSessionForkRequestSchema, WithdrawUserInputRequestSchema };

export const CreateSessionRequestSchema = z
  .object({
    idempotency_key: z.string().min(1).optional()
  })
  .strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ProductSessionTimingSchema = z
  .object({
    started_at: z.string().min(1),
    updated_at: z.string().min(1),
    suggested_duration_label: z.string().min(1).optional()
  })
  .strict();

export const ProductSessionSchema = z
  .object({
    id: z.string().min(1),
    scenario_id: z.string().min(1),
    status: SessionStatusSchema,
    timing: ProductSessionTimingSchema.optional(),
    view: SessionViewSchema
  })
  .strict()
  .superRefine((session, context) => {
    if (session.id !== session.view.session_id) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Product session id must match view.session_id."
      });
    }
    if (session.scenario_id !== session.view.scenario_id) {
      context.addIssue({
        code: "custom",
        path: ["scenario_id"],
        message: "Product session scenario_id must match view.scenario_id."
      });
    }
    if (session.status !== session.view.status) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Product session status must match view.status."
      });
    }
  });

export type ProductSession = z.infer<typeof ProductSessionSchema>;

export const CreateSessionResponseSchema = z
  .object({
    session: ProductSessionSchema
  })
  .strict();

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const CreateSessionForkResponseSchema = z
  .object({
    session: ProductSessionSchema,
    branch: BranchTreeNodeSchema,
    tree: BranchTreeResponseSchema
  })
  .strict();

export type CreateSessionForkResponse = z.infer<typeof CreateSessionForkResponseSchema>;

export const WithdrawUserInputResponseSchema = CreateSessionForkResponseSchema.extend({
  withdrawn_input: z
    .object({
      text: z.string(),
      event_id: z.string().min(1)
    })
    .strict()
}).strict();

export type WithdrawUserInputResponse = z.infer<typeof WithdrawUserInputResponseSchema>;

export const GetBranchTreeResponseSchema = z
  .object({
    tree: BranchTreeResponseSchema
  })
  .strict();

export type GetBranchTreeResponse = z.infer<typeof GetBranchTreeResponseSchema>;

export const CommitRuntimeCommandRequestSchema = z
  .object({
    expected_state_version: z.number().int().nonnegative(),
    idempotency_key: z.string().min(1).optional()
  })
  .strict();

export type CommitRuntimeCommandRequest = z.infer<typeof CommitRuntimeCommandRequestSchema>;

export const CommitRuntimeCommandResponseSchema = z
  .object({
    session: ProductSessionSchema
  })
  .strict();

export type CommitRuntimeCommandResponse = z.infer<typeof CommitRuntimeCommandResponseSchema>;

export const AiTurnObservabilitySchema = z
  .object({
    adapter_kind: z.string().min(1),
    model_config_id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    visible_history: z.array(
      z
        .object({
          event_id: z.string().min(1),
          sequence: z.number().int().nonnegative(),
          actor_id: z.string().min(1).optional(),
          step_id: z.string().min(1).optional(),
          text_summary: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();

export type AiTurnObservability = z.infer<typeof AiTurnObservabilitySchema>;

export const AiTurnResponseSchema = z
  .object({
    session: ProductSessionSchema,
    ai_turn_observability: AiTurnObservabilitySchema
  })
  .strict();

export type AiTurnResponse = z.infer<typeof AiTurnResponseSchema>;

export const GetSessionResponseSchema = z
  .object({
    session: ProductSessionSchema
  })
  .strict();

export type GetSessionResponse = z.infer<typeof GetSessionResponseSchema>;

export const GetScenarioResponseSchema = z
  .object({
    scenario: NormalizedScenarioV1Schema
  })
  .strict();

export type GetScenarioResponse = z.infer<typeof GetScenarioResponseSchema>;

const ReviewAdapterKindSchema = z.string().min(1);

export const ReviewReportDtoSchema = z.discriminatedUnion("status", [
  PendingReviewReportSchema.extend({ review_adapter_kind: ReviewAdapterKindSchema.optional() }).strict(),
  FailedReviewReportSchema.extend({ review_adapter_kind: ReviewAdapterKindSchema.optional() }).strict(),
  SucceededReviewReportSchema.extend({ review_adapter_kind: ReviewAdapterKindSchema.optional() }).strict()
]);

export type ReviewReportDto = z.infer<typeof ReviewReportDtoSchema>;

export const ReviewReportResponseSchema = z
  .object({
    review: ReviewReportDtoSchema
  })
  .strict();

export const CreateReviewReportResponseSchema = ReviewReportResponseSchema;
export const GetReviewReportResponseSchema = ReviewReportResponseSchema;
export const RetryReviewReportResponseSchema = ReviewReportResponseSchema;

export type ReviewReportResponse = z.infer<typeof ReviewReportResponseSchema>;
export type CreateReviewReportResponse = z.infer<typeof CreateReviewReportResponseSchema>;
export type GetReviewReportResponse = z.infer<typeof GetReviewReportResponseSchema>;
export type RetryReviewReportResponse = z.infer<typeof RetryReviewReportResponseSchema>;
