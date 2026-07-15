import type { JsonObject, RuntimeEvent } from "@personalflow/contracts";

import { ReplayStateVersionError } from "./errors";
import { cloneJson, jsonEqual } from "./state";

export interface ReplayResult {
  readonly state: JsonObject;
  readonly state_version: number;
}

export const replayState = (initialState: JsonObject, events: readonly RuntimeEvent[]): ReplayResult => {
  let state = cloneJson(initialState);
  let stateVersion = 0;
  const seenVersions = new Set<number>();

  for (const event of events) {
    if (event.type === "SessionStarted") {
      if (event.state_version_before !== 0 || event.state_version_after !== 0) {
        throw new ReplayStateVersionError("SessionStarted must not advance state version.");
      }
      continue;
    }

    if (event.type === "StepAttemptFailed") {
      if (event.state_version_before !== stateVersion || event.state_version_after !== stateVersion) {
        throw new ReplayStateVersionError("Failed attempts must preserve current state version.");
      }
      continue;
    }

    if (event.type === "RuntimeCommandCommitted") {
      if (event.state_version_before !== stateVersion || event.state_version_after !== stateVersion) {
        throw new ReplayStateVersionError("Runtime commands must preserve committed state version.");
      }
      continue;
    }

    if (event.type === "RuntimeBlockedCommitted") {
      if (event.state_version_before !== stateVersion || event.state_version_after !== stateVersion) {
        throw new ReplayStateVersionError("Runtime blocked events must preserve committed state version.");
      }
      continue;
    }

    if (event.type === "ToolCallCommitted" || event.type === "ToolCallFailed") {
      if (event.state_version_before !== stateVersion || event.state_version_after !== stateVersion) {
        throw new ReplayStateVersionError("Tool calls must preserve committed state version.");
      }
      continue;
    }

    if (event.type === "StepCommitted") {
      if (event.state_version_before !== stateVersion) {
        throw new ReplayStateVersionError("StepCommitted state version has a gap or duplicate.");
      }
      const nextState = cloneJson(event.payload.state_patch);
      const stateChanged = !jsonEqual(nextState, state);
      const expectedVersion = stateChanged ? event.state_version_before + 1 : event.state_version_before;
      if (event.state_version_after !== expectedVersion) {
        throw new ReplayStateVersionError("State patch is inconsistent with event version.");
      }
      if (stateChanged && seenVersions.has(event.state_version_after)) {
        throw new ReplayStateVersionError("StepCommitted state version is duplicated.");
      }
      if (stateChanged) {
        seenVersions.add(event.state_version_after);
      }
      state = nextState;
      stateVersion = event.state_version_after;
    }
  }

  return { state, state_version: stateVersion };
};
