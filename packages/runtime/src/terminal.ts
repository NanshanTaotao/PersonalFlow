import type { JsonObject, NormalizedScenarioV1, RuntimeEvent, SessionStatus, TerminalRuleV1 } from "@personalflow/contracts";

import { evaluateGuard } from "./guard";

export interface TerminalResult {
  readonly status: SessionStatus;
  readonly rule: TerminalRuleV1;
}

export const evaluateTerminal = (
  scenario: NormalizedScenarioV1,
  state: JsonObject,
  events: readonly RuntimeEvent[]
): TerminalResult | null => {
  const actor = scenario.roles[0];
  if (actor === undefined) {
    return null;
  }

  for (const rule of scenario.terminal_rules) {
    if (
      evaluateGuard(rule.when, {
        state,
        constants: scenario.constants,
        actor,
        args: {},
        events
      })
    ) {
      return { status: rule.status, rule };
    }
  }

  return null;
};
