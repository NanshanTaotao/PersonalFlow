import { describe, expect, it } from "vitest";

import type { JsonObject, NormalizedScenarioV1, RuntimeEvent } from "@personalflow/contracts";
import { parseAgentOutput } from "@personalflow/agent";

import { buildVisibleContextBundle, hashStableValue, projectVisibility, renderPrompt, resolveAllowedSteps } from "./index";
import { jobInterviewSmokeFixture, thesisDefenseFixture } from "./testing/scenarios";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type StepCommittedEvent = Extract<RuntimeEvent, { type: "StepCommitted" }>;

const committedQuestion = (overrides: Partial<StepCommittedEvent> = {}): StepCommittedEvent => ({
  id: "event-question",
  session_id: "session-prompt",
  sequence: 1,
  state_version_before: 0,
  state_version_after: 0,
  created_at: "2026-06-18T00:00:01.000Z",
  type: "StepCommitted",
  payload: {
    step_id: "ask_question",
    actor_id: "ai_interviewer",
    args: { question: "Describe a backend migration." },
    state_patch: {}
  },
  ...overrides
});

const failedAttempt = (): RuntimeEvent => ({
  id: "event-failed",
  session_id: "session-prompt",
  sequence: 2,
  state_version_before: 0,
  state_version_after: 0,
  created_at: "2026-06-18T00:00:02.000Z",
  type: "StepAttemptFailed",
  payload: {
    step_id: "answer_question",
    actor_id: "user_candidate",
    reason: "Private validation reason",
    error_code: "validation_error"
  }
});

const scenarioWithPrivateMaterial = (): NormalizedScenarioV1 => ({
  ...clone(jobInterviewSmokeFixture),
  resources: {
    interview_context: {
      role: "后端工程师",
      focus: "过往项目主导能力"
    },
    private_notes: {
      content: "Do not reveal salary band."
    }
  },
  initial_state: {
    turn_count: 0,
    private_score: 7
  }
});

const buildBundle = (input?: {
  readonly scenario?: NormalizedScenarioV1;
  readonly state?: JsonObject;
  readonly events?: readonly RuntimeEvent[];
}) => {
  const scenario = input?.scenario ?? scenarioWithPrivateMaterial();
  const state = input?.state ?? { turn_count: 0, private_score: 7 };
  const events = input?.events ?? [committedQuestion(), failedAttempt()];
  const allowedSteps = resolveAllowedSteps({ scenario, state, events });

  return buildVisibleContextBundle({
    actorId: "ai_interviewer",
    scenario,
    state,
    events,
    allowedSteps
  });
};

describe("visibility, context and prompt projection", () => {
  it("uses visibility policy allow lists and keeps private state, resources and event payloads out", () => {
    const visibility = projectVisibility({
      actorId: "ai_interviewer",
      scenario: scenarioWithPrivateMaterial(),
      state: { turn_count: 0, private_score: 7 },
      events: [committedQuestion(), failedAttempt()]
    });

    expect(visibility.state).toEqual({ turn_count: 0 });
    expect(visibility.resources).toEqual({
      interview_context: {
        role: "后端工程师",
        focus: "过往项目主导能力"
      }
    });
    expect(JSON.stringify(visibility)).not.toContain("private_score");
    expect(JSON.stringify(visibility)).not.toContain("Do not reveal salary band");
    expect(JSON.stringify(visibility)).toContain("Describe a backend migration.");
    expect(JSON.stringify(visibility)).not.toContain("Private validation reason");
    expect(visibility.events).toEqual([
      {
        id: "event-question",
        sequence: 1,
        type: "StepCommitted",
        actor_id: "ai_interviewer",
        step_id: "ask_question",
        text_summary: "Describe a backend migration.",
        state_version_before: 0,
        state_version_after: 0
      },
      {
        id: "event-failed",
        sequence: 2,
        type: "StepAttemptFailed",
        actor_id: "user_candidate",
        step_id: "answer_question",
        state_version_before: 0,
        state_version_after: 0,
        error_code: "validation_error"
      }
    ]);
  });

  it("applies visibility rules only for the active stage", () => {
    const visibility = projectVisibility({
      actorId: "ai_interviewer",
      scenario: {
        ...scenarioWithPrivateMaterial(),
        visibility_policy: {
          default: "deny",
          rules: [
            {
              id: "wrong_stage_private_notes",
              subject: { role_ids: ["ai_interviewer"], stage_ids: ["later_stage"] },
              target: { kind: "resource", path: "$.resources.private_notes" },
              access: "full"
            },
            {
              id: "active_stage_turn_count",
              subject: { role_ids: ["ai_interviewer"], stage_ids: ["conversation"] },
              target: { kind: "state", path: "$.state.turn_count" },
              access: "full"
            }
          ]
        }
      },
      state: { turn_count: 0, private_score: 7 },
      events: []
    });

    expect(visibility.state).toEqual({ turn_count: 0 });
    expect(visibility.resources).toEqual({});
    expect(JSON.stringify(visibility)).not.toContain("Do not reveal salary band");
  });

  it("projects redacted visibility targets without exposing original values", () => {
    const visibility = projectVisibility({
      actorId: "ai_interviewer",
      scenario: {
        ...scenarioWithPrivateMaterial(),
        visibility_policy: {
          default: "deny",
          rules: [
            {
              id: "redacted_private_notes",
              subject: { role_ids: ["ai_interviewer"], stage_ids: ["conversation"] },
              target: { kind: "resource", path: "$.resources.private_notes" },
              access: "redacted"
            }
          ]
        }
      },
      state: { turn_count: 0, private_score: 7 },
      events: []
    });

    expect(visibility.resources).toEqual({ private_notes: "[redacted]" });
    expect(JSON.stringify(visibility)).not.toContain("Do not reveal salary band");
  });

  it("does not expose raw string resources through summary visibility", () => {
    const visibility = projectVisibility({
      actorId: "ai_interviewer",
      scenario: {
        ...scenarioWithPrivateMaterial(),
        resources: {
          ...scenarioWithPrivateMaterial().resources,
          raw_private_note: "Do not reveal salary band"
        },
        visibility_policy: {
          default: "deny",
          rules: [
            {
              id: "summary_private_note",
              subject: { role_ids: ["ai_interviewer"], stage_ids: ["conversation"] },
              target: { kind: "resource", path: "$.resources.raw_private_note" },
              access: "summary"
            }
          ]
        }
      },
      state: { turn_count: 0, private_score: 7 },
      events: []
    });

    expect(visibility.resources).toEqual({ raw_private_note: "[summary]" });
    expect(JSON.stringify(visibility)).not.toContain("Do not reveal salary band");
  });

  it("projects single attached material resources as full, summary or hidden", () => {
    const materialPath = "$.resources.user_materials_by_ref.um_runtime_material";
    const material = {
      title: "候选人简历",
      source_ref: "material:runtime",
      source_type: "library_text",
      source_label: "手动粘贴",
      summary: "候选人有后端迁移经验。",
      context_text: "RUNTIME_FULL_MATERIAL_CONTEXT"
    };
    const scenario = {
      ...scenarioWithPrivateMaterial(),
      resources: {
        user_materials_by_ref: {
          um_runtime_material: material
        }
      }
    };

    const full = projectVisibility({
      actorId: "ai_interviewer",
      scenario: {
        ...scenario,
        visibility_policy: {
          default: "deny",
          rules: [{
            id: "full_material",
            subject: { role_ids: ["ai_interviewer"], stage_ids: ["conversation"] },
            target: { kind: "resource", path: materialPath },
            access: "full"
          }]
        }
      },
      state: { turn_count: 0 },
      events: []
    });
    expect(full.resources).toEqual({
      user_materials_by_ref: {
        um_runtime_material: material
      }
    });

    const summary = projectVisibility({
      actorId: "ai_interviewer",
      scenario: {
        ...scenario,
        visibility_policy: {
          default: "deny",
          rules: [{
            id: "summary_material",
            subject: { role_ids: ["ai_interviewer"], stage_ids: ["conversation"] },
            target: { kind: "resource", path: materialPath },
            access: "summary"
          }]
        }
      },
      state: { turn_count: 0 },
      events: []
    });
    expect(summary.resources).toEqual({
      user_materials_by_ref: {
        um_runtime_material: {
          title: "候选人简历",
          source_label: "手动粘贴",
          summary: "候选人有后端迁移经验。"
        }
      }
    });
    expect(JSON.stringify(summary)).not.toContain("RUNTIME_FULL_MATERIAL_CONTEXT");

    const hidden = projectVisibility({
      actorId: "ai_interviewer",
      scenario: {
        ...scenario,
        visibility_policy: { default: "deny", rules: [] }
      },
      state: { turn_count: 0 },
      events: []
    });
    expect(hidden.resources).toEqual({});
  });

  it("uses the active stage when projecting attached material visibility", () => {
    const materialPath = "$.resources.user_materials_by_ref.um_stage_material";
    const material = {
      title: "销售背景",
      source_ref: "material:stage",
      source_type: "library_text",
      source_label: "手动粘贴",
      summary: "客户关心 ROI。",
      context_text: "STAGE_FULL_MATERIAL_CONTEXT"
    };
    const base = scenarioWithPrivateMaterial();
      const baseStage = base.stages[0];
      if (baseStage === undefined) {
        throw new Error("Expected scenario fixture to include at least one stage.");
      }
    const scenario: NormalizedScenarioV1 = {
      ...base,
      stages: [
        {
            ...baseStage,
          id: "opening",
          title: "开场",
          enter_when: { op: "eq", path: "$.state.turn_count", value: 0 }
        },
        {
            ...baseStage,
          id: "deep_dive",
          title: "深入追问",
          enter_when: { op: "eq", path: "$.state.turn_count", value: 1 }
        }
      ],
      resources: {
        user_materials_by_ref: {
          um_stage_material: material
        }
      },
      visibility_policy: {
        default: "deny",
        rules: [
          {
            id: "opening_summary_material",
            subject: { role_ids: ["ai_interviewer"], stage_ids: ["opening"] },
            target: { kind: "resource", path: materialPath },
            access: "summary"
          },
          {
            id: "deep_dive_full_material",
            subject: { role_ids: ["ai_interviewer"], stage_ids: ["deep_dive"] },
            target: { kind: "resource", path: materialPath },
            access: "full"
          }
        ]
      }
    };

    const opening = projectVisibility({
      actorId: "ai_interviewer",
      scenario,
      state: { turn_count: 0 },
      events: []
    });
    expect(JSON.stringify(opening.resources)).not.toContain("STAGE_FULL_MATERIAL_CONTEXT");
    expect(opening.resources).toEqual({
      user_materials_by_ref: {
        um_stage_material: {
          title: "销售背景",
          source_label: "手动粘贴",
          summary: "客户关心 ROI。"
        }
      }
    });

    const deepDive = projectVisibility({
      actorId: "ai_interviewer",
      scenario,
      state: { turn_count: 1 },
      events: []
    });
    expect(deepDive.resources).toEqual({
      user_materials_by_ref: {
        um_stage_material: material
      }
    });
  });

  it("builds VisibleContextBundle with visible progress, materials, allowed steps and argument requirements", () => {
    const bundle = buildBundle();

    expect(bundle.actor).toMatchObject({ id: "ai_interviewer", kind: "ai", display_name: "Interviewer" });
    expect(bundle.current_progress.state).toEqual({ turn_count: 0 });
    expect(bundle.visible_materials).toHaveLength(1);
    expect(bundle.visible_materials[0]).toMatchObject({ path: "$.resources.interview_context" });
    expect(bundle.allowed_steps.map((step) => step.id)).toEqual(["ask_question", "answer_question"]);
    expect(bundle.allowed_steps[0]?.argument_requirements).toEqual({
      args_schema: jobInterviewSmokeFixture.steps[0]?.args_schema,
      args_ref_paths: ["$.resources.interview_context", "$.state.turn_count"]
    });
    expect(JSON.stringify(bundle)).not.toContain("private_score");
    expect(JSON.stringify(bundle)).not.toContain("Do not reveal salary band");
  });

  it("renders deterministic prompt blocks and debug hashes without leaking invisible content", () => {
    const prompt = renderPrompt(buildBundle());

    expect(prompt.blocks.map((block) => block.name)).toEqual([
      "output_protocol",
      "role_identity",
      "active_stage",
      "current_progress",
      "visible_history",
      "visible_materials",
      "allowed_steps",
      "argument_requirements"
    ]);
    expect(prompt.text).toContain("You must output one strict JSON object");
    expect(prompt.text).toContain("ask_question");
    expect(prompt.text).not.toContain("private_score");
    expect(prompt.text).not.toContain("Do not reveal salary band");
    expect(prompt.text).toContain("Describe a backend migration.");
    expect(JSON.stringify(prompt.debug)).not.toContain("后端工程师");
    expect(renderPrompt(buildBundle())).toEqual(prompt);
  });

  it("renders active_stage prompt block with stage context and priority guidance", () => {
    const bundle = buildBundle();
    const prompt = renderPrompt(bundle);
    const activeStageBlock = prompt.blocks.find((block) => block.name === "active_stage");

    expect(bundle).toMatchObject({
      active_stage: {
        id: "conversation",
        title: "面试提问",
        goal: "Ask and answer interview questions."
      }
    });
    expect(prompt.blocks.map((block) => block.name)).toEqual([
      "output_protocol",
      "role_identity",
      "active_stage",
      "current_progress",
      "visible_history",
      "visible_materials",
      "allowed_steps",
      "argument_requirements"
    ]);
    expect(activeStageBlock).toBeDefined();
    expect(activeStageBlock?.text).toContain("conversation");
    expect(activeStageBlock?.text).toContain("面试提问");
    expect(activeStageBlock?.text).toContain("Ask and answer interview questions.");
    expect(activeStageBlock?.text).toContain("Role");
    expect(activeStageBlock?.text).toContain("Stage");
    expect(activeStageBlock?.text).toContain("Step prompt has highest priority");
  });

  it("omits active_stage prompt block when no stage is active", () => {
    const bundle = buildBundle({
      scenario: {
        ...scenarioWithPrivateMaterial(),
        stages: scenarioWithPrivateMaterial().stages.map((stage) => ({
          ...stage,
          enter_when: { op: "eq" as const, path: "$.state.turn_count", value: 99 }
        }))
      },
      events: []
    });
    const prompt = renderPrompt(bundle);

    expect(bundle.active_stage).toBeUndefined();
    expect(prompt.blocks.some((block) => block.name === "active_stage")).toBe(false);
  });

  it("renders safe visible transcript text summaries inside the visible_history prompt block", () => {
    const secret = "dummy-secret-for-debug-observability-only";
    const longVisibleQuestion = "Visible launch question? " + "x".repeat(180);
    const expectedSummary = longVisibleQuestion.slice(0, 157) + "...";
    const prompt = renderPrompt(
      buildBundle({
        events: [
          committedQuestion({
            payload: {
              step_id: "ask_question",
              actor_id: "ai_interviewer",
              args: {
                question: longVisibleQuestion,
                raw_prompt: "FULL PROMPT " + secret,
                provider_raw_response: "provider raw response " + secret,
                secret_debug_field: secret
              },
              state_patch: {}
            }
          })
        ]
      })
    );
    const visibleHistory = prompt.blocks.find((block) => block.name === "visible_history");

    expect(visibleHistory).toBeDefined();
    expect(visibleHistory?.text).toContain("text_summary");
    expect(visibleHistory?.text).toContain(expectedSummary);
    expect(prompt.text).toContain(expectedSummary);
    expect(prompt.text).not.toContain(longVisibleQuestion);
    expect(prompt.text).not.toContain(secret);
    expect(prompt.text).not.toMatch(/FULL PROMPT|raw_prompt|provider raw|provider_raw_response|secret_debug_field/i);
    expect(visibleHistory?.text).not.toContain("\"args\"");
  });

  it("does not derive visible transcript summaries from credential-like args", () => {
    const sensitiveValues = {
      apiKey: "test-api-key-secret",
      access_token: "access-token-secret",
      password: "password-secret",
      authorization: "Authorization: Bearer auth-secret",
      bearerToken: "bearer-token-secret",
      signingKey: "signing-key-secret",
      credential: "credential-secret"
    };
    const prompt = renderPrompt(
      buildBundle({
        events: [
          committedQuestion({
            payload: {
              step_id: "ask_question",
              actor_id: "ai_interviewer",
              args: sensitiveValues,
              state_patch: {}
            }
          })
        ]
      })
    );
    const visibleHistory = prompt.blocks.find((block) => block.name === "visible_history");

    expect(visibleHistory).toBeDefined();
    expect(visibleHistory?.text).toContain("\"text_summary\":null");
    for (const value of Object.values(sensitiveValues)) {
      expect(prompt.text).not.toContain(value);
    }
    expect(prompt.text).not.toMatch(/apiKey|access_token|password|authorization|bearerToken|signingKey|credential/i);
  });

  it("keeps output_protocol aligned with the strict Agent parser protocol", () => {
    const prompt = renderPrompt(buildBundle());
    const outputProtocol = prompt.blocks.find((block) => block.name === "output_protocol");
    expect(outputProtocol).toBeDefined();
    expect(outputProtocol?.text).toContain("kind");
    expect(outputProtocol?.text).toContain("step");
    expect(outputProtocol?.text).toContain("selected_step");
    expect(outputProtocol?.text).toContain("content");
    expect(outputProtocol?.text).toContain("args");
    expect(outputProtocol?.text).toContain("Do not wrap the JSON in Markdown");
    expect(outputProtocol?.text).toContain("不要输出 Markdown");
    expect(outputProtocol?.text).toContain("strict_step_example");
    expect(outputProtocol?.text).toContain("\"kind\":\"step\"");
    expect(outputProtocol?.text).toContain("\"selected_step\":\"ask_question\"");
    expect(outputProtocol?.text).toContain("\"content\":\"Question\"");
    expect(outputProtocol?.text).toContain("\"question\":\"What project did you own end to end?\"");
    expect(outputProtocol?.text).not.toContain("step_id");

    const argumentRequirements = prompt.blocks.find((block) => block.name === "argument_requirements");
    expect(argumentRequirements).toBeDefined();
    expect(argumentRequirements?.text).toContain("kind");
    expect(argumentRequirements?.text).toContain("selected_step");
    expect(argumentRequirements?.text).not.toContain("step_id");

    expect(
      parseAgentOutput(
        JSON.stringify({
          kind: "step",
          selected_step: "ask_question",
          content: "Question",
          args: { question: "What project did you own end to end?" }
        })
      )
    ).toMatchObject({ ok: true });
  });

  it("guides AI follow-up turns to avoid repeating prior visible questions", () => {
    const prompt = renderPrompt(
      buildBundle({
        events: [
          committedQuestion({
            payload: {
              step_id: "ask_question",
              actor_id: "ai_interviewer",
              args: { question: "你们如何测试 outbox 消费风暴和重试放大？" },
              state_patch: {}
            }
          })
        ]
      })
    );
    const outputProtocol = prompt.blocks.find((block) => block.name === "output_protocol");

    expect(outputProtocol?.text).toContain("Do not repeat prior visible questions");
    expect(outputProtocol?.text).toContain("Advance one new dimension");
    expect(outputProtocol?.text).toContain("Do not invent facts");
    expect(prompt.text).toContain("你们如何测试 outbox 消费风暴和重试放大？");
  });

  it("includes Chinese output guidance for the thesis defense runtime prompt", () => {
    const allowedSteps = resolveAllowedSteps({
      scenario: thesisDefenseFixture,
      state: thesisDefenseFixture.initial_state,
      events: []
    });
    const prompt = renderPrompt(
      buildVisibleContextBundle({
        actorId: "ai_method_reviewer",
        scenario: thesisDefenseFixture,
        state: thesisDefenseFixture.initial_state,
        events: [],
        allowedSteps
      })
    );

    expect(prompt.text).toContain("请使用中文回复，除非用户明确要求使用其他语言。");
  });

  it("changes only related hashes for visible input changes", () => {
    const first = renderPrompt(buildBundle({ state: { turn_count: 0, private_score: 7 } }));
    const changed = renderPrompt(buildBundle({ state: { turn_count: 1, private_score: 7 } }));
    const firstByName = new Map(first.blocks.map((block) => [block.name, block.hash]));
    const changedByName = new Map(changed.blocks.map((block) => [block.name, block.hash]));

    expect(changed.prompt_hash).not.toBe(first.prompt_hash);
    expect(changedByName.get("current_progress")).not.toBe(firstByName.get("current_progress"));
    expect(changedByName.get("role_identity")).toBe(firstByName.get("role_identity"));
  });

  it("does not change prompt text or hashes for invisible resources and invisible state", () => {
    const scenario = {
      ...scenarioWithPrivateMaterial()
    };
    const base = renderPrompt(
      buildBundle({
        scenario,
        state: { turn_count: 0, private_score: 7 },
        events: [committedQuestion({ id: "event-latest", sequence: 1 })]
      })
    );
    const changedScenario = {
      ...scenario,
      resources: { ...scenario.resources, private_notes: { content: "Changed invisible salary band." } }
    };
    const changed = renderPrompt(
      buildBundle({
        scenario: changedScenario,
        state: { turn_count: 0, private_score: 999 },
        events: [committedQuestion({ id: "event-latest", sequence: 1 })]
      })
    );

    expect(changed).toEqual(base);
  });

  it("hashes objects stably regardless of insertion order", () => {
    expect(hashStableValue({ b: 2, a: { d: 4, c: 3 } })).toBe(hashStableValue({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it("keeps PromptRenderer typed to visible bundles instead of full scenarios", () => {
      const assertVisibleBundleOnly = () => {
      // @ts-expect-error PromptRenderer must not accept full NormalizedScenarioV1.
      renderPrompt(jobInterviewSmokeFixture);
      };
      expect(typeof assertVisibleBundleOnly).toBe("function");
  });
});
