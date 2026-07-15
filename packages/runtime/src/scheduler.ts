import type { JsonObject, NormalizedScenarioV1, RoleContractV3, RuntimeEvent, StepContractV3 } from "@personalflow/contracts";

import { evaluateAllGuards } from "./guard";
import { resolveActiveStage } from "./stage";

export interface SchedulerInput {
  readonly scenario: NormalizedScenarioV1;
  readonly state: JsonObject;
  readonly args?: JsonObject;
  readonly events: readonly RuntimeEvent[];
}

export const findActor = (scenario: NormalizedScenarioV1, actorId: string): RoleContractV3 | null =>
  scenario.roles.find((actor) => actor.id === actorId) ?? null;

export const findStep = (scenario: NormalizedScenarioV1, stepId: string): StepContractV3 | null =>
  scenario.steps.find((step) => step.id === stepId) ?? null;

export const resolveAllowedSteps = ({ scenario, state, args = {}, events }: SchedulerInput): StepContractV3[] => {
  const activeStage = resolveActiveStage({ scenario, state, events });
  if (!activeStage.ok) {
    return [];
  }
  const stepOrder = new Map(scenario.step_order.map((stepId, index) => [stepId, index]));
  const activeStageCandidates = scenario.steps.filter((step) => step.stage_id === activeStage.stage.id);

  return activeStageCandidates
    .filter((step) => {
      const actor = findActor(scenario, step.actor_id);
      if (actor === null) {
        return false;
      }
      return evaluateAllGuards(step.preconditions, {
        state,
        constants: scenario.constants,
        actor,
        args,
        events
      });
    })
    .sort(
      (left, right) =>
        (stepOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (stepOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
};
