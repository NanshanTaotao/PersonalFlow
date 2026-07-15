import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { anchoredGuidance, createLinearScenario, trajectoryRequirements, type LinearStep } from "./linear-scenario";

export interface JobInterviewFixtureParams {
  readonly target_role: string;
  readonly company_stage: string;
  readonly interview_focus: string;
  readonly max_turns: number;
}

const chineseInterviewInstruction = "请使用中文进行面试；除非候选人明确要求英文，否则所有提问、追问和总结都使用中文。";

const candidateMaterial = (params: JobInterviewFixtureParams): string => [
  `候选人背景：候选人有 6 年后端研发经验，技术栈以 TypeScript、Node.js、Go、PostgreSQL、Redis、消息队列和本地优先产品架构为主，目标岗位是 ${params.target_role}。候选人希望进入 ${params.company_stage} 的团队，重点证明自己能在 POC 到规模化之间补齐工程稳定性、可观测性和跨角色协作。`,
  "简历摘要：候选人近两年负责过 AI 演练产品的 Runtime、Review Engine 和本地数据链路，也参与过老系统向模块化单体迁移。候选人熟悉契约测试、端到端验收、LLM 输出协议、SQLite 本地持久化和前端产品体验闭环，但对大型分布式系统的长期容量规划经验仍不算充分。",
  "项目经历一：PersonalFlow RuntimeIR v3。背景是旧 Runtime 中有面试、晋升、辩论等业务分支，导致流程不可复用。候选人负责把流程抽象为 roles、stages、steps、preconditions、state_effects、visibility 和 terminal_rules，落地后新增复杂场景无需改 Runtime 主流程。技术方案包括 Zod 契约、确定性 replay、Fake LLM 回归和真实 LLM smoke。结果是协议一致性测试通过，场景失败时能定位到 selected_step、visibility 或 state effect 的问题，但仍有阶段编排复杂、长会话 UI 密度过高的问题。",
  "项目经历二：复盘报告与证据链。背景是用户需要会后得到结构化反馈，但不能让 AI 编造能力结论。候选人负责 Review Engine，从 Runtime 事件中抽取带 review_tags 的 evidence，生成带 evidence_refs 的维度观察、关键片段和建议。技术方案包含 prompt 约束、引用校验、短样本置信度、敏感字段过滤和失败摘要兜底。结果是复盘能引用真实发言，不再展示 raw prompt 或 provider raw response，但对 highlight/normal/lowlight 的区分仍依赖 rubric 质量。",
  "线上故障或复杂排查经历：一次真实模型演练中，连接测试失败但实际 AI 回合成功，用户困惑模型到底是否可用。候选人排查后发现连接测试 prompt 对 provider JSON 兼容性要求过窄，而主流程 prompt 更容易被模型满足。候选人补充了业务级失败识别、测试说明和安全观测字段，同时避免把 API key、Authorization、raw request 写入 UI。问题修复后，用户能看到更清晰的失败原因，但仍需要进一步优化测试连接的宽容度。",
  "协作或推进困难案例：在 UI 原型还原阶段，候选人一开始偏工程验收，忽略了用户对 90% 原型相似度、字体、间距和组件质感的要求，导致返工。后来候选人把 personalflow-redesign 作为视觉源码，推动首页、演练页、设置页和场景管理页统一到 hero + card + form 结构，并补充 E2E 与结构测试。这个案例说明候选人在产品审美和用户视角上有成长，但需要更早建立验收口径。",
  "短板或不确定点：候选人对多租户 SaaS、超大规模流量治理、复杂权限系统和成本优化还没有长期主责经验；在强压力下偶尔会先跑自动化而不是先做真实用户体验。候选人希望面试官重点追问 Runtime 可扩展性、Review 证据可靠性、故障排查、代码质量、协作复盘以及如何避免重复提问。",
  "候选人想了解公司的问题：团队如何平衡 AI 产品体验与确定性工程边界？真实 LLM 质量波动时如何设计验收？新成员如何参与高质量代码审查和线上问题复盘？"
].join("\n\n");

const hiddenMaterial = [
  "后端面试官隐藏评分维度：项目深度、系统设计、故障排查、工程习惯、协作沟通、反思能力、候选人反问质量。",
  "项目深度：追问候选人是否能说明背景、职责边界、核心取舍、指标、风险和结果，而不是只复述项目名。",
  "系统设计：追问 RuntimeIR v3、Review Engine、本地存储、LLM adapter、API/Web 边界和可扩展性，观察是否能拆分模块并识别工程取舍。",
  "故障排查：追问连接测试失败但真实 AI 回合成功的证据链、定位步骤、日志边界和修复方式。",
  "工程习惯：追问契约测试、TDD、release gate、敏感信息过滤、回归体验和可维护性。",
  "协作沟通：追问 UI 返工、原型还原、用户反馈处理和跨角色对齐。",
  "反思能力：观察候选人是否承认短板、能否提出下一步验证计划。",
  "候选人反问质量：观察候选人是否能提出团队工程文化、模型质量、验收方式和成长路径相关问题。"
].join("\n");

const stageSpecs = [
  ["opening", "开场和自我介绍", "确认候选人背景、目标岗位和自我介绍。", 2, "project_depth"],
  ["project_depth", "项目经历深挖", "围绕两个后端项目追问职责、方案、指标和结果。", 5, "project_depth"],
  ["system_design", "系统设计或架构取舍", "追问架构边界、状态机、数据流、可扩展性和工程取舍。", 4, "system_design"],
  ["incident", "故障排查与稳定性", "追问线上故障、复杂排查、稳定性和观测。", 3, "incident_debugging"],
  ["engineering", "工程习惯与代码质量", "追问测试、契约、代码质量、安全和发布门禁。", 3, "engineering_habit"],
  ["collaboration", "协作与行为问题", "追问协作冲突、用户反馈、推进方式和复盘。", 3, "collaboration"],
  ["reverse_question", "候选人反问", "观察候选人是否提出高质量反问。", 1, "candidate_question"],
  ["closing", "自然收尾", "收束本轮面试表现、风险和复盘方向。", 1, "reflection"]
] as const;

const questionPrompt = (title: string, tag: string, index: number): string =>
  `${chineseInterviewInstruction} 请提出第 ${index + 1} 个后端面试问题，围绕${title}。必须基于候选人材料、AI 隐藏评分维度和可见历史，避免重复已经问过的问题；轮换覆盖项目深挖、系统设计、工程取舍、故障处理、代码质量、协作沟通、反思能力和候选人反问。不要问脱离材料的泛泛教科书问题。question 字段必须输出中文自然语言。复盘标签：${tag}。`;

const answerPrompt = (title: string): string =>
  `请以候选人身份回答${title}相关问题。回答应尽量包含背景、行动、证据、指标、风险、反思或下一步；如果证据不足，也要明确说明边界。`;

const buildSteps = (): LinearStep[] => {
  const steps: LinearStep[] = [];
  let questionIndex = 0;
  for (const [stageId, title, , count, tag] of stageSpecs) {
    for (let round = 1; round <= count; round += 1) {
      steps.push({
        id: `ask_${stageId}_${round}`,
        stage_id: stageId,
        actor_id: "ai_backend_interviewer",
        prompt: questionPrompt(title, tag, questionIndex),
        field: "question",
        review_tags: [tag, "interviewer_question"],
        hidden_material: true
      });
      steps.push({
        id: `answer_${stageId}_${round}`,
        stage_id: stageId,
        actor_id: "user_candidate",
        prompt: answerPrompt(title),
        field: "answer",
        review_tags: [tag, "candidate_answer"]
      });
      questionIndex += 1;
    }
  }
  steps.push({
    id: "summarize_backend_interview",
    stage_id: "closing",
    actor_id: "ai_backend_interviewer",
    prompt: `${chineseInterviewInstruction} 请总结本次后端面试中观察到的亮点、风险和下一步建议。必须说明这是本次面试观察，不要写成长期稳定能力结论。summary 字段必须输出中文自然语言。`,
    field: "summary",
    review_tags: ["interview_summary"],
    hidden_material: true,
    complete: true
  });
  return steps;
};

export const createJobInterviewFixture = (params: JobInterviewFixtureParams): NormalizedScenarioV1 =>
  createLinearScenario({
    id: "scenario_job_interview",
    title: "求职面试",
    description: "单后端面试官围绕候选人材料进行长流程结构化面试。",
    domain: "backend-interview",
    roles: [
      {
        id: "user_candidate",
        kind: "user",
        display_name: "候选人",
        identity: "你是准备后端岗位面试的候选人。",
        goal: "用真实材料回应追问，证明项目深度、工程判断和反思能力。",
        behavior_style: "具体、诚实、证据导向"
      },
      {
        id: "ai_backend_interviewer",
        kind: "ai",
        display_name: "后端面试官",
        identity: "你是单一后端面试官，需要覆盖完整面试流程。",
        goal: "通过连续追问判断候选人在后端工程、系统设计、稳定性、协作和反思上的本次表现。",
        behavior_style: "专业、追问具体、避免重复、基于材料"
      }
    ],
    stages: stageSpecs.map(([id, title, goal]) => ({ id, title, goal })),
    steps: buildSteps(),
    user_visible_material: candidateMaterial(params),
    ai_hidden_material: hiddenMaterial,
    gate1: {
      minimum_effective_user_inputs: 22,
      trajectory_requirements: trajectoryRequirements("后端面试"),
      review_dimensions: ["项目深度", "系统设计", "故障排查", "工程习惯", "协作沟通", "反思能力", "候选人反问质量"]
    },
    constants: {
      max_turns: params.max_turns,
      target_role: params.target_role,
      company_stage: params.company_stage,
      interview_focus: params.interview_focus
    },
    resources: {
      interview_context: {
        target_role: params.target_role,
        company_stage: params.company_stage,
        interview_focus: params.interview_focus
      }
    },
    review_dimensions: [
      { id: "project_depth", title: "项目深度", description: "是否能说明项目背景、职责、方案、指标和结果。", evidence_tags: ["project_depth"], output_guidance: anchoredGuidance("优先引用项目经历深挖中的用户回答。") },
      { id: "system_design", title: "系统设计", description: "是否能拆解架构、边界、取舍和可扩展性。", evidence_tags: ["system_design"], output_guidance: anchoredGuidance("引用系统设计或架构取舍阶段的回答。") },
      { id: "incident_debugging", title: "故障排查", description: "是否能给出排查路径、证据链、修复和预防。", evidence_tags: ["incident_debugging"], output_guidance: anchoredGuidance("引用故障排查与稳定性阶段的回答。") },
      { id: "engineering_habit", title: "工程习惯", description: "是否体现测试、契约、安全、质量和发布习惯。", evidence_tags: ["engineering_habit"], output_guidance: anchoredGuidance("引用工程习惯与代码质量阶段的回答。") },
      { id: "collaboration", title: "协作沟通", description: "是否能处理冲突、推动对齐并响应用户反馈。", evidence_tags: ["collaboration"], output_guidance: anchoredGuidance("引用协作与行为问题阶段的回答。") },
      { id: "reflection", title: "反思能力", description: "是否承认边界并提出下一步验证或成长计划。", evidence_tags: ["reflection"], output_guidance: anchoredGuidance("引用自然收尾或反思相关回答。") },
      { id: "candidate_question", title: "候选人反问质量", description: "是否能提出与团队、工程文化、模型质量和成长路径相关的反问。", evidence_tags: ["candidate_question"], output_guidance: anchoredGuidance("引用候选人反问阶段的回答。") }
    ],
    terminal_reason: "后端面试完成并自然收尾。"
  });

export const jobInterviewFixture = createJobInterviewFixture({
  target_role: "后端工程师",
  company_stage: "增长期团队",
  interview_focus: "项目主导能力",
  max_turns: 22
});
