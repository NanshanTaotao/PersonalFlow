import type { NormalizedScenarioV1 } from "@personalflow/contracts";
import { legacyScenarioToV2 } from "./legacy-upgrade";

export interface ThesisDefenseFixtureParams {
  readonly topic: string;
  readonly review_context: string;
  readonly panel_focus: string;
  readonly max_turns: number;
}

const chineseOutputGuidance = "请使用中文回复，除非用户明确要求使用其他语言。";
const domainBoundaryGuidance = "追问必须围绕用户给定主题和本场景上下文。可以提出风险、性能、可靠性和落地边界问题；如果引入极端行业或生产场景，必须明确说明这是一个假设，不得当作用户已声明的业务背景。";

export const createThesisDefenseFixture = (params: ThesisDefenseFixtureParams): NormalizedScenarioV1 => legacyScenarioToV2({
  id: "scenario_thesis_defense",
  title: "论文答辩 / 项目评审",
  description: "围绕论文或项目结论、评审背景和追问重点进行模拟答辩。",
  actors: [
    { id: "user_presenter", kind: "user", display_name: "答辩人", description: "解释方案并回应质询。" },
    { id: "ai_chair_reviewer", kind: "ai", display_name: "主评审", description: "控制答辩节奏，先提出开场问题，并在末尾收束关键结论。" },
    { id: "ai_method_reviewer", kind: "ai", display_name: "方法评审", description: "追问证据链、实验设计、论证方法和可复现性。" },
    { id: "ai_impact_reviewer", kind: "ai", display_name: "落地评审", description: "追问局限、风险、应用边界和下一步落地计划。" }
  ],
  resources: {
    project_context: {
      topic: params.topic,
      review_context: params.review_context,
      panel_focus: params.panel_focus
    }
  },
  constants: {
    max_turns: params.max_turns
  },
  state_schema: {
    type: "object",
    properties: {
      response_count: { type: "integer", minimum: 0 },
      panel_stage: { type: "string", enum: ["opening", "evidence", "risk", "summary"] },
      awaiting_response: { type: "boolean" },
      synthesis_complete: { type: "boolean" }
    },
    required: ["response_count", "panel_stage", "awaiting_response", "synthesis_complete"],
    additionalProperties: false
  },
  initial_state: {
    response_count: 0,
    panel_stage: "opening",
    awaiting_response: false,
    synthesis_complete: false
  },
  steps: [
    {
      id: "chair_opening_question",
      actor_id: "ai_chair_reviewer",
      prompt: `Ask one opening defense question that frames the topic, review context, and panel focus. ${domainBoundaryGuidance} ${chineseOutputGuidance}`,
      args_schema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1 }
        },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.project_context", "$.state.response_count", "$.state.panel_stage"],
      preconditions: [
        { op: "eq", path: "$.state.response_count", value: 0 },
        { op: "eq", path: "$.state.awaiting_response", value: false },
        { op: "eq", path: "$.state.synthesis_complete", value: false }
      ],
      state_effects: [
        { op: "set", target_path: "$.state.panel_stage", value: "evidence" },
        { op: "set", target_path: "$.state.awaiting_response", value: true }
      ],
      review_tags: ["opening_question", "panel_question"]
    },
    {
      id: "method_evidence_probe",
      actor_id: "ai_method_reviewer",
      prompt: `Ask a focused follow-up about evidence quality, method design, reproducibility, or proof gaps. ${domainBoundaryGuidance} ${chineseOutputGuidance}`,
      args_schema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1 }
        },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.project_context", "$.state.response_count", "$.state.panel_stage"],
      preconditions: [
        { op: "eq", path: "$.state.response_count", value: 1 },
        { op: "lt", path: "$.state.response_count", value_from: "$.constants.max_turns" },
        { op: "eq", path: "$.state.awaiting_response", value: false },
        { op: "eq", path: "$.state.synthesis_complete", value: false }
      ],
      state_effects: [
        { op: "set", target_path: "$.state.panel_stage", value: "risk" },
        { op: "set", target_path: "$.state.awaiting_response", value: true }
      ],
      review_tags: ["evidence_probe", "method_review"]
    },
    {
      id: "impact_risk_probe",
      actor_id: "ai_impact_reviewer",
      prompt: `Ask a risk or implementation follow-up about limitations, adoption constraints, or next-step validation. ${domainBoundaryGuidance} ${chineseOutputGuidance}`,
      args_schema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1 }
        },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.project_context", "$.state.response_count", "$.state.panel_stage"],
      preconditions: [
        { op: "gte", path: "$.state.response_count", value: 2 },
        { op: "lt", path: "$.state.response_count", value_from: "$.constants.max_turns" },
        { op: "eq", path: "$.state.awaiting_response", value: false },
        { op: "eq", path: "$.state.synthesis_complete", value: false }
      ],
      state_effects: [
        { op: "set", target_path: "$.state.panel_stage", value: "risk" },
        { op: "set", target_path: "$.state.awaiting_response", value: true }
      ],
      review_tags: ["risk_probe", "implementation_review"]
    },
    {
      id: "respond_to_panel_question",
      actor_id: "user_presenter",
      prompt: "请用简洁的论点、证据、限制说明和下一步计划回应。",
      args_schema: {
        type: "object",
        properties: {
          response: { type: "string", minLength: 1 }
        },
        required: ["response"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.project_context", "$.state.response_count", "$.state.panel_stage"],
      preconditions: [
        { op: "lt", path: "$.state.response_count", value_from: "$.constants.max_turns" },
        { op: "eq", path: "$.state.awaiting_response", value: true },
        { op: "eq", path: "$.state.synthesis_complete", value: false }
      ],
      state_effects: [
        { op: "increment", target_path: "$.state.response_count", amount: 1 },
        { op: "set", target_path: "$.state.awaiting_response", value: false }
      ],
      review_tags: ["defense_response", "limitation_handling"]
    },
    {
      id: "chair_synthesis",
      actor_id: "ai_chair_reviewer",
      prompt: `Synthesize the defense by naming the strongest evidence, remaining limitation, and one next validation step. ${domainBoundaryGuidance} ${chineseOutputGuidance}`,
      args_schema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 }
        },
        required: ["summary"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.project_context", "$.state.response_count", "$.state.panel_stage"],
      preconditions: [
        { op: "gte", path: "$.state.response_count", value_from: "$.constants.max_turns" },
        { op: "eq", path: "$.state.awaiting_response", value: false },
        { op: "eq", path: "$.state.synthesis_complete", value: false }
      ],
      state_effects: [
        { op: "set", target_path: "$.state.panel_stage", value: "summary" },
        { op: "set", target_path: "$.state.synthesis_complete", value: true }
      ],
      review_tags: ["defense_synthesis", "panel_summary"]
    }
  ],
  step_order: [
    "chair_opening_question",
    "method_evidence_probe",
    "impact_risk_probe",
    "respond_to_panel_question",
    "chair_synthesis"
  ],
  max_steps: params.max_turns * 2 + 2,
  terminal_rules: [
    {
      id: "terminal_panel_synthesis_complete",
      when: { op: "eq", path: "$.state.synthesis_complete", value: true },
      status: "completed",
      reason: "Panel synthesis completed after configured defense responses."
    }
  ],
  context_profile: {
    visible_state_paths: ["$.state.response_count", "$.state.panel_stage", "$.state.awaiting_response", "$.state.synthesis_complete"],
    visible_resource_paths: ["$.resources.project_context"],
    event_window: 6
  }
});

export const thesisDefenseFixture = createThesisDefenseFixture({
  topic: "PersonalFlow 运行时确定性",
  review_context: "项目评审",
  panel_focus: "证据链与限制说明",
  max_turns: 3
});
