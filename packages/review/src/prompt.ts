import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import type { ReviewEvidenceItem } from "./evidence";

export interface RenderReviewPromptInput {
  readonly session_id: string;
  readonly scenario: NormalizedScenarioV1;
  readonly evidence: readonly ReviewEvidenceItem[];
}

const chineseOutputGuidance = "请使用中文回复，除非用户明确要求使用其他语言。";
const containsCjk = (value: string): boolean => /[\u3400-\u9fff]/.test(value);

export const renderReviewPrompt = ({ session_id, scenario, evidence }: RenderReviewPromptInput): string => {
  const safeScenario = {
    session_id,
    scenario_id: scenario.id,
    title: scenario.title,
    roles: scenario.roles.map((role) => ({ id: role.id, kind: role.kind, display_name: role.display_name }))
  };
  const safeRubric = scenario.review_rubric.dimensions.map((dimension) => ({
    id: dimension.id,
    title: dimension.title,
    description: dimension.description,
    evidence_tags: dimension.evidence_tags,
    evidence_requirement: dimension.evidence_requirement,
    output_guidance: dimension.output_guidance
  }));
  const schemaExample = {
    summary: "One concise evidence-based review summary.",
    dimensions: [
      {
        name: "ownership",
        conclusion: "Clear ownership signal grounded in the cited event.",
        evidence_refs: [
          {
            session_id,
            event_id: "event-id-from-evidence",
            sequence: 1,
            step_id: "step-id-from-evidence",
            actor_id: "actor-id-from-evidence"
          }
        ]
      }
    ],
    key_moments: [
      {
        title: "Specific observed moment",
        description: "Describe what happened and why it mattered.",
        evidence_ref: {
          session_id,
          event_id: "event-id-from-evidence",
          sequence: 1,
          step_id: "step-id-from-evidence",
          actor_id: "actor-id-from-evidence"
        }
      }
    ],
    recommendations: [
      {
        text: "Give one actionable recommendation.",
        evidence_refs: [
          {
            session_id,
            event_id: "event-id-from-evidence",
            sequence: 1,
            step_id: "step-id-from-evidence",
            actor_id: "actor-id-from-evidence"
          }
        ]
      }
    ],
    evidence_refs: [
      {
        session_id,
        event_id: "event-id-from-evidence",
        sequence: 1,
        step_id: "step-id-from-evidence",
        actor_id: "actor-id-from-evidence"
      }
    ],
    uncertainty_notes: ["State one limitation or uncertainty as a string array item."]
  };
  return [
    "You are generating an evidence-based PersonalFlow review.",
    ...(containsCjk(scenario.title) ? [chineseOutputGuidance] : []),
    "Return strict JSON: one JSON object only. Do not wrap JSON in markdown, do not add prose, and do not add extra top-level fields.",
    "The response must be directly parseable as application/json with a top-level object.",
    "Every dimension, key moment, recommendation, and top-level evidence_refs entry must use refs from the evidence list.",
    "Every dimension name must match one rubric dimension id or title.",
    "Do not infer stable ability, hiring suitability, promotion readiness, or long-term performance from a short practice transcript.",
    "If the evidence has fewer than 8 user answers, phrase conclusions as observations from this session only.",
    "Do not estimate or state the total number of user answers in summary, recommendations, or uncertainty_notes; the application will display deterministic evidence_summary counts.",
    "Do not write short-sample limitations when the evidence contains 8 or more user answers.",
    "Do not introduce facts that are not present in EVIDENCE_JSON. External scenarios must be framed as recommendations or hypotheticals.",
    ...(containsCjk(scenario.title) ? ["不能从短轮次 transcript 推断稳定能力、录用适配度、晋升准备度或长期表现。少于 8 条用户回答时，只能表述为本次演练中的观察。不得自行估算或书写用户回答总数；回答数量由系统 evidence_summary 展示。8 条及以上用户回答时，不要写短样本或样本较短限制。不得把 EVIDENCE_JSON 中不存在的事实写成既成事实；外部场景必须表述为假设或建议。"] : []),
    "Required top-level fields: summary, dimensions, key_moments, recommendations, evidence_refs, uncertainty_notes.",
    "Required nested fields: dimensions[].name, dimensions[].conclusion, dimensions[].evidence_refs; key_moments[].title, key_moments[].description, key_moments[].evidence_ref; recommendations[].text plus recommendations[].evidence_refs or recommendations[].uncertainty_note.",
    "Do not use refs, evaluation, or impact as output field names.",
    "OUTPUT_SCHEMA_EXAMPLE_START",
    JSON.stringify(schemaExample, null, 2),
    "OUTPUT_SCHEMA_EXAMPLE_END",
    "SCENARIO_JSON_START",
    JSON.stringify(safeScenario, null, 2),
    "SCENARIO_JSON_END",
    "RUBRIC_JSON_START",
    JSON.stringify(safeRubric, null, 2),
    "RUBRIC_JSON_END",
    "EVIDENCE_JSON_START",
    JSON.stringify(evidence, null, 2),
    "EVIDENCE_JSON_END"
  ].join("\n");
};
