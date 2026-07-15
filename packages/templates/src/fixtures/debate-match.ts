import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { anchoredGuidance, createLinearScenario, trajectoryRequirements, type LinearStep } from "./linear-scenario";

export interface DebateMatchConfig {
  readonly topic: string;
  readonly affirmative_position: string;
  readonly negative_position: string;
  readonly max_rounds: number;
}

const visibleMaterial = (config: DebateMatchConfig): string => [
  `辩题：${config.topic}。用户固定扮演正方二辩，不代表整个正方队。正方立场：${config.affirmative_position}。反方立场：${config.negative_position}。`,
  `正方准备卡：正方一辩需要围绕“${config.affirmative_position}”拆出清晰定义、判断标准、主要理由、例子类型和可承认的限制。正方二辩应从反方立论中寻找偷换概念、因果跳跃、证据不足、适用边界过宽或忽略收益的漏洞，并用当前辩题下的具体场景质询。`,
  `反方准备卡：反方一辩需要围绕“${config.negative_position}”拆出清晰反驳框架，优先攻击正方标准不稳、收益被夸大、代价被低估、例子不具代表性或结论外推过度。反方二辩和三辩应持续追问正方证据、边界、长期影响和例外情况。`,
  "攻防提醒：双方都只能围绕当前辩题和当前立场展开，不得引入与辩题无关的模板材料。可以使用常识例子、生活场景、社会影响、个人选择、制度治理、时间成本、机会成本、长期后果等通用论证角度，但必须服务于当前辩题。",
  "论证素材建议：开篇立论要先定义关键词，再说明比较标准，例如影响范围、长期后果、个体选择、社会成本、收益分配和可治理性。质询时不要只问态度题，要问对方标准如何衡量、例子是否代表整体、有没有忽略反例、成本由谁承担、收益是否可持续。自由辩中应持续承接队友发言，先回应上一轮核心攻击，再补充一条新证据或新判断标准。",
  "比赛规则：主持人控制流程；正方一辩和反方一辩先立论；用户作为正方二辩必须参与质询、回应反方质询，并在自由辩中多次发言；双方总结后由评委点评。用户二辩职责是抓住反方漏洞、提出质询、回应攻击、在自由辩中补强队友论证，保持正方立场稳定。",
  "准备提醒：材料不是完整辩词。用户需要根据现场反方观点组织质询和反驳，不能直接背材料。Lowlight 表现包括立场摇摆、只喊口号、错过反方漏洞、答非所问或替反方补强。用户会在正式质询环节开始发言，必须给出真实策略，不得只说“好的”或“继续”。"
].join("\n\n");

const hiddenMaterial = (config: DebateMatchConfig): string => [
  `主持人流程卡：开场必须说明当前辩题“${config.topic}”、用户身份、阶段和发言顺序；在质询、自由辩、总结和评委点评之间自然过渡，不能引入其他辩题材料。`,
  `正方一辩策略：围绕正方立场“${config.affirmative_position}”建立定义、判断标准和三条主线，给正方二辩留下可质询点。`,
  "正方三辩队友策略：自由辩中补位，帮助用户回到正方立场，但不能替用户完成所有二辩职责。",
  `反方一辩攻击策略：围绕反方立场“${config.negative_position}”提出反方开篇立论，重点攻击正方标准、证据、代价和边界。`,
  "反方二辩攻击策略：在质询中压迫正方二辩，要求用户解释正方论证中的漏洞、边界、成本和例外情况。",
  "反方三辩攻击策略：自由辩中持续追问正方证据代表性、长期影响、适用范围和现实执行成本。",
  "评委评分维度：定义、论证、攻防、配合、表达。评委必须指出用户作为正方二辩的质询质量、反驳有效性和立场稳定性。"
].join("\n");

const roles = [
  ["user_affirmative_second", "user", "正方二辩", "你是正方二辩，只代表自己的发言职责。", "参与质询、回应攻击、自由辩补强正方。"],
  ["ai_moderator", "ai", "主持人 / 主席", "你是辩论赛主持人。", "控制流程、宣布阶段、维护发言顺序。"],
  ["ai_affirmative_first", "ai", "正方一辩", "你是用户队友。", "完成开篇立论并为用户留出攻防空间。"],
  ["ai_affirmative_third", "ai", "正方三辩", "你是用户队友。", "在自由辩中协作补强，不替用户包办。"],
  ["ai_negative_first", "ai", "反方一辩", "你是反方一辩。", "提出反方开篇立论。"],
  ["ai_negative_second", "ai", "反方二辩", "你是反方二辩。", "负责质询和主要反驳。"],
  ["ai_negative_third", "ai", "反方三辩", "你是反方三辩。", "负责自由辩攻防和总结前压迫。"],
  ["ai_judge", "ai", "评委", "你是评委。", "最后给出胜负判断、论点质量、攻防表现和表达建议。"]
] as const;

const stages = [
  ["moderator_opening", "主持人开场", "主持人说明辩题、角色和比赛规则。"],
  ["affirmative_opening", "正方一辩立论", "正方一辩提出定义、边界和核心论点。"],
  ["negative_opening", "反方一辩立论", "反方一辩提出主要攻击线。"],
  ["crossfire", "质询环节", "用户作为正方二辩主动质询反方。"],
  ["negative_questions_user", "反方质询正方二辩", "反方二辩质询用户，用户必须回应。"],
  ["free_debate", "自由辩", "双方多轮攻防，用户多次发言并和队友配合。"],
  ["closing", "双方总结陈词", "双方总结核心论点和攻防结果。"],
  ["judge", "评委点评", "评委基于公开发言给出点评。"]
] as const;

const aiField = (id: string): string => {
  if (id.includes("moderator")) return "announcement";
  if (id.includes("question")) return "question";
  if (id.includes("answer")) return "answer";
  if (id.includes("judge")) return "verdict";
  return "speech";
};

const aiStep = (id: string, stage_id: string, actor_id: string, prompt: string, tags: readonly string[]): LinearStep => {
  const field = aiField(id);
  return {
    id,
    stage_id,
    actor_id,
    prompt: `${prompt} 必须保持角色立场，不要变成普通聊天。请基于可见历史和隐藏策略行动，避免重复。${field} 字段必须输出中文自然语言。`,
    field,
    review_tags: [...tags],
    hidden_material: true
  };
};

const userStep = (id: string, stage_id: string, prompt: string, tags: readonly string[]): LinearStep => ({
  id,
  stage_id,
  actor_id: "user_affirmative_second",
  prompt,
  field: "speech",
  review_tags: [...tags, "user_debate"]
});

const buildSteps = (): LinearStep[] => {
  const steps: LinearStep[] = [
    aiStep("moderator_open", "moderator_opening", "ai_moderator", "主持人开场，宣布辩题、用户身份和流程。", ["flow_control"]),
    aiStep("affirmative_first_open", "affirmative_opening", "ai_affirmative_first", "正方一辩立论，给出定义和三条主线。", ["argument_capture", "stance_stability"]),
    aiStep("negative_first_open", "negative_opening", "ai_negative_first", "反方一辩立论，围绕反方立场提出主要攻击线。", ["argument_capture"])
  ];
  for (let index = 1; index <= 5; index += 1) {
    steps.push(userStep(`user_cross_question_${index}`, "crossfire", `作为正方二辩提出第 ${index} 个质询，抓住反方漏洞并要求对方回答。`, ["question_quality", "stance_stability"]));
    steps.push(aiStep(`negative_cross_answer_${index}`, "crossfire", "ai_negative_second", "反方二辩回应用户质询并反击。", ["rebuttal_effectiveness"]));
  }
  for (let index = 1; index <= 3; index += 1) {
    steps.push(aiStep(`negative_question_${index}`, "negative_questions_user", "ai_negative_second", "反方二辩质询正方二辩，压迫其解释正方论证中的漏洞、边界和代价。", ["question_quality"]));
    steps.push(userStep(`user_answer_negative_${index}`, "negative_questions_user", `回应反方第 ${index} 个质询，保持正方立场并给出判断标准和反驳证据。`, ["rebuttal_effectiveness", "stance_stability"]));
  }
  for (let index = 1; index <= 7; index += 1) {
    const partner = index % 2 === 0 ? "ai_affirmative_third" : "ai_negative_third";
    steps.push(aiStep(`free_debate_ai_${index}`, "free_debate", partner, `${partner === "ai_affirmative_third" ? "正方三辩协作补位" : "反方三辩继续压迫"}，推进自由辩攻防。`, ["free_debate_teamwork", "rebuttal_effectiveness"]));
    steps.push(userStep(`user_free_debate_${index}`, "free_debate", `作为正方二辩进行第 ${index} 次自由辩发言，回应上一轮并补强正方论证。`, ["free_debate_teamwork", "rebuttal_effectiveness", "stance_stability"]));
  }
  steps.push(userStep("user_closing_crystallization", "closing", "作为正方二辩补充一段总结前的攻防结晶，明确本方最关键的胜负点。", ["expression_clarity", "stance_stability"]));
  steps.push(aiStep("affirmative_closing", "closing", "ai_affirmative_third", "正方总结陈词，承接用户攻防并收束正方论点。", ["expression_clarity", "stance_stability"]));
  steps.push(aiStep("negative_closing", "closing", "ai_negative_first", "反方总结陈词，收束反方攻击线。", ["argument_capture", "expression_clarity"]));
  steps.push({
    ...aiStep("judge_commentary", "judge", "ai_judge", "评委点评胜负判断、论点质量、攻防表现、用户二辩表现和表达建议。", ["expression_clarity", "question_quality", "rebuttal_effectiveness"]),
    complete: true
  });
  return steps;
};

export const createDebateMatchFixture = (config: DebateMatchConfig): NormalizedScenarioV1 =>
  createLinearScenario({
    id: "scenario_debate_match",
    title: "辩论赛",
    description: "用户固定为正方二辩的多角色强顺序常规辩论赛。",
    domain: "standard-debate",
    roles: roles.map(([id, kind, displayName, identity, goal]) => ({
      id,
      kind,
      display_name: displayName,
      identity,
      goal,
      behavior_style: "辩论式、证据导向、角色边界清晰"
    })),
    stages: stages.map(([id, title, goal]) => ({ id, title, goal })),
    steps: buildSteps(),
    user_visible_material: visibleMaterial(config),
    ai_hidden_material: hiddenMaterial(config),
    gate1: {
      minimum_effective_user_inputs: 16,
      trajectory_requirements: trajectoryRequirements("常规辩论赛"),
      review_dimensions: ["论点抓取", "质询质量", "反驳有效性", "自由辩协作", "立场稳定", "表达清晰度"]
    },
    constants: {
      max_rounds: config.max_rounds,
      topic: config.topic,
      affirmative_position: config.affirmative_position,
      negative_position: config.negative_position
    },
    resources: {
      debate_context: {
        topic: config.topic,
        affirmative_position: config.affirmative_position,
        negative_position: config.negative_position,
        user_role: "正方二辩"
      }
    },
    review_dimensions: [
      { id: "argument_capture", title: "论点抓取", description: "是否抓住双方核心论点和定义边界。", evidence_tags: ["argument_capture"], output_guidance: anchoredGuidance("引用立论、质询或自由辩中抓取论点的发言。") },
      { id: "question_quality", title: "质询质量", description: "质询是否命中反方漏洞并迫使对方回应。", evidence_tags: ["question_quality"], output_guidance: anchoredGuidance("引用用户作为正方二辩的质询。") },
      { id: "rebuttal_effectiveness", title: "反驳有效性", description: "是否正面回应反方关键攻击。", evidence_tags: ["rebuttal_effectiveness"], output_guidance: anchoredGuidance("引用被质询回应或自由辩反驳。") },
      { id: "free_debate_teamwork", title: "自由辩协作", description: "是否与正方队友形成承接和补位。", evidence_tags: ["free_debate_teamwork"], output_guidance: anchoredGuidance("引用自由辩多轮协作证据。") },
      { id: "stance_stability", title: "立场稳定", description: "是否持续维护正方立场并处理让步边界。", evidence_tags: ["stance_stability"], output_guidance: anchoredGuidance("引用用户是否保持正方立场的证据。") },
      { id: "expression_clarity", title: "表达清晰度", description: "表达是否清楚、有层次、易被评委追踪。", evidence_tags: ["expression_clarity"], output_guidance: anchoredGuidance("引用总结或关键发言中的表达结构。") }
    ],
    terminal_reason: "辩论赛评委点评完成。"
  });

export const debateMatchFixture = createDebateMatchFixture({
  topic: "AI 工具对职场新人能力提升大于削弱",
  affirmative_position: "AI 工具通过低成本练习、反馈显性化和安全试错提升新人能力",
  negative_position: "AI 工具容易造成依赖、虚假自信并削弱真实沟通能力",
  max_rounds: 16
});
