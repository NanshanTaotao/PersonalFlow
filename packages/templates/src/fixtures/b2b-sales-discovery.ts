import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { anchoredGuidance, createLinearScenario, trajectoryRequirements, type LinearStep } from "./linear-scenario";

export interface B2BSalesDiscoveryFixtureParams {
  readonly product_name: string;
  readonly target_customer: string;
  readonly sales_focus: string;
  readonly max_turns: number;
}

const visibleMaterial = (params: B2BSalesDiscoveryFixtureParams): string => [
  `销售产品简介：${params.product_name} 是面向 B2B 客户的流程协同与智能分析平台，帮助企业把客户线索、需求发现、方案推荐、审批流和复盘数据串起来。用户扮演销售 / 解决方案顾问，目标客户是 ${params.target_customer}，本次会议重点是 ${params.sales_focus}。`,
  "产品核心能力：统一线索和客户资料；把客户沟通记录沉淀为结构化需求；提供流程自动化、权限审计、系统集成和数据看板；支持私有化或专属环境部署；提供实施顾问和培训材料。产品不是万能替换方案，落地价值依赖客户现有流程、系统复杂度、数据质量和内部推动人。",
  "目标客户背景：客户所在行业是区域型连锁服务企业，约 2500 名员工，业务覆盖销售、交付、客服和财务。当前流程依赖 CRM、Excel、企业 IM 和部分自研系统。销售线索进入 CRM 后，需求详情散落在群聊和文档里；交付团队常抱怨需求变更太晚；财务关心预算审批周期；一线使用者担心新系统增加录入负担。",
  "已知痛点：销售到交付的信息断层、需求优先级不透明、客户复盘难以沉淀、跨部门审批慢。未知信息包括真实预算、是否已有内部替代方案、技术集成边界、数据安全红线、采购周期、谁是最终决策人，以及一线团队是否愿意迁移。",
  "价格区间和商业模式：标准 SaaS 按席位和模块计费，年费约 30-80 万；专属环境或私有化需要额外实施费用。可以从一个业务线试点开始，8-12 周完成 PoC，但前提是客户明确试点范围、成功指标、数据接口和内部负责人。",
  "已有客户案例或 ROI 假设：相似客户在试点后把销售交接遗漏率降低约 25%，交付前需求确认时间减少约 30%，但这些数字来自客户自报和短周期统计，不能直接承诺给当前客户。更稳妥的做法是和客户共同定义试点指标，例如需求补录率、交接缺陷数、审批时长和一线满意度。",
  "实施周期和安全能力摘要：标准部署 6-8 周，复杂集成 10-12 周。支持 SSO、角色权限、审计日志、数据导出、加密存储和专属环境。需要客户提供系统接口人、业务负责人、安全评审窗口和试点用户名单。",
  "本次会议目标：不要过早推销。先确认客户背景，挖出真实痛点和量化影响，再判断预算、安全、替换成本和组织阻力。理想下一步是约定 60 分钟方案工作坊，客户提供流程样例和系统边界；如果客户没有明确痛点或负责人，则应承认推进失败并说明原因。"
].join("\n\n");

const hiddenMaterial = [
  "客户业务负责人真实关切：想提升销售到交付转化效率，但担心 ROI 不清晰；不会主动说自己被集团要求降本。",
  "客户技术负责人真实关切：担心集成成本、安全审计、稳定性、数据权限和系统替换风险；不会主动提供所有系统边界。",
  "采购 / 财务负责人真实关切：预算有限，担心价格、付款方式、供应商风险和合同周期；只有看到明确价值和试点范围才愿意谈预算。",
  "一线使用者 / 业务运营真实关切：怕增加录入工作量、迁移成本和培训压力；如果销售只讲高层价值，会持续质疑好不好用。",
  "客户内部反对者：持续提出现有方案也能用、切换太麻烦、风险谁负责、失败谁背锅等阻力。",
  "客户不会主动说出的信息：真实预算、最终决策人、现有系统数据质量、历史项目失败原因、安全红线和内部反对者影响力。",
  "愿意进入下一步的条件：用户能问出痛点、量化影响、承认风险、提出低风险试点和清晰下一步。拒绝推进的条件：用户过早推销、忽略一线负担、无法处理安全/预算/替换成本异议。"
].join("\n");

const customers = [
  ["ai_business_owner", "客户业务负责人", "关注业务目标、ROI、上线价值和是否值得推动。", "业务目标、ROI、上线价值"],
  ["ai_tech_owner", "客户技术负责人", "关注集成成本、安全、稳定性、数据权限和系统替换风险。", "集成成本、安全、稳定性、数据权限"],
  ["ai_procurement", "采购 / 财务负责人", "关注预算、价格、付款方式、供应商风险和合同周期。", "预算、价格、供应商风险"],
  ["ai_operator", "一线使用者 / 业务运营", "关注实际好不好用、是否增加工作量、迁移成本和培训成本。", "使用负担、迁移成本、培训成本"],
  ["ai_internal_opponent", "客户内部反对者", "持续提出现有方案也能用、切换太麻烦、风险谁负责等阻力。", "组织阻力、替换成本、失败责任"]
] as const;

const stages = [
  ["opening", "开场与客户背景确认", "确认客户背景、参会角色和会议目标。", "ai_business_owner", "发现问题能力"],
  ["discovery", "需求发现", "通过问题挖出真实流程、利益相关方和未知信息。", "ai_operator", "提问质量"],
  ["quantify", "痛点量化", "推动客户量化痛点、影响和成功指标。", "ai_business_owner", "痛点量化"],
  ["solution_fit", "方案匹配", "把方案能力映射到客户痛点而不是直接堆功能。", "ai_tech_owner", "价值表达"],
  ["budget", "预算异议", "处理预算、价格和采购周期异议。", "ai_procurement", "异议处理"],
  ["security", "安全或集成异议", "处理安全、集成、稳定性和数据权限异议。", "ai_tech_owner", "异议处理"],
  ["replacement", "替换成本或组织阻力", "处理切换成本、一线负担和内部反对者。", "ai_internal_opponent", "异议处理"],
  ["value", "价值确认", "确认价值、试点范围、指标和内部负责人。", "ai_business_owner", "推进节奏"],
  ["next_step", "推进下一步或识别失败原因", "明确下一步，或承认失败并说明原因。", "ai_business_owner", "下一步清晰度"]
] as const;

const buildSteps = (): LinearStep[] => {
  const result: LinearStep[] = [];
  for (const [stageId, title, , actorId, tag] of stages) {
    const customer = customers.find((item) => item[0] === actorId);
    for (let round = 1; round <= 2; round += 1) {
      result.push({
        id: `customer_${stageId}_${round}`,
        stage_id: stageId,
        actor_id: actorId,
        prompt: `请以${customer?.[1] ?? "客户"}身份在 ${title} 阶段回应销售。不要主动把全部需求说出来；根据隐藏关切（${customer?.[3] ?? "真实业务关切"}）保留信息，并通过质疑或有限回答迫使销售继续发现问题。message 字段必须输出中文自然语言。`,
        field: "message",
        review_tags: [stageId, "customer_signal", tag],
        hidden_material: true
      });
      result.push({
        id: `seller_${stageId}_${round}`,
        stage_id: stageId,
        actor_id: "user_sales_consultant",
        prompt: `请以销售 / 解决方案顾问身份回应 ${title} 阶段。优先提问、确认、量化、处理异议或推进下一步，不要过早推销。`,
        field: "response",
        review_tags: [stageId, "seller_response", tag]
      });
    }
  }
  result.push({
    id: "customer_final_decision",
    stage_id: "next_step",
    actor_id: "ai_business_owner",
    prompt: "请代表客户给出是否进入下一步的决定。如果销售发现问题充分、处理异议并明确试点，则同意工作坊；否则说明失败原因。summary 字段必须输出中文自然语言。",
    field: "summary",
    review_tags: ["customer_decision"],
    hidden_material: true,
    complete: true
  });
  return result;
};

export const createB2BSalesDiscoveryFixture = (params: B2BSalesDiscoveryFixtureParams): NormalizedScenarioV1 =>
  createLinearScenario({
    id: "scenario_b2b_sales_discovery",
    title: "B2B 销售客户发现与异议处理",
    description: "多客户角色围绕需求发现、痛点量化、异议处理和下一步推进进行销售演练。",
    domain: "b2b-sales-discovery",
    roles: [
      {
        id: "user_sales_consultant",
        kind: "user",
        display_name: "销售 / 解决方案顾问",
        identity: "你是负责本次客户发现和异议处理的销售 / 解决方案顾问。",
        goal: "发现真实需求、量化痛点、处理异议并推进明确下一步。",
        behavior_style: "先问后讲、确认边界、价值导向、节奏清晰"
      },
      ...customers.map(([id, displayName, goal]) => ({
        id,
        kind: "ai" as const,
        display_name: displayName,
        identity: displayName,
        goal,
        behavior_style: "真实客户式、有保留、基于关切逐步透露信息"
      }))
    ],
    stages: stages.map(([id, title, goal]) => ({ id, title, goal })),
    steps: buildSteps(),
    user_visible_material: visibleMaterial(params),
    ai_hidden_material: hiddenMaterial,
    gate1: {
      minimum_effective_user_inputs: 18,
      trajectory_requirements: trajectoryRequirements("B2B 销售客户发现与异议处理"),
      review_dimensions: ["发现问题能力", "提问质量", "痛点量化", "价值表达", "异议处理", "推进节奏", "下一步清晰度"]
    },
    constants: {
      max_turns: params.max_turns,
      product_name: params.product_name,
      target_customer: params.target_customer,
      sales_focus: params.sales_focus
    },
    resources: {
      sales_context: {
        product_name: params.product_name,
        target_customer: params.target_customer,
        sales_focus: params.sales_focus
      }
    },
    review_dimensions: [
      { id: "problem_discovery", title: "发现问题能力", description: "是否发现客户背景、利益相关方和未知信息。", evidence_tags: ["发现问题能力"], output_guidance: anchoredGuidance("引用开场或需求发现阶段的提问与确认。") },
      { id: "question_quality", title: "提问质量", description: "问题是否开放、递进、能挖出客户保留信息。", evidence_tags: ["提问质量"], output_guidance: anchoredGuidance("引用用户的关键发现问题。") },
      { id: "pain_quantification", title: "痛点量化", description: "是否推动客户把痛点转成影响、指标或成本。", evidence_tags: ["痛点量化"], output_guidance: anchoredGuidance("引用痛点量化阶段的发言。") },
      { id: "value_expression", title: "价值表达", description: "是否把方案能力映射到客户痛点，而不是堆功能。", evidence_tags: ["价值表达"], output_guidance: anchoredGuidance("引用方案匹配或价值确认阶段。") },
      { id: "objection_handling", title: "异议处理", description: "是否处理预算、安全、集成、替换成本和组织阻力。", evidence_tags: ["异议处理"], output_guidance: anchoredGuidance("引用预算、安全或替换成本异议处理。") },
      { id: "progress_rhythm", title: "推进节奏", description: "是否在发现充分后推进，而不是过早推销或拖延。", evidence_tags: ["推进节奏"], output_guidance: anchoredGuidance("引用价值确认和节奏控制证据。") },
      { id: "next_step", title: "下一步清晰度", description: "是否明确下一步、参与人、材料、时间和成功指标。", evidence_tags: ["下一步清晰度"], output_guidance: anchoredGuidance("引用最终下一步或失败原因。") }
    ],
    terminal_reason: "B2B 销售客户发现会议完成。"
  });

export const b2bSalesDiscoveryFixture = createB2BSalesDiscoveryFixture({
  product_name: "PersonalFlow 销售赋能方案",
  target_customer: "区域连锁服务企业",
  sales_focus: "客户发现、痛点量化、异议处理和下一步推进",
  max_turns: 18
});
