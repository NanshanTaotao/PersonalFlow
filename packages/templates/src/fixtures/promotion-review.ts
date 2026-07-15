import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { anchoredGuidance, createLinearScenario, trajectoryRequirements, type LinearStep } from "./linear-scenario";

export interface PromotionReviewFixtureParams {
  readonly target_level: string;
  readonly review_cycle: string;
  readonly impact_focus: string;
  readonly max_turns: number;
}

const visibleMaterial = (params: PromotionReviewFixtureParams): string => [
  `转正材料：答辩人是一名试用期后端工程师，目标是在 ${params.review_cycle} 结束时证明自己达到 ${params.target_level} 的转正预期。本次答辩重点是 ${params.impact_focus}，但材料中包含不完美信息，需要评委继续追问。`,
  "试用期目标：熟悉核心业务链路，独立负责至少一个后端模块交付，补齐测试与监控，和前端、QA、PM 建立稳定协作机制。试用期开始时，答辩人对业务指标、发布流程和跨团队沟通节奏还不熟悉。",
  "主要工作概览：答辩人参与订单履约体验优化、配置中心迁移和演练报告稳定性治理。订单履约项目中，答辩人负责库存校验接口、幂等保护和异常兜底；配置中心迁移中，答辩人负责后端灰度读取和回滚脚本；报告稳定性治理中，答辩人修复复盘生成失败后的状态展示问题。",
  "关键项目一：订单履约体验优化。背景是用户在高峰期提交订单后偶发状态不一致。目标是降低重复提交和客服工单。技术方案包括请求幂等 key、库存二次校验、失败事件补偿和 API 错误码梳理。结果是重复扣减类问题下降，但第一版没有把边界错误充分透出给前端，导致联调阶段返工两次。",
  "关键项目二：配置中心迁移。背景是老配置散落在多个文件和环境变量中，发布时容易漏改。答辩人负责抽象读取层、补充配置校验和回滚脚本。交付证据是迁移 18 个配置项、上线后没有出现配置缺失事故。但候选人对权限审批流程不熟悉，曾经低估了发布时间窗口，导致里程碑延期 2 天。",
  "关键项目三：演练报告稳定性治理。背景是真实 LLM 输出不稳定，报告页有时状态模糊。答辩人补充失败摘要、脱敏校验、短样本提示和 release gate。结果是复盘失败可被用户理解，测试覆盖增加。但对 Review Engine 的 rubric 区分度还没有完全解决，仍需要在模板资产中补质量锚点。",
  "指标变化或交付证据：订单重复提交相关工单从每周 9-12 个降到 3-4 个；配置迁移后发布前人工检查项减少 40%；复盘失败问题从黑盒错误变成可解释状态。证据主要来自工单统计、发布记录和 QA 回归记录，但部分指标周期较短，不能过度外推。",
  "遇到的问题：有一次接口字段定义不清，合作前端在联调时发现枚举语义不一致；一次 QA 回归中发现异常分支缺少日志；一次需求评审中答辩人过早承诺排期，后来需要 Leader 协调优先级。答辩人承认自己在需求澄清、风险预案和跨角色信息同步上还有成长空间。",
  "自我反思和后续计划：答辩人认为自己能独立推进后端任务，但还需要提升负责人意识，尤其是提前识别产品边界、测试风险和上下游联调成本。后续计划包括提前输出接口契约、为异常分支补最小回归、在需求评审中主动提出风险和备选方案。"
].join("\n\n");

const hiddenMaterial = [
  "Leader / 直属负责人：追问负责人意识、成长速度、优先级判断、是否达到转正预期，不要只听项目列表。",
  "后端同事：追问代码质量、模块边界、复杂度、幂等、回滚、可维护性和技术债。",
  "QA 同事：追问测试覆盖、异常路径、缺陷复盘、线上风险和回归策略。",
  "PM / 产品经理：追问业务价值、需求理解、用户影响、指标口径和交付效果。",
  "合作前端：追问接口设计、联调效率、字段边界、变更沟通和沟通成本。",
  "Lowlight 用户如果缺少证据、逃避风险或无法说明真实影响，不能评价为基本达到转正预期。"
].join("\n");

const panel = [
  ["ai_leader", "Leader / 直属负责人", "关注成长、负责人意识、协作和是否达到转正预期。", "负责人意识、成长速度、优先级判断"],
  ["ai_backend_peer", "后端同事", "关注代码质量、架构设计、工程落地和可维护性。", "设计边界、复杂度、可维护性"],
  ["ai_qa", "QA 同事", "关注测试覆盖、线上风险和缺陷复盘。", "质量保障、风险预案、缺陷复盘"],
  ["ai_pm", "PM / 产品经理", "关注业务价值、需求理解、交付效果和用户影响。", "业务价值、需求理解、用户影响"],
  ["ai_frontend_partner", "合作前端", "关注接口协作、联调效率、边界定义和沟通成本。", "接口设计、联调、变更沟通"]
] as const;

const stages = [
  ["opening", "答辩人开场陈述", "答辩人说明试用期目标、关键项目和本次答辩重点。", "ai_leader", "表达问题"],
  ["leader", "Leader 追问", "直属负责人追问负责人意识、成长速度和优先级判断。", "ai_leader", "成长和后续计划"],
  ["backend_peer", "后端同事追问", "后端同事追问设计边界、复杂度和可维护性。", "ai_backend_peer", "技术判断"],
  ["qa", "QA 追问", "QA 追问测试覆盖、风险预案和缺陷复盘。", "ai_qa", "证据不足"],
  ["pm", "PM 追问", "PM 追问业务价值、需求理解和用户影响。", "ai_pm", "真实工作影响"],
  ["frontend", "合作前端追问", "合作前端追问接口协作、联调效率和变更沟通。", "ai_frontend_partner", "协作问题"],
  ["cross", "交叉质疑或补充追问", "评委交叉追问矛盾、风险和不完整证据。", "ai_backend_peer", "技术判断"],
  ["summary", "答辩人总结", "答辩人总结成长、短板和后续计划。", "ai_leader", "成长和后续计划"],
  ["decision", "评委建议与结论", "评委给出建议和本轮观察结论。", "ai_leader", "表达问题"]
] as const;

const buildSteps = (): LinearStep[] => {
  const result: LinearStep[] = [
    {
      id: "user_opening_statement",
      stage_id: "opening",
      actor_id: "user_probation_engineer",
      prompt: "请先完成转正答辩开场陈述，说明试用期目标、关键项目、本次答辩重点、核心证据和你希望评委关注的问题。",
      field: "answer",
      review_tags: ["opening", "probation_answer", "表达问题"]
    }
  ];
  for (const [stageId, title, , actorId, dimension] of stages.filter(([stageId]) => stageId !== "opening")) {
    const roundCount = stageId === "leader" ? 3 : 2;
    for (let round = 1; round <= roundCount; round += 1) {
      const actor = panel.find((item) => item[0] === actorId);
      result.push({
        id: `probe_${stageId}_${round}`,
        stage_id: stageId,
        actor_id: actorId,
        prompt: `请以${actor?.[1] ?? "评委"}身份提出 ${title} 的第 ${round} 个问题。必须基于转正材料、你的独立追问重点（${actor?.[3] ?? "证据和风险"}）和可见历史，避免重复，要求答辩人给出证据、风险和后续动作。question 字段必须输出中文自然语言。`,
        field: "question",
        review_tags: [stageId, "panel_probe", dimension],
        hidden_material: true
      });
      result.push({
        id: `answer_${stageId}_${round}`,
        stage_id: stageId,
        actor_id: "user_probation_engineer",
        prompt: `请回应${title}，说明具体工作、证据、风险、反思和下一步。不要把材料写成完美答案。`,
        field: "answer",
        review_tags: [stageId, "probation_answer", dimension]
      });
    }
  }
  result.push({
    id: "panel_final_recommendation",
    stage_id: "decision",
    actor_id: "ai_leader",
    prompt: "请代表评委组给出本次转正答辩的观察、风险和建议。不得把短样本写成长期稳定能力结论；Lowlight 表现不能被礼貌性高评。summary 字段必须输出中文自然语言。",
    field: "summary",
    review_tags: ["panel_conclusion"],
    hidden_material: true,
    complete: true
  });
  return result;
};

export const createPromotionReviewFixture = (params: PromotionReviewFixtureParams): NormalizedScenarioV1 =>
  createLinearScenario({
    id: "scenario_promotion_review",
    title: "后端转正答辩",
    description: "五位评委围绕试用期后端工程师的转正表现进行结构化答辩。",
    domain: "backend-probation-defense",
    roles: [
      {
        id: "user_probation_engineer",
        kind: "user",
        display_name: "答辩人：后端工程师",
        identity: "你是参加转正答辩的后端工程师。",
        goal: "基于试用期材料说明工作影响、技术判断、协作问题和后续成长计划。",
        behavior_style: "坦诚、结构化、证据导向"
      },
      ...panel.map(([id, displayName, goal]) => ({
        id,
        kind: "ai" as const,
        display_name: displayName,
        identity: displayName,
        goal,
        behavior_style: "职能差异明确、追问具体、基于证据"
      }))
    ],
    stages: stages.map(([id, title, goal]) => ({ id, title, goal })),
    steps: buildSteps(),
    user_visible_material: visibleMaterial(params),
    ai_hidden_material: hiddenMaterial,
    gate1: {
      minimum_effective_user_inputs: 18,
      trajectory_requirements: trajectoryRequirements("后端转正答辩"),
      review_dimensions: ["表达问题", "证据不足", "真实工作影响", "技术判断", "协作问题", "成长和后续计划"]
    },
    constants: {
      max_turns: params.max_turns,
      target_level: params.target_level,
      review_cycle: params.review_cycle,
      impact_focus: params.impact_focus
    },
    resources: {
      promotion_context: {
        target_level: params.target_level,
        review_cycle: params.review_cycle,
        impact_focus: params.impact_focus
      }
    },
    review_dimensions: [
      { id: "expression", title: "表达问题", description: "表达是否结构清晰、回答是否贴合问题。", evidence_tags: ["表达问题"], output_guidance: anchoredGuidance("引用开场、总结或被追问时的表达证据。") },
      { id: "evidence_gap", title: "证据不足", description: "是否缺少指标、事实、边界或复盘证据。", evidence_tags: ["证据不足"], output_guidance: anchoredGuidance("引用 QA 或交叉追问中的证据缺口。") },
      { id: "work_impact", title: "真实工作影响", description: "是否说明业务价值、用户影响和交付结果。", evidence_tags: ["真实工作影响"], output_guidance: anchoredGuidance("引用 PM 追问或项目影响回答。") },
      { id: "technical_judgment", title: "技术判断", description: "是否能说明设计边界、复杂度、风险和可维护性。", evidence_tags: ["技术判断"], output_guidance: anchoredGuidance("引用后端同事或交叉质疑阶段回答。") },
      { id: "collaboration", title: "协作问题", description: "是否能识别接口协作、联调、沟通成本和改进动作。", evidence_tags: ["协作问题"], output_guidance: anchoredGuidance("引用合作前端追问中的具体发言。") },
      { id: "growth_plan", title: "成长和后续计划", description: "是否承认短板并提出可执行成长计划。", evidence_tags: ["成长和后续计划"], output_guidance: anchoredGuidance("引用 Leader 追问和答辩人总结。") }
    ],
    terminal_reason: "后端转正答辩评委建议完成。"
  });

export const promotionReviewFixture = createPromotionReviewFixture({
  target_level: "后端工程师转正",
  review_cycle: "试用期 3 个月",
  impact_focus: "负责人意识、交付质量、协作和后续成长",
  max_turns: 18
});
