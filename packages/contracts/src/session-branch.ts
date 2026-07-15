import { z } from "zod";

import { SessionStatusSchema } from "./session-view";

export const SessionForkModeSchema = z.enum(["root", "manual_fork", "withdraw_user_input", "edit_answer"]);

export type SessionForkMode = z.infer<typeof SessionForkModeSchema>;

export const SessionBranchRecordSchema = z
  .object({
    session_id: z.string().min(1),
    root_session_id: z.string().min(1),
    parent_session_id: z.string().min(1).nullable(),
    forked_from_event_id: z.string().min(1).nullable(),
    forked_from_sequence: z.number().int().nonnegative().nullable(),
    forked_from_state_version: z.number().int().nonnegative().nullable(),
    fork_boundary_sequence: z.number().int().nonnegative().nullable(),
    fork_boundary_state_version: z.number().int().nonnegative().nullable(),
    include_selected_event: z.boolean().nullable(),
    fork_mode: SessionForkModeSchema,
    branch_label: z.string().min(1),
    created_at: z.string().min(1)
  })
  .strict();

export type SessionBranchRecord = z.infer<typeof SessionBranchRecordSchema>;

export const CreateSessionForkRequestSchema = z
  .object({
    fork_point_event_id: z.string().min(1),
    mode: z.enum(["manual_fork", "edit_answer"]).default("manual_fork"),
    include_selected_event: z.boolean().default(true),
    branch_label: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional()
  })
  .strict();

export type CreateSessionForkRequest = z.infer<typeof CreateSessionForkRequestSchema>;

export const WithdrawUserInputRequestSchema = z
  .object({
    user_event_id: z.string().min(1),
    branch_label: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional()
  })
  .strict();

export type WithdrawUserInputRequest = z.infer<typeof WithdrawUserInputRequestSchema>;

export type BranchTreeNode = {
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly label: string;
  readonly forked_from_sequence?: number | undefined;
  readonly status: z.infer<typeof SessionStatusSchema>;
  readonly rounds: number;
  readonly created_at: string;
  readonly is_current: boolean;
  readonly has_review: boolean;
  readonly latest_review?: {
    readonly id: string;
    readonly title: string;
    readonly status: "pending" | "succeeded" | "failed";
  } | undefined;
  readonly children: readonly BranchTreeNode[];
};

export const BranchTreeNodeSchema: z.ZodType<BranchTreeNode> = z.lazy(() =>
  z
    .object({
      session_id: z.string().min(1),
      parent_session_id: z.string().min(1).nullable(),
      label: z.string().min(1),
      forked_from_sequence: z.number().int().nonnegative().optional(),
      status: SessionStatusSchema,
      rounds: z.number().int().nonnegative(),
      created_at: z.string().min(1),
      is_current: z.boolean(),
      has_review: z.boolean(),
      latest_review: z
        .object({
          id: z.string().min(1),
          title: z.string().min(1),
          status: z.enum(["pending", "succeeded", "failed"])
        })
        .strict()
        .optional(),
      children: z.array(BranchTreeNodeSchema)
    })
    .strict()
);

export const BranchTreeResponseSchema = z
  .object({
    root_session_id: z.string().min(1),
    current_session_id: z.string().min(1),
    nodes: z.array(BranchTreeNodeSchema)
  })
  .strict();

export type BranchTreeResponse = z.infer<typeof BranchTreeResponseSchema>;

export type CreateSessionBranchInput = SessionBranchRecord;
