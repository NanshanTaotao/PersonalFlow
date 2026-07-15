import type { NormalizedScenarioV1 } from "@personalflow/contracts";
import { legacyScenarioToV2 } from "../fixtures/legacy-upgrade";

export const jobInterviewSmokeFixture: NormalizedScenarioV1 = legacyScenarioToV2({
  id: "scenario_job_interview_smoke",
  title: "Job interview smoke",
  description: "Minimal hand-written scenario for runtime smoke validation.",
  actors: [
    { id: "user_candidate", kind: "user", display_name: "Candidate" },
    { id: "ai_interviewer", kind: "ai", display_name: "Interviewer" }
  ],
  resources: {
    interview_context: {
      role: "后端工程师",
      focus: "过往项目主导能力"
    }
  },
  constants: {
    max_turns: 2
  },
  state_schema: {
    type: "object",
    properties: {
      turn_count: { type: "integer", minimum: 0 }
    },
    required: ["turn_count"],
    additionalProperties: false
  },
  initial_state: {
    turn_count: 0
  },
  steps: [
    {
      id: "answer_question",
      actor_id: "user_candidate",
      prompt: "Answer the interviewer's current question with one concrete example.",
      args_schema: {
        type: "object",
        properties: {
          answer: { type: "string", minLength: 1 }
        },
        required: ["answer"],
        additionalProperties: false
      },
      args_ref_paths: ["$.state.turn_count"],
      preconditions: [{ op: "lt", path: "$.state.turn_count", value_from: "$.constants.max_turns" }],
      state_effects: [{ op: "increment", target_path: "$.state.turn_count", amount: 1 }],
      review_tags: ["candidate_answer"]
    },
    {
      id: "ask_question",
      actor_id: "ai_interviewer",
      prompt: "Ask one concise job interview question.",
      args_schema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1 }
        },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.interview_context", "$.state.turn_count"],
      preconditions: [{ op: "lt", path: "$.state.turn_count", value_from: "$.constants.max_turns" }],
      state_effects: [],
      review_tags: ["interviewer_question"]
    }
  ],
  step_order: ["ask_question", "answer_question"],
  max_steps: 4,
  terminal_rules: [
    {
      id: "terminal_max_turns",
      when: { op: "gte", path: "$.state.turn_count", value_from: "$.constants.max_turns" },
      status: "completed",
      reason: "Reached max_turns."
    }
  ],
  context_profile: {
    visible_state_paths: ["$.state.turn_count"],
    visible_resource_paths: ["$.resources.interview_context"],
    event_window: 4
  }
});
