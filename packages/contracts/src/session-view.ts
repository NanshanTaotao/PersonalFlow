import { z } from "zod";

import { JsonObjectSchema, JsonSchemaValueSchema } from "./json";
import { RuntimeBlockedReasonSchema } from "./runtime";
import { ActorKindSchema } from "./scenario";

export const SessionStatusSchema = z.enum(["running", "paused", "completed", "ended", "failed", "blocked"]);

export const VisibleTranscriptEntrySchema = z
  .object({
    id: z.string().min(1),
    event_id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    actor_id: z.string().min(1),
    actor_kind: ActorKindSchema,
    actor_name: z.string().min(1),
    text: z.string()
  })
  .strict();

export const AllowedStepViewSchema = z
  .object({
    id: z.string().min(1),
    actor_id: z.string().min(1),
    actor_kind: ActorKindSchema,
    args_schema: JsonSchemaValueSchema,
    args_ref_paths: z.array(z.string().min(1)),
    review_tags: z.array(z.string().min(1))
  })
  .strict();

export const SessionViewSchema = z
  .object({
    session_id: z.string().min(1),
    scenario_id: z.string().min(1),
    status: SessionStatusSchema,
    state_version: z.number().int().nonnegative(),
    state: JsonObjectSchema,
    allowed_steps: z.array(AllowedStepViewSchema),
    visible_transcript: z.array(VisibleTranscriptEntrySchema),
    current_stage_label: z.string().min(1),
    current_stage: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        goal: z.string().min(1)
      })
      .strict()
      .optional(),
    visible_tool_results: z
      .array(
        z
          .object({
            sequence: z.number().int().nonnegative(),
            actor_name: z.string().min(1),
            tool_id: z.string().min(1),
            summary: z.string().min(1),
            source_ref: z.string().min(1),
            trust_level: z.enum(["high", "medium", "low"])
          })
          .strict()
      )
      .optional(),
    current_actor_name: z.string().min(1).nullable(),
    next_user_action_label: z.string().min(1),
    failure_summary: z
      .object({
        message: z.string().min(1),
        failed_attempts: z.number().int().positive(),
        can_retry: z.boolean(),
        action_label: z.string().min(1)
      })
      .strict()
      .optional(),
    blocked_summary: z
      .object({
        reason: RuntimeBlockedReasonSchema,
        message: z.string().min(1),
        stage_id: z.string().min(1).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type AllowedStepView = z.infer<typeof AllowedStepViewSchema>;
export type VisibleTranscriptEntry = z.infer<typeof VisibleTranscriptEntrySchema>;
export type SessionView = z.infer<typeof SessionViewSchema>;
