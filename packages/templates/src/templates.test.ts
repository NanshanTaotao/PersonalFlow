import { describe, expect, it } from "vitest";

import { NormalizedScenarioV1Schema, type JsonObject, type NormalizedScenarioV1 } from "@personalflow/contracts";

import {
  b2bSalesDiscoveryFixture,
  buildScenarioSemanticPreview,
  buildDraftFromComplexConfig,
  buildDraftFromTemplate,
  debateMatchFixture,
  builtInTemplates,
  jobInterviewFixture,
  promotionReviewFixture,
  thesisDefenseFixture,
  validateScenario
} from "./index";
import { negativeFixtures } from "./fixtures/negative";

const completeFixtures = [
  jobInterviewFixture,
  thesisDefenseFixture,
  promotionReviewFixture,
  debateMatchFixture,
  b2bSalesDiscoveryFixture
] as const;

const agentModulePath = "../../agent/src/index";
const runtimeModulePath = "../../runtime/src/index";
const loadAgent = async () => import(agentModulePath);
const loadRuntime = async () => import(runtimeModulePath);

const createRuntime = async (_scenario: NormalizedScenarioV1) => {
  const runtimeModule = await loadRuntime();
  return new runtimeModule.RuntimeKernel({ store: new runtimeModule.InMemoryRuntimeStore() });
};

const action = (selected_step: string, args: JsonObject) => ({
  content: JSON.stringify({ kind: "step", selected_step, content: "fixture action", args })
});

const argsForStep = (step: NormalizedScenarioV1["steps"][number], value: string): JsonObject => {
  if (typeof step.args_schema !== "object" || step.args_schema === null || Array.isArray(step.args_schema)) {
    return { input: value };
  }
  const required = step.args_schema.required ?? [];
  const properties = step.args_schema.properties ?? {};
  const field = required.find((key: string) => {
    const property = properties[key];
    return typeof property === "object" && property !== null && property.type === "string";
  });
  return { [field ?? "input"]: value };
};

const createRuntimeIRV3Scenario = (): NormalizedScenarioV1 => ({
  schema_version: "3",
  id: "scenario_runtime_ir_v3_validator",
  title: "RuntimeIR v3 validator",
  description: "Minimal RuntimeIR v3 scenario for validator and preview tests.",
  domain: "runtime-ir-v3",
  version: "1.0.0",
  roles: [
    {
      id: "user_participant",
      kind: "user",
      display_name: "参与者",
      identity: "你是参与演练的人。",
      goal: "回答当前问题。",
      behavior_style: "直接、具体。"
    },
    {
      id: "ai_coach",
      kind: "ai",
      display_name: "教练",
      identity: "你是结构化演练教练。",
      goal: "提出问题并收束反馈。",
      behavior_style: "清晰、简洁。"
    },
    {
      id: "tool_operator",
      kind: "system",
      display_name: "工具观察者",
      identity: "你只在授权工具可用时提供检索能力。",
      goal: "让工具授权在预览中可解释。",
      behavior_style: "中立。"
    },
    {
      id: "visibility_observer",
      kind: "ai",
      display_name: "可见性观察者",
      identity: "你只通过可见性规则读取上下文。",
      goal: "让可见性主体在预览中可解释。",
      behavior_style: "谨慎。"
    }
  ],
  stages: [
    {
      id: "opening",
      title: "开场",
      goal: "确认上下文并提出第一个问题。",
      order: 0,
      enter_when: { op: "eq", path: "$.state.phase", value: "opening" },
      exit_when: { op: "neq", path: "$.state.phase", value: "opening" }
    },
    {
      id: "closing",
      title: "收束",
      goal: "总结回应并结束演练。",
      order: 1,
      enter_when: { op: "eq", path: "$.state.phase", value: "closing" },
      exit_when: { op: "eq", path: "$.state.complete", value: true }
    }
  ],
  steps: [
    {
      id: "ask_opening_question",
      stage_id: "opening",
      actor_id: "ai_coach",
      prompt: "提出一个开场问题。",
      args_schema: {
        type: "object",
        properties: { question: { type: "string", minLength: 1 } },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.state.turn_count", "$.resources.playbook"],
      preconditions: [{ op: "eq", path: "$.state.awaiting_answer", value: false }],
      state_effects: [{ op: "set", target_path: "$.state.awaiting_answer", value: true }],
      review_tags: ["coach_question"]
    },
    {
      id: "answer_opening_question",
      stage_id: "opening",
      actor_id: "user_participant",
      prompt: "回答当前问题。",
      args_schema: {
        type: "object",
        properties: { answer: { type: "string", minLength: 1 } },
        required: ["answer"],
        additionalProperties: false
      },
      args_ref_paths: ["$.state.turn_count"],
      preconditions: [{ op: "eq", path: "$.state.awaiting_answer", value: true }],
      state_effects: [
        { op: "increment", target_path: "$.state.turn_count", amount: 1 },
        { op: "set", target_path: "$.state.awaiting_answer", value: false },
        { op: "set", target_path: "$.state.phase", value: "closing" }
      ],
      review_tags: ["participant_answer"]
    },
    {
      id: "close_summary",
      stage_id: "closing",
      actor_id: "ai_coach",
      prompt: "总结本次回应。",
      args_schema: {
        type: "object",
        properties: { summary: { type: "string", minLength: 1 } },
        required: ["summary"],
        additionalProperties: false
      },
      args_ref_paths: ["$.state.turn_count"],
      preconditions: [
        { op: "eq", path: "$.state.phase", value: "closing" },
        { op: "eq", path: "$.state.awaiting_answer", value: false }
      ],
      state_effects: [{ op: "set", target_path: "$.state.complete", value: true }],
      review_tags: ["closing_summary"]
    }
  ],
  step_order: ["ask_opening_question", "answer_opening_question", "close_summary"],
  runtime_limits: {
    max_committed_steps: 10,
    max_stage_committed_steps: 5,
    max_events: 20,
    max_failed_attempts: 3,
    max_tool_calls: 2
  },
  resources: {
    playbook: { summary: "Keep the opening concise." }
  },
  constants: {
    max_turns: 2
  },
  state_schema: {
    type: "object",
    properties: {
      turn_count: { type: "integer", minimum: 0 },
      awaiting_answer: { type: "boolean" },
      phase: { type: "string", enum: ["opening", "closing"] },
      complete: { type: "boolean" }
    },
    required: ["turn_count", "awaiting_answer", "phase", "complete"],
    additionalProperties: false
  },
  initial_state: {
    turn_count: 0,
    awaiting_answer: false,
    phase: "opening",
    complete: false
  },
  visibility_policy: {
    default: "deny",
    rules: [
      {
        id: "opening_state_for_visibility_observer",
        subject: { role_ids: ["visibility_observer"], stage_ids: ["opening"] },
        target: { kind: "state", path: "$.state.turn_count" },
        access: "summary"
      },
      {
        id: "opening_resource_for_coach",
        subject: { role_ids: ["ai_coach"], stage_ids: ["opening"] },
        target: { kind: "resource", path: "$.resources.playbook" },
        access: "summary"
      },
      {
        id: "closing_state_for_coach",
        subject: { role_ids: ["ai_coach"], stage_ids: ["closing"] },
        target: { kind: "state", path: "$.state.complete" },
        access: "summary"
      }
    ]
  },
  tool_policy: {
    tools: [
      {
        id: "coaching_notes",
        kind: "mock_rag_query",
        description: "教练资料检索",
        args_schema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false
        }
      }
    ],
    grants: [{ role_id: "tool_operator", stage_id: "opening", tool_id: "coaching_notes" }]
  },
  terminal_rules: [
    {
      id: "terminal_complete",
      when: { op: "eq", path: "$.state.complete", value: true },
      status: "completed",
      reason: "Scenario completed."
    }
  ],
  review_rubric: {
    dimensions: [
      {
        id: "answer_quality",
        title: "回答质量",
        description: "回答是否具体回应问题。",
        evidence_tags: ["participant_answer"],
        evidence_requirement: "required",
        output_guidance: "引用用户回答判断。"
      }
    ]
  }
});

const cloneRuntimeIRV3Scenario = (): NormalizedScenarioV1 =>
  structuredClone(createRuntimeIRV3Scenario()) as NormalizedScenarioV1;

const validationCodes = (scenario: unknown) => validateScenario(scenario).errors.map((error) => error.code);

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(label + " must be a string.");
  }
  return value;
};

const asStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(label + " must be a string array.");
  }
  return value;
};

const gate1Metadata = (scenario: NormalizedScenarioV1): Record<string, unknown> =>
  asRecord(scenario.resources.gate1, "gate1 metadata");

const assertGate1Asset = (
  scenario: NormalizedScenarioV1,
  expected: {
    readonly minimumEffectiveUserInputs: number;
    readonly minimumVisibleMaterialLength: number;
    readonly hiddenMaterialNeedles: readonly string[];
    readonly stageTitles: readonly string[];
    readonly reviewDimensions: readonly string[];
  }
) => {
  const metadata = gate1Metadata(scenario);
  const userVisibleMaterial = asString(scenario.resources.user_visible_material, "user_visible_material");
  const aiHiddenMaterial = asString(scenario.resources.ai_hidden_material, "ai_hidden_material");
  const trajectoryRequirements = asRecord(metadata.trajectory_requirements, "trajectory_requirements");
  const reviewDimensions = asStringArray(metadata.review_dimensions, "review_dimensions");
  const userRole = scenario.roles.find((role) => role.kind === "user");
  const aiRoles = scenario.roles.filter((role) => role.kind === "ai");
  const hiddenMaterialRules = scenario.visibility_policy.rules.filter(
    (rule) => rule.target.kind === "resource" && rule.target.path === "$.resources.ai_hidden_material"
  );
  const visibleMaterialRules = scenario.visibility_policy.rules.filter(
    (rule) => rule.target.kind === "resource" && rule.target.path === "$.resources.user_visible_material"
  );

  expect(userRole).toBeDefined();
  expect(aiRoles.length).toBeGreaterThan(0);
  expect(metadata.minimum_effective_user_inputs).toBe(expected.minimumEffectiveUserInputs);
  expect(scenario.constants.minimum_effective_user_inputs).toBe(expected.minimumEffectiveUserInputs);
  expect(userVisibleMaterial.length).toBeGreaterThanOrEqual(expected.minimumVisibleMaterialLength);
  for (const needle of expected.hiddenMaterialNeedles) {
    expect(aiHiddenMaterial).toContain(needle);
  }
  expect(scenario.stages.map((stage) => stage.title)).toEqual(expected.stageTitles);
  expect(asString(trajectoryRequirements.highlight, "highlight trajectory")).toContain("Highlight");
  expect(asString(trajectoryRequirements.normal, "normal trajectory")).toContain("Normal");
  expect(asString(trajectoryRequirements.lowlight, "lowlight trajectory")).toContain("Lowlight");
  expect(reviewDimensions).toEqual(expect.arrayContaining([...expected.reviewDimensions]));
  expect(scenario.review_rubric.dimensions.map((dimension) => dimension.title)).toEqual(
    expect.arrayContaining([...expected.reviewDimensions])
  );
  expect(hiddenMaterialRules.length).toBeGreaterThan(0);
  expect(hiddenMaterialRules.flatMap((rule) => rule.subject.role_ids ?? [])).not.toContain(userRole?.id);
  expect(hiddenMaterialRules.flatMap((rule) => rule.subject.role_ids ?? [])).toEqual(
    expect.arrayContaining(aiRoles.map((role) => role.id))
  );
  expect(visibleMaterialRules.flatMap((rule) => rule.subject.role_ids ?? [])).toContain(userRole?.id);
  expect(scenario.steps.filter((step) => step.actor_id === userRole?.id).length).toBeGreaterThanOrEqual(
    expected.minimumEffectiveUserInputs
  );
  expect(scenario.steps.some((step) => aiRoles.some((role) => role.id === step.actor_id) && step.args_ref_paths.includes("$.resources.ai_hidden_material"))).toBe(true);
};

describe("RuntimeIR v3 validator and semantic preview", () => {
  it("RuntimeIR v3 validator accepts scenarios without scheduler", () => {
    const scenario = createRuntimeIRV3Scenario();

    expect("scheduler" in scenario).toBe(false);
    expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
  });

  it("reports step_order coverage errors as blocked RuntimeIR v3 diagnostics", () => {
    const missingStepOrder = cloneRuntimeIRV3Scenario() as unknown as Record<string, unknown>;
    delete missingStepOrder.step_order;

    const duplicatedStepOrder = cloneRuntimeIRV3Scenario();
    duplicatedStepOrder.step_order = ["ask_opening_question", "ask_opening_question", "answer_opening_question", "close_summary"];

    const unknownStepOrder = cloneRuntimeIRV3Scenario();
    unknownStepOrder.step_order = ["ask_opening_question", "answer_opening_question", "missing_step", "close_summary"];

    const incompleteStepOrder = cloneRuntimeIRV3Scenario();
    incompleteStepOrder.step_order = ["ask_opening_question", "answer_opening_question"];

    expect(validationCodes(missingStepOrder)).toEqual(expect.arrayContaining(["missing_step_order", "invalid_schema"]));
    expect(validationCodes(duplicatedStepOrder)).toContain("step_order_duplicate");
    expect(validationCodes(unknownStepOrder)).toContain("step_order_unknown_step");
    expect(validationCodes(incompleteStepOrder)).toContain("step_order_incomplete");
  });

  it("reports runtime_limits schema diagnostics for missing or non-positive RuntimeIR v3 limits", () => {
    const missingLimit = cloneRuntimeIRV3Scenario() as unknown as {
      runtime_limits: Record<string, unknown>;
    };
    delete missingLimit.runtime_limits.max_events;

    const nonPositiveLimit = cloneRuntimeIRV3Scenario();
    nonPositiveLimit.runtime_limits.max_tool_calls = 0;

    const missingResult = validateScenario(missingLimit);
    const nonPositiveResult = validateScenario(nonPositiveLimit);

    expect(missingResult.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["runtime_limits_invalid", "invalid_schema"])
    );
    expect(missingResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_schema",
          diagnostics: expect.arrayContaining([expect.stringContaining("runtime_limits.max_events")])
        })
      ])
    );
    expect(nonPositiveResult.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["runtime_limits_invalid", "invalid_schema"])
    );
    expect(nonPositiveResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_schema",
          diagnostics: expect.arrayContaining([expect.stringContaining("runtime_limits.max_tool_calls")])
        })
      ])
    );
  });

  it("reports unknown RuntimeIR v3 step stage and actor references", () => {
    const unknownStage = cloneRuntimeIRV3Scenario();
    const firstStageStep = unknownStage.steps[0];
    if (firstStageStep === undefined) {
      throw new Error("RuntimeIR v3 scenario must define at least one step");
    }
    unknownStage.steps[0] = { ...firstStageStep, stage_id: "missing_stage" };

    const unknownActor = cloneRuntimeIRV3Scenario();
    const firstActorStep = unknownActor.steps[0];
    if (firstActorStep === undefined) {
      throw new Error("RuntimeIR v3 scenario must define at least one step");
    }
    unknownActor.steps[0] = { ...firstActorStep, actor_id: "missing_actor" };

    expect(validationCodes(unknownStage)).toContain("unknown_stage_reference");
    expect(validationCodes(unknownActor)).toContain("unknown_actor_reference");
  });

  it("reports stages without steps and unreachable initial RuntimeIR v3 entry", () => {
    const stageWithoutSteps = cloneRuntimeIRV3Scenario();
    stageWithoutSteps.stages = [
      ...stageWithoutSteps.stages,
      {
        id: "unused_stage",
        title: "空阶段",
        goal: "这个阶段没有任何步骤。",
        order: 2,
        enter_when: { op: "eq", path: "$.state.phase", value: "unused" },
        exit_when: { op: "neq", path: "$.state.phase", value: "unused" }
      }
    ];

    const unreachableInitialStage = cloneRuntimeIRV3Scenario();
    unreachableInitialStage.initial_state = { ...unreachableInitialStage.initial_state, phase: "missing" };

    const unreachableInitialStep = cloneRuntimeIRV3Scenario();
    unreachableInitialStep.initial_state = { ...unreachableInitialStep.initial_state, awaiting_answer: "blocked" };

    expect(validationCodes(stageWithoutSteps)).toContain("stage_without_steps");
    expect(validationCodes(unreachableInitialStage)).toContain("initial_stage_unreachable");
    expect(validationCodes(unreachableInitialStep)).toContain("initial_step_unreachable");
  });

  it("uses Runtime-equivalent initial guard context for state constants actor args and events.count", () => {
    const scenario = cloneRuntimeIRV3Scenario();
    scenario.constants = { ...scenario.constants, initial_phase: "opening" };
    scenario.stages = scenario.stages.map((stage) =>
      stage.id === "opening"
        ? {
            ...stage,
            enter_when: {
              op: "and",
              all: [
                { op: "eq", path: "$.state.phase", value_from: "$.constants.initial_phase" },
                { op: "eq", path: "$.actor.kind", value: "user" },
                { op: "exists", path: "$.args" },
                { op: "eq", path: "$.events.count", value: 0 }
              ]
            }
          }
        : stage
    );
    scenario.steps = scenario.steps.map((step) =>
      step.id === "ask_opening_question"
        ? {
            ...step,
            preconditions: [
              { op: "eq", path: "$.state.awaiting_answer", value: false },
              { op: "eq", path: "$.actor.kind", value: "ai" },
              { op: "exists", path: "$.args" },
              { op: "eq", path: "$.events.count", value: 0 }
            ]
          }
        : step
    );

    const codes = validationCodes(scenario);
    expect(codes).not.toContain("initial_stage_unreachable");
    expect(codes).not.toContain("initial_step_unreachable");
  });

  it("reports review evidence tags that are not observable from RuntimeIR v3 steps", () => {
    const scenario = cloneRuntimeIRV3Scenario();
    scenario.review_rubric = {
      dimensions: scenario.review_rubric.dimensions.map((dimension) => ({
        ...dimension,
        evidence_tags: ["missing_review_tag"]
      }))
    };

    expect(validationCodes(scenario)).toContain("review_evidence_tag_not_observable");
  });

  it("semantic preview derives RuntimeIR v3 stage roles without reading stage.allowed_role_ids", () => {
    const scenario = cloneRuntimeIRV3Scenario();
    const scenarioWithLegacyStageAllowList = {
      ...scenario,
      roles: [
        ...scenario.roles,
        {
          id: "legacy_only_role",
          kind: "ai",
          display_name: "旧 allow-list 角色",
          identity: "这个角色只存在于已删除的 stage allow-list。",
          goal: "如果预览读取 allowed_role_ids 就会泄漏。",
          behavior_style: "不应出现。"
        }
      ],
      stages: scenario.stages.map((stage) =>
        stage.id === "opening" ? { ...stage, allowed_role_ids: ["legacy_only_role"] } : stage
      )
    } as unknown as NormalizedScenarioV1;

    const preview = buildScenarioSemanticPreview(scenarioWithLegacyStageAllowList);
    const opening = preview.stages.find((stage) => stage.title === "开场");

    expect(opening?.roles).toEqual(expect.arrayContaining(["教练", "参与者", "工具观察者", "可见性观察者"]));
    expect(opening?.roles).not.toContain("旧 allow-list 角色");
    expect(opening?.tools).toEqual(["教练资料检索"]);
  });
});

describe("built-in product templates and complete fixtures", () => {
  it("exposes the product templates through the product registry", () => {
    expect(builtInTemplates.map((template) => template.id)).toEqual([
      "job_interview",
      "thesis_defense",
      "promotion_review",
      "debate_match",
      "b2b_sales_discovery"
    ]);
    expect(builtInTemplates.map((template) => template.title)).toEqual([
      "求职面试",
      "论文答辩 / 项目评审",
      "后端转正答辩",
      "辩论赛",
      "B2B 销售客户发现与异议处理"
    ]);
  });

  it("keeps built-in template copy localized for user-facing fields", () => {
    const templateCopy = JSON.stringify(builtInTemplates);

    expect(templateCopy).not.toMatch(/benchmark|next step|Sales Enablement|Backend Engineer|Growth-stage|project leadership|owner 意识/i);
  });

  it("labels turn parameters as suggested targets with clear session-control copy", () => {
    for (const template of builtInTemplates) {
      const turnProperty = template.param_schema.properties.max_turns ?? template.param_schema.properties.max_rounds;

      expect(turnProperty).toBeDefined();
      expect(turnProperty?.label).toBe("建议目标轮次");
      expect(turnProperty?.description).toContain("系统会围绕这个轮数安排追问并适时收束");
      expect(turnProperty?.description).toContain("你仍可提前结束演练");
    }
  });

  it("builds deterministic drafts from every built-in template default params", () => {
    for (const template of builtInTemplates) {
      const draft = buildDraftFromTemplate(template.id, {});
      const rebuilt = buildDraftFromTemplate(template.id, {});

      expect(draft.template_id).toBe(template.id);
      expect(draft.params).toEqual(template.default_params);
      expect(draft.preview.title.value).toBe(template.title);
      expect(draft.scenario).toEqual(rebuilt.scenario);
      expect(validateScenario(draft.scenario)).toEqual({ ok: true, errors: [] });
      expect(NormalizedScenarioV1Schema.safeParse(draft.scenario).success).toBe(true);
    }
  });

  it("ships four Gate 1 scenario assets with visible material, hidden AI material, trajectories, and review dimensions", () => {
    const gate1Cases = [
      {
        scenario: buildDraftFromTemplate("job_interview", {}).scenario,
        minimumEffectiveUserInputs: 22,
        minimumVisibleMaterialLength: 800,
        hiddenMaterialNeedles: ["项目深度", "系统设计", "候选人反问质量"],
        stageTitles: [
          "开场和自我介绍",
          "项目经历深挖",
          "系统设计或架构取舍",
          "故障排查与稳定性",
          "工程习惯与代码质量",
          "协作与行为问题",
          "候选人反问",
          "自然收尾"
        ],
        reviewDimensions: ["项目深度", "系统设计", "故障排查", "工程习惯", "协作沟通", "反思能力", "候选人反问质量"]
      },
      {
        scenario: buildDraftFromTemplate("promotion_review", {}).scenario,
        minimumEffectiveUserInputs: 18,
        minimumVisibleMaterialLength: 1000,
        hiddenMaterialNeedles: ["Leader", "后端同事", "QA", "PM", "合作前端"],
        stageTitles: [
          "答辩人开场陈述",
          "Leader 追问",
          "后端同事追问",
          "QA 追问",
          "PM 追问",
          "合作前端追问",
          "交叉质疑或补充追问",
          "答辩人总结",
          "评委建议与结论"
        ],
        reviewDimensions: ["表达问题", "证据不足", "真实工作影响", "技术判断", "协作问题", "成长和后续计划"]
      },
      {
        scenario: buildDraftFromTemplate("debate_match", {}).scenario,
        minimumEffectiveUserInputs: 16,
        minimumVisibleMaterialLength: 800,
        hiddenMaterialNeedles: ["主持人流程卡", "反方二辩攻击策略", "评委评分维度"],
        stageTitles: [
          "主持人开场",
          "正方一辩立论",
          "反方一辩立论",
          "质询环节",
          "反方质询正方二辩",
          "自由辩",
          "双方总结陈词",
          "评委点评"
        ],
        reviewDimensions: ["论点抓取", "质询质量", "反驳有效性", "自由辩协作", "立场稳定", "表达清晰度"]
      },
      {
        scenario: buildDraftFromTemplate("b2b_sales_discovery", {}).scenario,
        minimumEffectiveUserInputs: 18,
        minimumVisibleMaterialLength: 900,
        hiddenMaterialNeedles: ["业务负责人", "技术负责人", "采购", "内部反对者"],
        stageTitles: [
          "开场与客户背景确认",
          "需求发现",
          "痛点量化",
          "方案匹配",
          "预算异议",
          "安全或集成异议",
          "替换成本或组织阻力",
          "价值确认",
          "推进下一步或识别失败原因"
        ],
        reviewDimensions: ["发现问题能力", "提问质量", "痛点量化", "价值表达", "异议处理", "推进节奏", "下一步清晰度"]
      }
    ] as const;

    for (const item of gate1Cases) {
      expect(validateScenario(item.scenario)).toEqual({ ok: true, errors: [] });
      assertGate1Asset(item.scenario, item);
    }
  });

  it("validates all complete fixtures without runtime-specific extensions", () => {
    for (const scenario of completeFixtures) {
      expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
      expect(NormalizedScenarioV1Schema.parse(scenario)).toBeDefined();
      expect(scenario.roles.some((actor) => actor.kind === "user")).toBe(true);
      expect(scenario.roles.some((actor) => actor.kind === "ai")).toBe(true);
      expect(scenario.step_order.length).toBeGreaterThan(0);
      expect(scenario.runtime_limits.max_committed_steps).toBeGreaterThan(0);
      expect(scenario.terminal_rules.length).toBeGreaterThan(0);
      expect(scenario.visibility_policy.rules.length).toBeGreaterThan(0);
    }
  });

  it("builds thesis defense as a multi-role, multi-stage panel flow", () => {
    const draft = buildDraftFromTemplate("thesis_defense", {});
    const scenario = draft.scenario;
    const aiActors = scenario.roles.filter((actor) => actor.kind === "ai");
    const stepsByActor = new Map(
      aiActors.map((actor) => [actor.id, scenario.steps.filter((step) => step.actor_id === actor.id)])
    );
    const orderedStepIds = new Set(scenario.step_order);
    const aiStepIds = scenario.steps.filter((step) => aiActors.some((actor) => actor.id === step.actor_id)).map((step) => step.id);
    const aiReviewTags = new Set(
      scenario.steps
        .filter((step) => aiActors.some((actor) => actor.id === step.actor_id))
        .flatMap((step) => step.review_tags)
    );

    expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
    expect(NormalizedScenarioV1Schema.safeParse(scenario).success).toBe(true);
    expect(aiActors.length).toBeGreaterThanOrEqual(3);
    expect(aiActors.map((actor) => actor.display_name)).toEqual(
      expect.arrayContaining(["主评审", "方法评审", "落地评审"])
    );
    expect(scenario.constants.max_turns).toBeGreaterThanOrEqual(3);
    expect(aiActors.every((actor) => actor.identity.length > 0)).toBe(true);
    expect([...stepsByActor.values()].every((steps) => steps.length > 0)).toBe(true);
    expect(aiStepIds.length).toBeGreaterThanOrEqual(3);
    expect(scenario.steps.some((step) => step.actor_id === "user_presenter")).toBe(true);
    expect(aiStepIds.every((stepId) => orderedStepIds.has(stepId))).toBe(true);
    expect(new Set(scenario.steps.filter((step) => orderedStepIds.has(step.id)).map((step) => step.actor_id)).size).toBeGreaterThanOrEqual(3);
    expect(scenario.state_schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        panel_stage: expect.any(Object),
        awaiting_response: expect.any(Object)
      })
    });
    expect([...aiReviewTags]).toEqual(expect.arrayContaining(["opening_question", "evidence_probe", "risk_probe", "defense_synthesis"]));
    expect(
      scenario.steps
        .filter((step) => aiActors.some((actor) => actor.id === step.actor_id))
        .map((step) => step.prompt)
        .join("\n")
    ).toContain("如果引入极端行业或生产场景，必须明确说明这是一个假设");
    expect(scenario.terminal_rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "terminal_panel_synthesis_complete"
        })
      ])
    );
    expect(draft.preview.ai_role.value).toContain("主评审");
    expect(draft.preview.ai_role.value).toContain("方法评审");
    expect(draft.preview.flow.map((item) => item.value).join("\n")).toMatch(/开场|证据|风险|收束/);
  });

  it("builds backend interview as a single-AI long-form interviewer scenario", () => {
    const draft = buildDraftFromTemplate("job_interview", {});
    const scenario = draft.scenario;
    const aiActors = scenario.roles.filter((actor) => actor.kind === "ai");
    const orderedStepIds = new Set(scenario.step_order);
    const aiSteps = scenario.steps.filter((step) => aiActors.some((actor) => actor.id === step.actor_id));
    const userSteps = scenario.steps.filter((step) => step.actor_id === "user_candidate");

    expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
    expect(NormalizedScenarioV1Schema.safeParse(scenario).success).toBe(true);
    expect(aiActors.map((actor) => actor.display_name)).toEqual(["后端面试官"]);
    expect(userSteps.length).toBeGreaterThanOrEqual(22);
    expect(aiSteps.length).toBeGreaterThanOrEqual(22);
    expect(aiSteps.every((step) => orderedStepIds.has(step.id))).toBe(true);
    expect(new Set(aiSteps.map((step) => step.actor_id))).toEqual(new Set(["ai_backend_interviewer"]));
    expect(scenario.state_schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        slot: expect.any(Object),
        complete: expect.any(Object)
      })
    });
    expect(scenario.initial_state).toMatchObject({
      slot: 0,
      complete: false
    });
    expect(scenario.stages.map((stage) => stage.title)).toEqual(
      expect.arrayContaining(["项目经历深挖", "系统设计或架构取舍", "候选人反问", "自然收尾"])
    );
    expect(scenario.terminal_rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "terminal_scenario_job_interview_complete"
        })
      ])
    );
    expect(draft.preview.ai_role.value).toContain("后端面试官");
    expect(draft.preview.flow.map((item) => item.value).join("\n")).toMatch(/项目经历|系统设计|候选人反问|自然收尾/);
  });

  it("supports a twenty-two-input backend interview and estimates long interview duration", () => {
    const template = builtInTemplates.find((item) => item.id === "job_interview");
    const maxTurnsProperty = template?.param_schema.properties.max_turns;
    const draft = buildDraftFromTemplate("job_interview", {
      target_role: "后端 / Agent Runtime 工程师",
      company_stage: "POC 到增长阶段之间",
      interview_focus: "PersonalFlow RuntimeIR v3、Review Engine、Web 体验闭环、故障处理、代码质量和协作",
      max_turns: 22
    });

    expect(maxTurnsProperty?.minimum).toBeLessThanOrEqual(22);
    expect(maxTurnsProperty?.maximum).toBeGreaterThanOrEqual(22);
    expect(draft.scenario.constants.minimum_effective_user_inputs).toBe(22);
    expect(draft.scenario.constants.max_turns).toBe(22);
    expect(draft.preview.estimated_duration.value).toBe("约 45 分钟");
    expect(validateScenario(draft.scenario)).toEqual({ ok: true, errors: [] });
  });

  it("guides long backend interview probes to avoid repeated questions and rotate dimensions", () => {
    const draft = buildDraftFromTemplate("job_interview", { max_turns: 22 });
    const aiPromptCorpus = draft.scenario.steps
      .filter((step) => step.actor_id === "ai_backend_interviewer")
      .map((step) => step.prompt)
      .join("\n");

    expect(aiPromptCorpus).toContain("避免重复");
    expect(aiPromptCorpus).toContain("可见历史");
    expect(aiPromptCorpus).toContain("项目深挖");
    expect(aiPromptCorpus).toContain("系统设计");
    expect(aiPromptCorpus).toContain("工程取舍");
    expect(aiPromptCorpus).toContain("故障处理");
    expect(aiPromptCorpus).toContain("代码质量");
    expect(aiPromptCorpus).toContain("候选人反问");
  });

  it("defaults all job interview AI prompts to Chinese unless the candidate requests English", () => {
    const draft = buildDraftFromTemplate("job_interview", {});
    const aiRoleIds = new Set(draft.scenario.roles.filter((role) => role.kind === "ai").map((role) => role.id));
    const aiSteps = draft.scenario.steps.filter((step) => aiRoleIds.has(step.actor_id));

    expect(aiSteps.length).toBeGreaterThan(0);
    for (const step of aiSteps) {
      expect(step.prompt).toContain("请使用中文进行面试");
      expect(step.prompt).toContain("除非候选人明确要求英文");
      expect(step.prompt).not.toMatch(/\b(Open|Ask|Close) (the interview|one focused|a final|the final)/);
      if (step.args_schema && typeof step.args_schema === "object" && "properties" in step.args_schema && "question" in (step.args_schema.properties ?? {})) {
        expect(step.prompt).toContain("question 字段必须输出中文自然语言");
      }
      if (step.args_schema && typeof step.args_schema === "object" && "properties" in step.args_schema && "summary" in (step.args_schema.properties ?? {})) {
        expect(step.prompt).toContain("summary 字段必须输出中文自然语言");
      }
      expect(step.prompt).not.toContain("永远中文");
      expect(step.args_schema).toMatchObject({
        type: "object",
        additionalProperties: false
      });
    }
  });

  it("runs the backend interview template through the first ordered turns without blocking", async () => {
    const { createFakeLLM } = await loadAgent();
    const draft = buildDraftFromTemplate("job_interview", {
      target_role: "后端 / Agent Runtime 工程师",
      company_stage: "POC 到增长阶段之间",
      interview_focus: "PersonalFlow RuntimeIR v3、Review Engine、Web 体验闭环、故障处理、代码质量和协作",
      max_turns: 22
    });
    const runtime = await createRuntime(draft.scenario);
    const sessionId = "session-job-interview-long-flow";
    let view = await runtime.startSession({ sessionId, scenario: draft.scenario });

    expect(view.status).toBe("running");

    for (const stepId of draft.scenario.step_order.slice(0, 6)) {
      const step = draft.scenario.steps.find((item) => item.id === stepId);
      if (step === undefined) {
        throw new Error("Missing ordered step " + stepId);
      }
      const args = argsForStep(step, "我会引用材料、说明取舍，并补充可验证证据。");
      if (step.actor_id === "ai_backend_interviewer") {
        view = await runtime.runAiTurn({
          sessionId,
          actorId: step.actor_id,
          expectedStateVersion: view.state_version,
          adapter: createFakeLLM([action(step.id, args)])
        });
      } else {
        view = await runtime.submitStructuredAction({
          sessionId,
          actorId: step.actor_id,
          stepId: step.id,
          args,
          expectedStateVersion: view.state_version
        });
      }
      expect(view.status).toBe("running");
    }

    expect((await runtime.listEvents(sessionId)).map((event: { type: string }) => event.type)).not.toContain("RuntimeBlockedCommitted");
  });

  it("builds backend probation defense as a five-judge panel", () => {
    const draft = buildDraftFromTemplate("promotion_review", {});
    const scenario = draft.scenario;
    const aiActors = scenario.roles.filter((actor) => actor.kind === "ai");
    const orderedStepIds = new Set(scenario.step_order);
    const stepsByActor = new Map(
      aiActors.map((actor) => [actor.id, scenario.steps.filter((step) => step.actor_id === actor.id)])
    );
    const aiSteps = scenario.steps.filter((step) => aiActors.some((actor) => actor.id === step.actor_id));

    expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
    expect(NormalizedScenarioV1Schema.safeParse(scenario).success).toBe(true);
    expect(aiActors.map((actor) => actor.display_name)).toEqual([
      "Leader / 直属负责人",
      "后端同事",
      "QA 同事",
      "PM / 产品经理",
      "合作前端"
    ]);
    expect(aiSteps.length).toBeGreaterThanOrEqual(9);
    expect([...stepsByActor.values()].every((steps) => steps.length > 0)).toBe(true);
    expect(aiSteps.every((step) => orderedStepIds.has(step.id))).toBe(true);
    expect(new Set(aiSteps.map((step) => step.actor_id)).size).toBe(5);
    expect(scenario.state_schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        slot: expect.any(Object),
        complete: expect.any(Object)
      })
    });
    expect(scenario.initial_state).toMatchObject({
      slot: 0,
      complete: false
    });
    expect(scenario.terminal_rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "terminal_scenario_promotion_review_complete"
        })
      ])
    );
    expect(draft.preview.ai_role.value).toContain("Leader");
    expect(draft.preview.ai_role.value).toContain("QA 同事");
    expect(draft.preview.flow.map((item) => item.value).join("\n")).toMatch(/Leader|后端同事|QA|合作前端|评委建议/);
  });

  it("starts backend probation defense with the user's opening statement", () => {
    const draft = buildDraftFromTemplate("promotion_review", {});
    const scenario = draft.scenario;
    const firstStepId = scenario.step_order[0];
    const secondStepId = scenario.step_order[1];
    const firstStep = scenario.steps.find((step) => step.id === firstStepId);
    const secondStep = scenario.steps.find((step) => step.id === secondStepId);

    expect(firstStep).toMatchObject({
      stage_id: "opening",
      actor_id: "user_probation_engineer"
    });
    expect(firstStep?.prompt).toContain("开场陈述");
    expect(secondStep).toMatchObject({
      stage_id: "leader",
      actor_id: "ai_leader"
    });
  });

  it("threads custom thesis defense params into the complex panel scenario", () => {
    const draft = buildDraftFromTemplate("thesis_defense", {
      topic: "Deterministic replay audit",
      review_context: "graduate thesis defense",
      panel_focus: "method validity and rollout risk",
      max_turns: 3
    });

    expect(draft.scenario.resources.project_context).toEqual({
      topic: "Deterministic replay audit",
      review_context: "graduate thesis defense",
      panel_focus: "method validity and rollout risk"
    });
    expect(draft.scenario.constants.max_turns).toBe(3);
    expect(draft.preview.goal.value).toContain("Deterministic replay audit");
    expect(draft.preview.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "评审背景", value: "graduate thesis defense", is_default: false }),
        expect.objectContaining({ label: "追问重点", value: "method validity and rollout risk", is_default: false })
      ])
    );
  });

  it("builds debate match with the user fixed as affirmative second speaker", () => {
    const draft = buildDraftFromTemplate("debate_match", {});

    expect(draft.scenario.roles.find((role) => role.kind === "user")).toMatchObject({
      id: "user_affirmative_second",
      display_name: "正方二辩"
    });
    expect(draft.scenario.roles.map((role) => role.display_name)).toEqual(expect.arrayContaining([
      "正方一辩",
      "正方二辩",
      "正方三辩",
      "反方一辩",
      "反方二辩",
      "反方三辩",
      "主持人 / 主席",
      "评委"
    ]));
    expect(draft.scenario.stages.map((stage) => stage.title)).toEqual([
      "主持人开场",
      "正方一辩立论",
      "反方一辩立论",
      "质询环节",
      "反方质询正方二辩",
      "自由辩",
      "双方总结陈词",
      "评委点评"
    ]);
    expect(draft.scenario.review_rubric.dimensions.map((dimension) => dimension.title)).toEqual([
      "论点抓取",
      "质询质量",
      "反驳有效性",
      "自由辩协作",
      "立场稳定",
      "表达清晰度"
    ]);
    expect(draft.scenario.steps.filter((step) => step.actor_id === "user_affirmative_second")).toHaveLength(16);
    expect(validateScenario(draft.scenario).ok).toBe(true);
  });

  it("continues from moderator opening to affirmative first speaker before asking the user", async () => {
    const { createFakeLLM } = await loadAgent();
    const draft = buildDraftFromTemplate("debate_match", {});
    const runtime = await createRuntime(draft.scenario);
    const sessionId = "session-debate-opening-order";
    let view = await runtime.startSession({ sessionId, scenario: draft.scenario });

    expect(view.allowed_steps.map((step: { readonly id: string }) => step.id)).toEqual(["moderator_open"]);

    const moderatorStep = draft.scenario.steps.find((step) => step.id === "moderator_open");
    if (moderatorStep === undefined) {
      throw new Error("Debate match must define moderator opening step.");
    }
    view = await runtime.runAiTurn({
      sessionId,
      actorId: "ai_moderator",
      expectedStateVersion: view.state_version,
      adapter: createFakeLLM([action("moderator_open", argsForStep(moderatorStep, "主持人宣布规则并请正方一辩开始立论。"))])
    });

    expect(view.allowed_steps.map((step: { readonly id: string; readonly actor_id: string; readonly actor_kind: string }) => ({ id: step.id, actor_id: step.actor_id, actor_kind: step.actor_kind }))).toEqual([
      { id: "affirmative_first_open", actor_id: "ai_affirmative_first", actor_kind: "ai" }
    ]);
    expect(view.current_actor_name).toBe("正方一辩");
    expect(view.next_user_action_label).toContain("等待正方一辩");
  });

  it("keeps custom debate topic and positions out of default topic residue", () => {
    const draft = buildDraftFromTemplate("debate_match", {
      topic: "短视频的普及，对当代人利大于弊还是弊大于利",
      affirmative_position: "短视频降低表达门槛、扩大知识获取渠道，并为普通人提供新的创作和商业机会",
      negative_position: "短视频加剧注意力碎片化、放大低质内容传播，并削弱深度阅读和真实社交",
      max_rounds: 16
    });
    const scenarioCopy = JSON.stringify({
      resources: draft.scenario.resources,
      step_prompts: draft.scenario.steps.map((step) => step.prompt),
      constants: draft.scenario.constants
    });

    expect(scenarioCopy).toContain("短视频的普及");
    expect(scenarioCopy).toContain("短视频降低表达门槛");
    expect(scenarioCopy).toContain("短视频加剧注意力碎片化");
    expect(scenarioCopy).not.toMatch(/职场新人|真实导师|反馈显性化|安全试错|AI 反馈不准确|练习门槛|工具本身必然削弱能力/);
  });

  it("builds a three-stage multi-AI scenario from structured complex configuration", () => {
    const draft = buildDraftFromComplexConfig({
      title: "增长平台项目评审",
      goal: "验证增长平台方案的证据链、风险和落地计划",
      user_role: "方案负责人",
      ai_roles: [
        { name: "业务评审", focus: "业务目标、指标口径和收益证据" },
        { name: "技术评审", focus: "系统复杂度、稳定性和上线风险" }
      ],
      stages: [
        { name: "开场", rounds: 1, follow_up_strategy: "确认目标和背景" },
        { name: "证据追问", rounds: 2, follow_up_strategy: "连续追问指标证据和取舍" },
        { name: "风险收束", rounds: 1, follow_up_strategy: "收束风险、限制和下一步计划" }
      ],
      termination: "完成风险收束后结束并进入复盘"
    });
    const scenario = draft.scenario;
    const aiActors = scenario.roles.filter((actor) => actor.kind === "ai");
    const userSteps = scenario.steps.filter((step) => step.actor_id === "user_participant");
    const aiSteps = scenario.steps.filter((step) => aiActors.some((actor) => actor.id === step.actor_id));

    expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
    expect(NormalizedScenarioV1Schema.safeParse(scenario).success).toBe(true);
    expect(draft.template_id).toBe("complex_config");
    expect(draft.preview.title.value).toBe("增长平台项目评审");
    expect(draft.preview.goal.value).toContain("验证增长平台方案");
    expect(draft.preview.user_role.value).toBe("方案负责人");
    expect(draft.preview.ai_role.value).toContain("业务评审");
    expect(draft.preview.ai_role.value).toContain("技术评审");
    expect(draft.preview.flow.map((item) => item.value)).toEqual([
      "开场：确认目标和背景（1 轮）",
      "证据追问：连续追问指标证据和取舍（2 轮）",
      "风险收束：收束风险、限制和下一步计划（1 轮）"
    ]);
    expect(scenario.stages.map((stage) => stage.title)).toEqual(["开场", "证据追问", "风险收束"]);
    expect(draft.semantic_preview.stages.map((stage) => stage.title)).toEqual(["开场", "证据追问", "风险收束"]);
    expect(draft.semantic_preview.visibility.map((item) => item.target)).toEqual(
      expect.arrayContaining([
        "演练状态：轮次进度",
        "演练状态：当前阶段",
        "演练状态：等待回应状态",
        "材料：场景配置摘要"
      ])
    );
    expect(JSON.stringify(draft.semantic_preview.visibility)).not.toMatch(/turn_count|slot_index|current_stage|awaiting_response|complex_config/);
    expect(scenario.review_rubric.dimensions.map((dimension) => dimension.title)).toEqual([
      "目标清晰度",
      "证据质量",
      "风险处理",
      "承诺可执行性"
    ]);
    expect(new Set(scenario.review_rubric.dimensions.flatMap((dimension) => dimension.evidence_tags))).toEqual(
      new Set(["complex_goal_clarity", "complex_evidence_quality", "complex_risk_handling", "complex_action_commitment"])
    );
    expect(draft.semantic_preview.review_dimensions.map((dimension) => dimension.title)).toEqual([
      "目标清晰度",
      "证据质量",
      "风险处理",
      "承诺可执行性"
    ]);
    expect(aiActors.map((actor) => actor.display_name)).toEqual(["业务评审", "技术评审"]);
    expect(new Set(aiSteps.map((step) => step.actor_id))).toEqual(new Set(["ai_role_1", "ai_role_2"]));
    expect(new Set(scenario.steps.map((step) => step.stage_id))).toEqual(new Set(["stage_1", "stage_2", "stage_3"]));
    expect(scenario.visibility_policy.rules.every((rule) => rule.subject.stage_ids !== undefined)).toBe(true);
    expect(userSteps).toHaveLength(4);
    expect(scenario.constants.max_turns).toBe(4);
    expect(scenario.resources.complex_config).toMatchObject({
      goal: "验证增长平台方案的证据链、风险和落地计划",
      termination: "完成风险收束后结束并进入复盘"
    });
    expect(scenario.step_order[0]).toMatch(/^ask_stage_1_round_1$/);
    expect(scenario.runtime_limits.max_committed_steps).toBeGreaterThanOrEqual(scenario.step_order.length);
    expect(scenario.terminal_rules).toEqual([
      expect.objectContaining({ id: "terminal_complex_config_complete", status: "completed" })
    ]);
  });

  it("builds a four-role technical review config without changing runtime primitives", () => {
    const draft = buildDraftFromComplexConfig({
      title: "RuntimeIR v3 技术方案评审",
      goal: "评审 Runtime、Scenario Schema、Review Engine、Web 的职责边界和短样本复盘策略",
      user_role: "方案 owner",
      ai_roles: [
        { name: "主持人", focus: "组织流程、控制节奏、收敛结论" },
        { name: "架构评审", focus: "检查 Runtime 与上层策略的架构边界" },
        { name: "产品评审", focus: "检查短样本复盘是否误导用户" },
        { name: "可靠性评审", focus: "检查验证策略、发布风险和回归保护" }
      ],
      stages: [
        { name: "开场对齐", rounds: 1, follow_up_strategy: "主持人确认目标、限制和评审顺序" },
        { name: "分角色评审", rounds: 4, follow_up_strategy: "架构、产品、可靠性分别提出差异化问题" },
        { name: "结论收束", rounds: 2, follow_up_strategy: "主持人收敛 deferred、行动项和验收标准" }
      ],
      termination: "形成评审结论后结束并进入复盘"
    });
    const scenario = draft.scenario;
    const aiActors = scenario.roles.filter((actor) => actor.kind === "ai");
    const focusByRoleName = new Map([
      ["主持人", "组织流程、控制节奏、收敛结论"],
      ["架构评审", "检查 Runtime 与上层策略的架构边界"],
      ["产品评审", "检查短样本复盘是否误导用户"],
      ["可靠性评审", "检查验证策略、发布风险和回归保护"]
    ]);

    expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });
    expect(NormalizedScenarioV1Schema.safeParse(scenario).success).toBe(true);
    expect(aiActors.map((actor) => actor.display_name)).toEqual(["主持人", "架构评审", "产品评审", "可靠性评审"]);
    for (const actor of aiActors) {
      const actorPrompts = scenario.steps
        .filter((step) => step.actor_id === actor.id)
        .map((step) => step.prompt)
        .join("\n");
      expect(actorPrompts).toContain(actor.display_name);
      expect(actorPrompts).toContain(focusByRoleName.get(actor.display_name));
      expect(actorPrompts).toContain("避免重复");
      expect(actorPrompts).toContain("可见历史");
    }
    expect(draft.preview.ai_role.value).toContain("主持人");
    expect(draft.preview.ai_role.value).toContain("架构评审");
    expect(draft.preview.ai_role.value).toContain("产品评审");
    expect(draft.preview.ai_role.value).toContain("可靠性评审");
    expect(draft.semantic_preview.roles.map((role) => role.title)).toEqual(
      expect.arrayContaining(["主持人", "架构评审", "产品评审", "可靠性评审"])
    );
    expect(scenario.resources.complex_config).toMatchObject({
      termination: "形成评审结论后结束并进入复盘"
    });
    expect(JSON.stringify(draft.semantic_preview.visibility)).not.toMatch(/turn_count|slot_index|current_stage|awaiting_response|complex_config/);
  });

  it("starts every complete fixture in Runtime and commits at least one user turn", async () => {
    const { createFakeLLM } = await loadAgent();

    for (const scenario of completeFixtures) {
      const runtime = await createRuntime(scenario);
      const sessionId = "session-" + scenario.id;
      let view = await runtime.startSession({ sessionId, scenario });

      for (let guard = 0; guard < 10 && !view.allowed_steps.some((step: { readonly actor_kind: string }) => step.actor_kind === "user"); guard += 1) {
        const aiAllowedStep = view.allowed_steps.find((step: { readonly actor_kind: string }) => step.actor_kind === "ai");
        if (aiAllowedStep === undefined) {
          break;
        }
        const scenarioStep = scenario.steps.find((step) => step.id === aiAllowedStep.id);
        if (scenarioStep === undefined) {
          throw new Error("Missing allowed AI step for " + scenario.id + ": " + aiAllowedStep.id);
        }
        view = await runtime.runAiTurn({
          sessionId,
          actorId: scenarioStep.actor_id,
          expectedStateVersion: view.state_version,
          adapter: createFakeLLM([action(scenarioStep.id, argsForStep(scenarioStep, "请按当前流程继续。"))])
        });
      }

      expect(view.allowed_steps.some((step: { readonly actor_kind: string }) => step.actor_kind === "user")).toBe(true);
      const beforeUserStateVersion = view.state_version;
      view = await runtime.submitUserInput({
        sessionId,
        input: "我会基于材料给出具体回答，并说明证据、风险和下一步。",
        expectedStateVersion: beforeUserStateVersion
      });

      expect(view.state_version).toBeGreaterThan(beforeUserStateVersion);
      expect((await runtime.listEvents(sessionId)).map((event: { type: string }) => event.type).at(-1)).toBe("StepCommitted");
    }
  });
});

describe("negative fixtures", () => {
  it("records invalid selected_step without advancing committed state", async () => {
    const runtime = await createRuntime(negativeFixtures.invalidSelectedStep);
    const { createFakeLLM } = await loadAgent();
    const adapter = createFakeLLM([action("missing_step", { question: "Bad step" })]);
    const aiActor = negativeFixtures.invalidSelectedStep.roles.find((role) => role.kind === "ai");
    if (aiActor === undefined) {
      throw new Error("Negative selected-step fixture must define an AI actor.");
    }
    await runtime.startSession({
      sessionId: "session-negative-selected-step",
      scenario: negativeFixtures.invalidSelectedStep
    });

    const view = await runtime.runAiTurn({
      sessionId: "session-negative-selected-step",
      actorId: aiActor.id,
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect((await runtime.listEvents("session-negative-selected-step")).at(-1)).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 0,
      state_version_after: 0
    });
  });

  it("records invisible resource reference without advancing committed state", async () => {
    const runtime = await createRuntime(negativeFixtures.invisibleResourceReference);
    const { createFakeLLM } = await loadAgent();
    const adapter = createFakeLLM([
      action("ask_sensitive_question", {
        question: "Use hidden material?",
        material_path: "$.resources.private_notes"
      })
    ]);
    const aiActor = negativeFixtures.invisibleResourceReference.roles.find((role) => role.kind === "ai");
    if (aiActor === undefined) {
      throw new Error("Negative invisible-resource fixture must define an AI actor.");
    }
    await runtime.startSession({
      sessionId: "session-negative-invisible-resource",
      scenario: negativeFixtures.invisibleResourceReference
    });

    const view = await runtime.runAiTurn({
      sessionId: "session-negative-invisible-resource",
      actorId: aiActor.id,
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect((await runtime.listEvents("session-negative-invisible-resource")).at(-1)).toMatchObject({
      type: "StepAttemptFailed"
    });
  });

  it("rejects stale expectedStateVersion without appending a commit", async () => {
    const runtime = await createRuntime(negativeFixtures.stateVersionConflict);
    const { RuntimeConflictError } = await loadRuntime();
    await runtime.startSession({
      sessionId: "session-negative-conflict",
      scenario: negativeFixtures.stateVersionConflict
    });

    await expect(
      runtime.submitStructuredAction({
        sessionId: "session-negative-conflict",
        actorId: "user_candidate",
        stepId: "answer_interview_question",
        args: { answer: "This must not commit." },
        expectedStateVersion: 1
      })
    ).rejects.toBeInstanceOf(RuntimeConflictError);

    expect(await runtime.listEvents("session-negative-conflict")).toHaveLength(1);
  });

  it("reports state effects outside top-level state schema properties", () => {
    const result = validateScenario(negativeFixtures.stateEffectOutsideSchema);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "state_effect_path_outside_schema",
          path: "steps.answer_opening_1.state_effects.0.target_path"
        })
      ])
    );
  });
});
