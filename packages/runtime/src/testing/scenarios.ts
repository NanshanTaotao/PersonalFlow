import type { JsonObject, NormalizedScenarioV1, RoleContractV3, StepContractV3 } from "@personalflow/contracts";

const userRole = (id: string, displayName: string, _stageIds: readonly string[], _tags: readonly string[] = []): RoleContractV3 => ({
  id,
  kind: "user",
  display_name: displayName,
  identity: displayName,
  goal: "Provide user input for the runtime test.",
  behavior_style: "concise"
});

const aiRole = (id: string, displayName: string, _stageIds: readonly string[], _tags: readonly string[] = []): RoleContractV3 => ({
  id,
  kind: "ai",
  display_name: displayName,
  identity: displayName,
  goal: "Advance the runtime test scenario.",
  behavior_style: "focused"
});

const stringArgSchema = (field: string) => ({
  type: "object" as const,
  properties: { [field]: { type: "string" as const, minLength: 1 } },
  required: [field],
  additionalProperties: false
});

const visibilityRulesFor = (roleIds: readonly string[], stageIds: readonly string[], resourcePaths: readonly string[], statePaths: readonly string[]) => [
  ...resourcePaths.map((path) => ({
    id: `visible_${path.replace(/[^a-z0-9]+/gi, "_")}`,
    subject: { role_ids: [...roleIds], stage_ids: [...stageIds] },
    target: { kind: "resource" as const, path },
    access: "full" as const
  })),
  ...statePaths.map((path) => ({
    id: `visible_${path.replace(/[^a-z0-9]+/gi, "_")}`,
    subject: { role_ids: [...roleIds], stage_ids: [...stageIds] },
    target: { kind: "state" as const, path },
    access: "full" as const
  }))
];

const basePolicies = (input: {
  readonly roleIds: readonly string[];
  readonly stageIds: readonly string[];
  readonly resourcePaths?: readonly string[];
  readonly statePaths?: readonly string[];
}) => ({
  visibility_policy: {
    default: "deny" as const,
    rules: visibilityRulesFor(input.roleIds, input.stageIds, input.resourcePaths ?? [], input.statePaths ?? [])
  },
  tool_policy: { tools: [], grants: [] },
  review_rubric: {
    dimensions: [
      {
        id: "runtime_test_dimension",
        title: "Runtime Test Dimension",
        description: "Ensures committed user-visible steps can be reviewed.",
        evidence_tags: ["candidate_answer", "assistant_response", "test_evidence"],
        evidence_requirement: "optional" as const,
        output_guidance: "Use committed visible steps only."
      }
    ]
  }
});

export const jobInterviewSmokeFixture: NormalizedScenarioV1 = {
  schema_version: "3",
  id: "scenario_interview_smoke",
  title: "Interview smoke",
  description: "Minimal V3 runtime smoke scenario.",
  domain: "runtime_test",
  version: "3.0.0",
  roles: [
    userRole("user_candidate", "Candidate", ["conversation"], ["candidate_answer"]),
    aiRole("ai_interviewer", "Interviewer", ["conversation"], ["interviewer_question"])
  ],
  stages: [
    {
      id: "conversation",
      title: "面试提问",
      goal: "Ask and answer interview questions.",
      order: 1,
      enter_when: { op: "exists", path: "$.state.turn_count" },
      exit_when: { op: "gte", path: "$.state.turn_count", value: 2 }
    }
  ],
  resources: {
    interview_context: {
      role: "后端工程师",
      focus: "过往项目主导能力"
    }
  },
  constants: {},
  state_schema: {
    type: "object",
    properties: { turn_count: { type: "integer", minimum: 0 } },
    required: ["turn_count"],
    additionalProperties: true
  },
  initial_state: { turn_count: 0 },
  steps: [
    {
      id: "ask_question",
      stage_id: "conversation",
      actor_id: "ai_interviewer",
      prompt: "Ask one interview question.",
      args_schema: stringArgSchema("question"),
      args_ref_paths: ["$.resources.interview_context", "$.state.turn_count"],
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: [],
      review_tags: ["interviewer_question"]
    },
    {
      id: "answer_question",
      stage_id: "conversation",
      actor_id: "user_candidate",
      prompt: "Answer the interview question.",
      args_schema: stringArgSchema("answer"),
      args_ref_paths: ["$.resources.interview_context", "$.state.turn_count"],
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: [{ op: "increment", target_path: "$.state.turn_count", amount: 1 }],
      review_tags: ["candidate_answer"]
    }
  ],
  step_order: ["ask_question", "answer_question"],
  runtime_limits: {
    max_committed_steps: 6,
    max_stage_committed_steps: 4,
    max_events: 20,
    max_failed_attempts: 6,
    max_tool_calls: 4
  },
  terminal_rules: [{ id: "terminal_turn_count", when: { op: "gte", path: "$.state.turn_count", value: 2 }, status: "completed", reason: "done" }],
  ...basePolicies({
    roleIds: ["user_candidate", "ai_interviewer"],
    stageIds: ["conversation"],
    resourcePaths: ["$.resources.interview_context"],
    statePaths: ["$.state.turn_count"]
  })
};

const stageStep = (input: {
  readonly id: string;
  readonly stageId: string;
  readonly actorId: string;
  readonly field: string;
  readonly prompt: string;
  readonly statePath: string;
  readonly stateValue: string;
  readonly reviewTags: readonly string[];
}): StepContractV3 => ({
  id: input.id,
  stage_id: input.stageId,
  actor_id: input.actorId,
  prompt: input.prompt,
  args_schema: stringArgSchema(input.field),
  args_ref_paths: [],
  preconditions: [{ op: "eq", path: input.statePath, value: input.stateValue }],
  state_effects: [],
  review_tags: [...input.reviewTags]
});

export const thesisDefenseFixture: NormalizedScenarioV1 = {
  ...jobInterviewSmokeFixture,
  id: "scenario_thesis_defense",
  title: "论文答辩 / 项目评审",
  roles: [
    userRole("user_defender", "答辩人", ["evidence", "risk"], ["candidate_answer"]),
    {
      ...aiRole("ai_method_reviewer", "方法评审", ["evidence"], ["method_review"]),
      goal: "请使用中文回复，除非用户明确要求使用其他语言。"
    },
    {
      ...aiRole("ai_impact_reviewer", "落地评审", ["risk"], ["implementation_review"]),
      goal: "请使用中文回复，除非用户明确要求使用其他语言。"
    }
  ],
  stages: [
    {
      id: "evidence",
      title: "证据追问",
      goal: "Probe evidence quality.",
      order: 1,
      enter_when: { op: "eq", path: "$.state.panel_stage", value: "evidence" },
      exit_when: { op: "neq", path: "$.state.panel_stage", value: "evidence" }
    },
    {
      id: "risk",
      title: "风险澄清",
      goal: "Probe implementation risk.",
      order: 2,
      enter_when: { op: "eq", path: "$.state.panel_stage", value: "risk" },
      exit_when: { op: "neq", path: "$.state.panel_stage", value: "risk" }
    }
  ],
  resources: {},
  state_schema: {
    type: "object",
    properties: {
      response_count: { type: "integer", minimum: 0 },
      panel_stage: { type: "string" },
      awaiting_response: { type: "boolean" },
      synthesis_complete: { type: "boolean" }
    },
    required: ["response_count", "panel_stage", "awaiting_response", "synthesis_complete"],
    additionalProperties: false
  },
  initial_state: { response_count: 0, panel_stage: "evidence", awaiting_response: false, synthesis_complete: false },
  steps: [
    stageStep({
      id: "method_evidence_probe",
      stageId: "evidence",
      actorId: "ai_method_reviewer",
      field: "question",
      prompt: "Ask about method evidence.",
      statePath: "$.state.panel_stage",
      stateValue: "evidence",
      reviewTags: ["method_review"]
    }),
    stageStep({
      id: "impact_risk_probe",
      stageId: "risk",
      actorId: "ai_impact_reviewer",
      field: "question",
      prompt: "Ask about implementation risk.",
      statePath: "$.state.panel_stage",
      stateValue: "risk",
      reviewTags: ["implementation_review"]
    })
  ],
  step_order: ["method_evidence_probe", "impact_risk_probe"],
  runtime_limits: {
    max_committed_steps: 6,
    max_stage_committed_steps: 2,
    max_events: 20,
    max_failed_attempts: 6,
    max_tool_calls: 4
  },
  terminal_rules: [{ id: "terminal_synthesis", when: { op: "eq", path: "$.state.synthesis_complete", value: true }, status: "completed", reason: "done" }],
  ...basePolicies({ roleIds: ["user_defender", "ai_method_reviewer", "ai_impact_reviewer"], stageIds: ["evidence", "risk"] })
};

export const jobInterviewFixture: NormalizedScenarioV1 = {
  ...jobInterviewSmokeFixture,
  id: "scenario_job_interview",
  title: "求职面试",
  roles: [
    userRole("user_candidate", "候选人", ["technical_probe", "behavioral_probe"], ["candidate_answer"]),
    aiRole("ai_technical_reviewer", "技术评审", ["technical_probe"], ["technical_probe"]),
    aiRole("ai_behavioral_interviewer", "行为面试官", ["behavioral_probe"], ["behavioral_probe"])
  ],
  stages: [
    {
      id: "technical_probe",
      title: "技术追问",
      goal: "Probe technical judgment.",
      order: 1,
      enter_when: { op: "eq", path: "$.state.interview_stage", value: "technical_probe" },
      exit_when: { op: "neq", path: "$.state.interview_stage", value: "technical_probe" }
    },
    {
      id: "behavioral_probe",
      title: "协作追问",
      goal: "Probe collaboration behavior.",
      order: 2,
      enter_when: { op: "eq", path: "$.state.interview_stage", value: "behavioral_probe" },
      exit_when: { op: "neq", path: "$.state.interview_stage", value: "behavioral_probe" }
    }
  ],
  state_schema: {
    type: "object",
    properties: {
      turn_count: { type: "integer", minimum: 0 },
      interview_stage: { type: "string" },
      awaiting_answer: { type: "boolean" },
      closing_complete: { type: "boolean" }
    },
    required: ["turn_count", "interview_stage", "awaiting_answer", "closing_complete"],
    additionalProperties: false
  },
  initial_state: { turn_count: 0, interview_stage: "technical_probe", awaiting_answer: false, closing_complete: false },
  steps: [
    stageStep({
      id: "technical_probe",
      stageId: "technical_probe",
      actorId: "ai_technical_reviewer",
      field: "question",
      prompt: "Ask a technical probe.",
      statePath: "$.state.interview_stage",
      stateValue: "technical_probe",
      reviewTags: ["technical_probe"]
    }),
    stageStep({
      id: "behavioral_probe",
      stageId: "behavioral_probe",
      actorId: "ai_behavioral_interviewer",
      field: "question",
      prompt: "Ask a behavioral probe.",
      statePath: "$.state.interview_stage",
      stateValue: "behavioral_probe",
      reviewTags: ["behavioral_probe"]
    })
  ],
  step_order: ["technical_probe", "behavioral_probe"],
  terminal_rules: [{ id: "terminal_closing", when: { op: "eq", path: "$.state.closing_complete", value: true }, status: "completed", reason: "done" }],
  ...basePolicies({ roleIds: ["user_candidate", "ai_technical_reviewer", "ai_behavioral_interviewer"], stageIds: ["technical_probe", "behavioral_probe"] })
};

export const promotionReviewFixture: NormalizedScenarioV1 = {
  ...jobInterviewSmokeFixture,
  id: "scenario_promotion_review",
  title: "晋升 / 绩效沟通",
  roles: [
    userRole("user_employee", "员工", ["calibration", "collaboration"], ["impact_story"]),
    aiRole("ai_calibration_reviewer", "校准评审", ["calibration"], ["calibration_probe"]),
    aiRole("ai_collaboration_observer", "协作观察者", ["collaboration"], ["collaboration_observation"])
  ],
  stages: [
    {
      id: "calibration",
      title: "级别校准",
      goal: "Probe level calibration.",
      order: 1,
      enter_when: { op: "eq", path: "$.state.promotion_stage", value: "calibration" },
      exit_when: { op: "neq", path: "$.state.promotion_stage", value: "calibration" }
    },
    {
      id: "collaboration",
      title: "协作观察",
      goal: "Probe collaboration.",
      order: 2,
      enter_when: { op: "eq", path: "$.state.promotion_stage", value: "collaboration" },
      exit_when: { op: "neq", path: "$.state.promotion_stage", value: "collaboration" }
    }
  ],
  state_schema: {
    type: "object",
    properties: {
      story_count: { type: "integer", minimum: 0 },
      promotion_stage: { type: "string" },
      awaiting_story: { type: "boolean" },
      growth_plan_complete: { type: "boolean" }
    },
    required: ["story_count", "promotion_stage", "awaiting_story", "growth_plan_complete"],
    additionalProperties: false
  },
  initial_state: { story_count: 0, promotion_stage: "calibration", awaiting_story: false, growth_plan_complete: false },
  steps: [
    stageStep({
      id: "ask_calibration_probe",
      stageId: "calibration",
      actorId: "ai_calibration_reviewer",
      field: "question",
      prompt: "Ask a calibration probe.",
      statePath: "$.state.promotion_stage",
      stateValue: "calibration",
      reviewTags: ["calibration_probe"]
    }),
    stageStep({
      id: "share_collaboration_growth_plan",
      stageId: "collaboration",
      actorId: "ai_collaboration_observer",
      field: "summary",
      prompt: "Share collaboration growth plan.",
      statePath: "$.state.promotion_stage",
      stateValue: "collaboration",
      reviewTags: ["collaboration_observation"]
    })
  ],
  step_order: ["ask_calibration_probe", "share_collaboration_growth_plan"],
  terminal_rules: [{ id: "terminal_growth", when: { op: "eq", path: "$.state.growth_plan_complete", value: true }, status: "completed", reason: "done" }],
  ...basePolicies({ roleIds: ["user_employee", "ai_calibration_reviewer", "ai_collaboration_observer"], stageIds: ["calibration", "collaboration"] })
};

export const buildDraftFromComplexConfig = (input: {
  readonly title: string;
  readonly goal: string;
  readonly user_role: string;
  readonly ai_roles: readonly { readonly name: string; readonly focus: string }[];
  readonly stages: readonly { readonly name: string; readonly rounds: number; readonly follow_up_strategy: string }[];
  readonly termination: string;
}): { readonly scenario: NormalizedScenarioV1 } => {
  const stageIds = input.stages.map((stage) => stage.name);
  const roleIds = ["user_configured", ...input.ai_roles.map((_, index) => `ai_configured_${index}`)];
  const roles = [
    userRole("user_configured", input.user_role, stageIds, ["configured_response"]),
    ...input.ai_roles.map((role, index) => aiRole(`ai_configured_${index}`, role.name, stageIds, ["configured_probe"]))
  ];
  const steps = input.stages.map((stage, index) =>
    stageStep({
      id: `configured_step_${index}`,
      stageId: stage.name,
      actorId: `ai_configured_${Math.min(index, input.ai_roles.length - 1)}`,
      field: "question",
      prompt: stage.follow_up_strategy,
      statePath: "$.state.current_stage",
      stateValue: stage.name,
      reviewTags: ["configured_probe"]
    })
  );
  return {
    scenario: {
      ...jobInterviewSmokeFixture,
      id: "scenario_complex_config",
      title: input.title,
      description: input.goal,
      resources: { complex_config: input as unknown as JsonObject },
      roles,
      stages: input.stages.map((stage, index) => ({
        id: stage.name,
        title: stage.name,
        goal: stage.follow_up_strategy,
        order: index + 1,
        enter_when: { op: "eq", path: "$.state.current_stage", value: stage.name },
        exit_when: { op: "neq", path: "$.state.current_stage", value: stage.name }
      })),
      state_schema: {
        type: "object",
        properties: {
          turn_count: { type: "integer", minimum: 0 },
          slot_index: { type: "integer", minimum: 0 },
          current_stage: { type: "string" },
          awaiting_response: { type: "boolean" },
          complete: { type: "boolean" }
        },
        required: ["turn_count", "slot_index", "current_stage", "awaiting_response", "complete"],
        additionalProperties: false
      },
      initial_state: { turn_count: 0, slot_index: 0, current_stage: input.stages[0]?.name ?? "start", awaiting_response: false, complete: false },
      steps,
      step_order: steps.map((step) => step.id),
      runtime_limits: {
        max_committed_steps: Math.max(10, steps.length * 4),
        max_stage_committed_steps: Math.max(1, ...input.stages.map((stage) => stage.rounds)),
        max_events: Math.max(30, steps.length * 8),
        max_failed_attempts: 10,
        max_tool_calls: 10
      },
      terminal_rules: [{ id: "terminal_complex", when: { op: "eq", path: "$.state.complete", value: true }, status: "completed", reason: input.termination }],
      ...basePolicies({ roleIds, stageIds, resourcePaths: ["$.resources.complex_config"], statePaths: ["$.state.current_stage"] })
    }
  };
};
