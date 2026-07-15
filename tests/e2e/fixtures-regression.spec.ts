import { afterEach, describe, expect, it } from "vitest";

import { NormalizedScenarioV1Schema, type NormalizedScenarioV1, type RuntimeEvent } from "@personalflow/contracts";
import type { LLMRequest } from "@personalflow/agent";
import { replayState } from "@personalflow/runtime";
import { createTestDatabase, type TestDatabase } from "@personalflow/storage";
import { builtInTemplates, exportSceneForInternalUse, hashNormalizedScenario, negativeFixtures, stressFixtureDrafts, validateScenario } from "@personalflow/templates";

import { buildApp } from "../../apps/api/src/app";
import { createProductApiContext } from "../../apps/api/src/context";

const encryptionKey = new Uint8Array(32).fill(12);
const databases: TestDatabase[] = [];

type BranchTreeFixtureTemplate = {
  readonly id: string;
  readonly default_params: Record<string, unknown>;
  readonly buildScenario: (params: Record<string, unknown>) => NormalizedScenarioV1;
};

const createDatabase = (): TestDatabase => {
  const database = createTestDatabase({ encryptionKey });
  databases.push(database);
  return database;
};

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.cleanup();
  }
});

const createAppForScenario = async (
  scenario: NormalizedScenarioV1,
  adapter: { complete(request: LLMRequest): Promise<{ content: string; model?: string }> }
) => {
  const database = createDatabase();
  const context = createProductApiContext({
    database,
    createModelAdapter: () => adapter
  });
  const app = buildApp({ context, logger: false });
  const imported = await app.inject({
    method: "POST",
    url: "/api/scenes/import",
    payload: {
      export_json: exportSceneForInternalUse({
        id: `scene-${scenario.id}`,
        source_template_id: "fixture_regression",
        scenario,
        normalized_hash: hashNormalizedScenario(scenario)
      }),
      idempotency_key: `import-${scenario.id}`
    }
  });
  expect(imported.statusCode).toBe(201);
  const started = await app.inject({
    method: "POST",
    url: `/api/scenes/${imported.json().scene.id}/sessions`,
    payload: { idempotency_key: `start-${scenario.id}` }
  });
  expect(started.statusCode).toBe(201);
  return { app, context, sessionId: started.json().session.id as string };
};

const firstRequiredStringField = (request: LLMRequest): string => {
  const step = request.allowed_steps[0];
  const schema = typeof step?.args_schema === "object" && step.args_schema !== null ? step.args_schema : undefined;
  const properties = schema?.properties ?? {};
  return (schema?.required ?? []).find((key) => properties[key]?.type === "string") ?? "content";
};

const assertUnpolluted = async (
  context: ReturnType<typeof createProductApiContext>,
  sessionId: string,
  scenario: NormalizedScenarioV1,
  before: { readonly stateVersion: number; readonly status: string; readonly transcript: unknown[]; readonly committedSteps: number }
) => {
  const view = await context.runtime.getView(sessionId);
  const events = await context.runtime.listEvents(sessionId);
  const committedSteps = events.filter((event) => event.type === "StepCommitted").length;

  expect(view.state_version).toBe(before.stateVersion);
  expect(view.status).toBe(before.status);
  expect(view.visible_transcript).toEqual(before.transcript);
  expect(committedSteps).toBe(before.committedSteps);
  expect(replayState(scenario.initial_state, events)).toEqual({
    state: view.state,
    state_version: before.stateVersion
  });
  expect(events.at(-1)).toMatchObject({
    type: "StepAttemptFailed",
    state_version_before: before.stateVersion,
    state_version_after: before.stateVersion
  });
};

describe("negative fixture regression", () => {
  it("rejects illegal selected_step without polluting committed state or replay", async () => {
    const scenario = negativeFixtures.invalidSelectedStep;
    const { context, sessionId, app } = await createAppForScenario(scenario, {
      async complete() {
        return {
          model: "fake-llm",
          content: JSON.stringify({ kind: "step", selected_step: "missing_step", content: "Invalid step", args: { question: "Invalid step" } })
        };
      }
    });
    const before = await context.runtime.getView(sessionId);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: before.state_version, idempotency_key: "bad-selected-step" }
    });

    expect(response.statusCode).toBe(200);
    await assertUnpolluted(context, sessionId, scenario, {
      stateVersion: before.state_version,
      status: before.status,
      transcript: before.visible_transcript,
      committedSteps: 0
    });
  });

  it("keeps invisible resource references out of prompt, session view, API response, review evidence, and debug-safe output", async () => {
    const scenario = negativeFixtures.invisibleResourceReference;
    const hiddenText = "hidden calibration notes";
    let capturedRequest: LLMRequest | null = null;
    const { context, sessionId, app } = await createAppForScenario(scenario, {
      async complete(request) {
        capturedRequest = request;
        return {
          model: "fake-llm",
          content: JSON.stringify({
            kind: "step",
            selected_step: "ask_sensitive_question",
            content: "Should not see private notes.",
            args: {
              question: "Should not see private notes.",
              material_path: "$.resources.private_notes"
            }
          })
        };
      }
    });
    const before = await context.runtime.getView(sessionId);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: before.state_version, idempotency_key: "invisible-ref" }
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(capturedRequest)).not.toContain(hiddenText);
    expect(JSON.stringify(response.json())).not.toContain(hiddenText);
    await assertUnpolluted(context, sessionId, scenario, {
      stateVersion: before.state_version,
      status: before.status,
      transcript: before.visible_transcript,
      committedSteps: 0
    });

    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/end`,
      payload: { expected_state_version: before.state_version, idempotency_key: "end-after-invisible-ref" }
    });
    const review = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/reviews`,
      payload: { idempotency_key: "review-after-invisible-ref" }
    });
    expect(JSON.stringify(review.json())).not.toContain(hiddenText);
  });

  it("returns stable conflict semantics for stale expected_state_version without auto-healing", async () => {
    const scenario = negativeFixtures.stateVersionConflict;
    const { context, sessionId, app } = await createAppForScenario(scenario, {
      async complete() {
        return {
          model: "fake-llm",
          content: JSON.stringify({ kind: "step", selected_step: "ask_opening_1", content: "Fresh question", args: { question: "Fresh question" } })
        };
      }
    });
    const before = await context.runtime.getView(sessionId);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/input`,
      payload: {
        input: "Stale input must not be accepted.",
        expected_state_version: before.state_version + 1,
        idempotency_key: "stale-version"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict");
    const view = await context.runtime.getView(sessionId);
    const events = await context.runtime.listEvents(sessionId);
    expect(view.state_version).toBe(before.state_version);
    expect(view.status).toBe(before.status);
    expect(view.visible_transcript).toEqual(before.visible_transcript);
    expect(events.map((event: RuntimeEvent) => event.type)).toEqual(["SessionStarted"]);
    expect(replayState(scenario.initial_state, events)).toEqual({ state: view.state, state_version: before.state_version });
  });
});

describe("stress fixture regression", () => {
  it("creates debate_match through the API and runs through judge commentary with review evidence", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const draft = await app.inject({
      method: "POST",
      url: "/api/drafts/from-template",
      payload: { template_id: "debate_match", params: {}, idempotency_key: "debate-draft" }
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().draft.semantic_preview.stages.map((stage: { title: string }) => stage.title)).toContain("评委点评");

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/drafts/" + draft.json().draft.id + "/confirm",
      payload: { idempotency_key: "debate-confirm" }
    });
    expect(confirmed.statusCode).toBe(201);

    const started = await app.inject({
      method: "POST",
      url: "/api/scenes/" + confirmed.json().scene.id + "/sessions",
      payload: { idempotency_key: "debate-start" }
    });
    expect(started.statusCode).toBe(201);

    let session = started.json().session as {
      id: string;
      status: string;
      view: {
        state_version: number;
        allowed_steps: Array<{ id: string; actor_id: string; actor_kind: "user" | "ai" | "system" }>;
        visible_transcript: unknown[];
      };
    };

    for (let turn = 0; turn < 80 && session.status === "running"; turn += 1) {
      const aiStep = session.view.allowed_steps.find((step) => step.actor_kind === "ai");
      if (aiStep !== undefined) {
        const response = await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/ai-turn`,
          payload: {
            actor_id: aiStep.actor_id,
            expected_state_version: session.view.state_version,
            idempotency_key: `debate-ai-${turn}`
          }
        });
        expect(response.statusCode).toBe(200);
        session = response.json().session;
        continue;
      }

      const userStep = session.view.allowed_steps.find((step) => step.actor_kind === "user");
      if (userStep === undefined) {
        break;
      }
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/input`,
        payload: {
          input: "正方基于公开材料提出清晰论点并回应反方质疑。",
          expected_state_version: session.view.state_version,
          idempotency_key: `debate-user-${turn}`
        }
      });
      expect(response.statusCode).toBe(200);
      session = response.json().session;
    }

    expect(session.status).toBe("completed");
    expect(session.view.visible_transcript.length).toBeGreaterThanOrEqual(6);

    const review = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/reviews`,
      payload: { idempotency_key: "debate-review" }
    });
    expect(review.statusCode).toBe(201);
    const reviewBody = review.json().review as {
      status: string;
      dimensions: Array<{ name: string; evidence_refs: Array<{ event_id: string; actor_id: string }> }>;
      key_moments: Array<{ evidence_ref: { event_id: string; actor_id: string } }>;
      recommendations: Array<{ evidence_refs?: Array<{ event_id: string; actor_id: string }> }>;
      evidence_refs: Array<{ session_id: string; event_id: string; actor_id: string }>;
      evidence_summary: { answer_count: number; cited_answer_count: number; coverage: string; confidence: string };
      credibility_checks: Array<{ message: string }>;
      uncertainty_notes: string[];
    };
    expect(reviewBody).toMatchObject({
      status: "succeeded",
      evidence_refs: expect.arrayContaining([expect.objectContaining({ session_id: session.id })])
    });
    expect(reviewBody.dimensions.map((dimension) => dimension.name)).toEqual([
      "论点抓取",
      "质询质量",
      "反驳有效性",
      "自由辩协作",
      "立场稳定",
      "表达清晰度"
    ]);
    expect(reviewBody.evidence_summary).toMatchObject({
      answer_count: 16,
      cited_answer_count: 16,
      coverage: "sufficient",
      confidence: "high"
    });
    expect(reviewBody.uncertainty_notes.join("\n")).not.toContain("仅基于 2 条用户回答");
    expect(reviewBody.key_moments.length).toBeGreaterThanOrEqual(2);
    expect(reviewBody.key_moments.map((moment) => moment.evidence_ref.actor_id)).toEqual(
      expect.arrayContaining(["user_affirmative_second", "user_affirmative_second"])
    );
    expect(new Set(reviewBody.key_moments.map((moment) => moment.evidence_ref.actor_id))).toEqual(new Set(["user_affirmative_second"]));
    const userMomentEventIds = reviewBody.key_moments.map((moment) => moment.evidence_ref.event_id);
    const dimensionEventIds = reviewBody.dimensions.flatMap((dimension) => dimension.evidence_refs).map((ref) => ref.event_id);
    const recommendationEventIds = reviewBody.recommendations.flatMap((recommendation) => recommendation.evidence_refs ?? []).map((ref) => ref.event_id);
    expect(dimensionEventIds).toEqual(expect.arrayContaining(userMomentEventIds));
    expect(recommendationEventIds).toEqual(expect.arrayContaining(userMomentEventIds));
    expect(JSON.stringify(reviewBody.credibility_checks)).toContain("16/16");
    expect(JSON.stringify(reviewBody.credibility_checks)).not.toContain("0/16");
  });

  it("keeps branch tree product-safe for forked fixture sessions", async () => {
    const template = (builtInTemplates as readonly BranchTreeFixtureTemplate[]).find((item) => item.id === "job_interview");
    if (template === undefined) {
      throw new Error("job_interview template must exist for branch tree regression.");
    }
    const scenario = template.buildScenario(template.default_params);
    const { app, sessionId } = await createAppForScenario(scenario, {
      async complete(request) {
        const step = request.allowed_steps[0];
        if (step === undefined) {
          return { model: "fake-llm", content: "{}" };
        }
        const field = firstRequiredStringField(request);
        return {
          model: "fake-llm",
          content: JSON.stringify({
            kind: "step",
            selected_step: step.id,
            content: "Branch tree fixture question.",
            args: { [field]: "Branch tree fixture question." }
          })
        };
      }
    });

    const ai = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "branch-tree-fixture-ai" }
    });
    expect(ai.statusCode).toBe(200);
    const eventId = ai.json().session.view.visible_transcript[0].event_id as string;
    const forked = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/forks`,
      payload: { fork_point_event_id: eventId, idempotency_key: "branch-tree-fixture-fork" }
    });
    expect(forked.statusCode).toBe(201);

    const childSessionId = forked.json().session.id as string;
    const tree = await app.inject({ method: "GET", url: `/api/sessions/${childSessionId}/branch-tree` });

    expect(tree.statusCode).toBe(200);
    expect(JSON.stringify(tree.json())).not.toMatch(/state_version|actor_id|step_id|RuntimeEvent|event_json|scenario_json/i);
    expect(tree.json().tree.nodes[0].children).toEqual([
      expect.objectContaining({ session_id: childSessionId })
    ]);
  });

  it("validates non-MVP drafts and runs a minimal runtime round without productizing them", async () => {
    expect(stressFixtureDrafts.map((scenario) => scenario.id)).toEqual([
      "stress_who_is_undercover",
      "stress_salary_negotiation"
    ]);

    for (const scenario of stressFixtureDrafts) {
      expect(NormalizedScenarioV1Schema.parse(scenario)).toEqual(scenario);
      expect(validateScenario(scenario)).toEqual({ ok: true, errors: [] });

      const { context, sessionId, app } = await createAppForScenario(scenario, {
        async complete(request) {
          const step = request.allowed_steps[0];
          if (step === undefined) {
            return { model: "fake-llm", content: "{}" };
          }
          const field = firstRequiredStringField(request);
          return {
            model: "fake-llm",
            content: JSON.stringify({
              kind: "step",
              selected_step: step.id,
              content: `stress probe for ${scenario.id}`,
              args: { [field]: `stress probe for ${scenario.id}` }
            })
          };
        }
      });
      const before = await context.runtime.getView(sessionId);
      const firstAllowedStep = before.allowed_steps[0];
      if (firstAllowedStep === undefined) {
        throw new Error(`Stress scenario ${scenario.id} must expose an initial allowed step.`);
      }
      const response =
        firstAllowedStep.actor_kind === "ai"
          ? await app.inject({
              method: "POST",
              url: `/api/sessions/${sessionId}/ai-turn`,
              payload: {
                actor_id: firstAllowedStep.actor_id,
                expected_state_version: before.state_version,
                idempotency_key: `stress-${scenario.id}`
              }
            })
          : await app.inject({
              method: "POST",
              url: `/api/sessions/${sessionId}/input`,
              payload: {
                input: `stress response for ${scenario.id}`,
                expected_state_version: before.state_version,
                idempotency_key: `stress-${scenario.id}`
              }
            });
      expect(response.statusCode).toBe(200);
      expect((await context.runtime.listEvents(sessionId)).filter((event) => event.type === "StepCommitted")).toHaveLength(1);
    }

    expect(builtInTemplates.map((template) => template.id)).toEqual([
      "job_interview",
      "thesis_defense",
      "promotion_review",
      "debate_match",
      "b2b_sales_discovery"
    ]);
    expect(JSON.stringify(builtInTemplates)).not.toMatch(/undercover|salary|negotiation|谁是卧底|薪资/iu);
  });
});
