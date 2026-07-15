import type { JsonObject, NormalizedScenarioV1 } from "@personalflow/contracts";

export interface LinearRole {
  readonly id: string;
  readonly kind: "user" | "ai";
  readonly display_name: string;
  readonly identity: string;
  readonly goal: string;
  readonly behavior_style: string;
}

export interface LinearStage {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
}

export interface LinearStep {
  readonly id: string;
  readonly stage_id: string;
  readonly actor_id: string;
  readonly prompt: string;
  readonly field: string;
  readonly review_tags: readonly string[];
  readonly hidden_material?: boolean;
  readonly complete?: boolean;
}

export interface LinearReviewDimension {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly evidence_tags: readonly string[];
  readonly evidence_requirement?: "required" | "optional";
  readonly output_guidance: string;
}

export interface Gate1Metadata {
  readonly minimum_effective_user_inputs: number;
  readonly trajectory_requirements: {
    readonly highlight: string;
    readonly normal: string;
    readonly lowlight: string;
  };
  readonly review_dimensions: readonly string[];
}

export interface LinearScenarioInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly roles: readonly LinearRole[];
  readonly stages: readonly LinearStage[];
  readonly steps: readonly LinearStep[];
  readonly user_visible_material: string;
  readonly ai_hidden_material: string;
  readonly gate1: Gate1Metadata;
  readonly constants?: JsonObject;
  readonly resources?: JsonObject;
  readonly review_dimensions: readonly LinearReviewDimension[];
  readonly terminal_reason: string;
}

const objectArgs = (field: string): NormalizedScenarioV1["steps"][number]["args_schema"] => ({
  type: "object",
  properties: { [field]: { type: "string", minLength: 1 } },
  required: [field],
  additionalProperties: false
});

const stageRange = (steps: readonly (LinearStep & { readonly slot: number })[], stageId: string) => {
  const slots = steps.filter((step) => step.stage_id === stageId).map((step) => step.slot);
  if (slots.length === 0) {
    throw new Error(`Linear scenario stage '${stageId}' has no steps.`);
  }
  const start = Math.min(...slots);
  const end = Math.max(...slots);
  return { start, end };
};

export const createLinearScenario = (input: LinearScenarioInput): NormalizedScenarioV1 => {
  const indexedSteps = input.steps.map((step, slot) => ({ ...step, slot }));
  const allRoleIds = input.roles.map((role) => role.id);
  const aiRoleIds = input.roles.filter((role) => role.kind === "ai").map((role) => role.id);
  const stageIds = input.stages.map((stage) => stage.id);
  const maxCommittedSteps = indexedSteps.length + 2;

  return {
    schema_version: "3",
    id: input.id,
    title: input.title,
    description: input.description,
    domain: input.domain,
    version: "3.0.0",
    roles: input.roles.map((role) => ({ ...role })),
    stages: input.stages.map((stage, order) => {
      const range = stageRange(indexedSteps, stage.id);
      return {
        ...stage,
        order,
        enter_when: { op: "gte", path: "$.state.slot", value: range.start },
        exit_when: { op: "gte", path: "$.state.slot", value: range.end + 1 }
      };
    }),
    steps: indexedSteps.map((step) => ({
      id: step.id,
      stage_id: step.stage_id,
      actor_id: step.actor_id,
      prompt: `${step.prompt}\n输出时必须选择 selected_step="${step.id}"，args 必须符合 ${step.field} 字段 schema。`,
      args_schema: objectArgs(step.field),
      args_ref_paths: [
        "$.resources.user_visible_material",
        "$.state.slot",
        ...(step.hidden_material === true ? ["$.resources.ai_hidden_material"] : [])
      ],
      preconditions: [
        { op: "eq", path: "$.state.slot", value: step.slot },
        { op: "eq", path: "$.state.complete", value: false }
      ],
      state_effects: [
        { op: "increment", target_path: "$.state.slot", amount: 1 },
        ...(step.complete === true ? [{ op: "set" as const, target_path: "$.state.complete", value: true }] : [])
      ],
      review_tags: [...step.review_tags]
    })),
    step_order: indexedSteps.map((step) => step.id),
    runtime_limits: {
      max_committed_steps: maxCommittedSteps,
      max_stage_committed_steps: maxCommittedSteps,
      max_events: Math.max(80, maxCommittedSteps * 4),
      max_failed_attempts: 12,
      max_tool_calls: 4
    },
    resources: {
      ...(input.resources ?? {}),
      user_visible_material: input.user_visible_material,
      ai_hidden_material: input.ai_hidden_material,
      gate1: input.gate1 as unknown as JsonObject
    },
    constants: {
      ...(input.constants ?? {}),
      minimum_effective_user_inputs: input.gate1.minimum_effective_user_inputs
    },
    state_schema: {
      type: "object",
      properties: {
        slot: { type: "integer", minimum: 0 },
        complete: { type: "boolean" }
      },
      required: ["slot", "complete"],
      additionalProperties: false
    },
    initial_state: { slot: 0, complete: false },
    visibility_policy: {
      default: "deny",
      rules: [
        {
          id: "user_visible_material_visible",
          subject: { role_ids: allRoleIds, stage_ids: stageIds },
          target: { kind: "resource", path: "$.resources.user_visible_material" },
          access: "full"
        },
        {
          id: "ai_hidden_material_visible",
          subject: { role_ids: aiRoleIds, stage_ids: stageIds },
          target: { kind: "resource", path: "$.resources.ai_hidden_material" },
          access: "full"
        },
        {
          id: "slot_visible",
          subject: { role_ids: allRoleIds, stage_ids: stageIds },
          target: { kind: "state", path: "$.state.slot" },
          access: "summary"
        },
        {
          id: "complete_visible",
          subject: { role_ids: allRoleIds, stage_ids: stageIds },
          target: { kind: "state", path: "$.state.complete" },
          access: "summary"
        }
      ]
    },
    tool_policy: { tools: [], grants: [] },
    terminal_rules: [
      {
        id: `terminal_${input.id}_complete`,
        when: { op: "eq", path: "$.state.complete", value: true },
        status: "completed",
        reason: input.terminal_reason
      }
    ],
    review_rubric: {
      dimensions: input.review_dimensions.map((dimension) => ({
        ...dimension,
        evidence_tags: [...dimension.evidence_tags],
        evidence_requirement: dimension.evidence_requirement ?? "required"
      }))
    }
  };
};

export const trajectoryRequirements = (domain: string) => ({
  highlight: `Highlight 用户：${domain} 中结构清晰、主动澄清、能引用材料、能处理追问，并承认边界。`,
  normal: `Normal 用户：${domain} 中回答基本相关，但结构、指标、风险闭环或推进力度不稳定。`,
  lowlight: `Lowlight 用户：${domain} 中答非所问、证据不足、逃避追问、逻辑跳跃或过早让步。`
});

export const anchoredGuidance = (base: string): string =>
  `${base} Highlight 要引用充分证据、结构、指标或推进动作；Normal 要指出相关但不完整的证据；Lowlight 要明确指出跑题、缺证据、逃避或无法推进的问题。结论只能描述本次演练表现，不得写成长期稳定能力判断。`;
