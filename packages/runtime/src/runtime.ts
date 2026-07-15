import type {
  JsonObject,
  JsonSchemaValue,
  JsonValue,
  NormalizedScenarioV1,
  RuntimeEvent,
  RuntimeSessionRecord,
  RuntimeStoreContext,
  RuntimeUnitOfWork,
  SessionStatus,
  SessionView,
  StepContractV2
} from "@personalflow/contracts";
import { invokeAgentWithRetry, type LLMAdapter, type LLMRequest } from "@personalflow/agent";

import { CommitService } from "./commit-service";
import { buildVisibleContextBundle, type VisibleContextBundle } from "./context";
import { applyStateEffects } from "./effect";
import { RuntimeConflictError, RuntimeValidationError } from "./errors";
import { evaluateAllGuards } from "./guard";
import { findActor, findStep, resolveAllowedSteps } from "./scheduler";
import { renderPrompt } from "./prompt-renderer";
import { resolveActiveStage } from "./stage";
import { cloneJson } from "./state";
import { evaluateTerminal } from "./terminal";
import { defaultRuntimeToolAdapters, type RuntimeToolAdapter } from "./tool-broker";

export interface RuntimeKernelOptions {
  readonly store: RuntimeUnitOfWork;
  readonly commitService?: CommitService;
}

export interface StartSessionInput {
  readonly sessionId: string;
  readonly scenario: NormalizedScenarioV1;
}

export interface StructuredActionInput {
  readonly sessionId: string;
  readonly actorId: string;
  readonly stepId: string;
  readonly args: JsonObject;
  readonly expectedStateVersion: number;
}

export interface UserInputActionInput {
  readonly sessionId: string;
  readonly input: string;
  readonly expectedStateVersion: number;
}

export interface AiTurnInput {
  readonly sessionId: string;
  readonly actorId: string;
  readonly expectedStateVersion: number;
  readonly adapter: LLMAdapter;
  readonly toolAdapters?: readonly RuntimeToolAdapter[];
  readonly maxAttempts?: number;
}

export interface RuntimeCommandInput {
  readonly sessionId: string;
  readonly expectedStateVersion: number;
}

interface LoadedSession {
  readonly record: RuntimeSessionRecord;
  readonly scenario: NormalizedScenarioV1;
  readonly view: SessionView;
  readonly events: RuntimeEvent[];
}

type RuntimeBlockedReason = "no_active_stage" | "no_allowed_step" | "runtime_limit_exceeded";

interface RuntimeBlockDecision {
  readonly reason: RuntimeBlockedReason;
  readonly stageId?: string;
  readonly diagnostics: readonly string[];
}

const isJsonObject = (value: JsonValue | unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const jsonEqual = (left: JsonValue, right: JsonValue): boolean => JSON.stringify(left) === JSON.stringify(right);

const typeOfJson = (value: JsonValue): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  return typeof value;
};

const validateJsonValue = (value: JsonValue, schema: JsonSchemaValue, path: string): string | null => {
  if (schema === true) {
    return null;
  }
  if (schema === false) {
    return path + " is not allowed.";
  }
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    return path + " must equal const.";
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => jsonEqual(item, value))) {
    return path + " must be one of enum values.";
  }
  if (schema.type !== undefined) {
    const actual = typeOfJson(value);
    const matches = schema.type === "number" ? actual === "number" || actual === "integer" : actual === schema.type;
    if (!matches) {
      return path + " must be " + schema.type + ".";
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return path + " is shorter than minLength.";
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return path + " is longer than maxLength.";
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return path + " is less than minimum.";
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return path + " is greater than maximum.";
    }
  }
  if (isJsonObject(value)) {
    const properties = schema.properties ?? {};
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in value)) {
        return path + "." + requiredKey + " is required.";
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) {
          return path + "." + key + " is not allowed.";
        }
        if (typeof schema.additionalProperties === "object") {
          const nested = validateJsonValue(item, schema.additionalProperties, path + "." + key);
          if (nested !== null) {
            return nested;
          }
        }
        continue;
      }
      const nested = validateJsonValue(item, propertySchema, path + "." + key);
      if (nested !== null) {
        return nested;
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item === undefined) {
        continue;
      }
      const nested = validateJsonValue(item, schema.items, path + "[" + String(index) + "]");
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
};

const collectResourceReferences = (value: JsonValue): string[] => {
  if (typeof value === "string") {
    return value.startsWith("$.resources.") || value === "$.resources" ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectResourceReferences(item));
  }
  if (isJsonObject(value)) {
    return Object.values(value).flatMap((item) => collectResourceReferences(item));
  }
  return [];
};

export class RuntimeKernel {
  private readonly store: RuntimeUnitOfWork;
  private readonly commitService: CommitService;

  constructor({ store, commitService = new CommitService() }: RuntimeKernelOptions) {
    this.store = store;
    this.commitService = commitService;
  }

  async startSession(input: StartSessionInput): Promise<SessionView> {
    return this.store.transaction((stores: RuntimeStoreContext) => this.startSessionInStores(stores, input));
  }

  async startSessionInStores(stores: RuntimeStoreContext, input: StartSessionInput): Promise<SessionView> {
    const scenario = cloneJson(input.scenario);
    const view = await this.commitService.commitSessionStarted(stores, input.sessionId, scenario);
    return this.enforceRuntimeBlockedAfterView({
      stores,
      sessionId: input.sessionId,
      scenario,
      view
    });
  }

  async submitStructuredAction(input: StructuredActionInput): Promise<SessionView> {
    return this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, input.sessionId);
      if (loaded.record.state_version !== input.expectedStateVersion) {
        throw new RuntimeConflictError("Expected state version is stale.");
      }
      if (loaded.view.status === "blocked") {
        return cloneJson(loaded.view);
      }

      const terminalBefore = evaluateTerminal(loaded.scenario, loaded.view.state, loaded.events);
      const status = terminalBefore?.status ?? loaded.view.status;
      if (status !== "running") {
        return this.commitService.commitFailedAttempt({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          events: loaded.events,
          actorId: input.actorId,
          stepId: input.stepId,
          state: loaded.view.state,
          stateVersion: loaded.view.state_version,
          status,
          reason: "Session is not running."
        });
      }
      const blocked = await this.enforceRuntimeBlocked({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status
      });
      if (blocked !== null) {
        return blocked;
      }

      const currentAllowedStepIds = this.resolveCurrentAllowedStepIds(loaded);
      const step = findStep(loaded.scenario, input.stepId);
      const actor = findActor(loaded.scenario, input.actorId);
      const failureReason = this.validateAction(
        loaded.scenario,
        step,
        actor?.id ?? input.actorId,
        input.actorId,
        input.args,
        loaded,
        undefined,
        currentAllowedStepIds
      );
      if (failureReason !== null || step === null || actor === null) {
        const failed = await this.commitService.commitFailedAttempt({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          events: loaded.events,
          actorId: input.actorId,
          stepId: input.stepId,
          state: loaded.view.state,
          stateVersion: loaded.view.state_version,
          status: loaded.view.status,
          reason: failureReason ?? "Step or actor is invalid."
        });
        return this.enforceRuntimeBlockedAfterView({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          view: failed
        });
      }

      try {
        const nextState = applyStateEffects(loaded.scenario, loaded.view.state, step.state_effects, {
          state: loaded.view.state,
          constants: loaded.scenario.constants,
          actor,
          args: input.args,
          events: loaded.events
        });
        const terminalAfter = evaluateTerminal(loaded.scenario, nextState, loaded.events);

        const committed = await this.commitService.commitStep({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          events: loaded.events,
          actorId: input.actorId,
          stepId: input.stepId,
          args: input.args,
          state: loaded.view.state,
          nextState,
          stateVersion: loaded.view.state_version,
          status: terminalAfter?.status ?? "running"
        });
        return this.enforceRuntimeBlockedAfterView({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          view: committed
        });
      } catch (error) {
        const failed = await this.commitService.commitFailedAttempt({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          events: loaded.events,
          actorId: input.actorId,
          stepId: input.stepId,
          state: loaded.view.state,
          stateVersion: loaded.view.state_version,
          status: loaded.view.status,
          reason: error instanceof Error ? error.message : "State effects failed."
        });
        return this.enforceRuntimeBlockedAfterView({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          view: failed
        });
      }
    });
  }

  async submitUserInput(input: UserInputActionInput): Promise<SessionView> {
    return this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, input.sessionId);
      if (loaded.record.state_version !== input.expectedStateVersion) {
        throw new RuntimeConflictError("Expected state version is stale.");
      }
      if (loaded.view.status === "blocked") {
        return cloneJson(loaded.view);
      }
      if (loaded.view.status !== "running") {
        throw new RuntimeValidationError("Session is not running.");
      }
      const blocked = await this.enforceRuntimeBlocked({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status: loaded.view.status
      });
      if (blocked !== null) {
        return blocked;
      }
      const humanSteps = resolveAllowedSteps({
        scenario: loaded.scenario,
        state: loaded.view.state,
        events: loaded.events
      }).filter((step) => findActor(loaded.scenario, step.actor_id)?.kind === "user");
      if (humanSteps.length !== 1) {
        throw new RuntimeValidationError("Expected exactly one allowed human step for product input.");
      }
      const step = humanSteps[0];
      const actor = step === undefined ? null : findActor(loaded.scenario, step.actor_id);
      if (step === undefined || actor === null) {
        throw new RuntimeValidationError("Allowed human step is invalid.");
      }
      const args = this.userInputToArgs(step, input.input);
      return this.submitStructuredActionOutsideTransaction({
        stores,
        loaded,
        sessionId: input.sessionId,
        actorId: actor.id,
        stepId: step.id,
        args,
        expectedStateVersion: input.expectedStateVersion
      });
    });
  }

  async runAiTurn(input: AiTurnInput): Promise<SessionView> {
    const prepared = await this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, input.sessionId);
      if (loaded.record.state_version !== input.expectedStateVersion) {
        throw new RuntimeConflictError("Expected state version is stale.");
      }
      if (loaded.view.status === "blocked") {
        return { blockedView: cloneJson(loaded.view) };
      }

      const actor = findActor(loaded.scenario, input.actorId);
      if (actor === null) {
        throw new RuntimeValidationError("Actor does not exist.");
      }
      if (actor.kind !== "ai") {
        throw new RuntimeValidationError("AI turn requires an AI actor.");
      }

      const terminalBefore = evaluateTerminal(loaded.scenario, loaded.view.state, loaded.events);
      const status = terminalBefore?.status ?? loaded.view.status;
      if (status !== "running") {
        throw new RuntimeValidationError("Session is not running.");
      }
      const blocked = await this.enforceRuntimeBlocked({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status
      });
      if (blocked !== null) {
        return { blockedView: blocked };
      }

      const allowedSteps = resolveAllowedSteps({
        scenario: loaded.scenario,
        state: loaded.view.state,
        events: loaded.events
      }).filter((step) => step.actor_id === input.actorId);
      const bundle = buildVisibleContextBundle({
        actorId: input.actorId,
        scenario: loaded.scenario,
        state: loaded.view.state,
        events: loaded.events,
        allowedSteps,
        stateVersion: loaded.view.state_version
      });
      return {
        blockedView: undefined,
        request: this.buildLLMRequest(input.actorId, bundle),
        allowedStepIds: allowedSteps.map((step) => step.id),
        visibleResourcePaths: bundle.visible_materials.map((material) => material.path)
      };
    });

    if (prepared.blockedView !== undefined) {
      return prepared.blockedView;
    }
    if (prepared.request === undefined) {
      throw new RuntimeValidationError("AI turn was not prepared.");
    }
    const preparedRequest = prepared.request;
    const preparedAllowedStepIds = prepared.allowedStepIds ?? [];
    const preparedVisibleResourcePaths = prepared.visibleResourcePaths ?? [];

    const result = await invokeAgentWithRetry({
      adapter: input.adapter,
      request: preparedRequest,
      maxAttempts: input.maxAttempts ?? 2
    });

    if (!result.ok) {
      return this.store.transaction(async (stores: RuntimeStoreContext) => {
        const loaded = await this.loadSession(stores, input.sessionId);
        if (loaded.record.state_version !== input.expectedStateVersion) {
          throw new RuntimeConflictError("Expected state version is stale.");
        }
        if (loaded.view.status === "blocked") {
          return cloneJson(loaded.view);
        }
        const failed = await this.commitService.commitFailedAttempt({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          events: loaded.events,
          actorId: input.actorId,
          stepId: "model_output",
          state: loaded.view.state,
          stateVersion: loaded.view.state_version,
          status: loaded.view.status,
          reason: "Model failed to produce a valid action."
        });
        return this.enforceRuntimeBlockedAfterView({
          stores,
          sessionId: input.sessionId,
          scenario: loaded.scenario,
          view: failed
        });
      });
    }

    const action = result.action;
    if (action.kind === "tool_request") {
      const toolAdapters = input.toolAdapters ?? defaultRuntimeToolAdapters();
      return this.store.transaction(async (stores: RuntimeStoreContext) => {
        const loaded = await this.loadSession(stores, input.sessionId);
        return this.submitToolRequestOutsideTransaction({
          stores,
          loaded,
          sessionId: input.sessionId,
          actorId: input.actorId,
          expectedStateVersion: input.expectedStateVersion,
          toolId: action.selected_tool,
          args: action.args,
          toolAdapters
        });
      });
    }

    return this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, input.sessionId);
      return this.submitStructuredActionOutsideTransaction({
        stores,
        loaded,
        sessionId: input.sessionId,
        actorId: input.actorId,
        stepId: action.selected_step,
        args: action.args,
        expectedStateVersion: input.expectedStateVersion,
        allowedStepIds: preparedAllowedStepIds,
        visibleResourcePaths: preparedVisibleResourcePaths
      });
    });
  }

  private async submitToolRequestOutsideTransaction(input: {
    readonly stores: RuntimeStoreContext;
    readonly loaded: LoadedSession;
    readonly sessionId: string;
    readonly actorId: string;
    readonly expectedStateVersion: number;
    readonly toolId: string;
    readonly args: JsonObject;
    readonly toolAdapters: readonly RuntimeToolAdapter[];
  }): Promise<SessionView> {
    const { stores, loaded } = input;
    if (loaded.record.state_version !== input.expectedStateVersion) {
      throw new RuntimeConflictError("Expected state version is stale.");
    }
    if (loaded.view.status === "blocked") {
      return cloneJson(loaded.view);
    }

    const activeStage = resolveActiveStage({
      scenario: loaded.scenario,
      state: loaded.view.state,
      events: loaded.events
    });
    const stageId = activeStage.ok ? activeStage.stage.id : "unknown_stage";
    const terminalBefore = evaluateTerminal(loaded.scenario, loaded.view.state, loaded.events);
    const status = terminalBefore?.status ?? loaded.view.status;
    const fail = async (reason: string, errorCode: "validation_error" | "permission_error" | "scenario_error") => {
      const failed = await this.commitService.commitToolFailure({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        actorId: input.actorId,
        stageId,
        toolId: input.toolId,
        request: input.args,
        reason,
        errorCode,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status
      });
      return this.enforceRuntimeBlockedAfterView({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        view: failed
      });
    };

    if (status !== "running") {
      return fail("Session is not running.", "validation_error");
    }
    const blocked = await this.enforceRuntimeBlocked({
      stores,
      sessionId: input.sessionId,
      scenario: loaded.scenario,
      events: loaded.events,
      state: loaded.view.state,
      stateVersion: loaded.view.state_version,
      status
    });
    if (blocked !== null) {
      return blocked;
    }
    if (!activeStage.ok) {
      return fail(activeStage.reason, "validation_error");
    }

    const tool = loaded.scenario.tool_policy.tools.find((item) => item.id === input.toolId);
    const grant = loaded.scenario.tool_policy.grants.find(
      (item) => item.role_id === input.actorId && item.stage_id === activeStage.stage.id && item.tool_id === input.toolId
    );
    if (tool === undefined || grant === undefined) {
      return fail("Tool is not granted for this role and stage.", "permission_error");
    }

    const schemaFailure = validateJsonValue(input.args, tool.args_schema, "$.args");
    if (schemaFailure !== null) {
      return fail(schemaFailure, "validation_error");
    }

    const adapter = input.toolAdapters.find((item) => item.id === input.toolId);
    if (adapter === undefined) {
      return fail("Tool adapter is not registered.", "scenario_error");
    }

    try {
      const result = await adapter.execute({ args: input.args, scenario: loaded.scenario });
      const committed = await this.commitService.commitToolCall({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        actorId: input.actorId,
        stageId: activeStage.stage.id,
        toolId: input.toolId,
        request: input.args,
        result,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status
      });
      return this.enforceRuntimeBlockedAfterView({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        view: committed
      });
    } catch {
      return fail("Tool execution failed.", "scenario_error");
    }
  }

  async pauseSession(input: RuntimeCommandInput): Promise<SessionView> {
    return this.commitRuntimeCommand(input, "pause_session", "paused", { action: "pause_session" });
  }

  async resumeSession(input: RuntimeCommandInput): Promise<SessionView> {
    return this.commitRuntimeCommand(input, "resume_session", "running", { action: "resume_session" });
  }

  async endSession(input: RuntimeCommandInput): Promise<SessionView> {
    return this.commitRuntimeCommand(input, "end_session", "ended", { action: "end_session" });
  }

  async getView(sessionId: string): Promise<SessionView> {
    return this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, sessionId);
      return cloneJson(loaded.view);
    });
  }

  async getScenario(sessionId: string): Promise<NormalizedScenarioV1> {
    return this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, sessionId);
      return cloneJson(loaded.scenario);
    });
  }

  async listEvents(sessionId: string): Promise<RuntimeEvent[]> {
    return this.store.transaction(async (stores: RuntimeStoreContext) => stores.events.listBySession(sessionId));
  }

  private async submitStructuredActionOutsideTransaction(
    input: StructuredActionInput & {
      readonly stores: RuntimeStoreContext;
      readonly loaded: LoadedSession;
      readonly allowedStepIds?: readonly string[];
      readonly visibleResourcePaths?: readonly string[];
    }
  ): Promise<SessionView> {
    const { stores, loaded } = input;
    if (loaded.record.state_version !== input.expectedStateVersion) {
      throw new RuntimeConflictError("Expected state version is stale.");
    }
    if (loaded.view.status === "blocked") {
      return cloneJson(loaded.view);
    }

    const terminalBefore = evaluateTerminal(loaded.scenario, loaded.view.state, loaded.events);
    const status = terminalBefore?.status ?? loaded.view.status;
    if (status !== "running") {
      return this.commitService.commitFailedAttempt({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        actorId: input.actorId,
        stepId: input.stepId,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status,
        reason: "Session is not running."
      });
    }
    const blocked = await this.enforceRuntimeBlocked({
      stores,
      sessionId: input.sessionId,
      scenario: loaded.scenario,
      events: loaded.events,
      state: loaded.view.state,
      stateVersion: loaded.view.state_version,
      status
    });
    if (blocked !== null) {
      return blocked;
    }

    const currentAllowedStepIds = this.resolveCurrentAllowedStepIds(loaded);
    const step = findStep(loaded.scenario, input.stepId);
    const actor = findActor(loaded.scenario, input.actorId);
    const failureReason = this.validateAction(
      loaded.scenario,
      step,
      actor?.id ?? input.actorId,
      input.actorId,
      input.args,
      loaded,
      input.visibleResourcePaths,
      currentAllowedStepIds,
      input.allowedStepIds
    );
    if (failureReason !== null || step === null || actor === null) {
      const failed = await this.commitService.commitFailedAttempt({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        actorId: input.actorId,
        stepId: input.stepId,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status: loaded.view.status,
        reason: failureReason ?? "Step or actor is invalid."
      });
      return this.enforceRuntimeBlockedAfterView({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        view: failed
      });
    }

    const nextState = applyStateEffects(loaded.scenario, loaded.view.state, step.state_effects, {
      state: loaded.view.state,
      constants: loaded.scenario.constants,
      actor,
      args: input.args,
      events: loaded.events
    });
    const terminalAfter = evaluateTerminal(loaded.scenario, nextState, loaded.events);
    const committed = await this.commitService.commitStep({
      stores,
      sessionId: input.sessionId,
      scenario: loaded.scenario,
      events: loaded.events,
      actorId: input.actorId,
      stepId: input.stepId,
      args: input.args,
      state: loaded.view.state,
      nextState,
      stateVersion: loaded.view.state_version,
      status: terminalAfter?.status ?? "running"
    });
    return this.enforceRuntimeBlockedAfterView({
      stores,
      sessionId: input.sessionId,
      scenario: loaded.scenario,
      view: committed
    });
  }

  private async commitRuntimeCommand(
    input: RuntimeCommandInput,
    command: "pause_session" | "resume_session" | "end_session",
    nextStatus: SessionStatus,
    args: JsonObject
  ): Promise<SessionView> {
    return this.store.transaction(async (stores: RuntimeStoreContext) => {
      const loaded = await this.loadSession(stores, input.sessionId);
      if (loaded.record.state_version !== input.expectedStateVersion) {
        throw new RuntimeConflictError("Expected state version is stale.");
      }
      const currentStatus = loaded.view.status;
      const validTransition =
        (command === "pause_session" && currentStatus === "running") ||
        (command === "resume_session" && currentStatus === "paused") ||
        (command === "end_session" && (currentStatus === "running" || currentStatus === "paused" || currentStatus === "blocked"));
      if (!validTransition) {
        throw new RuntimeValidationError(`Cannot ${command} when session status is ${currentStatus}.`);
      }
      return this.commitService.commitRuntimeCommand({
        stores,
        sessionId: input.sessionId,
        scenario: loaded.scenario,
        events: loaded.events,
        command,
        state: loaded.view.state,
        stateVersion: loaded.view.state_version,
        status: loaded.view.status,
        nextStatus,
        args
      });
    });
  }

  private async loadSession(
    stores: RuntimeStoreContext,
    sessionId: string
  ): Promise<LoadedSession> {
    const record = await stores.sessions.get(sessionId);
    if (record === null || record.scenario === undefined || record.view === undefined) {
      throw new RuntimeValidationError("Session does not exist.");
    }
    const events = await stores.events.listBySession(sessionId);
    return {
      record,
      scenario: record.scenario,
      view: record.view,
      events
    };
  }

  private async enforceRuntimeBlockedAfterView(input: {
    readonly stores: RuntimeStoreContext;
    readonly sessionId: string;
    readonly scenario: NormalizedScenarioV1;
    readonly view: SessionView;
  }): Promise<SessionView> {
    if (input.view.status !== "running") {
      return input.view;
    }
    const events = await input.stores.events.listBySession(input.sessionId);
    const blocked = await this.enforceRuntimeBlocked({
      stores: input.stores,
      sessionId: input.sessionId,
      scenario: input.scenario,
      events,
      state: input.view.state,
      stateVersion: input.view.state_version,
      status: input.view.status
    });
    return blocked ?? input.view;
  }

  private async enforceRuntimeBlocked(input: {
    readonly stores: RuntimeStoreContext;
    readonly sessionId: string;
    readonly scenario: NormalizedScenarioV1;
    readonly events: readonly RuntimeEvent[];
    readonly state: JsonObject;
    readonly stateVersion: number;
    readonly status: SessionStatus;
  }): Promise<SessionView | null> {
    if (input.status !== "running") {
      return null;
    }
    const decision = this.resolveRuntimeBlock(input.scenario, input.state, input.events);
    if (decision === null) {
      return null;
    }
    return this.commitService.commitRuntimeBlocked({
      stores: input.stores,
      sessionId: input.sessionId,
      scenario: input.scenario,
      events: input.events,
      reason: decision.reason,
      ...(decision.stageId === undefined ? {} : { stageId: decision.stageId }),
      diagnostics: decision.diagnostics,
      state: input.state,
      stateVersion: input.stateVersion
    });
  }

  private resolveRuntimeBlock(
    scenario: NormalizedScenarioV1,
    state: JsonObject,
    events: readonly RuntimeEvent[]
  ): RuntimeBlockDecision | null {
    if (evaluateTerminal(scenario, state, events) !== null) {
      return null;
    }

    const activeStage = resolveActiveStage({ scenario, state, events });
    if (!activeStage.ok) {
      return {
        reason: "no_active_stage",
        diagnostics: [activeStage.reason]
      };
    }

    const limitBlock = this.resolveRuntimeLimitBlock(scenario, events, activeStage.stage.id);
    if (limitBlock !== null) {
      return limitBlock;
    }

    const allowedSteps = resolveAllowedSteps({ scenario, state, events });
    if (allowedSteps.length === 0) {
      return {
        reason: "no_allowed_step",
        stageId: activeStage.stage.id,
        diagnostics: [`No allowed step is available for active stage ${activeStage.stage.id}.`]
      };
    }

    return null;
  }

  private resolveRuntimeLimitBlock(
    scenario: NormalizedScenarioV1,
    events: readonly RuntimeEvent[],
    activeStageId: string
  ): RuntimeBlockDecision | null {
    const { runtime_limits: limits } = scenario;
    const committedSteps = events.filter((event) => event.type === "StepCommitted");
    if (committedSteps.length >= limits.max_committed_steps) {
      return {
        reason: "runtime_limit_exceeded",
        stageId: activeStageId,
        diagnostics: [`runtime_limits.max_committed_steps exceeded: ${committedSteps.length}/${limits.max_committed_steps}.`]
      };
    }

    const stageCommittedSteps = committedSteps.filter((event) => {
      if (event.type !== "StepCommitted") {
        return false;
      }
      return findStep(scenario, event.payload.step_id)?.stage_id === activeStageId;
    });
    if (stageCommittedSteps.length >= limits.max_stage_committed_steps) {
      return {
        reason: "runtime_limit_exceeded",
        stageId: activeStageId,
        diagnostics: [
          `runtime_limits.max_stage_committed_steps exceeded for stage ${activeStageId}: ${stageCommittedSteps.length}/${limits.max_stage_committed_steps}.`
        ]
      };
    }

    const failedAttempts = events.filter((event) => event.type === "StepAttemptFailed");
    if (failedAttempts.length >= limits.max_failed_attempts) {
      return {
        reason: "runtime_limit_exceeded",
        stageId: activeStageId,
        diagnostics: [`runtime_limits.max_failed_attempts exceeded: ${failedAttempts.length}/${limits.max_failed_attempts}.`]
      };
    }

    const toolCalls = events.filter((event) => event.type === "ToolCallCommitted" || event.type === "ToolCallFailed");
    if (toolCalls.length >= limits.max_tool_calls) {
      return {
        reason: "runtime_limit_exceeded",
        stageId: activeStageId,
        diagnostics: [`runtime_limits.max_tool_calls exceeded: ${toolCalls.length}/${limits.max_tool_calls}.`]
      };
    }

    if (events.length >= limits.max_events) {
      return {
        reason: "runtime_limit_exceeded",
        stageId: activeStageId,
        diagnostics: [`runtime_limits.max_events exceeded: ${events.length}/${limits.max_events}.`]
      };
    }

    return null;
  }

  private validateAction(
    scenario: NormalizedScenarioV1,
    step: StepContractV2 | null,
    actorIdForFailure: string,
    actorId: string,
    args: JsonObject,
    loaded: LoadedSession,
    visibleResourcePaths: readonly string[] = scenario.visibility_policy.rules
      .filter((rule) => rule.target.kind === "resource" && rule.access !== "redacted")
      .map((rule) => rule.target.path),
    currentAllowedStepIds: readonly string[] = this.resolveCurrentAllowedStepIds(loaded),
    preparedAllowedStepIds?: readonly string[]
  ): string | null {
    if (step === null) {
      return "Step is not declared.";
    }
    if (!currentAllowedStepIds.includes(step.id)) {
      return "Step is not allowed in current runtime state.";
    }
    if (preparedAllowedStepIds !== undefined && !preparedAllowedStepIds.includes(step.id)) {
      return "Step is not allowed in this AI turn.";
    }
    if (step.actor_id !== actorId) {
      return "Actor does not match selected step.";
    }
    const actor = findActor(scenario, actorIdForFailure);
    if (actor === null) {
      return "Actor is not declared.";
    }
    const schemaFailure = validateJsonValue(args, step.args_schema, "$.args");
    if (schemaFailure !== null) {
      return schemaFailure;
    }

    const allowedReferences = new Set(step.args_ref_paths);
    const visibleReferences = new Set(visibleResourcePaths);
    for (const reference of collectResourceReferences(args)) {
      if (!allowedReferences.has(reference) || !visibleReferences.has(reference)) {
        return "Args reference is not visible or allowed.";
      }
    }

    const context = {
      state: loaded.view.state,
      constants: scenario.constants,
      actor,
      args,
      events: loaded.events
    };
    const allowed = evaluateAllGuards(step.preconditions, context);
    if (!allowed) {
      return "Step preconditions are not satisfied.";
    }
    if (step.accept_when !== undefined && !evaluateAllGuards([step.accept_when], context)) {
      return "Step accept_when is not satisfied.";
    }
    return null;
  }

  private resolveCurrentAllowedStepIds(loaded: LoadedSession): string[] {
    return resolveAllowedSteps({
      scenario: loaded.scenario,
      state: loaded.view.state,
      events: loaded.events
    }).map((step) => step.id);
  }

  private buildLLMRequest(actorId: string, bundle: VisibleContextBundle): LLMRequest {
    const prompt = renderPrompt(bundle);
    return {
      prompt: prompt.text,
      prompt_hash: prompt.prompt_hash,
      actor_id: actorId,
      allowed_steps: bundle.allowed_steps.map((step) => ({
        id: step.id,
        actor_id: step.actor_id,
        args_schema: step.argument_requirements.args_schema,
        args_ref_paths: step.argument_requirements.args_ref_paths
      })),
      metadata: {
        context_hash: prompt.debug.context_hash,
        visibility_hash: prompt.debug.visibility_hash,
        block_hashes: prompt.debug.blocks.map((block) => ({ name: block.name, hash: block.hash })),
        source_refs: prompt.debug.blocks.flatMap((block) => block.source_refs)
      }
    };
  }

  private userInputToArgs(step: StepContractV2 | null, input: string): JsonObject {
    if (step === null || typeof step.args_schema !== "object" || step.args_schema === null) {
      return { input };
    }
    const required = step.args_schema.required ?? [];
    const properties = step.args_schema.properties ?? {};
    const field = required.find((key: string) => {
      const property = properties[key];
      return typeof property === "object" && property !== null && property.type === "string";
    });
    return field === undefined ? { input } : { [field]: input };
  }
}
