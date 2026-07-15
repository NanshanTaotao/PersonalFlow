import { z } from "zod";

import { JsonObjectSchema, JsonSchemaValueSchema, JsonValueSchema } from "./json";

const JsonPathSchema = z.string().min(1).regex(/^\$\./, "JSON path must start with $.");
const GuardReadPathSchema = z
  .string()
  .min(1)
  .regex(/^\$\.(state|constants|actor|args|events)(\.|$)/, "Guard path must read deterministic runtime roots.");
const StateWritePathSchema = z
  .string()
  .min(1)
  .regex(/^\$\.state\..+/, "State effect target_path must write under $.state.*.");
const ContractIdSchema = z.string().min(1);

export const ActorKindSchema = z.enum(["user", "ai", "system"]);

export const ActorContractV1Schema = z
  .object({
    id: ContractIdSchema,
    kind: ActorKindSchema,
    display_name: z.string().min(1),
    description: z.string().min(1).optional()
  })
  .strict();

export type ActorContractV1 = z.infer<typeof ActorContractV1Schema>;

type GuardExprV1 =
  | {
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
      path: string;
      value: z.infer<typeof JsonValueSchema>;
      value_from?: never;
    }
  | {
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
      path: string;
      value_from: string;
      value?: never;
    }
  | {
      op: "exists";
      path: string;
      value?: z.infer<typeof JsonValueSchema> | undefined;
    }
  | {
      op: "and" | "or";
      all: GuardExprV1[];
    }
  | {
      op: "not";
      expr: GuardExprV1;
    };

export const GuardExprV1Schema: z.ZodType<GuardExprV1> = z.lazy(() =>
  z.union([
    z
      .object({
        op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
        path: GuardReadPathSchema,
        value: JsonValueSchema
      })
      .strict(),
    z
      .object({
        op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
        path: GuardReadPathSchema,
        value_from: GuardReadPathSchema
      })
      .strict(),
    z
      .object({
        op: z.literal("exists"),
        path: GuardReadPathSchema,
        value: JsonValueSchema.optional()
      })
      .strict(),
    z
      .object({
        op: z.enum(["and", "or"]),
        all: z.array(GuardExprV1Schema).min(1)
      })
      .strict(),
    z
      .object({
        op: z.literal("not"),
        expr: GuardExprV1Schema
      })
      .strict()
  ])
);

export type { GuardExprV1 };

export const StateEffectV1Schema = z
  .object({
    op: z.enum(["set", "increment", "append", "remove", "clear"]),
    target_path: StateWritePathSchema,
    value: JsonValueSchema.optional(),
    value_from: GuardReadPathSchema.optional(),
    amount: z.number().optional()
  })
  .strict();

export type StateEffectV1 = z.infer<typeof StateEffectV1Schema>;

export const StepContractV1Schema = z
  .object({
    id: ContractIdSchema,
    actor_id: ContractIdSchema,
    prompt: z.string().min(1),
    args_schema: JsonSchemaValueSchema,
    args_ref_paths: z.array(JsonPathSchema),
    preconditions: z.array(GuardExprV1Schema),
    accept_when: GuardExprV1Schema.optional(),
    state_effects: z.array(StateEffectV1Schema),
    review_tags: z.array(z.string().min(1))
  })
  .strict();

export type StepContractV1 = z.infer<typeof StepContractV1Schema>;

export const SchedulerContractV1Schema = z
  .object({
    strategy: z.enum(["ordered", "manual", "priority"]),
    entry_step_ids: z.array(ContractIdSchema).min(1),
    candidate_step_ids: z.array(ContractIdSchema).min(1),
    max_steps: z.number().int().positive().optional()
  })
  .strict();

export type SchedulerContractV1 = z.infer<typeof SchedulerContractV1Schema>;

export const TerminalRuleV1Schema = z
  .object({
    id: ContractIdSchema,
    when: GuardExprV1Schema,
    status: z.enum(["completed", "ended", "failed"]),
    reason: z.string().min(1)
  })
  .strict();

export type TerminalRuleV1 = z.infer<typeof TerminalRuleV1Schema>;

export const ContextProfileV1Schema = z
  .object({
    visible_state_paths: z.array(JsonPathSchema),
    visible_resource_paths: z.array(JsonPathSchema),
    event_window: z.number().int().nonnegative()
  })
  .strict();

export type ContextProfileV1 = z.infer<typeof ContextProfileV1Schema>;

export const RoleSourceV2Schema = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    metadata: JsonObjectSchema.optional()
  })
  .strict();

export type RoleSourceV2 = z.infer<typeof RoleSourceV2Schema>;

export const RoleStageBehaviorV2Schema = z
  .object({
    stage_id: ContractIdSchema,
    goal: z.string().min(1),
    behavior_style: z.string().min(1)
  })
  .strict();

export type RoleStageBehaviorV2 = z.infer<typeof RoleStageBehaviorV2Schema>;

export const RoleContractV2Schema = z
  .object({
    id: ContractIdSchema,
    kind: ActorKindSchema,
    display_name: z.string().min(1),
    source: RoleSourceV2Schema,
    identity: z.string().min(1),
    goal: z.string().min(1),
    behavior_style: z.string().min(1),
    stage_behaviors: z.array(RoleStageBehaviorV2Schema).min(1),
    forbidden_behaviors: z.array(z.string().min(1)),
    requested_capabilities: z.array(z.string().min(1)),
    default_visibility_scope: z.enum(["none", "stage", "scenario"]),
    review_contribution_tags: z.array(z.string().min(1))
  })
  .strict();

export type RoleContractV2 = z.infer<typeof RoleContractV2Schema>;

export const RoleContractV3Schema = z
  .object({
    id: ContractIdSchema,
    kind: ActorKindSchema,
    display_name: z.string().min(1),
    identity: z.string().min(1),
    goal: z.string().min(1),
    behavior_style: z.string().min(1)
  })
  .strict();

export type RoleContractV3 = z.infer<typeof RoleContractV3Schema>;

export const StageContractV2Schema = z
  .object({
    id: ContractIdSchema,
    title: z.string().min(1),
    goal: z.string().min(1),
    order: z.number().int().nonnegative(),
    enter_when: GuardExprV1Schema,
    exit_when: GuardExprV1Schema,
    allowed_role_ids: z.array(ContractIdSchema).min(1),
    allowed_step_ids: z.array(ContractIdSchema).min(1),
    max_turns: z.number().int().positive()
  })
  .strict();

export type StageContractV2 = z.infer<typeof StageContractV2Schema>;

export const StageContractV3Schema = z
  .object({
    id: ContractIdSchema,
    title: z.string().min(1),
    goal: z.string().min(1),
    order: z.number().int().nonnegative(),
    enter_when: GuardExprV1Schema,
    exit_when: GuardExprV1Schema
  })
  .strict();

export type StageContractV3 = z.infer<typeof StageContractV3Schema>;

export const StepContractV2Schema = z
  .object({
    id: ContractIdSchema,
    stage_id: ContractIdSchema,
    actor_id: ContractIdSchema,
    prompt: z.string().min(1),
    args_schema: JsonSchemaValueSchema,
    args_ref_paths: z.array(JsonPathSchema),
    preconditions: z.array(GuardExprV1Schema),
    accept_when: GuardExprV1Schema.optional(),
    state_effects: z.array(StateEffectV1Schema),
    review_tags: z.array(z.string().min(1))
  })
  .strict();

export type StepContractV2 = z.infer<typeof StepContractV2Schema>;

export const StepContractV3Schema = StepContractV2Schema;
export type StepContractV3 = z.infer<typeof StepContractV3Schema>;

export const VisibilitySubjectV2Schema = z.union([
  z
    .object({
      role_ids: z.array(ContractIdSchema).min(1),
      stage_ids: z.array(ContractIdSchema).min(1).optional()
    })
    .strict(),
  z
    .object({
      role_ids: z.array(ContractIdSchema).min(1).optional(),
      stage_ids: z.array(ContractIdSchema).min(1)
    })
    .strict()
]);

export type VisibilitySubjectV2 = z.infer<typeof VisibilitySubjectV2Schema>;

export const VisibilityTargetV2Schema = z
  .object({
    kind: z.enum(["resource", "state"]),
    path: JsonPathSchema
  })
  .strict();

export type VisibilityTargetV2 = z.infer<typeof VisibilityTargetV2Schema>;

export const VisibilityRuleV2Schema = z
  .object({
    id: ContractIdSchema,
    subject: VisibilitySubjectV2Schema,
    target: VisibilityTargetV2Schema,
    access: z.enum(["full", "summary", "redacted"])
  })
  .strict();

export type VisibilityRuleV2 = z.infer<typeof VisibilityRuleV2Schema>;

export const VisibilityPolicyV2Schema = z
  .object({
    default: z.literal("deny"),
    rules: z.array(VisibilityRuleV2Schema)
  })
  .strict();

export type VisibilityPolicyV2 = z.infer<typeof VisibilityPolicyV2Schema>;

export const ToolContractV2Schema = z
  .object({
    id: ContractIdSchema,
    kind: z.literal("mock_rag_query"),
    description: z.string().min(1),
    args_schema: JsonSchemaValueSchema
  })
  .strict();

export type ToolContractV2 = z.infer<typeof ToolContractV2Schema>;

export const ToolGrantV2Schema = z
  .object({
    role_id: ContractIdSchema,
    stage_id: ContractIdSchema,
    tool_id: ContractIdSchema
  })
  .strict();

export type ToolGrantV2 = z.infer<typeof ToolGrantV2Schema>;

export const ToolPolicyV2Schema = z
  .object({
    tools: z.array(ToolContractV2Schema),
    grants: z.array(ToolGrantV2Schema)
  })
  .strict();

export type ToolPolicyV2 = z.infer<typeof ToolPolicyV2Schema>;

export const RagSourceV2Schema = z
  .object({
    id: ContractIdSchema,
    title: z.string().min(1),
    visibility_label: z.string().min(1),
    trust_level: z.enum(["high", "medium", "low"])
  })
  .strict();

export type RagSourceV2 = z.infer<typeof RagSourceV2Schema>;

export const RagPolicyV2Schema = z
  .object({
    sources: z.array(RagSourceV2Schema)
  })
  .strict();

export type RagPolicyV2 = z.infer<typeof RagPolicyV2Schema>;

export const ReviewRubricDimensionV2Schema = z
  .object({
    id: ContractIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    evidence_tags: z.array(z.string().min(1)).min(1),
    evidence_requirement: z.enum(["required", "optional"]),
    insufficient_evidence_policy: z.enum(["state_uncertainty", "omit_dimension"]),
    output_guidance: z.string().min(1)
  })
  .strict();

export type ReviewRubricDimensionV2 = z.infer<typeof ReviewRubricDimensionV2Schema>;

export const ReviewKeyMomentRuleV2Schema = z
  .object({
    id: ContractIdSchema,
    evidence_tags: z.array(z.string().min(1)).min(1),
    guidance: z.string().min(1),
    when: GuardExprV1Schema.optional()
  })
  .strict();

export type ReviewKeyMomentRuleV2 = z.infer<typeof ReviewKeyMomentRuleV2Schema>;

export const ReviewRubricV2Schema = z
  .object({
    dimensions: z.array(ReviewRubricDimensionV2Schema).min(1),
    key_moment_rules: z.array(ReviewKeyMomentRuleV2Schema).min(1),
    recommendation_policy: z.string().min(1),
    calibration_tags: z.array(z.string().min(1))
  })
  .strict();

export type ReviewRubricV2 = z.infer<typeof ReviewRubricV2Schema>;

export const QualityChecksV2Schema = z
  .object({
    required: z.array(z.string().min(1)).min(1)
  })
  .strict();

export type QualityChecksV2 = z.infer<typeof QualityChecksV2Schema>;

export const RuntimeLimitsV3Schema = z
  .object({
    max_committed_steps: z.number().int().positive(),
    max_stage_committed_steps: z.number().int().positive(),
    max_events: z.number().int().positive(),
    max_failed_attempts: z.number().int().positive(),
    max_tool_calls: z.number().int().positive()
  })
  .strict();

export type RuntimeLimitsV3 = z.infer<typeof RuntimeLimitsV3Schema>;

export const ReviewRubricDimensionV3Schema = z
  .object({
    id: ContractIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    evidence_tags: z.array(z.string().min(1)).min(1),
    evidence_requirement: z.enum(["required", "optional"]),
    output_guidance: z.string().min(1)
  })
  .strict();

export type ReviewRubricDimensionV3 = z.infer<typeof ReviewRubricDimensionV3Schema>;

export const ReviewRubricV3Schema = z
  .object({
    dimensions: z.array(ReviewRubricDimensionV3Schema).min(1)
  })
  .strict();

export type ReviewRubricV3 = z.infer<typeof ReviewRubricV3Schema>;

export const NormalizedScenarioV2Schema = z
  .object({
    schema_version: z.literal("2"),
    id: ContractIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    domain: z.string().min(1),
    version: z.string().min(1),
    roles: z.array(RoleContractV2Schema).min(1),
    stages: z.array(StageContractV2Schema).min(1),
    resources: JsonObjectSchema,
    constants: JsonObjectSchema,
    state_schema: JsonSchemaValueSchema,
    initial_state: JsonObjectSchema,
    steps: z.array(StepContractV2Schema).min(1),
    scheduler: SchedulerContractV1Schema,
    visibility_policy: VisibilityPolicyV2Schema,
    tool_policy: ToolPolicyV2Schema,
    rag_policy: RagPolicyV2Schema,
    terminal_rules: z.array(TerminalRuleV1Schema).min(1),
    review_rubric: ReviewRubricV2Schema,
    quality_checks: QualityChecksV2Schema
  })
  .strict();

export type NormalizedScenarioV2 = z.infer<typeof NormalizedScenarioV2Schema>;

export const RuntimeIRV3Schema = z
  .object({
    schema_version: z.literal("3"),
    id: ContractIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    domain: z.string().min(1),
    version: z.string().min(1),
    roles: z.array(RoleContractV3Schema).min(1),
    stages: z.array(StageContractV3Schema).min(1),
    steps: z.array(StepContractV3Schema).min(1),
    step_order: z.array(ContractIdSchema).min(1),
    runtime_limits: RuntimeLimitsV3Schema,
    resources: JsonObjectSchema,
    constants: JsonObjectSchema,
    state_schema: JsonSchemaValueSchema,
    initial_state: JsonObjectSchema,
    visibility_policy: VisibilityPolicyV2Schema,
    tool_policy: ToolPolicyV2Schema,
    terminal_rules: z.array(TerminalRuleV1Schema).min(1),
    review_rubric: ReviewRubricV3Schema
  })
  .strict();

export type RuntimeIRV3 = z.infer<typeof RuntimeIRV3Schema>;

export const ScenarioPackageV1Schema = z
  .object({
    runtime_ir: RuntimeIRV3Schema,
    authoring_metadata: JsonObjectSchema.optional()
  })
  .strict();

export type ScenarioPackageV1 = z.infer<typeof ScenarioPackageV1Schema>;

// Source-compatible aliases point at the current runtime-executable shape.
export const NormalizedScenarioSchema = RuntimeIRV3Schema;
export type NormalizedScenario = RuntimeIRV3;
export const NormalizedScenarioV1Schema = NormalizedScenarioSchema;
export type NormalizedScenarioV1 = NormalizedScenario;
