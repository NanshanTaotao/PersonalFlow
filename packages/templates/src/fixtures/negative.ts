import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { jobInterviewFixture } from "./job-interview";

const cloneScenario = (scenario: NormalizedScenarioV1): NormalizedScenarioV1 =>
  JSON.parse(JSON.stringify(scenario)) as NormalizedScenarioV1;

const withId = (scenario: NormalizedScenarioV1, id: string): NormalizedScenarioV1 => ({ ...cloneScenario(scenario), id });

const createInvisibleResourceReference = (): NormalizedScenarioV1 => {
  const scenario = withId(jobInterviewFixture, "scenario_negative_invisible_resource");
  scenario.resources = {
    ...scenario.resources,
    private_notes: { content: "hidden calibration notes" }
  };
  scenario.steps = scenario.steps.map((step) =>
    step.id === "ask_opening_1"
      ? {
          ...step,
          id: "ask_sensitive_question",
          args_schema: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1 },
              material_path: { type: "string", minLength: 1 }
            },
            required: ["question", "material_path"],
            additionalProperties: false
          },
          args_ref_paths: ["$.resources.user_visible_material"]
        }
      : step
  );
  scenario.step_order = scenario.step_order.map((stepId) =>
    stepId === "ask_opening_1" ? "ask_sensitive_question" : stepId
  );
  return scenario;
};

const createStateEffectOutsideSchema = (): NormalizedScenarioV1 => {
  const scenario = withId(jobInterviewFixture, "scenario_negative_state_effect_outside_schema");
  scenario.steps = scenario.steps.map((step) =>
    step.id === "answer_opening_1"
      ? {
          ...step,
          state_effects: [{ op: "increment", target_path: "$.state.hidden_counter", amount: 1 }]
        }
      : step
  );
  return scenario;
};

export const negativeFixtures = {
  invalidSelectedStep: withId(jobInterviewFixture, "scenario_negative_invalid_selected_step"),
  invisibleResourceReference: createInvisibleResourceReference(),
  stateVersionConflict: withId(jobInterviewFixture, "scenario_negative_state_version_conflict"),
  stateEffectOutsideSchema: createStateEffectOutsideSchema()
} as const;
