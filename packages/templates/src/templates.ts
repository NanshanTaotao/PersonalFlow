import type { JsonObject, JsonValue, NormalizedScenarioV1 } from "@personalflow/contracts";

import { createB2BSalesDiscoveryFixture } from "./fixtures/b2b-sales-discovery";
import { createDebateMatchFixture } from "./fixtures/debate-match";
import { createJobInterviewFixture } from "./fixtures/job-interview";
import { createPromotionReviewFixture } from "./fixtures/promotion-review";
import { createThesisDefenseFixture } from "./fixtures/thesis-defense";

export type BuiltInTemplateId = "job_interview" | "thesis_defense" | "promotion_review" | "debate_match" | "b2b_sales_discovery";
export type TemplateParamType = "string" | "integer";

export interface TemplateParamDefinition {
  readonly type: TemplateParamType;
  readonly label: string;
  readonly description: string;
  readonly default: JsonValue;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface TemplateParamSchema {
  readonly type: "object";
  readonly properties: Record<string, TemplateParamDefinition>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface TemplatePreviewMaterialDefinition {
  readonly label: string;
  readonly param: string;
}

export interface TemplatePreviewMetadata {
  readonly goal_param: string;
  readonly goal_prefix: string;
  readonly goal_suffix?: string;
  readonly user_role: string;
  readonly ai_role: string;
  readonly flow: readonly string[];
  readonly materials: readonly TemplatePreviewMaterialDefinition[];
  readonly review_method: string;
  readonly estimated_duration?: string;
  readonly pressure_level?: string;
  readonly ready_summary?: string;
  readonly notes?: readonly string[];
}

export interface BuiltInTemplateDefinition {
  readonly id: BuiltInTemplateId;
  readonly title: string;
  readonly description: string;
  readonly param_schema: TemplateParamSchema;
  readonly default_params: JsonObject;
  readonly preview_metadata: TemplatePreviewMetadata;
  readonly buildScenario: (params: JsonObject) => NormalizedScenarioV1;
}

const stringParam = (
  label: string,
  description: string,
  defaultValue: string,
  minLength = 1
): TemplateParamDefinition => ({
  type: "string",
  label,
  description,
  default: defaultValue,
  minLength
});

const integerParam = (
  label: string,
  description: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): TemplateParamDefinition => ({
  type: "integer",
  label,
  description,
  default: defaultValue,
  minimum,
  maximum
});

const defineTemplate = (template: BuiltInTemplateDefinition): BuiltInTemplateDefinition => template;

const targetTurnDescription = "系统会围绕这个轮数安排追问并适时收束；你仍可提前结束演练。";

export const builtInTemplates: readonly BuiltInTemplateDefinition[] = [
  defineTemplate({
    id: "job_interview",
    title: "求职面试",
    description: "基于目标岗位和面试重点生成可运行的结构化模拟面试。",
    param_schema: {
      type: "object",
      properties: {
        target_role: stringParam("目标岗位", "准备面试的岗位名称。", "后端工程师"),
        company_stage: stringParam("公司阶段", "面试公司或团队所处阶段。", "增长期团队"),
        interview_focus: stringParam("面试关注点", "本轮模拟重点追问的能力。", "项目主导能力"),
        max_turns: integerParam("建议目标轮次", targetTurnDescription, 22, 22, 22)
      },
      required: ["target_role", "company_stage", "interview_focus", "max_turns"],
      additionalProperties: false
    },
    default_params: {
      target_role: "后端工程师",
      company_stage: "增长期团队",
      interview_focus: "项目主导能力",
      max_turns: 22
    },
    preview_metadata: {
      goal_param: "target_role",
      goal_prefix: "准备",
      goal_suffix: "面试",
      user_role: "候选人",
      ai_role: "后端面试官",
      flow: ["开场和自我介绍", "项目经历深挖", "系统设计或架构取舍", "故障排查与稳定性", "工程习惯与代码质量", "协作与行为问题", "候选人反问", "自然收尾"],
      materials: [
        { label: "公司阶段", param: "company_stage" },
        { label: "面试关注点", param: "interview_focus" }
      ],
      review_method: "按项目深度、系统设计、故障排查、工程习惯、协作沟通、反思和反问质量复盘。",
      estimated_duration: "约 45 分钟",
      pressure_level: "高压：单一后端面试官会连续追问项目细节、技术风险、协作复盘和反问质量。",
      ready_summary: "场景已检查，可以开始模拟面试。",
      notes: ["建议提前准备一段代表性项目经历。", "可以用自然语言回答，后端面试官会按阶段持续追问。"]
    },
    buildScenario: (params) =>
      createJobInterviewFixture({
        target_role: String(params.target_role),
        company_stage: String(params.company_stage),
        interview_focus: String(params.interview_focus),
        max_turns: Number(params.max_turns)
      })
  }),
  defineTemplate({
    id: "thesis_defense",
    title: "论文答辩 / 项目评审",
    description: "基于主题和评审关注点生成可运行的答辩或项目评审场景。",
    param_schema: {
      type: "object",
      properties: {
        topic: stringParam("主题", "论文、方案或项目主题。", "PersonalFlow 运行时确定性"),
        review_context: stringParam("评审背景", "答辩或评审发生的上下文。", "项目评审"),
        panel_focus: stringParam("追问重点", "评审最关心的证明方向。", "证据链与限制说明"),
        max_turns: integerParam("建议目标轮次", targetTurnDescription, 3, 1, 5)
      },
      required: ["topic", "review_context", "panel_focus", "max_turns"],
      additionalProperties: false
    },
    default_params: {
      topic: "PersonalFlow 运行时确定性",
      review_context: "项目评审",
      panel_focus: "证据链与限制说明",
      max_turns: 3
    },
    preview_metadata: {
      goal_param: "topic",
      goal_prefix: "准备答辩：",
      user_role: "答辩人",
      ai_role: "主评审 / 方法评审 / 落地评审",
      flow: ["主评审提出开场问题并明确答辩焦点", "方法评审围绕证据链和方法可靠性追问", "落地评审追问风险、限制和下一步验证", "主评审收束论证强项、遗留限制和复盘依据"],
      materials: [
        { label: "评审背景", param: "review_context" },
        { label: "追问重点", param: "panel_focus" }
      ],
      review_method: "按论点清晰度、证据充分性、限制处理和下一步计划复盘。",
      estimated_duration: "约 20 分钟",
      pressure_level: "高压：多位评审会连续追问证据、风险和落地计划。",
      ready_summary: "场景已检查，可以开始答辩演练。",
      notes: ["建议准备核心论点、证据材料和限制说明。", "可以用自然语言回应，AI 评审会按阶段继续追问。"]
    },
    buildScenario: (params) =>
      createThesisDefenseFixture({
        topic: String(params.topic),
        review_context: String(params.review_context),
        panel_focus: String(params.panel_focus),
        max_turns: Number(params.max_turns)
      })
  }),
  defineTemplate({
    id: "promotion_review",
    title: "后端转正答辩",
    description: "基于试用期材料生成五位评委参与的后端转正答辩。",
    param_schema: {
      type: "object",
      properties: {
        target_level: stringParam("转正目标", "本次转正答辩需要证明的预期。", "后端工程师转正"),
        review_cycle: stringParam("试用期周期", "用于组织证据的试用期周期。", "试用期 3 个月"),
        impact_focus: stringParam("答辩重点", "需要证明的核心影响方向。", "负责人意识、交付质量、协作和后续成长"),
        max_turns: integerParam("建议目标轮次", targetTurnDescription, 18, 18, 18)
      },
      required: ["target_level", "review_cycle", "impact_focus", "max_turns"],
      additionalProperties: false
    },
    default_params: {
      target_level: "后端工程师转正",
      review_cycle: "试用期 3 个月",
      impact_focus: "负责人意识、交付质量、协作和后续成长",
      max_turns: 18
    },
    preview_metadata: {
      goal_param: "target_level",
      goal_prefix: "准备转正答辩：",
      user_role: "答辩人：后端工程师",
      ai_role: "Leader / 直属负责人、后端同事、QA 同事、PM / 产品经理、合作前端",
      flow: ["答辩人开场陈述", "Leader 追问", "后端同事追问", "QA 追问", "PM 追问", "合作前端追问", "交叉质疑或补充追问", "答辩人总结", "评委建议与结论"],
      materials: [
        { label: "绩效周期", param: "review_cycle" },
        { label: "影响力重点", param: "impact_focus" }
      ],
      review_method: "按表达问题、证据不足、真实工作影响、技术判断、协作问题、成长和后续计划复盘。",
      estimated_duration: "约 40 分钟",
      pressure_level: "高压：五位评委会围绕职能差异连续追问不完美信息和转正风险。",
      ready_summary: "场景已检查，可以开始转正答辩演练。",
      notes: ["建议准备试用期关键项目、缺陷复盘、协作摩擦和后续计划。", "真实模型模式可能受网络、额度或配置影响。"]
    },
    buildScenario: (params) =>
      createPromotionReviewFixture({
        target_level: String(params.target_level),
        review_cycle: String(params.review_cycle),
        impact_focus: String(params.impact_focus),
        max_turns: Number(params.max_turns)
      })
  }),
  defineTemplate({
    id: "debate_match",
    title: "辩论赛",
    description: "基于辩题和双方立场生成多角色、多阶段辩论基准演练。",
    param_schema: {
      type: "object",
      properties: {
        topic: stringParam("辩题", "本场辩论围绕的命题。", "AI 工具对职场新人能力提升大于削弱"),
        affirmative_position: stringParam("正方立场", "正方核心主张。", "AI 工具通过低成本练习、反馈显性化和安全试错提升新人能力"),
        negative_position: stringParam("反方立场", "反方核心主张。", "AI 工具容易造成依赖、虚假自信并削弱真实沟通能力"),
        max_rounds: integerParam("建议目标轮次", targetTurnDescription, 16, 16, 16)
      },
      required: ["topic", "affirmative_position", "negative_position", "max_rounds"],
      additionalProperties: false
    },
    default_params: {
      topic: "AI 工具对职场新人能力提升大于削弱",
      affirmative_position: "AI 工具通过低成本练习、反馈显性化和安全试错提升新人能力",
      negative_position: "AI 工具容易造成依赖、虚假自信并削弱真实沟通能力",
      max_rounds: 16
    },
    preview_metadata: {
      goal_param: "topic",
      goal_prefix: "辩论：",
      user_role: "正方二辩",
      ai_role: "主持人 / 主席、正方一辩、正方三辩、反方一辩、反方二辩、反方三辩、评委",
      flow: ["主持人开场", "正方一辩立论", "反方一辩立论", "质询环节", "反方质询正方二辩", "自由辩", "双方总结陈词", "评委点评"],
      materials: [
        { label: "正方立场", param: "affirmative_position" },
        { label: "反方立场", param: "negative_position" }
      ],
      review_method: "按论点抓取、质询质量、反驳有效性、自由辩协作、立场稳定和表达清晰度复盘。",
      estimated_duration: "约 35 分钟",
      pressure_level: "高压：多角色连续攻防，用户必须以正方二辩身份多次参与。",
      ready_summary: "场景已检查，可以开始辩论演练。",
      notes: ["正方二辩由用户扮演，其余角色由 AI 扮演。", "裁判只基于公开发言和允许材料点评。"]
    },
    buildScenario: (params) =>
      createDebateMatchFixture({
        topic: String(params.topic),
        affirmative_position: String(params.affirmative_position),
        negative_position: String(params.negative_position),
        max_rounds: Number(params.max_rounds)
      })
  }),
  defineTemplate({
    id: "b2b_sales_discovery",
    title: "B2B 销售客户发现与异议处理",
    description: "基于产品、目标客户和会议重点生成客户发现、异议处理与下一步推进演练。",
    param_schema: {
      type: "object",
      properties: {
        product_name: stringParam("销售产品", "本次销售会议中的产品或方案名称。", "PersonalFlow 销售赋能方案"),
        target_customer: stringParam("目标客户", "客户行业、规模或业务背景。", "区域连锁服务企业"),
        sales_focus: stringParam("会议重点", "本次会议最需要练习的销售能力。", "客户发现、痛点量化、异议处理和下一步推进"),
        max_turns: integerParam("建议目标轮次", targetTurnDescription, 18, 18, 18)
      },
      required: ["product_name", "target_customer", "sales_focus", "max_turns"],
      additionalProperties: false
    },
    default_params: {
      product_name: "PersonalFlow 销售赋能方案",
      target_customer: "区域连锁服务企业",
      sales_focus: "客户发现、痛点量化、异议处理和下一步推进",
      max_turns: 18
    },
    preview_metadata: {
      goal_param: "target_customer",
      goal_prefix: "客户发现：",
      user_role: "销售 / 解决方案顾问",
      ai_role: "客户业务负责人、客户技术负责人、采购 / 财务负责人、一线使用者 / 业务运营、客户内部反对者",
      flow: ["开场与客户背景确认", "需求发现", "痛点量化", "方案匹配", "预算异议", "安全或集成异议", "替换成本或组织阻力", "价值确认", "推进下一步或识别失败原因"],
      materials: [
        { label: "销售产品", param: "product_name" },
        { label: "会议重点", param: "sales_focus" }
      ],
      review_method: "按发现问题能力、提问质量、痛点量化、价值表达、异议处理、推进节奏和下一步清晰度复盘。",
      estimated_duration: "约 40 分钟",
      pressure_level: "高压：客户多角色有保留，不会主动透露完整需求。",
      ready_summary: "场景已检查，可以开始客户发现与异议处理演练。",
      notes: ["建议先阅读销售材料，再按客户节奏发现需求，不要过早推销。", "目标是推进明确下一步，或识别失败原因。"]
    },
    buildScenario: (params) =>
      createB2BSalesDiscoveryFixture({
        product_name: String(params.product_name),
        target_customer: String(params.target_customer),
        sales_focus: String(params.sales_focus),
        max_turns: Number(params.max_turns)
      })
  })
] as const;

export const findBuiltInTemplate = (templateId: string): BuiltInTemplateDefinition | null =>
  builtInTemplates.find((template) => template.id === templateId) ?? null;
