import { describe, expect, it } from "vitest";

import { GetBranchTreeResponseSchema } from "./api";
import {
  AiTurnResponseSchema,
  ApiErrorCodeSchema,
  CommitRuntimeCommandRequestSchema,
  CommitRuntimeCommandResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  GetReviewReportResponseSchema,
  GetSessionResponseSchema,
  GuardExprV1Schema,
  NormalizedScenarioSchema,
  NormalizedScenarioV1Schema,
  NormalizedScenarioV2Schema,
  ProductSessionSchema,
  ReviewReportSchema,
  RuntimeIRV3Schema,
  RuntimeCommandRequestSchema,
  RuntimeEventSchema,
  ScenarioPackageV1Schema,
  SessionStatusSchema,
  SessionViewSchema,
  StateEffectV1Schema,
  StepContractV1Schema,
  createId,
  type RuntimeEventStore,
  type RuntimeSessionStore,
  type RuntimeUnitOfWork
} from "./index";
import {
  BranchTreeResponseSchema,
  CreateSessionForkRequestSchema,
  SessionBranchRecordSchema,
  WithdrawUserInputRequestSchema
} from "./session-branch";

const baseStep = {
  id: "step_greet",
  actor_id: "actor_ai",
  prompt: "Greet the user and ask one deterministic question.",
  args_schema: {
    type: "object",
    properties: {
      message: { type: "string" }
    },
    required: ["message"],
    additionalProperties: false
  },
  args_ref_paths: ["$.resources.profile"],
  preconditions: [{ op: "exists", path: "$.state.started" }],
  accept_when: { op: "contains", path: "$.args.message", value: "hello" },
  state_effects: [
    { op: "set", target_path: "$.state.last_message", value_from: "$.args.message" }
  ],
  review_tags: ["opening"]
};

const baseScenario = {
  schema_version: "1",
  id: "scenario_interview_smoke",
  title: "Interview practice",
  description: "Minimal executable scenario contract.",
  actors: [
    { id: "actor_user", kind: "user", display_name: "Candidate" },
    { id: "actor_ai", kind: "ai", display_name: "Interviewer" }
  ],
  resources: {
    profile: { name: "Ada" }
  },
  constants: {
    max_turns: 2
  },
  state_schema: {
    type: "object",
    properties: {
      started: { type: "boolean" },
      last_message: { type: "string" },
      turn_count: { type: "number" }
    },
    required: ["started", "turn_count"],
    additionalProperties: false
  },
  initial_state: {
    started: true,
    turn_count: 0
  },
  steps: [baseStep],
  scheduler: {
    strategy: "ordered",
    entry_step_ids: ["step_greet"],
    candidate_step_ids: ["step_greet"],
    max_steps: 4
  },
  terminal_rules: [
    {
      id: "terminal_turn_limit",
      when: { op: "gte", path: "$.state.turn_count", value_from: "$.constants.max_turns" },
      status: "completed",
      reason: "Turn limit reached."
    }
  ],
  context_profile: {
    visible_state_paths: ["$.state.started", "$.state.turn_count"],
    visible_resource_paths: ["$.resources.profile"],
    event_window: 4
  }
};

const baseScenarioV2 = {
  schema_version: "2",
  id: "scenario_v2_smoke",
  title: "Scenario V2 smoke",
  description: "Minimal Scenario V2 runtime protocol contract.",
  domain: "general",
  version: "0.1.0",
  roles: [
    {
      id: "role_user",
      kind: "user",
      display_name: "Participant",
      source: { kind: "inline", ref: "roles.participant" },
      identity: "A human participant in the scenario.",
      goal: "Provide the requested input.",
      behavior_style: "clear and concise",
      stage_behaviors: [
        {
          stage_id: "stage_collect",
          goal: "Share the requested input.",
          behavior_style: "direct"
        }
      ],
      forbidden_behaviors: ["Do not reveal hidden resources."],
      requested_capabilities: ["text_input"],
      default_visibility_scope: "stage",
      review_contribution_tags: ["participant_input"]
    },
    {
      id: "role_ai",
      kind: "ai",
      display_name: "Assistant",
      source: { kind: "inline", ref: "roles.assistant" },
      identity: "An AI role that follows the scenario contract.",
      goal: "Respond using only visible context.",
      behavior_style: "grounded and helpful",
      stage_behaviors: [
        {
          stage_id: "stage_collect",
          goal: "Acknowledge the input and ask one follow-up.",
          behavior_style: "focused"
        }
      ],
      forbidden_behaviors: ["Do not claim access to redacted material."],
      requested_capabilities: ["text_generation", "tool_use"],
      default_visibility_scope: "stage",
      review_contribution_tags: ["assistant_response"]
    }
  ],
  stages: [
    {
      id: "stage_collect",
      title: "Collect input",
      goal: "Collect one input and produce one response.",
      order: 1,
      enter_when: { op: "exists", path: "$.state.started" },
      exit_when: { op: "gte", path: "$.state.turn_count", value_from: "$.constants.max_turns" },
      allowed_role_ids: ["role_user", "role_ai"],
      allowed_step_ids: ["step_ai_response"],
      max_turns: 2
    }
  ],
  resources: {
    briefing: { summary: "Shared instructions." }
  },
  constants: {
    max_turns: 2
  },
  state_schema: {
    type: "object",
    properties: {
      started: { type: "boolean" },
      turn_count: { type: "number" },
      last_response: { type: "string" }
    },
    required: ["started", "turn_count"],
    additionalProperties: false
  },
  initial_state: {
    started: true,
    turn_count: 0
  },
  steps: [
    {
      id: "step_ai_response",
      stage_id: "stage_collect",
      actor_id: "role_ai",
      prompt: "Acknowledge the latest input and ask one follow-up.",
      args_schema: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.briefing"],
      preconditions: [{ op: "exists", path: "$.state.started" }],
      accept_when: { op: "contains", path: "$.args.message", value: "acknowledged" },
      state_effects: [
        { op: "set", target_path: "$.state.last_response", value_from: "$.args.message" },
        { op: "increment", target_path: "$.state.turn_count", amount: 1 }
      ],
      review_tags: ["assistant_response"]
    }
  ],
  scheduler: {
    strategy: "ordered",
    entry_step_ids: ["step_ai_response"],
    candidate_step_ids: ["step_ai_response"],
    max_steps: 4
  },
  visibility_policy: {
    default: "deny",
    rules: [
      {
        id: "visibility_state_turns",
        subject: { role_ids: ["role_ai"], stage_ids: ["stage_collect"] },
        target: { kind: "state", path: "$.state.turn_count" },
        access: "full"
      },
      {
        id: "visibility_resource_briefing",
        subject: { role_ids: ["role_user", "role_ai"], stage_ids: ["stage_collect"] },
        target: { kind: "resource", path: "$.resources.briefing" },
        access: "summary"
      }
    ]
  },
  tool_policy: {
    tools: [
      {
        id: "tool_lookup",
        kind: "mock_rag_query",
        description: "Lookup allowed reference data.",
        args_schema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    ],
    grants: [{ role_id: "role_ai", stage_id: "stage_collect", tool_id: "tool_lookup" }]
  },
  rag_policy: {
    sources: [
      {
        id: "source_briefing",
        title: "Briefing",
        visibility_label: "shared",
        trust_level: "high"
      }
    ]
  },
  terminal_rules: [
    {
      id: "terminal_turn_limit",
      when: { op: "gte", path: "$.state.turn_count", value_from: "$.constants.max_turns" },
      status: "completed",
      reason: "Turn limit reached."
    }
  ],
  review_rubric: {
    dimensions: [
      {
        id: "dimension_grounding",
        title: "Grounding",
        description: "Uses visible evidence and avoids hidden data.",
        evidence_tags: ["assistant_response"],
        evidence_requirement: "required",
        insufficient_evidence_policy: "state_uncertainty",
        output_guidance: "Explain which evidence is missing."
      }
    ],
    key_moment_rules: [
      {
        id: "moment_response",
        when: { op: "exists", path: "$.events.last.type" },
        evidence_tags: ["assistant_response"],
        guidance: "Select the most useful committed response as the key moment."
      }
    ],
    recommendation_policy: "Recommendations must reference evidence or explicitly state uncertainty.",
    calibration_tags: ["grounded"]
  },
  quality_checks: {
    required: ["structure", "visibility", "tool_policy", "review_rubric"]
  }
};

const runtimeIRV3 = {
  schema_version: "3",
  id: "scenario_runtime_ir_v3_smoke",
  title: "RuntimeIR v3 smoke",
  description: "Minimal runtime executable scenario.",
  domain: "runtime-test",
  version: "1.0.0",
  roles: [
    {
      id: "user_participant",
      kind: "user",
      display_name: "参与者",
      identity: "你是参与演练的人。",
      goal: "回应当前问题。",
      behavior_style: "直接、具体。"
    },
    {
      id: "ai_coach",
      kind: "ai",
      display_name: "教练",
      identity: "你是演练教练。",
      goal: "提出一个聚焦问题。",
      behavior_style: "清晰、简洁。"
    }
  ],
  stages: [
    {
      id: "opening",
      title: "开场",
      goal: "确认上下文并提出第一个问题。",
      order: 0,
      enter_when: { op: "eq", path: "$.state.turn_count", value: 0 },
      exit_when: { op: "gte", path: "$.state.turn_count", value: 1 }
    }
  ],
  steps: [
    {
      id: "ask_opening_question",
      stage_id: "opening",
      actor_id: "ai_coach",
      prompt: "提出一个开场问题。",
      args_schema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: [],
      preconditions: [{ op: "eq", path: "$.state.awaiting_answer", value: false }],
      state_effects: [{ op: "set", target_path: "$.state.awaiting_answer", value: true }],
      review_tags: ["coach_question"]
    },
    {
      id: "answer_opening_question",
      stage_id: "opening",
      actor_id: "user_participant",
      prompt: "回答当前问题。",
      args_schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false
      },
      args_ref_paths: [],
      preconditions: [{ op: "eq", path: "$.state.awaiting_answer", value: true }],
      state_effects: [
        { op: "increment", target_path: "$.state.turn_count", amount: 1 },
        { op: "set", target_path: "$.state.awaiting_answer", value: false }
      ],
      review_tags: ["participant_answer"]
    }
  ],
  step_order: ["ask_opening_question", "answer_opening_question"],
  runtime_limits: {
    max_committed_steps: 10,
    max_stage_committed_steps: 10,
    max_events: 20,
    max_failed_attempts: 5,
    max_tool_calls: 5
  },
  resources: {},
  constants: {},
  state_schema: {
    type: "object",
    properties: {
      turn_count: { type: "number" },
      awaiting_answer: { type: "boolean" }
    },
    required: ["turn_count", "awaiting_answer"],
    additionalProperties: false
  },
  initial_state: { turn_count: 0, awaiting_answer: false },
  visibility_policy: { default: "deny", rules: [] },
  tool_policy: { tools: [], grants: [] },
  terminal_rules: [
    {
      id: "one_turn_done",
      when: { op: "gte", path: "$.state.turn_count", value: 1 },
      status: "completed",
      reason: "One turn completed."
    }
  ],
  review_rubric: {
    dimensions: [
      {
        id: "answer_quality",
        title: "回答质量",
        description: "是否具体回应问题。",
        evidence_tags: ["participant_answer"],
        evidence_requirement: "required",
        output_guidance: "引用用户回答判断。"
      }
    ]
  }
} as const;

const baseAllowedStepView = {
  id: baseStep.id,
  actor_id: baseStep.actor_id,
  actor_kind: "ai",
  args_schema: baseStep.args_schema,
  args_ref_paths: baseStep.args_ref_paths,
  review_tags: baseStep.review_tags
};

describe("runtime contracts", () => {
  it("exports error codes and createId", () => {
    expect(ApiErrorCodeSchema.options).toEqual([
      "validation_error",
      "conflict",
      "model_error",
      "permission_error",
      "scenario_quality_blocked",
      "scenario_error",
      "storage_error"
    ]);
    expect(createId("session")).toMatch(/^session_[a-z0-9]+_[a-z0-9]+$/);
  });

  it("validates session branch records and branch tree DTOs", () => {
    expect(
      SessionBranchRecordSchema.parse({
        session_id: "session_root",
        root_session_id: "session_root",
        parent_session_id: null,
        forked_from_event_id: null,
        forked_from_sequence: null,
        forked_from_state_version: null,
        fork_boundary_sequence: null,
        fork_boundary_state_version: null,
        include_selected_event: null,
        fork_mode: "root",
        branch_label: "主线",
        created_at: "2026-07-10T00:00:00.000Z"
      })
    ).toMatchObject({ fork_mode: "root", branch_label: "主线" });

    expect(
      BranchTreeResponseSchema.parse({
        root_session_id: "session_root",
        current_session_id: "session_child",
        nodes: [
          {
            session_id: "session_root",
            parent_session_id: null,
            label: "主线",
            status: "running",
            rounds: 1,
            created_at: "2026-07-10T00:00:00.000Z",
            is_current: false,
            has_review: false,
            children: [
              {
                session_id: "session_child",
                parent_session_id: "session_root",
                label: "撤回后重写",
                forked_from_sequence: 2,
                status: "running",
                rounds: 1,
                created_at: "2026-07-10T00:01:00.000Z",
                is_current: true,
                has_review: false,
                children: []
              }
            ]
          }
        ]
      }).current_session_id
    ).toBe("session_child");

    expect(
      GetBranchTreeResponseSchema.parse({
        tree: {
          root_session_id: "session_root",
          current_session_id: "session_child",
          nodes: []
        }
      }).tree.root_session_id
    ).toBe("session_root");
  });

  it("validates branch fork and withdraw requests without exposing Runtime internals as required UI fields", () => {
    expect(
      CreateSessionForkRequestSchema.parse({
        fork_point_event_id: "event-visible-ai-question",
        mode: "manual_fork",
        include_selected_event: true,
        branch_label: "从第 2 轮分支",
        idempotency_key: "fork-key"
      })
    ).toMatchObject({ include_selected_event: true });

    expect(
      WithdrawUserInputRequestSchema.parse({
        user_event_id: "event-visible-user-answer",
        branch_label: "撤回后重写",
        idempotency_key: "withdraw-key"
      })
    ).toMatchObject({ branch_label: "撤回后重写" });
  });

  it("validates branch-visible transcript entries with actor kind locators", () => {
    expect(
      SessionViewSchema.parse({
        session_id: "session_branch_actor_kind",
        scenario_id: "scenario_interview_smoke",
        status: "running",
        state_version: 1,
        state: { started: true },
        allowed_steps: [],
        visible_transcript: [
          {
            id: "visible_user_1",
            event_id: "event_user_1",
            sequence: 2,
            actor_id: "actor_user",
            actor_kind: "user",
            actor_name: "Candidate",
            text: "I owned the migration plan."
          }
        ],
        current_stage_label: "等待下一步",
        current_actor_name: null,
        next_user_action_label: "演练状态同步中，请刷新或稍后重试。"
      }).visible_transcript[0]
    ).toMatchObject({ actor_kind: "user", text: "I owned the migration plan." });
  });

  it("validates the normalized scenario and step semantic source", () => {
    expect(StepContractV1Schema.parse(baseStep)).toMatchObject({
      prompt: baseStep.prompt,
      review_tags: ["opening"]
    });
  });

  it("validates the normalized scenario v2 contract while normalized aliases require RuntimeIR v3", () => {
    expect(NormalizedScenarioV2Schema.parse(baseScenarioV2)).toMatchObject({
      schema_version: "2",
      roles: [
        expect.objectContaining({
          id: "role_user",
          source: { kind: "inline", ref: "roles.participant" },
          identity: "A human participant in the scenario."
        }),
        expect.objectContaining({
          id: "role_ai",
          requested_capabilities: ["text_generation", "tool_use"]
        })
      ],
      stages: [
        expect.objectContaining({
          id: "stage_collect",
          allowed_role_ids: ["role_user", "role_ai"],
          allowed_step_ids: ["step_ai_response"]
        })
      ],
      steps: [
        expect.objectContaining({
          id: "step_ai_response",
          stage_id: "stage_collect",
          actor_id: "role_ai"
        })
      ],
      visibility_policy: expect.objectContaining({ default: "deny" }),
      quality_checks: { required: ["structure", "visibility", "tool_policy", "review_rubric"] }
    });
    expect(NormalizedScenarioSchema.safeParse(baseScenarioV2).success).toBe(false);
    expect(NormalizedScenarioV1Schema.safeParse(baseScenarioV2).success).toBe(false);
    expect(NormalizedScenarioV1Schema.safeParse(baseScenario).success).toBe(false);
    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        visibility_policy: { ...baseScenarioV2.visibility_policy, default: "allow" }
      }).success
    ).toBe(false);
    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        roles: [{ ...baseScenarioV2.roles[0], system_prompt: "hidden instruction" }, baseScenarioV2.roles[1]]
      }).success
    ).toBe(false);
    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        context_profile: baseScenario.context_profile
      }).success
    ).toBe(false);

    const roleWithoutGoal = { ...baseScenarioV2.roles[0] } as Record<string, unknown>;
    delete roleWithoutGoal.goal;
    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        roles: [roleWithoutGoal, baseScenarioV2.roles[1]]
      }).success
    ).toBe(false);

    const stepWithoutStageId = { ...baseScenarioV2.steps[0] } as Record<string, unknown>;
    delete stepWithoutStageId.stage_id;
    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        steps: [stepWithoutStageId]
      }).success
    ).toBe(false);

    const dimensionWithoutEvidenceTags = { ...baseScenarioV2.review_rubric.dimensions[0] } as Record<string, unknown>;
    delete dimensionWithoutEvidenceTags.evidence_tags;
    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        review_rubric: {
          ...baseScenarioV2.review_rubric,
          dimensions: [dimensionWithoutEvidenceTags]
        }
      }).success
    ).toBe(false);

    expect(
      NormalizedScenarioV2Schema.safeParse({
        ...baseScenarioV2,
        review_rubric: {
          ...baseScenarioV2.review_rubric,
          dimensions: [{ ...baseScenarioV2.review_rubric.dimensions[0], evidence_tags: [] }]
        }
      }).success
    ).toBe(false);
  });

  it("limits guards and state effects to MVP runtime primitives", () => {
    for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "contains"] as const) {
      expect(GuardExprV1Schema.parse({ op, path: "$.state.score", value: 1 }).op).toBe(op);
    }
    expect(GuardExprV1Schema.parse({ op: "gte", path: "$.state.score", value_from: "$.constants.max_score" })).toEqual({
      op: "gte",
      path: "$.state.score",
      value_from: "$.constants.max_score"
    });
    expect(GuardExprV1Schema.parse({ op: "and", all: [{ op: "exists", path: "$.state.ready" }] })).toEqual({
      op: "and",
      all: [{ op: "exists", path: "$.state.ready" }]
    });
    expect(GuardExprV1Schema.safeParse({ op: "gte", path: "$.state.score" }).success).toBe(false);
    expect(
      GuardExprV1Schema.safeParse({ op: "gte", path: "$.state.score", value_from: "$.resources.max_score" }).success
    ).toBe(false);
    expect(GuardExprV1Schema.safeParse({ op: "round", path: "$.state.round" }).success).toBe(false);

    for (const op of ["set", "increment", "append", "remove", "clear"] as const) {
      expect(StateEffectV1Schema.parse({ op, target_path: "$.state.value", value: 1 }).op).toBe(op);
    }
    expect(StateEffectV1Schema.safeParse({ op: "vote", target_path: "$.state.vote" }).success).toBe(false);
  });

  it("validates RuntimeIR v3 and rejects v2 runtime fields", () => {
    expect(RuntimeIRV3Schema.parse(runtimeIRV3)).toEqual(runtimeIRV3);
    expect(ScenarioPackageV1Schema.parse({ runtime_ir: runtimeIRV3 })).toEqual({ runtime_ir: runtimeIRV3 });
    expect(NormalizedScenarioSchema.parse(runtimeIRV3).schema_version).toBe("3");
    expect(NormalizedScenarioV1Schema.parse(runtimeIRV3).schema_version).toBe("3");
    expect(NormalizedScenarioV1Schema.safeParse({ ...runtimeIRV3, schema_version: "2" }).success).toBe(false);
    expect(
      RuntimeIRV3Schema.safeParse({
        ...runtimeIRV3,
        scheduler: {
          strategy: "ordered",
          entry_step_ids: ["ask_opening_question"],
          candidate_step_ids: ["ask_opening_question"]
        }
      }).success
    ).toBe(false);
    expect(RuntimeIRV3Schema.safeParse({ ...runtimeIRV3, rag_policy: { sources: [] } }).success).toBe(false);
    expect(RuntimeIRV3Schema.safeParse({ ...runtimeIRV3, quality_checks: { required: ["structure"] } }).success).toBe(
      false
    );
  });

  it("restricts guard reads and state effect writes to deterministic runtime paths", () => {
    for (const path of [
      "$.state.score",
      "$.constants.max_turns",
      "$.actor.id",
      "$.args.message",
      "$.events.last.type"
    ]) {
      expect(GuardExprV1Schema.safeParse({ op: "exists", path }).success).toBe(true);
    }

    for (const path of ["$.resources.profile", "$.random.value", "$.stateful.value"]) {
      expect(GuardExprV1Schema.safeParse({ op: "exists", path }).success).toBe(false);
    }

    expect(StateEffectV1Schema.safeParse({ op: "set", target_path: "$.state.score", value: 1 }).success).toBe(true);

    for (const target_path of ["$.args.message", "$.resources.profile", "$.events.last", "$.constants.max_turns"]) {
      expect(StateEffectV1Schema.safeParse({ op: "set", target_path, value: 1 }).success).toBe(false);
    }
  });

  it("validates runtime events including failed attempts that do not advance state version", () => {
    const failed = RuntimeEventSchema.parse({
      id: "event_failed",
      session_id: "session_1",
      type: "StepAttemptFailed",
      sequence: 3,
      state_version_before: 2,
      state_version_after: 2,
      created_at: "2026-06-18T00:00:00.000Z",
      payload: {
        step_id: "step_greet",
        actor_id: "actor_ai",
        reason: "args_schema_invalid",
        error_code: "validation_error"
      }
    });

    expect(failed).toMatchObject({
      type: "StepAttemptFailed",
      state_version_before: 2,
      state_version_after: 2
    });
    expect(RuntimeEventSchema.safeParse({ ...failed, state_version_after: 3 }).success).toBe(false);
  });

  it("validates committed tool calls without advancing state version", () => {
    const committed = RuntimeEventSchema.parse({
      id: "event_tool_call_committed",
      session_id: "session_1",
      type: "ToolCallCommitted",
      sequence: 4,
      state_version_before: 2,
      state_version_after: 2,
      created_at: "2026-06-18T00:00:00.000Z",
      payload: {
        actor_id: "role_ai",
        stage_id: "stage_collect",
        tool_id: "tool_lookup",
        request: { query: "visible briefing" },
        result: {
          summary: "Found one visible briefing chunk.",
          source_ref: "source_briefing",
          doc_version_hash: "doc_hash_1",
          chunk_id: "chunk_1",
          visibility_label: "shared",
          trust_level: "high"
        }
      }
    });

    expect(committed).toMatchObject({
      type: "ToolCallCommitted",
      state_version_before: 2,
      state_version_after: 2,
      payload: {
        actor_id: "role_ai",
        stage_id: "stage_collect",
        tool_id: "tool_lookup",
        request: { query: "visible briefing" },
        result: {
          trust_level: "high"
        }
      }
    });
    if (committed.type !== "ToolCallCommitted") {
      throw new Error("expected committed tool call event");
    }

    for (const trust_level of ["high", "medium", "low"] as const) {
      expect(
        RuntimeEventSchema.safeParse({
          ...committed,
          payload: {
            ...committed.payload,
            result: { ...committed.payload.result, trust_level }
          }
        }).success
      ).toBe(true);
    }

    expect(
      RuntimeEventSchema.safeParse({
        ...committed,
        payload: {
          ...committed.payload,
          result: { ...committed.payload.result, trust_level: "unknown" }
        }
      }).success
    ).toBe(false);
    expect(RuntimeEventSchema.safeParse({ ...committed, state_version_after: 3 }).success).toBe(false);
  });

  it("validates failed tool calls without advancing state version", () => {
    const failed = RuntimeEventSchema.parse({
      id: "event_tool_call_failed",
      session_id: "session_1",
      type: "ToolCallFailed",
      sequence: 5,
      state_version_before: 2,
      state_version_after: 2,
      created_at: "2026-06-18T00:00:00.000Z",
      payload: {
        actor_id: "role_ai",
        stage_id: "stage_collect",
        tool_id: "tool_lookup",
        request: { query: "hidden resource" },
        reason: "tool_access_denied",
        error_code: "permission_error"
      }
    });

    expect(failed).toMatchObject({
      type: "ToolCallFailed",
      state_version_before: 2,
      state_version_after: 2,
      payload: {
        actor_id: "role_ai",
        stage_id: "stage_collect",
        tool_id: "tool_lookup",
        request: { query: "hidden resource" },
        reason: "tool_access_denied",
        error_code: "permission_error"
      }
    });
    expect(RuntimeEventSchema.safeParse({ ...failed, state_version_after: 3 }).success).toBe(false);
  });

  it("validates blocked session view status", () => {
    expect(SessionStatusSchema.parse("blocked")).toBe("blocked");
    expect(
      SessionViewSchema.parse({
        session_id: "session_blocked",
        scenario_id: "scenario_runtime_ir_v3_smoke",
        status: "blocked",
        state_version: 0,
        state: { turn_count: 0, awaiting_answer: false },
        allowed_steps: [],
        visible_transcript: [],
        current_stage_label: "运行时已阻断",
        current_actor_name: null,
        next_user_action_label: "运行时已阻断，请查看阻断原因。",
        blocked_summary: {
          reason: "no_allowed_step",
          message: "No allowed step is available for the active stage.",
          stage_id: "opening"
        }
      })
    ).toMatchObject({
      status: "blocked",
      blocked_summary: {
        reason: "no_allowed_step",
        stage_id: "opening"
      }
    });
  });

  it("validates blocked RuntimeBlockedCommitted events without advancing state version", () => {
    const blocked = RuntimeEventSchema.parse({
      id: "event_runtime_blocked",
      session_id: "session_1",
      type: "RuntimeBlockedCommitted",
      sequence: 1,
      state_version_before: 0,
      state_version_after: 0,
      created_at: "2026-06-18T00:00:00.000Z",
      payload: {
        reason: "no_allowed_step",
        stage_id: "opening",
        diagnostics: ["No candidate step passed guards."]
      }
    });

    expect(blocked).toMatchObject({
      type: "RuntimeBlockedCommitted",
      state_version_before: 0,
      state_version_after: 0,
      payload: {
        reason: "no_allowed_step",
        stage_id: "opening"
      }
    });
    expect(blocked.state_version_after).toBe(blocked.state_version_before);
    expect(RuntimeEventSchema.safeParse({ ...blocked, state_version_after: 1 }).success).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({
        ...blocked,
        payload: { ...blocked.payload, reason: "unknown_blocked_reason" }
      }).success
    ).toBe(false);
    expect(
      RuntimeEventSchema.safeParse({
        ...blocked,
        payload: { ...blocked.payload, diagnostics: [{ code: "no_candidate_step" }] }
      }).success
    ).toBe(false);
  });

  it("validates session view, review report, and API DTOs", () => {
    expect(
      SessionViewSchema.parse({
        session_id: "session_1",
        scenario_id: "scenario_interview_smoke",
        status: "running",
        state_version: 1,
        state: { started: true },
        allowed_steps: [baseAllowedStepView],
        visible_transcript: [
          {
            id: "visible_1",
            event_id: "event_1",
            sequence: 1,
            actor_id: "actor_ai",
            actor_kind: "ai",
            actor_name: "Interviewer",
            text: "hello"
          }
        ],
        current_stage_label: "开场提问",
        current_actor_name: "Interviewer",
        next_user_action_label: "等待 Interviewer 继续提问，可点击让 AI 提问。"
      })
    ).toMatchObject({ status: "running", allowed_steps: [{ id: "step_greet" }], visible_transcript: [{ text: "hello" }] });
    expect(
      SessionViewSchema.safeParse({
        session_id: "session_unsafe",
        scenario_id: "scenario_interview_smoke",
        status: "running",
        state_version: 1,
        state: { started: true },
        allowed_steps: [baseStep],
        visible_transcript: []
      }).success
    ).toBe(false);
    expect(
      SessionViewSchema.parse({
        session_id: "session_paused",
        scenario_id: "scenario_interview_smoke",
        status: "paused",
        state_version: 1,
        state: { started: true },
        allowed_steps: [],
        visible_transcript: [],
        current_stage_label: "演练已暂停",
        current_actor_name: null,
        next_user_action_label: "演练已暂停，可点击继续恢复。"
      }).status
    ).toBe("paused");
    expect(
      SessionViewSchema.parse({
        session_id: "session_ended",
        scenario_id: "scenario_interview_smoke",
        status: "ended",
        state_version: 1,
        state: { started: true },
        allowed_steps: [],
        visible_transcript: [],
        current_stage_label: "演练已结束",
        current_actor_name: null,
        next_user_action_label: "演练已结束，可查看复盘。"
      }).status
    ).toBe("ended");

    const evidenceRef = {
      session_id: "session_1",
      event_id: "event_1",
      sequence: 1,
      step_id: "step_greet",
      actor_id: "actor_ai"
    };
    expect(ReviewReportSchema.parse({
      id: "review_pending",
      session_id: "session_1",
      status: "pending",
      created_at: "2026-06-18T00:00:00.000Z"
    })).toMatchObject({ status: "pending" });
    expect(ReviewReportSchema.parse({
      id: "review_failed",
      session_id: "session_1",
      status: "failed",
      created_at: "2026-06-18T00:00:00.000Z",
      completed_at: "2026-06-18T00:01:00.000Z",
      error_message: "review_parse_failed"
    })).toMatchObject({ status: "failed" });
    expect(
      ReviewReportSchema.parse({
        id: "review_1",
        session_id: "session_1",
        status: "succeeded",
        summary: "Clear opening.",
        dimensions: [{ name: "opening", conclusion: "Clear", evidence_refs: [evidenceRef] }],
        key_moments: [{ title: "Greeting", description: "The AI greeted clearly.", evidence_ref: evidenceRef }],
        recommendations: [{ text: "Keep the opening concise.", evidence_refs: [evidenceRef] }],
        evidence_refs: [evidenceRef],
        uncertainty_notes: ["Only one turn was available."],
        created_at: "2026-06-18T00:00:00.000Z",
        completed_at: "2026-06-18T00:01:00.000Z"
      })
    ).toMatchObject({ status: "succeeded", evidence_refs: [evidenceRef] });
    expect(ReviewReportSchema.safeParse({
      id: "review_bad",
      session_id: "session_1",
      status: "succeeded",
      summary: "Missing evidence.",
      created_at: "2026-06-18T00:00:00.000Z",
      completed_at: "2026-06-18T00:01:00.000Z"
    }).success).toBe(false);

    expect(CreateSessionRequestSchema.parse({})).toEqual({});
    expect(CreateSessionRequestSchema.parse({ idempotency_key: "session-create-1" })).toEqual({
      idempotency_key: "session-create-1"
    });
    expect(CreateSessionRequestSchema.safeParse({ scenario_id: "scenario_interview_smoke" }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ initial_state_override: { started: true } }).success).toBe(false);
    const productSession = {
      id: "session_1",
      scenario_id: "scenario_interview_smoke",
      status: "running",
      view: {
        session_id: "session_1",
        scenario_id: "scenario_interview_smoke",
        status: "running",
        state_version: 1,
        state: { started: true },
        allowed_steps: [],
        visible_transcript: [],
        current_stage_label: "等待下一步",
        current_actor_name: null,
        next_user_action_label: "演练状态同步中，请刷新或稍后重试。",
        failure_summary: {
          message: "AI 本轮没有成功生成可用提问，已保留当前演练进度。",
          failed_attempts: 1,
          can_retry: true,
          action_label: "重试当前 AI 回合"
        }
      }
    };
    expect(ProductSessionSchema.parse(productSession)).toEqual(productSession);
    const timedProductSession = {
      ...productSession,
      id: "session_timing",
      scenario_id: "scenario_timing",
      timing: {
        started_at: "2026-07-11T10:00:00.000Z",
        updated_at: "2026-07-11T10:08:00.000Z",
        suggested_duration_label: "建议约 15 分钟"
      },
      view: {
        ...productSession.view,
        session_id: "session_timing",
        scenario_id: "scenario_timing"
      }
    };
    expect(ProductSessionSchema.parse(timedProductSession).timing?.started_at).toBe("2026-07-11T10:00:00.000Z");
    expect(SessionViewSchema.safeParse({ ...timedProductSession.view, timing: timedProductSession.timing }).success).toBe(false);
    expect(ProductSessionSchema.safeParse({ ...productSession, id: "session_mismatch" }).success).toBe(false);
    expect(ProductSessionSchema.safeParse({ ...productSession, scenario_id: "scenario_mismatch" }).success).toBe(false);
    expect(ProductSessionSchema.safeParse({ ...productSession, status: "paused" }).success).toBe(false);
    expect(CreateSessionResponseSchema.parse({ session: productSession })).toEqual({ session: productSession });
    expect(GetSessionResponseSchema.parse({ session: productSession })).toEqual({ session: productSession });
    expect(CreateSessionResponseSchema.safeParse({ session_id: "session_1" }).success).toBe(false);

    expect(CommitRuntimeCommandRequestSchema.parse({ expected_state_version: 1 })).toEqual({
      expected_state_version: 1
    });
    expect(CommitRuntimeCommandRequestSchema.parse({ expected_state_version: 1, idempotency_key: "pause-1" })).toEqual({
      expected_state_version: 1,
      idempotency_key: "pause-1"
    });
    expect(CommitRuntimeCommandRequestSchema.safeParse({
      step_id: "step_greet",
      args: { message: "hello" },
      expected_state_version: 1
    }).success).toBe(false);
    expect(CommitRuntimeCommandResponseSchema.parse({ session: productSession })).toEqual({ session: productSession });
    expect(CommitRuntimeCommandResponseSchema.safeParse({ accepted: true, view: productSession.view }).success).toBe(false);

    const aiTurnResponse = {
      session: productSession,
      ai_turn_observability: {
        adapter_kind: "fake",
        model_config_id: "default",
        provider: "fake",
        model: "fake-llm",
        visible_history: [
          {
            event_id: "event_1",
            sequence: 1,
            actor_id: "ai_interviewer",
            step_id: "ask_question",
            text_summary: "Visible question."
          }
        ]
      }
    };
    expect(AiTurnResponseSchema.parse(aiTurnResponse)).toEqual(aiTurnResponse);
    expect(AiTurnResponseSchema.safeParse({
      ...aiTurnResponse,
      ai_turn_observability: {
        ...aiTurnResponse.ai_turn_observability,
        api_key: "dummy-secret-for-debug-observability-only"
      }
    }).success).toBe(false);

    for (const review of [
      {
        id: "review_pending",
        session_id: "session_1",
        status: "pending",
        created_at: "2026-06-18T00:00:00.000Z"
      },
      {
        id: "review_failed",
        session_id: "session_1",
        status: "failed",
        created_at: "2026-06-18T00:00:00.000Z",
        completed_at: "2026-06-18T00:01:00.000Z",
        error_message: "review_parse_failed"
      },
      {
        id: "review_succeeded",
        session_id: "session_1",
        status: "succeeded",
        summary: "Clear opening.",
        dimensions: [{ name: "opening", conclusion: "Clear", evidence_refs: [evidenceRef] }],
        key_moments: [{ title: "Greeting", description: "The AI greeted clearly.", evidence_ref: evidenceRef }],
        recommendations: [{ text: "Keep the opening concise.", evidence_refs: [evidenceRef] }],
        evidence_refs: [evidenceRef],
        uncertainty_notes: ["Only one turn was available."],
        created_at: "2026-06-18T00:00:00.000Z",
        completed_at: "2026-06-18T00:01:00.000Z",
        review_adapter_kind: "fake"
      }
    ]) {
      expect(GetReviewReportResponseSchema.parse({ review })).toEqual({ review });
      expect(GetReviewReportResponseSchema.safeParse({ review: { ...review, raw_prompt: "FULL PROMPT" } }).success).toBe(false);
      expect(GetReviewReportResponseSchema.safeParse({ report: review }).success).toBe(false);
    }

    expect(
      RuntimeCommandRequestSchema.parse({
        step_id: "step_greet",
        args: { message: "hello" },
        expected_state_version: 1
      })
    ).toMatchObject({ expected_state_version: 1 });
  });
});

describe("runtime store ports", () => {
  it("define storage-independent port method contracts", async () => {
    const eventStore: RuntimeEventStore = {
      append: async (event) => event,
      listBySession: async () => []
    };
    const sessionStore: RuntimeSessionStore = {
      create: async (session) => session,
      get: async () => null,
      saveView: async (view) => view
    };
    const unitOfWork: RuntimeUnitOfWork = {
      transaction: async (fn) => fn({ events: eventStore, sessions: sessionStore })
    };

    await expect(eventStore.listBySession("session_1")).resolves.toEqual([]);
    await expect(sessionStore.get("session_1")).resolves.toBeNull();
    await expect(unitOfWork.transaction(async ({ events }) => events.listBySession("session_1"))).resolves.toEqual([]);
  });
});
