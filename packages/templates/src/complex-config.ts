import {
  JsonObjectSchema,
  type JsonObject,
  type NormalizedScenarioV1,
  type StageContractV3,
  type StepContractV3
} from "@personalflow/contracts";

import { checkScenario } from "./validator";
import { legacyScenarioToV2 } from "./fixtures/legacy-upgrade";
import { buildScenarioSemanticPreview } from "./semantic-preview";
import type { TemplateDraft } from "./builder";
import type { TemplatePreview } from "./preview";

export interface ComplexAiRoleConfig {
  readonly name: string;
  readonly focus: string;
}

export interface ComplexStageConfig {
  readonly name: string;
  readonly rounds: number;
  readonly follow_up_strategy: string;
}

export interface ComplexScenarioConfig {
  readonly title: string;
  readonly goal: string;
  readonly user_role: string;
  readonly ai_roles: readonly ComplexAiRoleConfig[];
  readonly stages: readonly ComplexStageConfig[];
  readonly termination: string;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const nonEmpty = (label: string, value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${label}不能为空。`);
  }
  return trimmed;
};

const assertConfig = (config: ComplexScenarioConfig): ComplexScenarioConfig => {
  if (config.ai_roles.length < 2) {
    throw new Error("复杂场景至少需要两个 AI 角色。");
  }
  if (config.stages.length < 2) {
    throw new Error("复杂场景至少需要两个阶段。");
  }
  return {
    title: nonEmpty("场景标题", config.title),
    goal: nonEmpty("演练目标", config.goal),
    user_role: nonEmpty("用户角色", config.user_role),
    ai_roles: config.ai_roles.map((role) => ({
      name: nonEmpty("AI 角色", role.name),
      focus: nonEmpty("AI 关注点", role.focus)
    })),
    stages: config.stages.map((stage) => ({
      name: nonEmpty("阶段", stage.name),
      rounds: Math.max(1, Math.min(5, Math.trunc(stage.rounds))),
      follow_up_strategy: nonEmpty("追问策略", stage.follow_up_strategy)
    })),
    termination: nonEmpty("终止条件", config.termination)
  };
};

const slotName = (stageIndex: number, roundIndex: number) => `stage_${stageIndex + 1}_round_${roundIndex + 1}`;
const stageContractId = (stageIndex: number) => `stage_${stageIndex + 1}`;

const nextStageName = (stages: readonly ComplexStageConfig[], slotIndex: number, slots: readonly { stageIndex: number }[]): string => {
  const next = slots[slotIndex + 1];
  return next === undefined ? "完成" : stages[next.stageIndex]?.name ?? "下一阶段";
};

const stageStartSlot = (stages: readonly ComplexStageConfig[], stageIndex: number): number =>
  stages.slice(0, stageIndex).reduce((sum, stage) => sum + stage.rounds, 0);

const complexReviewDimensionTags = [
  "complex_goal_clarity",
  "complex_evidence_quality",
  "complex_risk_handling",
  "complex_action_commitment"
] as const;

const buildScenario = (config: ComplexScenarioConfig): NormalizedScenarioV1 => {
  const slots = config.stages.flatMap((stage, stageIndex) =>
    Array.from({ length: stage.rounds }, (_unused, roundIndex) => ({ stage, stageIndex, roundIndex }))
  );
  const aiActors = config.ai_roles.map((role, index) => ({
    id: `ai_role_${index + 1}`,
    kind: "ai" as const,
    display_name: role.name,
    description: role.focus
  }));
  const aiSteps: Array<Omit<StepContractV3, "stage_id">> = slots.map((slot, slotIndex) => {
    const actor = aiActors[slotIndex % aiActors.length];
    if (actor === undefined) {
      throw new Error("复杂场景至少需要一个 AI 角色。");
    }
    return {
      id: `ask_${slotName(slot.stageIndex, slot.roundIndex)}`,
      actor_id: actor.id,
      prompt: `你是「${actor.display_name}」。你的关注点：${actor.description}。围绕「${slot.stage.name}」阶段提一个问题。追问策略：${slot.stage.follow_up_strategy}。演练目标：${config.goal}。请基于可见历史推进，避免重复已经问过的问题；如果你的角色是主持人，应优先组织流程、确认共识、收敛结论和标记 deferred，而不是重复其他评审的问题。`,
      args_schema: {
        type: "object",
        properties: { question: { type: "string", minLength: 1 } },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.complex_config", "$.state.slot_index", "$.state.current_stage"],
      preconditions: [
        { op: "eq" as const, path: "$.state.slot_index", value: slotIndex },
        { op: "eq" as const, path: "$.state.awaiting_response", value: false },
        { op: "eq" as const, path: "$.state.complete", value: false }
      ],
      state_effects: [{ op: "set" as const, target_path: "$.state.awaiting_response", value: true }],
      review_tags: ["complex_follow_up", slot.stage.name, actor.display_name]
    };
  });
  const userSteps: Array<Omit<StepContractV3, "stage_id">> = slots.map((slot, slotIndex) => {
    const isLast = slotIndex === slots.length - 1;
    return {
      id: `respond_${slotName(slot.stageIndex, slot.roundIndex)}`,
      actor_id: "user_participant",
      prompt: `回应「${slot.stage.name}」阶段的问题，补充证据、取舍和下一步计划。`,
      args_schema: {
        type: "object",
        properties: { response: { type: "string", minLength: 1 } },
        required: ["response"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.complex_config", "$.state.turn_count", "$.state.current_stage"],
      preconditions: [
        { op: "eq" as const, path: "$.state.slot_index", value: slotIndex },
        { op: "eq" as const, path: "$.state.awaiting_response", value: true },
        { op: "eq" as const, path: "$.state.complete", value: false }
      ],
      state_effects: [
        { op: "increment" as const, target_path: "$.state.turn_count", amount: 1 },
        { op: "increment" as const, target_path: "$.state.slot_index", amount: 1 },
        { op: "set" as const, target_path: "$.state.awaiting_response", value: false },
        { op: "set" as const, target_path: "$.state.current_stage", value: nextStageName(config.stages, slotIndex, slots) },
        ...(isLast ? [{ op: "set" as const, target_path: "$.state.complete", value: true }] : [])
      ],
      review_tags: ["user_response", slot.stage.name, ...complexReviewDimensionTags]
    };
  });
  const steps = slots.flatMap((_slot, index) => {
    const aiStep = aiSteps[index];
    const userStep = userSteps[index];
    if (aiStep === undefined || userStep === undefined) {
      throw new Error("复杂场景步骤生成失败。");
    }
    return [aiStep, userStep];
  });
  const stageIdByStepId = new Map<string, string>();
  slots.forEach((slot, index) => {
    const aiStep = aiSteps[index];
    const userStep = userSteps[index];
    const stageId = stageContractId(slot.stageIndex);
    if (aiStep !== undefined) {
      stageIdByStepId.set(aiStep.id, stageId);
    }
    if (userStep !== undefined) {
      stageIdByStepId.set(userStep.id, stageId);
    }
  });

  const scenario = legacyScenarioToV2({
    id: "scenario_complex_config",
    title: config.title,
    description: `围绕「${config.goal}」进行多角色、多阶段复杂演练。`,
    actors: [
      { id: "user_participant", kind: "user", display_name: config.user_role, description: "参与复杂场景演练的用户。" },
      ...aiActors
    ],
    resources: {
      complex_config: JsonObjectSchema.parse(cloneJson({
        goal: config.goal,
        ai_roles: config.ai_roles,
        stages: config.stages,
        termination: config.termination
      }))
    },
    constants: { max_turns: slots.length },
    state_schema: {
      type: "object",
      properties: {
        turn_count: { type: "integer", minimum: 0 },
        slot_index: { type: "integer", minimum: 0 },
        current_stage: { type: "string" },
        awaiting_response: { type: "boolean" },
        complete: { type: "boolean" }
      },
      required: ["turn_count", "slot_index", "current_stage", "awaiting_response", "complete"],
      additionalProperties: false
    },
    initial_state: {
      turn_count: 0,
      slot_index: 0,
      current_stage: config.stages[0]?.name ?? "开场",
      awaiting_response: false,
      complete: false
    },
    steps,
    step_order: steps.map((step) => step.id),
    max_steps: slots.length * 2 + 1,
    terminal_rules: [
      {
        id: "terminal_complex_config_complete",
        when: { op: "eq", path: "$.state.complete", value: true },
        status: "completed",
        reason: config.termination
      }
    ],
    context_profile: {
      visible_state_paths: ["$.state.turn_count", "$.state.slot_index", "$.state.current_stage", "$.state.awaiting_response"],
      visible_resource_paths: ["$.resources.complex_config"],
      event_window: 8
    }
  });
  const stages: StageContractV3[] = config.stages.map((stage, stageIndex) => {
    const startSlot = stageStartSlot(config.stages, stageIndex);
    const endSlot = startSlot + stage.rounds;
    return {
      id: stageContractId(stageIndex),
      title: stage.name,
      goal: `${stage.name}：${stage.follow_up_strategy}`,
      order: stageIndex,
      enter_when: { op: "gte", path: "$.state.slot_index", value: startSlot },
      exit_when: { op: "gte", path: "$.state.slot_index", value: endSlot }
    };
  });
  const stageIds = stages.map((stage) => stage.id);
  return {
    ...scenario,
    stages,
    steps: scenario.steps.map((step) => ({
      ...step,
      stage_id: stageIdByStepId.get(step.id) ?? stageIds[0] ?? stageContractId(0)
    })),
    step_order: steps.map((step) => step.id),
    runtime_limits: {
      max_committed_steps: Math.max(slots.length * 2 + 1, 1),
      max_stage_committed_steps: Math.max(2, ...config.stages.map((stage) => stage.rounds * 2)),
      max_events: Math.max(30, slots.length * 8),
      max_failed_attempts: 10,
      max_tool_calls: 10
    },
    visibility_policy: {
      ...scenario.visibility_policy,
      rules: scenario.visibility_policy.rules.map((rule) => ({
        ...rule,
        subject: {
          ...rule.subject,
          stage_ids: stageIds
        }
      }))
    },
    review_rubric: {
      ...scenario.review_rubric,
      dimensions: [
        {
          id: "complex_goal_clarity",
          title: "目标清晰度",
          description: "评价参与者是否清楚说明目标、成功标准和关键约束。",
          evidence_tags: ["complex_goal_clarity"],
          evidence_requirement: "required",
          output_guidance: "只基于已提交回应判断目标和成功标准是否清晰。"
        },
        {
          id: "complex_evidence_quality",
          title: "证据质量",
          description: "评价参与者是否提供可观察、可核验的事实、指标或案例。",
          evidence_tags: ["complex_evidence_quality"],
          evidence_requirement: "required",
          output_guidance: "引用具体回应中的事实、指标或案例；证据不足时说明不确定性。"
        },
        {
          id: "complex_risk_handling",
          title: "风险处理",
          description: "评价参与者是否识别关键风险、边界条件和缓解方案。",
          evidence_tags: ["complex_risk_handling"],
          evidence_requirement: "required",
          output_guidance: "仅引用已提交回应里的风险判断、取舍和缓解动作。"
        },
        {
          id: "complex_action_commitment",
          title: "承诺可执行性",
          description: "评价参与者是否给出明确、可执行、可追踪的后续承诺。",
          evidence_tags: ["complex_action_commitment"],
          evidence_requirement: "required",
          output_guidance: "检查回应是否包含负责人、下一步、时间或验证方式等可执行信息。"
        }
      ]
    }
  };
};

const buildComplexPreview = (config: ComplexScenarioConfig): TemplatePreview => ({
  title: { value: config.title, is_default: false },
  goal: { value: config.goal, is_default: false },
  user_role: { value: config.user_role, is_default: false },
  ai_role: { value: config.ai_roles.map((role) => role.name).join(" / "), is_default: false },
  flow: config.stages.map((stage, index) => ({
    label: `流程 ${index + 1}`,
    value: `${stage.name}：${stage.follow_up_strategy}（${stage.rounds} 轮）`,
    is_default: false
  })),
  materials: [],
  review_method: { value: "按阶段目标、证据强度、风险处理和下一步计划复盘。", is_default: true },
  estimated_duration: { value: `约 ${Math.max(10, config.stages.reduce((sum, stage) => sum + stage.rounds, 0) * 5)} 分钟`, is_default: false },
  pressure_level: { value: "高压：多位 AI 会按阶段连续追问。", is_default: true },
  ready_summary: { value: "复杂场景已生成，可进入检查和确认流程。", is_default: false },
  notes: [
    { label: "结束条件", value: `结束条件：${config.termination}`, is_default: false },
    { label: "安全提醒", value: "普通页面只展示配置摘要，详细编排会由系统在后台处理。", is_default: true },
    { label: "提醒 1", value: "只需要填写角色、阶段、轮次和追问策略。", is_default: true },
    { label: "提醒 2", value: "生成后可复用场景检查、确认、演练、导出和复制流程。", is_default: true }
  ]
});

const buildDraftBody = (draft: Omit<TemplateDraft, "body">): JsonObject =>
  JsonObjectSchema.parse({
    template_id: draft.template_id,
    params: draft.params,
    preview: draft.preview,
    semantic_preview: draft.semantic_preview,
    scenario: draft.scenario as unknown
  });

export const buildDraftFromComplexConfig = (rawConfig: ComplexScenarioConfig): TemplateDraft => {
  const config = assertConfig(rawConfig);
  const scenario = buildScenario(config);
  const check = checkScenario(scenario);
  if (!check.ok) {
    throw new Error("Complex config generated an invalid scenario.");
  }
  const draftWithoutBody = {
    id: "draft_complex_config",
    template_id: "complex_config",
    params: JsonObjectSchema.parse(cloneJson(config)),
    preview: buildComplexPreview(config),
    semantic_preview: buildScenarioSemanticPreview(scenario),
    scenario: cloneJson(scenario)
  } satisfies Omit<TemplateDraft, "body">;
  return {
    ...draftWithoutBody,
    body: buildDraftBody(draftWithoutBody)
  };
};
