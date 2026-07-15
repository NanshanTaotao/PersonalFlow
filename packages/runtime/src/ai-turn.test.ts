import { describe, expect, it } from "vitest";

import type { NormalizedScenarioV1 } from "@personalflow/contracts";
import { createFakeLLM } from "@personalflow/agent";

import { InMemoryRuntimeStore, RuntimeConflictError, RuntimeKernel, RuntimeValidationError } from "./index";
import { jobInterviewSmokeFixture } from "./testing/scenarios";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const createRuntime = (scenario: NormalizedScenarioV1 = jobInterviewSmokeFixture) => {
  const store = new InMemoryRuntimeStore();
  const runtime = new RuntimeKernel({ store });
  return { runtime, scenario };
};

const action = (selected_step: string, args: Record<string, unknown>, content = "Question") =>
  JSON.stringify({ kind: "step", selected_step, content, args });

const toolAction = (selected_tool: string, args: Record<string, unknown>, reason = "Need source context") =>
  JSON.stringify({ kind: "tool_request", selected_tool, reason, args });

const stageChangesByEventCountScenario = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  id: "scenario-ai-current-allowed-recheck",
  stages: [
    {
      id: "initial_ai_stage",
      title: "Initial AI stage",
      goal: "Only active while the session has the start event.",
      order: 1,
      enter_when: { op: "eq", path: "$.events.count", value: 1 },
      exit_when: { op: "gte", path: "$.events.count", value: 2 }
    },
    {
      id: "later_human_stage",
      title: "Later human stage",
      goal: "Active after any committed runtime event.",
      order: 2,
      enter_when: { op: "gte", path: "$.events.count", value: 2 },
      exit_when: { op: "eq", path: "$.state.turn_count", value: 99 }
    }
  ],
  steps: [
    {
      ...clone(jobInterviewSmokeFixture.steps).find((step) => step.id === "ask_question")!,
      stage_id: "initial_ai_stage",
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: []
    },
    {
      ...clone(jobInterviewSmokeFixture.steps).find((step) => step.id === "answer_question")!,
      stage_id: "later_human_stage",
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: []
    }
  ],
  step_order: ["ask_question", "answer_question"],
  runtime_limits: {
    ...jobInterviewSmokeFixture.runtime_limits,
    max_events: 20
  }
});

describe("RuntimeKernel AI turn", () => {
  it("renders visible context, calls Fake LLM and commits a validated AI step", async () => {
    const { runtime, scenario } = createRuntime();
    const adapter = createFakeLLM([
      { content: action("ask_question", { question: "What project did you own end to end?" }) }
    ]);
    await runtime.startSession({ sessionId: "session-ai-success", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-success",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state).toEqual({ turn_count: 0 });
    expect(view.state_version).toBe(0);
    expect(adapter.calls()).toHaveLength(1);
    expect(adapter.calls()[0]).toMatchObject({
      actor_id: "ai_interviewer",
      prompt_hash: expect.any(String),
      allowed_steps: expect.arrayContaining([expect.objectContaining({ id: "ask_question", actor_id: "ai_interviewer" })]),
      metadata: {
        context_hash: expect.any(String),
        visibility_hash: expect.any(String),
        source_refs: expect.arrayContaining(["step:ask_question"])
      }
    });
    expect(JSON.stringify(adapter.calls()[0])).not.toContain("initial_state");

    const events = await runtime.listEvents("session-ai-success");
    expect(events.at(-1)).toMatchObject({
      type: "StepCommitted",
      payload: {
        step_id: "ask_question",
        actor_id: "ai_interviewer",
        args: { question: "What project did you own end to end?" }
      }
    });
  });

  it("records StepAttemptFailed for invalid selected_step without advancing state", async () => {
    const { runtime, scenario } = createRuntime();
    const adapter = createFakeLLM([{ content: action("missing_step", { question: "Bad" }) }]);
    await runtime.startSession({ sessionId: "session-ai-invalid-step", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-invalid-step",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect(view.state).toEqual({ turn_count: 0 });
    expect((await runtime.listEvents("session-ai-invalid-step")).at(-1)).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 0,
      state_version_after: 0,
      payload: { step_id: "missing_step", actor_id: "ai_interviewer", error_code: "validation_error" }
    });
  });

  it("commits authorized tool requests as ToolCallCommitted without advancing state", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      tool_policy: {
        tools: [
          {
            id: "mock_rag_query",
            kind: "mock_rag_query",
            description: "Search visible interview context.",
            args_schema: {
              type: "object",
              properties: { query: { type: "string", minLength: 1 } },
              required: ["query"],
              additionalProperties: false
            }
          }
        ],
        grants: [{ role_id: "ai_interviewer", stage_id: "conversation", tool_id: "mock_rag_query" }]
      }
    };
    const { runtime } = createRuntime(scenario);
    const adapter = createFakeLLM([{ content: toolAction("mock_rag_query", { query: "ownership evidence" }) }]);
    await runtime.startSession({ sessionId: "session-ai-tool-committed", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-tool-committed",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect(view.state).toEqual({ turn_count: 0 });
    expect((await runtime.listEvents("session-ai-tool-committed")).at(-1)).toMatchObject({
      type: "ToolCallCommitted",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        actor_id: "ai_interviewer",
        stage_id: "conversation",
        tool_id: "mock_rag_query",
        request: { query: "ownership evidence" },
        result: {
          summary: "Mock RAG result for: ownership evidence",
          source_ref: "mock_rag:chunk-1",
          trust_level: "medium"
        }
      }
    });
  });

  it("commits unauthorized tool requests as ToolCallFailed without advancing state", async () => {
    const { runtime, scenario } = createRuntime();
    const adapter = createFakeLLM([{ content: toolAction("mock_rag_query", { query: "hidden" }) }]);
    await runtime.startSession({ sessionId: "session-ai-tool-denied", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-tool-denied",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect((await runtime.listEvents("session-ai-tool-denied")).at(-1)).toMatchObject({
      type: "ToolCallFailed",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        actor_id: "ai_interviewer",
        stage_id: "conversation",
        tool_id: "mock_rag_query",
        request: { query: "hidden" },
        error_code: "permission_error"
      }
    });
  });

  it("records StepAttemptFailed when AI selects a declared step outside the turn allowed set", async () => {
    const hiddenAiStep = {
      ...clone(jobInterviewSmokeFixture.steps).find((step) => step.id === "ask_question")!,
      id: "hidden_ai_step",
      prompt: "This step is intentionally not exposed by the scheduler candidates.",
      preconditions: [{ op: "eq" as const, path: "$.state.turn_count", value: 99 }]
    };
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-hidden-step",
      steps: [...clone(jobInterviewSmokeFixture.steps), hiddenAiStep]
    };
    const { runtime } = createRuntime(scenario);
    const adapter = createFakeLLM([{ content: action("hidden_ai_step", { question: "Bypass allowed set?" }) }]);
    await runtime.startSession({ sessionId: "session-ai-hidden-step", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-hidden-step",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect(view.state).toEqual({ turn_count: 0 });
    expect(adapter.calls()[0]?.allowed_steps.map((step) => step.id)).toEqual(["ask_question"]);
    expect((await runtime.listEvents("session-ai-hidden-step")).at(-1)).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 0,
      state_version_after: 0,
      payload: { step_id: "hidden_ai_step", actor_id: "ai_interviewer", error_code: "validation_error" }
    });
  });

  it("rechecks current allowed steps outside the prepared AI turn transaction", async () => {
    const scenario = stageChangesByEventCountScenario();
    const { runtime } = createRuntime(scenario);
    await runtime.startSession({ sessionId: "session-ai-current-allowed-recheck", scenario });

    const adapter = {
      async complete() {
        await runtime.submitStructuredAction({
          sessionId: "session-ai-current-allowed-recheck",
          actorId: "ai_interviewer",
          stepId: "ask_question",
          args: { question: "Concurrent no-op commit changes events.count." },
          expectedStateVersion: 0
        });
        return { content: action("ask_question", { question: "Prepared action should now be stale." }) };
      }
    };

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-current-allowed-recheck",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect(view.allowed_steps.map((step) => step.id)).toEqual(["answer_question"]);
    expect((await runtime.listEvents("session-ai-current-allowed-recheck")).map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepCommitted",
      "StepAttemptFailed"
    ]);
  });

  it("rejects non-AI actors before calling the model", async () => {
    const { runtime, scenario } = createRuntime();
    const adapter = createFakeLLM([{ content: action("answer_question", { answer: "No call" }) }]);
    await runtime.startSession({ sessionId: "session-ai-user", scenario });

    await expect(
      runtime.runAiTurn({
        sessionId: "session-ai-user",
        actorId: "user_candidate",
        expectedStateVersion: 0,
        adapter
      })
    ).rejects.toBeInstanceOf(RuntimeValidationError);

    expect(adapter.calls()).toHaveLength(0);
    expect(await runtime.listEvents("session-ai-user")).toHaveLength(1);
  });

  it("rejects stale expected state versions before calling the model", async () => {
    const { runtime, scenario } = createRuntime();
    const adapter = createFakeLLM([{ content: action("ask_question", { question: "No call" }) }]);
    await runtime.startSession({ sessionId: "session-ai-conflict", scenario });

    await expect(
      runtime.runAiTurn({
        sessionId: "session-ai-conflict",
        actorId: "ai_interviewer",
        expectedStateVersion: 1,
        adapter
      })
    ).rejects.toBeInstanceOf(RuntimeConflictError);

    expect(adapter.calls()).toHaveLength(0);
    expect(await runtime.listEvents("session-ai-conflict")).toHaveLength(1);
  });

  it("validates AI args schema and accept_when before committing", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-accept",
      steps: clone(jobInterviewSmokeFixture.steps).map((step) =>
        step.id === "ask_question"
          ? { ...step, accept_when: { op: "contains" as const, path: "$.args.question", value: "backend" } }
          : step
      )
    };
    const { runtime } = createRuntime(scenario);
    const adapter = createFakeLLM([
      { content: action("ask_question", {}) },
      { content: action("ask_question", { question: "frontend only" }) }
    ]);
    await runtime.startSession({ sessionId: "session-ai-args", scenario });

    await runtime.runAiTurn({
      sessionId: "session-ai-args",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });
    const second = await runtime.runAiTurn({
      sessionId: "session-ai-args",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(second.state_version).toBe(0);
    expect((await runtime.listEvents("session-ai-args")).map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepAttemptFailed",
      "StepAttemptFailed"
    ]);
  });

  it("rejects invisible resource reference paths in AI args", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-ref",
      resources: { ...clone(jobInterviewSmokeFixture.resources), private_notes: { content: "hidden" } },
      steps: clone(jobInterviewSmokeFixture.steps).map((step) =>
        step.id === "ask_question"
          ? {
              ...step,
              args_schema: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  material_path: { type: "string" }
                },
                required: ["question", "material_path"],
                additionalProperties: false
              }
            }
          : step
      )
    };
    const { runtime } = createRuntime(scenario);
    const adapter = createFakeLLM([
      {
        content: action("ask_question", {
          question: "Use hidden material?",
          material_path: "$.resources.private_notes"
        })
      }
    ]);
    await runtime.startSession({ sessionId: "session-ai-ref", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-ref",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });

    expect(view.state_version).toBe(0);
    expect((await runtime.listEvents("session-ai-ref")).at(-1)).toMatchObject({ type: "StepAttemptFailed" });
  });

  it("keeps adapter failure details, prompt text and secrets out of committed state and failure events", async () => {
    const { runtime, scenario } = createRuntime();
    const secret = "dummy-secret-for-security-check-only";
    const adapter = {
      async complete() {
        throw new Error(`Authorization: Bearer ${secret}; full provider raw response; ${scenario.steps[0]?.prompt ?? ""}`);
      }
    };
    await runtime.startSession({ sessionId: "session-ai-adapter-failure-clean", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-adapter-failure-clean",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter
    });
    const events = await runtime.listEvents("session-ai-adapter-failure-clean");

    expect(view.state_version).toBe(0);
    expect(view.state).toEqual({ turn_count: 0 });
    expect(events.at(-1)).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 0,
      state_version_after: 0,
      payload: { step_id: "model_output", actor_id: "ai_interviewer", error_code: "validation_error" }
    });
    const serialized = JSON.stringify({ view, events });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/Authorization|Bearer|provider raw response|full provider/i);
    expect(serialized).not.toContain(scenario.steps[0]?.prompt ?? "unreachable");
  });

  it("projects retryable AI turn failure summaries without advancing state", async () => {
    const { runtime, scenario } = createRuntime();
    const adapter = createFakeLLM([
      { throws: new Error("temporary provider failure") },
      { throws: new Error("temporary provider failure again") }
    ]);
    await runtime.startSession({ sessionId: "session-ai-retryable-failure-summary", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-retryable-failure-summary",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter,
      maxAttempts: 2
    });

    expect(view.state_version).toBe(0);
    expect(view.failure_summary).toEqual({
      message: "AI 本轮没有成功生成可用提问，已保留当前演练进度。",
      failed_attempts: 1,
      can_retry: true,
      action_label: "重试当前 AI 回合"
    });
    expect(view.next_user_action_label).toContain("重试当前 AI 回合");
    expect((await runtime.listEvents("session-ai-retryable-failure-summary")).map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepAttemptFailed"
    ]);
  });

  it("blocks with runtime_limit_exceeded when failed AI attempts reach max_failed_attempts after invalid JSON", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-failed-attempt-limit",
      runtime_limits: {
        ...jobInterviewSmokeFixture.runtime_limits,
        max_failed_attempts: 1
      }
    };
    const { runtime } = createRuntime(scenario);
    const adapter = createFakeLLM([{ content: "not-json" }]);
    await runtime.startSession({ sessionId: "session-ai-failed-attempt-limit", scenario });

    const view = await runtime.runAiTurn({
      sessionId: "session-ai-failed-attempt-limit",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter,
      maxAttempts: 1
    });

    expect(view.status).toBe("blocked");
    expect(view.state_version).toBe(0);
    expect(view.blocked_summary).toMatchObject({
      reason: "runtime_limit_exceeded",
      stage_id: "conversation"
    });

    const events = await runtime.listEvents("session-ai-failed-attempt-limit");
    expect(events.map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepAttemptFailed",
      "RuntimeBlockedCommitted"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "RuntimeBlockedCommitted",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        reason: "runtime_limit_exceeded",
        stage_id: "conversation",
        diagnostics: expect.arrayContaining([expect.stringContaining("max_failed_attempts")])
      }
    });
  });

  it("returns the existing blocked view from runAiTurn without calling the model or appending progress events", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-blocked-before-turn",
      runtime_limits: {
        ...jobInterviewSmokeFixture.runtime_limits,
        max_failed_attempts: 1
      }
    };
    const { runtime } = createRuntime(scenario);
    const firstAdapter = createFakeLLM([{ content: "not-json" }]);
    await runtime.startSession({ sessionId: "session-ai-blocked-before-turn", scenario });
    await runtime.runAiTurn({
      sessionId: "session-ai-blocked-before-turn",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter: firstAdapter,
      maxAttempts: 1
    });

    const secondAdapter = createFakeLLM([
      { content: action("ask_question", { question: "This should not be requested." }) }
    ]);
    const blocked = await runtime.runAiTurn({
      sessionId: "session-ai-blocked-before-turn",
      actorId: "ai_interviewer",
      expectedStateVersion: 0,
      adapter: secondAdapter
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_summary?.reason).toBe("runtime_limit_exceeded");
    expect(secondAdapter.calls()).toHaveLength(0);
    expect((await runtime.listEvents("session-ai-blocked-before-turn")).map((event) => event.type)).toEqual([
      "SessionStarted",
      "StepAttemptFailed",
      "RuntimeBlockedCommitted"
    ]);
  });

  it("keeps visible transcript summaries only in prompt visible_history, not LLM metadata", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-visible-summary",
      steps: clone(jobInterviewSmokeFixture.steps).map((step) =>
        step.id === "ask_question"
          ? {
              ...step,
              args_schema: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: true
              }
            }
          : step
      )
    };
    const { runtime } = createRuntime(scenario);
    const secret = "dummy-secret-for-debug-observability-only";
    await runtime.startSession({ sessionId: "session-ai-visible-summary", scenario });
    await runtime.submitStructuredAction({
      sessionId: "session-ai-visible-summary",
      actorId: "ai_interviewer",
      stepId: "ask_question",
      args: {
        question: "Visible launch question?",
        raw_prompt: "FULL PROMPT " + secret,
        provider_raw_response: "provider raw response " + secret,
        apiKey: "test-credential-like-secret"
      },
      expectedStateVersion: 0
    });
    await runtime.submitStructuredAction({
      sessionId: "session-ai-visible-summary",
      actorId: "user_candidate",
      stepId: "answer_question",
      args: { answer: "Visible launch answer." },
      expectedStateVersion: 0
    });
    const adapter = createFakeLLM([
      { content: action("ask_question", { question: "Next visible question." }) }
    ]);

    await runtime.runAiTurn({
      sessionId: "session-ai-visible-summary",
      actorId: "ai_interviewer",
      expectedStateVersion: 1,
      adapter
    });

    const request = adapter.calls()[0];
    const serialized = JSON.stringify(request?.metadata);
    expect(request?.metadata).not.toHaveProperty("visible_transcript");
    expect(request?.prompt).toContain("text_summary");
    expect(request?.prompt).toContain("Visible launch question?");
    expect(request?.prompt).toContain("Visible launch answer.");
    expect(request?.prompt).not.toContain("test-credential-like-secret");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/visible_transcript|credential|apiKey|FULL PROMPT|raw_prompt|provider raw|provider_raw_response/i);
    expect(serialized).not.toContain("state_patch");
  });

  it("filters sensitive question and answer values out of prompt visible_history text_summary", async () => {
    const scenario: NormalizedScenarioV1 = {
      ...clone(jobInterviewSmokeFixture),
      id: "scenario-ai-sensitive-summary-values",
      steps: clone(jobInterviewSmokeFixture.steps).map((step) =>
        step.id === "ask_question"
          ? {
              ...step,
              args_schema: {
                type: "object",
                properties: { question: { type: "string" } },
                required: ["question"],
                additionalProperties: true
              }
            }
          : step
      )
    };
    const { runtime } = createRuntime(scenario);
    const secret = "test-sensitive-summary-value";
    await runtime.startSession({ sessionId: "session-ai-sensitive-summary-values", scenario });
    await runtime.submitStructuredAction({
      sessionId: "session-ai-sensitive-summary-values",
      actorId: "ai_interviewer",
      stepId: "ask_question",
      args: { question: `Authorization: Bearer ${secret}; FULL PROMPT provider raw` },
      expectedStateVersion: 0
    });
    await runtime.submitStructuredAction({
      sessionId: "session-ai-sensitive-summary-values",
      actorId: "user_candidate",
      stepId: "answer_question",
      args: { answer: `token password secret ${secret}` },
      expectedStateVersion: 0
    });
    const adapter = createFakeLLM([
      { content: action("ask_question", { question: "Safe next question." }) }
    ]);

    await runtime.runAiTurn({
      sessionId: "session-ai-sensitive-summary-values",
      actorId: "ai_interviewer",
      expectedStateVersion: 1,
      adapter
    });

    const request = adapter.calls()[0];
    expect(request?.prompt).toContain("visible_history");
    expect(request?.prompt).not.toContain(secret);
    expect(request?.prompt).not.toMatch(/Authorization|Bearer|FULL PROMPT|provider raw|token password secret/i);
  });
});
