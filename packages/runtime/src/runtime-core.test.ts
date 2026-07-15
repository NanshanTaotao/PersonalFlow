import { describe, expect, it } from "vitest";

import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { CommitService, InMemoryRuntimeStore, RuntimeKernel, RuntimeConflictError, RuntimeValidationError, replayState } from "./index";
import { jobInterviewSmokeFixture } from "./testing/scenarios";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const createRuntime = () => {
  const store = new InMemoryRuntimeStore();
  return { runtime: new RuntimeKernel({ store }), store };
};

const blockedNoAllowedStepScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario_no_allowed_step",
  steps: clone(jobInterviewSmokeFixture.steps).map((step) => ({
    ...step,
    preconditions: [{ op: "gt" as const, path: "$.state.turn_count", value: 99 }]
  }))
});

const blockedNoActiveStageScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario_no_active_stage",
  stages: clone(jobInterviewSmokeFixture.stages).map((stage) => ({
    ...stage,
    enter_when: { op: "eq" as const, path: "$.state.turn_count", value: 99 },
    exit_when: { op: "eq" as const, path: "$.state.turn_count", value: 100 }
  }))
});

const stageLimitScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario_stage_limit_cumulative",
  title: "Stage limit cumulative",
  resources: {},
  state_schema: {
    type: "object",
    properties: { active_stage: { type: "string" } },
    required: ["active_stage"],
    additionalProperties: false
  },
  initial_state: { active_stage: "stage_a" },
  stages: [
    {
      id: "stage_a",
      title: "Stage A",
      goal: "Exercise stage A.",
      order: 1,
      enter_when: { op: "eq", path: "$.state.active_stage", value: "stage_a" },
      exit_when: { op: "neq", path: "$.state.active_stage", value: "stage_a" }
    },
    {
      id: "stage_b",
      title: "Stage B",
      goal: "Exercise stage B.",
      order: 2,
      enter_when: { op: "eq", path: "$.state.active_stage", value: "stage_b" },
      exit_when: { op: "neq", path: "$.state.active_stage", value: "stage_b" }
    }
  ],
  steps: [
    {
      id: "stage_a_to_b",
      stage_id: "stage_a",
      actor_id: "user_candidate",
      prompt: "Move from stage A to stage B.",
      args_schema: {
        type: "object",
        properties: { input: { type: "string", minLength: 1 } },
        required: ["input"],
        additionalProperties: false
      },
      args_ref_paths: [],
      preconditions: [{ op: "eq", path: "$.state.active_stage", value: "stage_a" }],
      state_effects: [{ op: "set", target_path: "$.state.active_stage", value: "stage_b" }],
      review_tags: ["test_evidence"]
    },
    {
      id: "stage_b_to_a",
      stage_id: "stage_b",
      actor_id: "user_candidate",
      prompt: "Move from stage B back to stage A.",
      args_schema: {
        type: "object",
        properties: { input: { type: "string", minLength: 1 } },
        required: ["input"],
        additionalProperties: false
      },
      args_ref_paths: [],
      preconditions: [{ op: "eq", path: "$.state.active_stage", value: "stage_b" }],
      state_effects: [{ op: "set", target_path: "$.state.active_stage", value: "stage_a" }],
      review_tags: ["test_evidence"]
    }
  ],
  step_order: ["stage_a_to_b", "stage_b_to_a"],
  runtime_limits: {
    max_committed_steps: 10,
    max_stage_committed_steps: 1,
    max_events: 20,
    max_failed_attempts: 10,
    max_tool_calls: 10
  },
  terminal_rules: [
    {
      id: "terminal_never",
      when: { op: "eq", path: "$.state.active_stage", value: "done" },
      status: "completed",
      reason: "done"
    }
  ],
  visibility_policy: { default: "deny", rules: [] },
  tool_policy: { tools: [], grants: [] }
});

const nonActiveStageAllowedByGuardScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario_non_active_stage_step_guard_true",
  stages: [
    ...clone(jobInterviewSmokeFixture.stages),
    {
      id: "follow_up",
      title: "Follow up",
      goal: "This stage is not active in the initial state.",
      order: 2,
      enter_when: { op: "eq", path: "$.state.turn_count", value: 99 },
      exit_when: { op: "eq", path: "$.state.turn_count", value: 100 }
    }
  ],
  steps: [
    ...clone(jobInterviewSmokeFixture.steps),
    {
      id: "follow_up_question",
      stage_id: "follow_up",
      actor_id: "ai_interviewer",
      prompt: "This step should not be runnable while conversation is active.",
      args_schema: {
        type: "object",
        properties: { question: { type: "string", minLength: 1 } },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: [],
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: [],
      review_tags: ["interviewer_question"]
    }
  ],
  step_order: ["ask_question", "answer_question", "follow_up_question"]
});

const onlyAiAllowedScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario_only_ai_allowed",
  steps: clone(jobInterviewSmokeFixture.steps).map((step) =>
    step.id === "answer_question"
      ? { ...step, preconditions: [{ op: "eq" as const, path: "$.state.turn_count", value: 99 }] }
      : step
  )
});

const multipleHumanStepsScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario_multiple_human_steps",
  steps: [
    ...clone(jobInterviewSmokeFixture.steps),
    {
      ...clone(jobInterviewSmokeFixture.steps).find((step) => step.id === "answer_question")!,
      id: "clarify_answer"
    }
  ],
  step_order: ["ask_question", "answer_question", "clarify_answer"]
});

describe("RuntimeKernel", () => {
  it("starts the smoke scenario and commits legal steps through the store port", async () => {
    const { runtime } = createRuntime();

    const started = await runtime.startSession({
      sessionId: "session-smoke",
      scenario: jobInterviewSmokeFixture
    });

    expect(started.status).toBe("running");
    expect(started.state).toEqual({ turn_count: 0 });
    expect(started.state_version).toBe(0);
    expect(started.allowed_steps.map((step) => step.id)).toEqual(["ask_question", "answer_question"]);

    const afterAi = await runtime.submitStructuredAction({
      sessionId: "session-smoke",
      actorId: "ai_interviewer",
      stepId: "ask_question",
      args: { question: "What project did you own end to end?" },
      expectedStateVersion: 0
    });

    expect(afterAi.state).toEqual({ turn_count: 0 });
    expect(afterAi.state_version).toBe(0);

    const afterUser = await runtime.submitUserInput({
      sessionId: "session-smoke",
      input: "I led a migration from a batch job to an event-driven worker.",
      expectedStateVersion: 0
    });

    expect(afterUser.state).toEqual({ turn_count: 1 });
    expect(afterUser.state_version).toBe(1);

    const events = await runtime.listEvents("session-smoke");
    expect(events.map((event) => event.type)).toEqual(["SessionStarted", "StepCommitted", "StepCommitted"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(replayState(jobInterviewSmokeFixture.initial_state, events)).toEqual({
      state: afterUser.state,
      state_version: afterUser.state_version
    });
  });

  it("starts a session through existing runtime stores with the same view semantics", async () => {
    const store = new InMemoryRuntimeStore();
    const runtime = new RuntimeKernel({ store });

    await store.transaction(async (stores) => {
      const view = await runtime.startSessionInStores(stores, {
        sessionId: "session-start-in-stores",
        scenario: jobInterviewSmokeFixture
      });

      expect(view.session_id).toBe("session-start-in-stores");
      expect(view.status).toBe("running");
      expect(view.state_version).toBe(0);
      expect(view.allowed_steps.length).toBeGreaterThan(0);
      expect(await stores.sessions.get("session-start-in-stores")).toMatchObject({
        session_id: "session-start-in-stores",
        status: view.status
      });
    });
  });

  it("orders allowed steps by step_order and ignores legacy scheduler and stage allow-list candidates", async () => {
    const { runtime } = createRuntime();
    const scenario = {
      ...jobInterviewSmokeFixture,
      id: "scenario_step_order_runtime",
      step_order: ["answer_question", "ask_question"],
      scheduler: {
        strategy: "ordered",
        entry_step_ids: ["ask_question"],
        candidate_step_ids: ["ask_question"],
        max_steps: 1
      },
      stages: jobInterviewSmokeFixture.stages.map((stage) =>
        stage.id === "conversation"
          ? {
              ...stage,
              allowed_role_ids: ["ai_interviewer"],
              allowed_step_ids: ["ask_question"],
              max_turns: 1
            }
          : stage
      )
    };

    const started = await runtime.startSession({
      sessionId: "session-step-order",
      scenario
    });

    expect(started.allowed_steps.map((step) => step.id)).toEqual(["answer_question", "ask_question"]);
  });

  it("rejects a non active stage step even when its own guard is allowed", async () => {
    const { runtime } = createRuntime();
    const scenario = nonActiveStageAllowedByGuardScenario();
    await runtime.startSession({ sessionId: "session-non-active-stage-step", scenario });

    const view = await runtime.submitStructuredAction({
      sessionId: "session-non-active-stage-step",
      actorId: "ai_interviewer",
      stepId: "follow_up_question",
      args: { question: "Can I bypass the active stage?" },
      expectedStateVersion: 0
    });

    expect(view.state_version).toBe(0);
    expect(view.visible_transcript).toEqual([]);
    expect((await runtime.listEvents("session-non-active-stage-step")).map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepAttemptFailed"
    ]);
  });

  it("commits RuntimeBlockedCommitted with no_allowed_step when startSession has an active stage but no runnable steps", async () => {
    const { runtime } = createRuntime();
    const scenario = blockedNoAllowedStepScenario();

    const started = await runtime.startSession({
      sessionId: "session-no-allowed-step",
      scenario
    });

    expect(started.status).toBe("blocked");
    expect(started.allowed_steps).toEqual([]);
    expect(started.blocked_summary).toEqual({
      reason: "no_allowed_step",
      message: expect.stringContaining("No allowed step"),
      stage_id: "conversation"
    });

    const events = await runtime.listEvents("session-no-allowed-step");
    expect(events.map((event) => event.type)).toEqual(["SessionStarted", "RuntimeBlockedCommitted"]);
    expect(events[1]).toMatchObject({
      type: "RuntimeBlockedCommitted",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        reason: "no_allowed_step",
        stage_id: "conversation",
        diagnostics: expect.arrayContaining([expect.any(String)])
      }
    });
  });

  it("commits RuntimeBlockedCommitted with no_active_stage when startSession is non-terminal without an active stage", async () => {
    const { runtime } = createRuntime();
    const scenario = blockedNoActiveStageScenario();

    const started = await runtime.startSession({
      sessionId: "session-no-active-stage",
      scenario
    });

    expect(started.status).toBe("blocked");
    expect(started.allowed_steps).toEqual([]);
    expect(started.blocked_summary).toEqual({
      reason: "no_active_stage",
      message: expect.stringContaining("No active stage")
    });

    const events = await runtime.listEvents("session-no-active-stage");
    expect(events.map((event) => event.type)).toEqual(["SessionStarted", "RuntimeBlockedCommitted"]);
    expect(events[1]).toMatchObject({
      type: "RuntimeBlockedCommitted",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        reason: "no_active_stage",
        diagnostics: expect.arrayContaining([expect.any(String)])
      }
    });
    expect(events[1]).not.toHaveProperty("payload.stage_id");
  });

  it("keeps blocked sessions blocked and does not append progressing events from structured or user input", async () => {
    const { runtime } = createRuntime();
    const scenario = blockedNoAllowedStepScenario();
    await runtime.startSession({ sessionId: "session-blocked-inputs", scenario });

    const structured = await runtime.submitStructuredAction({
      sessionId: "session-blocked-inputs",
      actorId: "ai_interviewer",
      stepId: "ask_question",
      args: { question: "This should not progress." },
      expectedStateVersion: 0
    });
    const user = await runtime.submitUserInput({
      sessionId: "session-blocked-inputs",
      input: "This should not progress.",
      expectedStateVersion: 0
    });

    expect(structured.status).toBe("blocked");
    expect(user.status).toBe("blocked");
    expect(structured.state_version).toBe(0);
    expect(user.state_version).toBe(0);

    const events = await runtime.listEvents("session-blocked-inputs");
    expect(events.filter((event) => event.type === "StepCommitted" || event.type === "ToolCallCommitted")).toEqual([]);
    expect(events.filter((event) => event.type === "RuntimeBlockedCommitted")).toHaveLength(1);
    expect(events.every((event) => event.state_version_before === event.state_version_after)).toBe(true);
  });

  it("allows blocked sessions to end but keeps pause and resume blocked", async () => {
    const { runtime } = createRuntime();
    const scenario = blockedNoAllowedStepScenario();
    const blocked = await runtime.startSession({ sessionId: "session-blocked-end", scenario });

    expect(blocked.status).toBe("blocked");
    await expect(
      runtime.pauseSession({ sessionId: "session-blocked-end", expectedStateVersion: 0 })
    ).rejects.toBeInstanceOf(RuntimeValidationError);
    await expect(
      runtime.resumeSession({ sessionId: "session-blocked-end", expectedStateVersion: 0 })
    ).rejects.toBeInstanceOf(RuntimeValidationError);

    const ended = await runtime.endSession({ sessionId: "session-blocked-end", expectedStateVersion: 0 });

    expect(ended.status).toBe("ended");
    expect(ended.state_version).toBe(0);
    expect(ended.allowed_steps).toEqual([]);
    expect((await runtime.listEvents("session-blocked-end")).map((event) => event.type)).toEqual([
      "SessionStarted",
      "RuntimeBlockedCommitted",
      "RuntimeCommandCommitted"
    ]);
  });

  it("deduplicates RuntimeBlockedCommitted by session, state version, reason and stage", async () => {
    const store = new InMemoryRuntimeStore();
    const commitService = new CommitService({ now: () => "runtime-idempotent" });
    const scenario = clone(jobInterviewSmokeFixture);
    await store.transaction(async (stores) => {
      await commitService.commitSessionStarted(stores, "session-block-idempotent", scenario);
    });

    await store.transaction(async (stores) => {
      const events = await stores.events.listBySession("session-block-idempotent");
      await commitService.commitRuntimeBlocked({
        stores,
        sessionId: "session-block-idempotent",
        scenario,
        events,
        reason: "no_allowed_step",
        stageId: "conversation",
        diagnostics: ["No candidate step passed guards."],
        state: scenario.initial_state,
        stateVersion: 0
      });
    });
    const second = await store.transaction(async (stores) => {
      const events = await stores.events.listBySession("session-block-idempotent");
      return commitService.commitRuntimeBlocked({
        stores,
        sessionId: "session-block-idempotent",
        scenario,
        events,
        reason: "no_allowed_step",
        stageId: "conversation",
        diagnostics: ["A repeated evaluation hit the same blocked condition."],
        state: scenario.initial_state,
        stateVersion: 0
      });
    });

    expect(second.status).toBe("blocked");
    expect(second.blocked_summary).toMatchObject({ reason: "no_allowed_step", stage_id: "conversation" });
    const events = await store.transaction(async (stores) => stores.events.listBySession("session-block-idempotent"));
    expect(events.filter((event) => event.type === "RuntimeBlockedCommitted")).toHaveLength(1);
  });

  it("enforces max_stage_committed_steps across non-contiguous visits to the same stage", async () => {
    const { runtime } = createRuntime();
    const scenario = stageLimitScenario();
    const started = await runtime.startSession({ sessionId: "session-stage-limit", scenario });

    expect(started.status).toBe("running");
    expect(started.allowed_steps.map((step) => step.id)).toEqual(["stage_a_to_b"]);

    const afterStageA = await runtime.submitUserInput({
      sessionId: "session-stage-limit",
      input: "to b",
      expectedStateVersion: 0
    });
    expect(afterStageA.status).toBe("running");
    expect(afterStageA.state).toEqual({ active_stage: "stage_b" });

    const afterReturnToStageA = await runtime.submitUserInput({
      sessionId: "session-stage-limit",
      input: "to a",
      expectedStateVersion: 1
    });

    expect(afterReturnToStageA.status).toBe("blocked");
    expect(afterReturnToStageA.state).toEqual({ active_stage: "stage_a" });
    expect(afterReturnToStageA.state_version).toBe(2);
    expect(afterReturnToStageA.blocked_summary).toMatchObject({
      reason: "runtime_limit_exceeded",
      stage_id: "stage_a"
    });

    const events = await runtime.listEvents("session-stage-limit");
    expect(events.map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepCommitted",
      "StepCommitted",
      "RuntimeBlockedCommitted"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "RuntimeBlockedCommitted",
      state_version_before: 2,
      state_version_after: 2,
      payload: {
        reason: "runtime_limit_exceeded",
        stage_id: "stage_a",
        diagnostics: expect.arrayContaining([expect.stringContaining("max_stage_committed_steps")])
      }
    });
  });

  it("records invalid step attempts without changing committed state or advancing state version", async () => {
    const { runtime } = createRuntime();
    await runtime.startSession({ sessionId: "session-failure", scenario: jobInterviewSmokeFixture });

    const view = await runtime.submitStructuredAction({
      sessionId: "session-failure",
      actorId: "user_candidate",
      stepId: "missing_step",
      args: {},
      expectedStateVersion: 0
    });

    expect(view.state).toEqual({ turn_count: 0 });
    expect(view.state_version).toBe(0);

    const events = await runtime.listEvents("session-failure");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        step_id: "missing_step",
        actor_id: "user_candidate",
        error_code: "validation_error"
      }
    });
  });

  it("wraps product human step input from the unique allowed human step", async () => {
    const { runtime } = createRuntime();
    await runtime.startSession({ sessionId: "session-human-step-input", scenario: jobInterviewSmokeFixture });

    const view = await runtime.submitUserInput({
      sessionId: "session-human-step-input",
      input: "I led a migration from a batch job to an event-driven worker.",
      expectedStateVersion: 0
    });

    expect(view.state).toEqual({ turn_count: 1 });
    expect(view.state_version).toBe(1);
    expect((await runtime.listEvents("session-human-step-input")).at(-1)).toMatchObject({
      type: "StepCommitted",
      payload: {
        actor_id: "user_candidate",
        step_id: "answer_question",
        args: { answer: "I led a migration from a batch job to an event-driven worker." }
      }
    });
  });

  it("rejects product human step input when there is no unique allowed human step", async () => {
    const { runtime: noHumanRuntime } = createRuntime();
    const noHumanScenario = onlyAiAllowedScenario();
    await noHumanRuntime.startSession({ sessionId: "session-no-human-step", scenario: noHumanScenario });

    await expect(
      noHumanRuntime.submitUserInput({
        sessionId: "session-no-human-step",
        input: "No human step should be selected.",
        expectedStateVersion: 0
      })
    ).rejects.toBeInstanceOf(RuntimeValidationError);
    expect(await noHumanRuntime.listEvents("session-no-human-step")).toHaveLength(1);

    const { runtime: multipleHumanRuntime } = createRuntime();
    const multipleHumanScenario = multipleHumanStepsScenario();
    await multipleHumanRuntime.startSession({ sessionId: "session-multiple-human-steps", scenario: multipleHumanScenario });

    await expect(
      multipleHumanRuntime.submitUserInput({
        sessionId: "session-multiple-human-steps",
        input: "Ambiguous human step.",
        expectedStateVersion: 0
      })
    ).rejects.toBeInstanceOf(RuntimeValidationError);
    expect(await multipleHumanRuntime.listEvents("session-multiple-human-steps")).toHaveLength(1);
  });

  it("records actor mismatch and guard failures without changing committed state", async () => {
    const { runtime } = createRuntime();
    await runtime.startSession({ sessionId: "session-invalid-action", scenario: jobInterviewSmokeFixture });

    const actorMismatch = await runtime.submitStructuredAction({
      sessionId: "session-invalid-action",
      actorId: "user_candidate",
      stepId: "ask_question",
      args: { question: "Wrong actor" },
      expectedStateVersion: 0
    });

    expect(actorMismatch.state).toEqual({ turn_count: 0 });
    expect(actorMismatch.state_version).toBe(0);

    const guardedScenario = {
      ...jobInterviewSmokeFixture,
      id: "scenario_guard_failure",
      steps: jobInterviewSmokeFixture.steps.map((step) =>
        step.id === "answer_question"
          ? { ...step, preconditions: [{ op: "gt" as const, path: "$.state.turn_count", value: 99 }] }
          : step
      )
    };
    const { runtime: guardedRuntime } = createRuntime();
    await guardedRuntime.startSession({ sessionId: "session-guard-failure", scenario: guardedScenario });

    const guardFailure = await guardedRuntime.submitStructuredAction({
      sessionId: "session-guard-failure",
      actorId: "user_candidate",
      stepId: "answer_question",
      args: { answer: "Not allowed yet" },
      expectedStateVersion: 0
    });

    expect(guardFailure.state).toEqual({ turn_count: 0 });
    expect(guardFailure.state_version).toBe(0);
    expect((await guardedRuntime.listEvents("session-guard-failure")).at(-1)).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 0,
      state_version_after: 0
    });
  });

  it("rejects stale expected state versions without appending a successful commit", async () => {
    const { runtime } = createRuntime();
    await runtime.startSession({ sessionId: "session-conflict", scenario: jobInterviewSmokeFixture });

    await expect(
      runtime.submitStructuredAction({
        sessionId: "session-conflict",
        actorId: "ai_interviewer",
        stepId: "ask_question",
        args: { question: "Where did you reduce operational risk?" },
        expectedStateVersion: 1
      })
    ).rejects.toBeInstanceOf(RuntimeConflictError);

    const view = await runtime.getView("session-conflict");
    expect(view.state_version).toBe(0);
    expect(view.state).toEqual({ turn_count: 0 });

    const events = await runtime.listEvents("session-conflict");
    expect(events.map((event) => event.type)).toEqual(["SessionStarted"]);
  });

  it("commits runtime commands and rejects normal steps after terminal completion", async () => {
    const { runtime } = createRuntime();
    await runtime.startSession({ sessionId: "session-terminal", scenario: jobInterviewSmokeFixture });

    const paused = await runtime.pauseSession({ sessionId: "session-terminal", expectedStateVersion: 0 });
    expect(paused.status).toBe("paused");
    expect(paused.allowed_steps).toEqual([]);

    const resumed = await runtime.resumeSession({ sessionId: "session-terminal", expectedStateVersion: 0 });
    expect(resumed.status).toBe("running");

    await runtime.submitStructuredAction({
      sessionId: "session-terminal",
      actorId: "user_candidate",
      stepId: "answer_question",
      args: { answer: "First answer" },
      expectedStateVersion: 0
    });

    const completed = await runtime.submitStructuredAction({
      sessionId: "session-terminal",
      actorId: "user_candidate",
      stepId: "answer_question",
      args: { answer: "Second answer" },
      expectedStateVersion: 1
    });

    expect(completed.status).toBe("completed");
    expect(completed.state_version).toBe(2);

    const afterRejected = await runtime.submitStructuredAction({
      sessionId: "session-terminal",
      actorId: "user_candidate",
      stepId: "answer_question",
      args: { answer: "Too late" },
      expectedStateVersion: 2
    });

    expect(afterRejected.status).toBe("completed");
    expect(afterRejected.state).toEqual({ turn_count: 2 });
    expect(afterRejected.state_version).toBe(2);

    await expect(
      runtime.endSession({ sessionId: "session-terminal", expectedStateVersion: 2 })
    ).rejects.toBeInstanceOf(RuntimeValidationError);

    const events = await runtime.listEvents("session-terminal");
    expect(events.map((event) => event.type)).toEqual([
      "SessionStarted",
      "RuntimeCommandCommitted",
      "RuntimeCommandCommitted",
      "StepCommitted",
      "StepCommitted",
      "StepAttemptFailed"
    ]);
  });

  it("rejects invalid lifecycle transitions after terminal states", async () => {
    const { runtime } = createRuntime();
    await runtime.startSession({ sessionId: "session-lifecycle", scenario: jobInterviewSmokeFixture });

    const ended = await runtime.endSession({ sessionId: "session-lifecycle", expectedStateVersion: 0 });
    expect(ended.status).toBe("ended");

    await expect(
      runtime.resumeSession({ sessionId: "session-lifecycle", expectedStateVersion: 0 })
    ).rejects.toBeInstanceOf(RuntimeValidationError);
    await expect(
      runtime.pauseSession({ sessionId: "session-lifecycle", expectedStateVersion: 0 })
    ).rejects.toBeInstanceOf(RuntimeValidationError);

    const view = await runtime.getView("session-lifecycle");
    expect(view.status).toBe("ended");
    expect(view.allowed_steps).toEqual([]);

    const events = await runtime.listEvents("session-lifecycle");
    expect(events.map((event) => event.type)).toEqual(["SessionStarted", "RuntimeCommandCommitted"]);
  });
});
