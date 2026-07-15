import type { NormalizedScenarioV1, RuntimeEvent, SessionStatus, SessionView } from "@personalflow/contracts";

import { replayState } from "./replay";
import { evaluateTerminal } from "./terminal";
import { projectSessionView } from "./view-projector";

export interface ProjectForkedSessionViewInput {
  readonly sessionId: string;
  readonly scenario: NormalizedScenarioV1;
  readonly events: readonly RuntimeEvent[];
}

const commandStatus = (events: readonly RuntimeEvent[]): SessionStatus => {
  let status: SessionStatus = "running";
  for (const event of events) {
    if (event.type !== "RuntimeCommandCommitted") {
      continue;
    }
    if (event.payload.command === "pause_session") {
      status = "paused";
    }
    if (event.payload.command === "resume_session") {
      status = "running";
    }
    if (event.payload.command === "end_session") {
      status = "ended";
    }
  }
  return status;
};

const hasBlockedEvent = (events: readonly RuntimeEvent[]): boolean =>
  events.some((event) => event.type === "RuntimeBlockedCommitted");

export const projectForkedSessionView = ({
  sessionId,
  scenario,
  events
}: ProjectForkedSessionViewInput): SessionView => {
  const replayed = replayState(scenario.initial_state, events);
  const lifecycleStatus = commandStatus(events);
  const terminal = lifecycleStatus === "ended" ? null : evaluateTerminal(scenario, replayed.state, events);
  const status: SessionStatus =
    lifecycleStatus === "ended" ? "ended" : terminal?.status ?? (hasBlockedEvent(events) ? "blocked" : lifecycleStatus);

  return projectSessionView({
    sessionId,
    scenario,
    status,
    stateVersion: replayed.state_version,
    state: replayed.state,
    events
  });
};
