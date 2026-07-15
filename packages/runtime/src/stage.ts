import type { JsonObject, NormalizedScenarioV1, RuntimeEvent, StageContractV3 } from "@personalflow/contracts";

import { evaluateGuard } from "./guard";

export type ActiveStageResult =
  | { readonly ok: true; readonly stage: StageContractV3 }
  | { readonly ok: false; readonly reason: string };

export const resolveActiveStage = ({
  scenario,
  state,
  events
}: {
  readonly scenario: NormalizedScenarioV1;
  readonly state: JsonObject;
  readonly events: readonly RuntimeEvent[];
}): ActiveStageResult => {
  const actor = scenario.roles[0];
  if (actor === undefined) {
    return { ok: false, reason: "Scenario has no roles." };
  }

  const ordered = [...scenario.stages].sort((left, right) => left.order - right.order);
  for (const stage of ordered) {
    const context = {
      state,
      constants: scenario.constants,
      actor,
      args: {},
      events
    };
    if (evaluateGuard(stage.enter_when, context) && !evaluateGuard(stage.exit_when, context)) {
      return { ok: true, stage };
    }
  }

  return { ok: false, reason: "No active stage matched current state." };
};
