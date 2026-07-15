import type {
  ApiErrorCode,
  JsonObject,
  NormalizedScenarioV1,
  RuntimeEvent,
  RuntimeStoreContext,
  SessionStatus,
  SessionView
} from "@personalflow/contracts";

import { RuntimeConflictError, RuntimeValidationError } from "./errors";
import type { RuntimeToolResult } from "./tool-broker";
import { jsonEqual } from "./state";
import { projectSessionView } from "./view-projector";

interface CommitBaseInput {
  readonly stores: RuntimeStoreContext;
  readonly sessionId: string;
  readonly scenario: NormalizedScenarioV1;
  readonly events: readonly RuntimeEvent[];
}

interface CommitStepInput extends CommitBaseInput {
  readonly actorId: string;
  readonly stepId: string;
  readonly args: JsonObject;
  readonly state: JsonObject;
  readonly nextState: JsonObject;
  readonly stateVersion: number;
  readonly status: SessionStatus;
}

interface CommitFailedAttemptInput extends CommitBaseInput {
  readonly actorId: string;
  readonly stepId: string;
  readonly state: JsonObject;
  readonly stateVersion: number;
  readonly status: SessionStatus;
  readonly reason: string;
}

interface CommitRuntimeCommandInput extends CommitBaseInput {
  readonly command: "pause_session" | "resume_session" | "end_session";
  readonly state: JsonObject;
  readonly stateVersion: number;
  readonly status: SessionStatus;
  readonly nextStatus: SessionStatus;
  readonly args: JsonObject;
}

interface CommitToolCallInput extends CommitBaseInput {
  readonly actorId: string;
  readonly stageId: string;
  readonly toolId: string;
  readonly request: JsonObject;
  readonly result: RuntimeToolResult;
  readonly state: JsonObject;
  readonly stateVersion: number;
  readonly status: SessionStatus;
}

interface CommitToolFailureInput extends CommitBaseInput {
  readonly actorId: string;
  readonly stageId: string;
  readonly toolId: string;
  readonly request: JsonObject;
  readonly reason: string;
  readonly errorCode: ApiErrorCode;
  readonly state: JsonObject;
  readonly stateVersion: number;
  readonly status: SessionStatus;
}

type RuntimeBlockedReason = "no_active_stage" | "no_allowed_step" | "runtime_limit_exceeded";

interface CommitRuntimeBlockedInput extends CommitBaseInput {
  readonly reason: RuntimeBlockedReason;
  readonly stageId?: string;
  readonly diagnostics: readonly string[];
  readonly state: JsonObject;
  readonly stateVersion: number;
}

const eventId = (sessionId: string, sequence: number, type: RuntimeEvent["type"]): string =>
  `${sessionId}:${sequence}:${type}`;

const sameBlockedKey = (
  event: RuntimeEvent,
  input: Pick<CommitRuntimeBlockedInput, "sessionId" | "stateVersion" | "reason" | "stageId">
): boolean =>
  event.type === "RuntimeBlockedCommitted" &&
  event.session_id === input.sessionId &&
  event.state_version_before === input.stateVersion &&
  event.payload.reason === input.reason &&
  (event.payload.stage_id ?? null) === (input.stageId ?? null);

const normalizeDiagnostics = (diagnostics: readonly string[]): string[] => {
  const normalized = diagnostics.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length === 0 ? ["Runtime blocked by runtime enforcement."] : normalized;
};

export class CommitService {
  private readonly now: (() => string) | undefined;

  constructor({ now }: { readonly now?: () => string } = {}) {
    this.now = now;
  }

  private eventCreatedAt(sequence: number): string {
    return this.now?.() ?? `runtime-sequence-${sequence}`;
  }

  async commitSessionStarted(
    stores: RuntimeStoreContext,
    sessionId: string,
    scenario: NormalizedScenarioV1
  ): Promise<SessionView> {
    const event: RuntimeEvent = {
      id: eventId(sessionId, 0, "SessionStarted"),
      session_id: sessionId,
      sequence: 0,
      state_version_before: 0,
      state_version_after: 0,
      created_at: this.eventCreatedAt(0),
      type: "SessionStarted",
      payload: {
        scenario_id: scenario.id,
        initial_state: scenario.initial_state
      }
    };
    await stores.events.append(event);

    const view = projectSessionView({
      sessionId,
      scenario,
      status: "running",
      stateVersion: 0,
      state: scenario.initial_state,
      events: [event]
    });

    await stores.sessions.create({
      session_id: sessionId,
      scenario_id: scenario.id,
      status: view.status,
      state_version: view.state_version,
      scenario,
      view
    });

    return view;
  }

  async commitStep(input: CommitStepInput): Promise<SessionView> {
    await this.assertCurrentVersion(input.stores, input.sessionId, input.stateVersion);
    const sequence = input.events.length;
    const nextVersion = jsonEqual(input.state, input.nextState) ? input.stateVersion : input.stateVersion + 1;
    const event: RuntimeEvent = {
      id: eventId(input.sessionId, sequence, "StepCommitted"),
      session_id: input.sessionId,
      sequence,
      state_version_before: input.stateVersion,
      state_version_after: nextVersion,
      created_at: this.eventCreatedAt(sequence),
      type: "StepCommitted",
      payload: {
        step_id: input.stepId,
        actor_id: input.actorId,
        args: input.args,
        state_patch: input.nextState
      }
    };

    await input.stores.events.append(event);
    const nextEvents = [...input.events, event];
    const view = projectSessionView({
      sessionId: input.sessionId,
      scenario: input.scenario,
      status: input.status,
      stateVersion: nextVersion,
      state: input.nextState,
      events: nextEvents
    });
    return input.stores.sessions.saveView(view);
  }

  async commitFailedAttempt(input: CommitFailedAttemptInput): Promise<SessionView> {
    const sequence = input.events.length;
    const event: RuntimeEvent = {
      id: eventId(input.sessionId, sequence, "StepAttemptFailed"),
      session_id: input.sessionId,
      sequence,
      state_version_before: input.stateVersion,
      state_version_after: input.stateVersion,
      created_at: this.eventCreatedAt(sequence),
      type: "StepAttemptFailed",
      payload: {
        step_id: input.stepId,
        actor_id: input.actorId,
        reason: input.reason,
        error_code: "validation_error"
      }
    };

    await input.stores.events.append(event);
    const view = projectSessionView({
      sessionId: input.sessionId,
      scenario: input.scenario,
      status: input.status,
      stateVersion: input.stateVersion,
      state: input.state,
      events: [...input.events, event]
    });
    return input.stores.sessions.saveView(view);
  }

  async commitRuntimeCommand(input: CommitRuntimeCommandInput): Promise<SessionView> {
    await this.assertCurrentVersion(input.stores, input.sessionId, input.stateVersion);
    const sequence = input.events.length;
    const event: RuntimeEvent = {
      id: eventId(input.sessionId, sequence, "RuntimeCommandCommitted"),
      session_id: input.sessionId,
      sequence,
      state_version_before: input.stateVersion,
      state_version_after: input.stateVersion,
      created_at: this.eventCreatedAt(sequence),
      type: "RuntimeCommandCommitted",
      payload: {
        command: input.command,
        args: input.args
      }
    };

    await input.stores.events.append(event);
    const view = projectSessionView({
      sessionId: input.sessionId,
      scenario: input.scenario,
      status: input.nextStatus,
      stateVersion: input.stateVersion,
      state: input.state,
      events: [...input.events, event]
    });
    return input.stores.sessions.saveView(view);
  }

  async commitToolCall(input: CommitToolCallInput): Promise<SessionView> {
    await this.assertCurrentVersion(input.stores, input.sessionId, input.stateVersion);
    const sequence = input.events.length;
    const event: RuntimeEvent = {
      id: eventId(input.sessionId, sequence, "ToolCallCommitted"),
      session_id: input.sessionId,
      sequence,
      state_version_before: input.stateVersion,
      state_version_after: input.stateVersion,
      created_at: this.eventCreatedAt(sequence),
      type: "ToolCallCommitted",
      payload: {
        actor_id: input.actorId,
        stage_id: input.stageId,
        tool_id: input.toolId,
        request: input.request,
        result: input.result
      }
    };
    await input.stores.events.append(event);
    const view = projectSessionView({
      sessionId: input.sessionId,
      scenario: input.scenario,
      status: input.status,
      stateVersion: input.stateVersion,
      state: input.state,
      events: [...input.events, event]
    });
    return input.stores.sessions.saveView(view);
  }

  async commitToolFailure(input: CommitToolFailureInput): Promise<SessionView> {
    await this.assertCurrentVersion(input.stores, input.sessionId, input.stateVersion);
    const sequence = input.events.length;
    const event: RuntimeEvent = {
      id: eventId(input.sessionId, sequence, "ToolCallFailed"),
      session_id: input.sessionId,
      sequence,
      state_version_before: input.stateVersion,
      state_version_after: input.stateVersion,
      created_at: this.eventCreatedAt(sequence),
      type: "ToolCallFailed",
      payload: {
        actor_id: input.actorId,
        stage_id: input.stageId,
        tool_id: input.toolId,
        request: input.request,
        reason: input.reason,
        error_code: input.errorCode
      }
    };
    await input.stores.events.append(event);
    const view = projectSessionView({
      sessionId: input.sessionId,
      scenario: input.scenario,
      status: input.status,
      stateVersion: input.stateVersion,
      state: input.state,
      events: [...input.events, event]
    });
    return input.stores.sessions.saveView(view);
  }

  async commitRuntimeBlocked(input: CommitRuntimeBlockedInput): Promise<SessionView> {
    await this.assertCurrentVersion(input.stores, input.sessionId, input.stateVersion);
    const existing = input.events.find((event) => sameBlockedKey(event, input));
    if (existing !== undefined) {
      const view = projectSessionView({
        sessionId: input.sessionId,
        scenario: input.scenario,
        status: "blocked",
        stateVersion: input.stateVersion,
        state: input.state,
        events: input.events
      });
      return input.stores.sessions.saveView(view);
    }

    const sequence = input.events.length;
    const event: RuntimeEvent = {
      id: eventId(input.sessionId, sequence, "RuntimeBlockedCommitted"),
      session_id: input.sessionId,
      sequence,
      state_version_before: input.stateVersion,
      state_version_after: input.stateVersion,
      created_at: this.eventCreatedAt(sequence),
      type: "RuntimeBlockedCommitted",
      payload: {
        reason: input.reason,
        ...(input.stageId === undefined ? {} : { stage_id: input.stageId }),
        diagnostics: normalizeDiagnostics(input.diagnostics)
      }
    };

    await input.stores.events.append(event);
    const view = projectSessionView({
      sessionId: input.sessionId,
      scenario: input.scenario,
      status: "blocked",
      stateVersion: input.stateVersion,
      state: input.state,
      events: [...input.events, event]
    });
    return input.stores.sessions.saveView(view);
  }

  private async assertCurrentVersion(
    stores: RuntimeStoreContext,
    sessionId: string,
    expectedStateVersion: number
  ): Promise<void> {
    const current = await stores.sessions.get(sessionId);
    if (current === null) {
      throw new RuntimeValidationError("Session does not exist.");
    }
    if (current.state_version !== expectedStateVersion) {
      throw new RuntimeConflictError("Expected state version is stale.");
    }
  }
}
