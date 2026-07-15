import type { NormalizedScenarioV1, ProductSession, RuntimeEvent, SessionView } from "@personalflow/contracts";

import type { ProductApiContext } from "./context";

const suggestedDurationLabel = (scenario: NormalizedScenarioV1): string | undefined => {
  const maxTurns = scenario.constants.max_turns;
  if (typeof maxTurns !== "number" || !Number.isFinite(maxTurns)) {
    return undefined;
  }
  return `建议约 ${Math.max(15, Math.round(maxTurns * 2.25))} 分钟`;
};

export const productSessionDto = async (
  context: ProductApiContext,
  view: SessionView,
  input: {
    readonly scenario?: NormalizedScenarioV1;
    readonly events?: readonly RuntimeEvent[];
  } = {}
): Promise<ProductSession> => {
  const events = input.events ?? await context.runtime.listEvents(view.session_id);
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1] ?? firstEvent;
  const scenario = input.scenario ?? await context.runtime.getScenario(view.session_id);
  const suggested = suggestedDurationLabel(scenario);

  return {
    id: view.session_id,
    scenario_id: view.scenario_id,
    status: view.status,
    ...(firstEvent === undefined || lastEvent === undefined
      ? {}
      : {
          timing: {
            started_at: firstEvent.created_at,
            updated_at: lastEvent.created_at,
            ...(suggested === undefined ? {} : { suggested_duration_label: suggested })
          }
        }),
    view
  };
};
