import { z } from "zod";

import { ApiErrorCodeSchema } from "./errors";
import { JsonObjectSchema, JsonValueSchema } from "./json";

export const RuntimeBlockedReasonSchema = z.enum(["no_active_stage", "no_allowed_step", "runtime_limit_exceeded"]);

const EventBaseSchema = z
  .object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    state_version_before: z.number().int().nonnegative(),
    state_version_after: z.number().int().nonnegative(),
    created_at: z.string().min(1)
  })
  .strict();

export const SessionStartedEventSchema = EventBaseSchema.extend({
  type: z.literal("SessionStarted"),
  payload: z
    .object({
      scenario_id: z.string().min(1),
      initial_state: JsonObjectSchema
    })
    .strict()
});

export const StepCommittedEventSchema = EventBaseSchema.extend({
  type: z.literal("StepCommitted"),
  payload: z
    .object({
      step_id: z.string().min(1),
      actor_id: z.string().min(1),
      args: JsonObjectSchema,
      state_patch: JsonObjectSchema
    })
    .strict()
});

export const StepAttemptFailedEventSchema = EventBaseSchema.extend({
  type: z.literal("StepAttemptFailed"),
  payload: z
    .object({
      step_id: z.string().min(1),
      actor_id: z.string().min(1),
      reason: z.string().min(1),
      error_code: ApiErrorCodeSchema
    })
    .strict()
}).refine((event) => event.state_version_before === event.state_version_after, {
  message: "StepAttemptFailed must not advance state version",
  path: ["state_version_after"]
});

export const RuntimeCommandCommittedEventSchema = EventBaseSchema.extend({
  type: z.literal("RuntimeCommandCommitted"),
  payload: z
    .object({
      command: z.enum(["start_session", "pause_session", "resume_session", "end_session"]),
      args: JsonObjectSchema
    })
    .strict()
});

export const RuntimeBlockedCommittedEventSchema = EventBaseSchema.extend({
  type: z.literal("RuntimeBlockedCommitted"),
  payload: z
    .object({
      reason: RuntimeBlockedReasonSchema,
      stage_id: z.string().min(1).optional(),
      diagnostics: z.array(z.string().min(1)).optional()
    })
    .strict()
}).refine((event) => event.state_version_before === event.state_version_after, {
  message: "RuntimeBlockedCommitted must not advance state version",
  path: ["state_version_after"]
});

export const ToolCallCommittedEventSchema = EventBaseSchema.extend({
  type: z.literal("ToolCallCommitted"),
  payload: z
    .object({
      actor_id: z.string().min(1),
      stage_id: z.string().min(1),
      tool_id: z.string().min(1),
      request: JsonObjectSchema,
      result: z
        .object({
          summary: z.string().min(1),
          source_ref: z.string().min(1),
          doc_version_hash: z.string().min(1),
          chunk_id: z.string().min(1),
          visibility_label: z.string().min(1),
          trust_level: z.enum(["high", "medium", "low"])
        })
        .strict()
    })
    .strict()
}).refine((event) => event.state_version_before === event.state_version_after, {
  message: "ToolCallCommitted must not advance state version",
  path: ["state_version_after"]
});

export const ToolCallFailedEventSchema = EventBaseSchema.extend({
  type: z.literal("ToolCallFailed"),
  payload: z
    .object({
      actor_id: z.string().min(1),
      stage_id: z.string().min(1),
      tool_id: z.string().min(1),
      request: JsonObjectSchema,
      reason: z.string().min(1),
      error_code: ApiErrorCodeSchema
    })
    .strict()
}).refine((event) => event.state_version_before === event.state_version_after, {
  message: "ToolCallFailed must not advance state version",
  path: ["state_version_after"]
});

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  SessionStartedEventSchema,
  StepCommittedEventSchema,
  StepAttemptFailedEventSchema,
  RuntimeCommandCommittedEventSchema,
  RuntimeBlockedCommittedEventSchema,
  ToolCallCommittedEventSchema,
  ToolCallFailedEventSchema
]);

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const RuntimeCommandRequestSchema = z
  .object({
    step_id: z.string().min(1),
    args: JsonObjectSchema,
    expected_state_version: z.number().int().nonnegative(),
    idempotency_key: z.string().min(1).optional(),
    metadata: z.record(z.string(), JsonValueSchema).optional()
  })
  .strict();

export type RuntimeCommandRequest = z.infer<typeof RuntimeCommandRequestSchema>;
