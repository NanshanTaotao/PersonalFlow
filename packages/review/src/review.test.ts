import { describe, expect, it } from "vitest";

import type { NormalizedScenarioV1, RuntimeEvent } from "@personalflow/contracts";
import { extractReviewEvidence, generateReviewReport, renderReviewPrompt, type ReviewModelAdapter } from "./index";

const scenario: NormalizedScenarioV1 = {
  schema_version: "3",
  id: "scenario-review",
  title: "Interview practice",
  description: "Minimal review scenario.",
  domain: "test",
  version: "3.0.0",
  roles: [
    {
      id: "user_candidate",
      kind: "user",
      display_name: "答辩人",
      identity: "Candidate under review.",
      goal: "Answer with concrete evidence.",
      behavior_style: "concise"
    },
    {
      id: "ai_interviewer",
      kind: "ai",
      display_name: "Interviewer",
      identity: "Interview facilitator.",
      goal: "Ask evidence-seeking questions.",
      behavior_style: "direct"
    }
  ],
  stages: [
    {
      id: "main",
      title: "Main review",
      goal: "Collect answer evidence.",
      order: 0,
      enter_when: { op: "exists", path: "$.state.turn_count" },
      exit_when: { op: "gte", path: "$.state.turn_count", value: 1 }
    }
  ],
  resources: {},
  constants: {},
  state_schema: { type: "object", properties: { turn_count: { type: "number" } }, required: ["turn_count"], additionalProperties: false },
  initial_state: { turn_count: 0 },
  steps: [
    {
      id: "answer_question",
      stage_id: "main",
      actor_id: "user_candidate",
      prompt: "Answer the interview question.",
      args_schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      args_ref_paths: [],
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: [{ op: "increment", target_path: "$.state.turn_count", amount: 1 }],
      review_tags: ["answer", "ownership"]
    },
    {
      id: "ask_question",
      stage_id: "main",
      actor_id: "ai_interviewer",
      prompt: "Ask the interview question.",
      args_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
      args_ref_paths: [],
      preconditions: [{ op: "exists", path: "$.state.turn_count" }],
      state_effects: [],
      review_tags: ["interviewer_question"]
    }
  ],
  step_order: ["answer_question", "ask_question"],
  runtime_limits: {
    max_committed_steps: 10,
    max_stage_committed_steps: 10,
    max_events: 20,
    max_failed_attempts: 5,
    max_tool_calls: 5
  },
  visibility_policy: {
    default: "deny",
    rules: [{ id: "turn-count-visible", subject: { role_ids: ["user_candidate", "ai_interviewer"], stage_ids: ["main"] }, target: { kind: "state", path: "$.state.turn_count" }, access: "full" }]
  },
  tool_policy: { tools: [], grants: [] },
  terminal_rules: [{ id: "done", when: { op: "gte", path: "$.state.turn_count", value: 1 }, status: "completed", reason: "done" }],
  review_rubric: {
    dimensions: [
      {
        id: "ownership",
        title: "ownership",
        description: "Evaluate whether the answer shows ownership with concrete evidence.",
        evidence_tags: ["answer", "ownership"],
        evidence_requirement: "required",
        output_guidance: "Use only committed answer evidence."
      },
      {
        id: "interviewer_question",
        title: "interviewer_question",
        description: "Evaluate whether the interviewer asked an evidence-seeking question.",
        evidence_tags: ["interviewer_question"],
        evidence_requirement: "optional",
        output_guidance: "Use only committed interviewer questions."
      }
    ]
  }
};

const answerOnlyScenario: NormalizedScenarioV1 = {
  ...scenario,
  review_rubric: {
    ...scenario.review_rubric,
    dimensions: scenario.review_rubric.dimensions.filter((dimension) => dimension.id === "ownership")
  }
};

const committed = (overrides: Partial<RuntimeEvent> = {}): RuntimeEvent => ({
  id: "event-answer",
  session_id: "session-review",
  sequence: 2,
  state_version_before: 0,
  state_version_after: 1,
  created_at: "2026-06-19T01:00:00.000Z",
  type: "StepCommitted",
  payload: {
    step_id: "answer_question",
    actor_id: "user_candidate",
    args: { answer: "我回应了证据链，说明实验指标、用户反馈和方案调整之间的关系。", secret_token: "hidden-token" },
    state_patch: { turn_count: 1 }
  },
  ...overrides
} as RuntimeEvent);

const failedAttempt: RuntimeEvent = {
  id: "event-failed",
  session_id: "session-review",
  sequence: 3,
  state_version_before: 1,
  state_version_after: 1,
  created_at: "2026-06-19T01:01:00.000Z",
  type: "StepAttemptFailed",
  payload: { step_id: "answer_question", actor_id: "user_candidate", reason: "invalid", error_code: "validation_error" }
};

const aiCommitted = (): RuntimeEvent => committed({
  id: "event-question",
  sequence: 1,
  payload: {
    step_id: "ask_question",
    actor_id: "ai_interviewer",
    args: { question: "Please introduce your migration work." },
    state_patch: {}
  }
});

const userAnswerCommitted = (input: { readonly id: string; readonly sequence: number; readonly answer: string }): RuntimeEvent => committed({
  id: input.id,
  sequence: input.sequence,
  payload: {
    step_id: "answer_question",
    actor_id: "user_candidate",
    args: { answer: input.answer },
    state_patch: { turn_count: input.sequence }
  }
});

const debateReviewScenario: NormalizedScenarioV1 = {
  ...scenario,
  id: "scenario-debate-review",
  title: "辩论赛",
  roles: [
    {
      ...scenario.roles[0]!,
      id: "user_affirmative_first",
      display_name: "正方一辩"
    },
    {
      ...scenario.roles[1]!,
      id: "ai_moderator",
      display_name: "主持人"
    }
  ],
  stages: [
    {
      ...scenario.stages[0]!
    }
  ],
  steps: [
    {
      ...scenario.steps[1]!,
      id: "moderator_rules",
      actor_id: "ai_moderator",
      prompt: "说明辩题、双方立场、发言顺序和裁判标准。",
      args_schema: { type: "object", properties: { announcement: { type: "string" } }, required: ["announcement"], additionalProperties: false },
      review_tags: ["logic", "live_response"]
    },
    {
      ...scenario.steps[0]!,
      id: "affirmative_opening",
      actor_id: "user_affirmative_first",
      prompt: "代表正方一辩进行开篇立论，给出核心论点和证据。",
      args_schema: { type: "object", properties: { speech: { type: "string" } }, required: ["speech"], additionalProperties: false },
      review_tags: ["argument_clarity", "evidence_reference", "teamwork"]
    },
    {
      ...scenario.steps[0]!,
      id: "affirmative_free_response",
      actor_id: "user_affirmative_first",
      prompt: "代表正方在自由辩中回应反方质疑并推进己方论证。",
      args_schema: { type: "object", properties: { response: { type: "string" } }, required: ["response"], additionalProperties: false },
      review_tags: ["rebuttal", "live_response", "teamwork"]
    }
  ],
  step_order: ["moderator_rules", "affirmative_opening", "affirmative_free_response"],
  review_rubric: {
    dimensions: [
      { id: "argument_clarity", title: "论点清晰度", description: "立场是否明确，论点是否可被追踪。", evidence_tags: ["argument_clarity"], evidence_requirement: "required", output_guidance: "引用双方立论或总结陈词中的具体表达。" },
      { id: "evidence_reference", title: "证据引用", description: "是否使用公开材料或已发言内容支撑判断。", evidence_tags: ["evidence_reference"], evidence_requirement: "required", output_guidance: "只引用公开发言和允许材料。" },
      { id: "rebuttal", title: "反驳有效性", description: "是否正面回应对方关键论点。", evidence_tags: ["rebuttal"], evidence_requirement: "required", output_guidance: "指出反驳命中的具体对象。" },
      { id: "logic", title: "逻辑一致性", description: "论证链路是否前后一致。", evidence_tags: ["logic"], evidence_requirement: "required", output_guidance: "标明前提、推理和结论是否一致。" },
      { id: "teamwork", title: "阵营协作", description: "同阵营是否补位、承接和收束。", evidence_tags: ["teamwork"], evidence_requirement: "optional", output_guidance: "观察同阵营发言之间的呼应。" },
      { id: "live_response", title: "临场回应", description: "是否根据现场追问即时调整回答。", evidence_tags: ["live_response"], evidence_requirement: "required", output_guidance: "引用攻辩或自由辩中的即时回应。" }
    ]
  }
};

const debateModeratorCommitted = (): RuntimeEvent => committed({
  id: "event-moderator",
  sequence: 1,
  payload: {
    step_id: "moderator_rules",
    actor_id: "ai_moderator",
    args: { announcement: "主持人说明规则和裁判标准。" },
    state_patch: { turn_count: 1 }
  }
});

const debateUserCommitted = (input: { readonly id: string; readonly sequence: number; readonly step_id: "affirmative_opening" | "affirmative_free_response"; readonly field: "speech" | "response"; readonly text: string }): RuntimeEvent => committed({
  id: input.id,
  sequence: input.sequence,
  payload: {
    step_id: input.step_id,
    actor_id: "user_affirmative_first",
    args: { [input.field]: input.text },
    state_patch: { turn_count: input.sequence }
  }
});

const ref = (event: RuntimeEvent = committed()) => ({
  session_id: event.session_id,
  event_id: event.id,
  sequence: event.sequence,
  step_id: event.type === "StepCommitted" ? event.payload.step_id : "answer_question",
  actor_id: event.type === "StepCommitted" ? event.payload.actor_id : "user_candidate"
});

const testRefKey = (value: ReturnType<typeof ref>): string =>
  [value.session_id, value.event_id, value.sequence, value.step_id, value.actor_id].join("|");

const validModelContent = (event: RuntimeEvent = committed()) =>
  JSON.stringify({
    summary: "Candidate gave a concrete ownership answer.",
    dimensions: [{ name: "ownership", conclusion: "Clear ownership signal.", evidence_refs: [ref(event)] }],
    key_moments: [{ title: "Ownership example", description: "The candidate described rollout ownership.", evidence_ref: ref(event) }],
    recommendations: [{ text: "Quantify the adoption result more explicitly.", evidence_refs: [ref(event)] }],
    evidence_refs: [ref(event)],
    uncertainty_notes: ["The answer did not include a numeric outcome."]
  });

const fakeAdapter = (content: string): ReviewModelAdapter => ({
  async complete() {
    return { content };
  }
});

describe("review evidence extraction", () => {
  it("extracts only safe StepCommitted evidence with verifiable refs", () => {
    const evidence = extractReviewEvidence({
      session_id: "session-review",
      scenario,
      events: [committed({ id: "event-question", sequence: 1 }), failedAttempt]
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      ref: { session_id: "session-review", event_id: "event-question", sequence: 1, step_id: "answer_question", actor_id: "user_candidate" },
      review_tags: expect.arrayContaining(["answer"])
    });
    expect(evidence[0]).not.toHaveProperty("step_prompt");
    expect(JSON.stringify(evidence)).not.toContain("Answer the interview question.");
    expect(JSON.stringify(evidence)).not.toContain("hidden-token");
    expect(JSON.stringify(evidence)).not.toContain("StepAttemptFailed");
  });

  it("extracts only committed evidence whose tags are declared by the rubric", () => {
    const evidence = extractReviewEvidence({
      session_id: "session-review",
      scenario: answerOnlyScenario,
      events: [aiCommitted(), committed()]
    });

    expect(evidence.map((item) => item.ref.event_id)).toEqual(["event-answer"]);
    expect(JSON.stringify(evidence)).not.toContain("Please introduce your migration work.");
  });

  it("renders a strict JSON review prompt without raw runtime events", () => {
    const prompt = renderReviewPrompt({
      session_id: "session-review",
      scenario,
      evidence: extractReviewEvidence({ session_id: "session-review", scenario, events: [committed()] })
    });

    expect(prompt).toContain("EVIDENCE_JSON_START");
    expect(prompt).toContain("RUBRIC_JSON_START");
    expect(prompt).toContain("Evaluate whether the answer shows ownership");
    expect(prompt).toContain("Return strict JSON");
    expect(prompt).not.toContain("insufficient_evidence_policy");
    expect(prompt).not.toContain("RuntimeEvent");
    expect(prompt).not.toContain("step_prompt");
    expect(prompt).not.toContain("Answer the interview question.");
    expect(prompt).not.toContain("hidden-token");
    expect(prompt).not.toContain("state_patch");
  });

  it("renders short-sample and evidence-boundary rules in the review prompt", () => {
    const prompt = renderReviewPrompt({
      session_id: "session-review",
      scenario: { ...scenario, title: "论文答辩 / 项目评审" },
      evidence: extractReviewEvidence({ session_id: "session-review", scenario, events: [committed()] })
    });

    expect(prompt).toContain("Do not infer stable ability, hiring suitability, promotion readiness, or long-term performance from a short practice transcript.");
    expect(prompt).toContain("If the evidence has fewer than 8 user answers, phrase conclusions as observations from this session only.");
    expect(prompt).toContain("Do not introduce facts that are not present in EVIDENCE_JSON.");
    expect(prompt).toContain("External scenarios must be framed as recommendations or hypotheticals.");
    expect(prompt).toContain("Do not estimate or state the total number of user answers");
    expect(prompt).toContain("the application will display deterministic evidence_summary counts");
    expect(prompt).toContain("Do not write short-sample limitations when the evidence contains 8 or more user answers.");
    expect(prompt).toContain("不能从短轮次 transcript 推断稳定能力、录用适配度、晋升准备度或长期表现。");
    expect(prompt).toContain("不得自行估算或书写用户回答总数");
  });

  it("renders the complete nested review schema with exact field names", () => {
    const prompt = renderReviewPrompt({
      session_id: "session-review",
      scenario,
      evidence: extractReviewEvidence({ session_id: "session-review", scenario, events: [committed()] })
    });

    expect(prompt).toContain("\"dimensions\"");
    expect(prompt).toContain("\"conclusion\"");
    expect(prompt).toContain("\"evidence_refs\"");
    expect(prompt).toContain("\"key_moments\"");
    expect(prompt).toContain("\"description\"");
    expect(prompt).toContain("\"evidence_ref\"");
    expect(prompt).toContain("\"recommendations\"");
    expect(prompt).toContain("\"uncertainty_notes\"");
    expect(prompt).toContain("Do not use refs, evaluation, or impact as output field names.");
  });

  it("includes Chinese output guidance for Chinese thesis review prompts", () => {
    const prompt = renderReviewPrompt({
      session_id: "session-review",
      scenario: { ...scenario, title: "论文答辩 / 项目评审" },
      evidence: extractReviewEvidence({ session_id: "session-review", scenario, events: [committed()] })
    });

    expect(prompt).toContain("请使用中文回复，除非用户明确要求使用其他语言。");
  });
});

describe("review engine", () => {
  it("fails when model output invents a dimension outside the scenario rubric", async () => {
    const report = await generateReviewReport({
      review_id: "review-rubric-invalid",
      session_id: "session-review",
      scenario: answerOnlyScenario,
      events: [committed()],
      adapter: fakeAdapter(JSON.stringify({
        summary: "Invalid dimension.",
        dimensions: [{ name: "made_up_dimension", conclusion: "Bad.", evidence_refs: [ref()] }],
        key_moments: [{ title: "Moment", description: "Desc", evidence_ref: ref() }],
        recommendations: [{ text: "Improve.", evidence_refs: [ref()] }],
        evidence_refs: [ref()],
        uncertainty_notes: ["none"]
      })),
      now: () => "2026-06-27T00:00:00.000Z"
    });

    expect(report).toMatchObject({ status: "failed", error_message: "review_rubric_dimension_invalid" });
  });

  it("generates a succeeded report and validates evidence refs against current session events", async () => {
    const report = await generateReviewReport({
      review_id: "review-1",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: fakeAdapter(validModelContent()),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report).toMatchObject({
      id: "review-1",
      session_id: "session-review",
      status: "succeeded",
      summary: "Candidate gave a concrete ownership answer.",
      evidence_refs: [{ event_id: "event-answer", sequence: 2 }]
    });
    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected succeeded review");
    }
    expect(report.key_moments[0]).toMatchObject({
      title: "答辩人回应了证据链",
      description: "答辩人提到“我回应了证据链，说明实验指标、用户反馈和方案调整之间的关系。”，支撑了本次复盘判断。"
    });
    expect(JSON.stringify(report.key_moments)).not.toContain("hidden-token");
    expect(report.completed_at).toBe("2026-06-19T01:10:00.000Z");
    expect("error_message" in report).toBe(false);
  });

  it("parses a valid fenced JSON review while still validating evidence refs", async () => {
    const markdown = await generateReviewReport({
      review_id: "review-markdown",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: fakeAdapter("```json\n" + validModelContent() + "\n```"),
      now: () => "2026-06-19T01:10:00.000Z"
    });
    expect(markdown).toMatchObject({
      status: "succeeded",
      summary: "Candidate gave a concrete ownership answer.",
      evidence_refs: [{ event_id: "event-answer", sequence: 2 }]
    });
  });

  it("retries once when the model returns schema-invalid review JSON", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const retryingAdapter: ReviewModelAdapter = {
      async complete(input) {
        calls += 1;
        prompts.push(input.prompt);
        return {
          content: calls === 1
            ? JSON.stringify({ summary: "Missing required nested fields." })
            : validModelContent()
        };
      }
    };

    const report = await generateReviewReport({
      review_id: "review-schema-retry",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: retryingAdapter,
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(calls).toBe(2);
    expect(prompts[1]).toContain("Previous review output was rejected with review_schema_invalid");
    expect(report).toMatchObject({
      id: "review-schema-retry",
      status: "succeeded",
      summary: "Candidate gave a concrete ownership answer."
    });
  });

  it("normalizes known real-provider nested review field variants before strict validation", async () => {
    const providerContent = JSON.stringify({
      summary: "Candidate gave a concrete ownership answer.",
      dimensions: [{ name: "ownership", evaluation: "Clear ownership signal.", refs: [ref()] }],
      key_moments: [{ title: "Ownership example", impact: "The candidate described rollout ownership.", refs: [ref()] }],
      recommendations: [{ text: "Quantify the adoption result more explicitly.", refs: [ref()] }],
      evidence_refs: [ref()],
      uncertainty_notes: "The answer did not include a numeric outcome."
    });

    const report = await generateReviewReport({
      review_id: "review-normalized",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: fakeAdapter(providerContent),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected normalized review to succeed");
    }
    expect(report.dimensions[0]).toMatchObject({ conclusion: "Clear ownership signal.", evidence_refs: [ref()] });
    expect(report.key_moments[0]).toMatchObject({
      title: "答辩人回应了证据链",
      description: "答辩人提到“我回应了证据链，说明实验指标、用户反馈和方案调整之间的关系。”，支撑了本次复盘判断。",
      evidence_ref: ref()
    });
    expect(report.recommendations[0]).toMatchObject({ evidence_refs: [ref()] });
    expect(report.uncertainty_notes).toEqual(expect.arrayContaining([
      "The answer did not include a numeric outcome.",
      "本次复盘仅基于 1 条用户回答，适合观察本轮演练中的表达和证据倾向，不能代表稳定能力判断。"
    ]));
  });

  it("keeps fake-style AI anchored output aligned with user evidence coverage and complete rubric dimensions", async () => {
    const moderator = debateModeratorCommitted();
    const opening = debateUserCommitted({
      id: "event-opening",
      sequence: 2,
      step_id: "affirmative_opening",
      field: "speech",
      text: "正方基于公开材料提出清晰论点，并说明训练可及性和反馈质量的证据。"
    });
    const freeResponse = debateUserCommitted({
      id: "event-free-response",
      sequence: 3,
      step_id: "affirmative_free_response",
      field: "response",
      text: "正方回应反方质疑，指出误判风险可以通过证据链和人工复核降低。"
    });
    const aiAnchoredContent = JSON.stringify({
      summary: "Evidence-based review generated from committed events.",
      dimensions: [{ name: "argument_clarity", conclusion: "The session has reviewable committed evidence.", evidence_refs: [ref(moderator)] }],
      key_moments: [{ title: "Committed step", description: "A committed step was used as the review anchor.", evidence_ref: ref(moderator) }],
      recommendations: [{ text: "Add more concrete outcome details in the next practice run.", evidence_refs: [ref(moderator)] }],
      evidence_refs: [ref(moderator)],
      uncertainty_notes: ["Only committed runtime evidence was available to the review engine."]
    });

    const report = await generateReviewReport({
      review_id: "review-debate-aligned",
      session_id: "session-review",
      scenario: debateReviewScenario,
      events: [moderator, opening, freeResponse],
      adapter: fakeAdapter(aiAnchoredContent),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected debate review to succeed");
    }
    expect(report.dimensions.map((dimension) => dimension.name)).toEqual([
      "论点清晰度",
      "证据引用",
      "反驳有效性",
      "逻辑一致性",
      "阵营协作",
      "临场回应"
    ]);
    expect(report.evidence_summary).toMatchObject({
      answer_count: 2,
      cited_answer_count: 2,
      coverage: "sufficient",
      confidence: "low"
    });
    expect(report.uncertainty_notes).toEqual(expect.arrayContaining([
      "本次复盘仅基于 2 条用户回答，适合观察本轮演练中的表达和证据倾向，不能代表稳定能力判断。"
    ]));
    expect(report.key_moments.map((moment) => moment.evidence_ref.event_id)).toEqual(["event-opening", "event-free-response"]);

    const openingKey = testRefKey(ref(opening));
    const freeResponseKey = testRefKey(ref(freeResponse));
    const dimensionRefKeys = report.dimensions.flatMap((dimension) => dimension.evidence_refs).map(testRefKey);
    const recommendationRefKeys = report.recommendations.flatMap((recommendation) => recommendation.evidence_refs ?? []).map(testRefKey);
    expect(dimensionRefKeys).toEqual(expect.arrayContaining([openingKey, freeResponseKey]));
    expect(recommendationRefKeys).toEqual(expect.arrayContaining([openingKey, freeResponseKey]));
    expect(JSON.stringify(report.credibility_checks)).toContain("2/2");
    expect(JSON.stringify(report.credibility_checks)).not.toContain("0/2");
  });

  it("keeps dimensions with no matching evidence as uncertainty without fabricated refs", async () => {
    const answer = committed();
    const sparseScenario: NormalizedScenarioV1 = {
      ...scenario,
      review_rubric: {
        ...scenario.review_rubric,
        dimensions: [
          scenario.review_rubric.dimensions[0]!,
          {
            id: "missing_signal",
            title: "未观测维度",
            description: "这个维度在当前事件中没有任何可观察证据。",
            evidence_tags: ["missing_signal"],
            evidence_requirement: "required",
            output_guidance: "缺证据时必须说明不确定性。"
          }
        ]
      }
    };

    const report = await generateReviewReport({
      review_id: "review-missing-dimension",
      session_id: "session-review",
      scenario: sparseScenario,
      events: [answer],
      adapter: fakeAdapter(validModelContent(answer)),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected sparse review to succeed");
    }
    expect(report.dimensions.map((dimension) => dimension.name)).toEqual(["ownership", "未观测维度"]);
    expect(report.dimensions[1]).toMatchObject({
      name: "未观测维度",
      conclusion: expect.stringContaining("证据不足"),
      evidence_refs: []
    });
    expect(report.uncertainty_notes).toEqual(expect.arrayContaining(["证据不足：未观测维度 缺少可观察证据。"]));
  });

  it("prefers committed user transcript when model key moments point at earlier AI evidence", async () => {
    const aiEvent = aiCommitted();
    const report = await generateReviewReport({
      review_id: "review-user-moment",
      session_id: "session-review",
      scenario,
      events: [aiEvent, committed()],
      adapter: fakeAdapter(validModelContent(aiEvent)),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected user moment review to succeed");
    }
    expect(report.key_moments[0]).toMatchObject({
      title: "答辩人回应了证据链",
      description: "答辩人提到“我回应了证据链，说明实验指标、用户反馈和方案调整之间的关系。”，支撑了本次复盘判断。",
      evidence_ref: ref()
    });
    expect(JSON.stringify(report.key_moments)).not.toContain("Please introduce your migration work.");
  });

  it("adds evidence sufficiency, safe transcript locators and stable credibility checks", async () => {
    const offTopic = userAnswerCommitted({
      id: "event-off-topic",
      sequence: 2,
      answer: "我不知道你在问什么，今天午饭很好吃。"
    });
    const contradiction = userAnswerCommitted({
      id: "event-contradiction",
      sequence: 3,
      answer: "我没有参与迁移，只是旁观；但这次迁移全部由我主导完成，零风险零问题。"
    });
    const citedOnly = JSON.stringify({
      summary: "Candidate answers need stronger grounding.",
      dimensions: [{ name: "ownership", conclusion: "回答存在跑题和矛盾风险。", evidence_refs: [ref(offTopic)] }],
      key_moments: [{ title: "Off topic answer", description: "The candidate did not answer the question.", evidence_ref: ref(offTopic) }],
      recommendations: [{ text: "回到问题本身，并解释前后不一致处。", evidence_refs: [ref(offTopic)] }],
      evidence_refs: [ref(offTopic)],
      uncertainty_notes: ["Only one of two user answers was cited by the model."]
    });

    const report = await generateReviewReport({
      review_id: "review-credibility",
      session_id: "session-review",
      scenario,
      events: [offTopic, contradiction],
      adapter: fakeAdapter(citedOnly),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected credibility review to succeed");
    }
    expect(report.evidence_summary).toMatchObject({
      answer_count: 2,
      cited_answer_count: 2,
      coverage: "sufficient",
      confidence: "low"
    });
    expect(report.uncertainty_notes).toEqual(expect.arrayContaining([
      "本次复盘仅基于 2 条用户回答，适合观察本轮演练中的表达和证据倾向，不能代表稳定能力判断。"
    ]));
    const [firstMoment] = report.key_moments;
    if (firstMoment === undefined) {
      throw new Error("expected at least one key moment");
    }
    expect(firstMoment.evidence_locator).toEqual({
      sequence: 2,
      speaker: "答辩人",
      snippet: "我不知道你在问什么，今天午饭很好吃。"
    });
    expect(report.credibility_checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "off_topic", severity: "warning", message: expect.stringContaining("答非所问") }),
      expect.objectContaining({ kind: "contradiction", severity: "warning", message: expect.stringContaining("前后矛盾") })
    ]));
    expect(JSON.stringify(report.credibility_checks)).not.toContain("1/2");
    expect(JSON.stringify(firstMoment.evidence_locator)).not.toMatch(/event-off-topic|event-contradiction|step_id|actor_id|session_id/);
  });

  it("keeps credibility statistics aligned when all user answers are cited", async () => {
    const answers = [1, 2, 3, 4].map((index) => userAnswerCommitted({
      id: `event-answer-${index}`,
      sequence: index,
      answer: `第 ${index} 条回答提供了可复盘证据。`
    }));
    const content = JSON.stringify({
      summary: "Candidate gave four grounded answers.",
      dimensions: [{ name: "ownership", conclusion: "四条回答都有证据支撑。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "继续保持证据完整度。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["No additional uncertainty."]
    });

    const report = await generateReviewReport({
      review_id: "review-four-cited",
      session_id: "session-review",
      scenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected fully cited review to succeed");
    }
    expect(report.evidence_summary).toMatchObject({
      answer_count: 4,
      cited_answer_count: 4,
      coverage: "sufficient",
      confidence: "medium"
    });
    expect(report.key_moments).toHaveLength(4);
    expect(JSON.stringify(report.credibility_checks)).toContain("4/4");
    expect(JSON.stringify(report.credibility_checks)).not.toContain("0/4");
  });

  it("allows high confidence only for sufficiently covered reviews with at least eight user answers and no warnings", async () => {
    const answers = Array.from({ length: 8 }, (_, index) => userAnswerCommitted({
      id: `event-answer-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答提供了稳定且可复盘的项目证据。`
    }));
    const content = JSON.stringify({
      summary: "Candidate gave eight grounded answers.",
      dimensions: [{ name: "ownership", conclusion: "八条回答都有证据支撑。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "继续保持证据完整度。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["No additional uncertainty."]
    });

    const report = await generateReviewReport({
      review_id: "review-eight-cited",
      session_id: "session-review",
      scenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected fully cited eight-answer review to succeed");
    }
    expect(report.evidence_summary).toMatchObject({
      answer_count: 8,
      cited_answer_count: 8,
      coverage: "sufficient",
      confidence: "high"
    });
    expect(JSON.stringify(report.credibility_checks)).toContain("8/8");
    expect(JSON.stringify(report.credibility_checks)).not.toContain("仅基于 8 条用户回答");
  });

  it("removes model-written short-sample answer counts that conflict with long evidence summaries", async () => {
    const answers = Array.from({ length: 20 }, (_, index) => userAnswerCommitted({
      id: `event-long-answer-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答提供了长流程面试证据。`
    }));
    const content = JSON.stringify({
      summary: "候选人表现清晰，但鉴于仅有7条用户回答，结论只能低可信参考。",
      dimensions: [{ name: "ownership", conclusion: "长流程回答都有证据支撑。", evidence_refs: answers.map(ref) }],
      key_moments: answers.slice(0, 3).map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "继续补充复杂场景验证。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: [
        "本次演练仅有7条用户回答，样本量较小，结论仅反映本次演练表现。",
        "所有结论基于当前8条回答，不推断长期能力。",
        "所有结论基于本次演练的8条用户回答，不推断参与者长期能力或稳定性。",
        "本次评估基于单次面试演练的41轮事件，且其中部分问题重复，可能未覆盖全部能力维度。",
        "本次演练基于单一面试场景，且用户回答数量为40条，但因仅此一次 session，无法评估长期一致性。",
        "所有回答均基于候选人自述，缺乏实际代码或系统验证。"
      ]
    });

    const report = await generateReviewReport({
      review_id: "review-long-count-conflict",
      session_id: "session-review",
      scenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected long review to succeed");
    }
    expect(report.evidence_summary).toMatchObject({
      answer_count: 20,
      cited_answer_count: 20,
      coverage: "sufficient",
      confidence: "high"
    });
    expect(report.summary).not.toMatch(/仅有\s*7\s*条|7\s*条用户回答|样本量较小|低可信/);
    expect(report.summary).not.toContain("。。");
    expect(report.uncertainty_notes.join("\n")).not.toMatch(/仅有\s*7\s*条|7\s*条用户回答|当前8条回答|本次演练的8条用户回答|用户回答数量为\s*40\s*条|40\s*条(?:用户)?回答|\d+\s*轮事件|样本量较小|样本较短/);
    expect(report.uncertainty_notes).toEqual([
      "本次评估基于单次面试演练的完整对话，且其中部分问题重复，可能未覆盖全部能力维度。",
      "本次演练基于单一面试场景，但因仅此一次 session，无法评估长期一致性。",
      "所有回答均基于候选人自述，缺乏实际代码或系统验证。"
    ]);
  });

  it("does not allow high confidence when a required rubric dimension has no evidence", async () => {
    const answers = Array.from({ length: 8 }, (_, index) => userAnswerCommitted({
      id: `event-answer-missing-dimension-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答只覆盖 ownership 证据，没有覆盖缺失维度。`
    }));
    const missingRequiredDimensionScenario: NormalizedScenarioV1 = {
      ...scenario,
      review_rubric: {
        ...scenario.review_rubric,
        dimensions: [
          scenario.review_rubric.dimensions[0]!,
          {
            id: "missing_required_signal",
            title: "缺失必需维度",
            description: "该必需维度在当前事件中没有证据。",
            evidence_tags: ["missing_required_signal"],
            evidence_requirement: "required",
            output_guidance: "缺证据时必须说明限制。"
          }
        ]
      }
    };
    const content = JSON.stringify({
      summary: "Candidate gave eight grounded answers for ownership only.",
      dimensions: [{ name: "ownership", conclusion: "八条回答都有 ownership 证据支撑。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "补充缺失维度的证据。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["No additional uncertainty."]
    });

    const report = await generateReviewReport({
      review_id: "review-eight-cited-missing-dimension",
      session_id: "session-review",
      scenario: missingRequiredDimensionScenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected missing-dimension review to succeed with limited confidence");
    }
    expect(report.evidence_summary).toMatchObject({
      answer_count: 8,
      cited_answer_count: 8,
      coverage: "sufficient",
      confidence: "medium"
    });
    expect(report.credibility_checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "evidence_gap", severity: "warning", message: expect.stringContaining("缺失必需维度") })
    ]));
  });

  it("does not accept punctuation-only conclusions for required dimensions", async () => {
    const answers = Array.from({ length: 8 }, (_, index) => userAnswerCommitted({
      id: `event-answer-empty-dimension-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答讨论了风险处理、补救计划和验证策略。`
    }));
    const content = JSON.stringify({
      summary: "用户围绕风险处理给出了完整讨论。",
      dimensions: [{ name: "ownership", conclusion: "。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `风险处理片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "继续把风险处理行动项拆成负责人和截止时间。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["仍需验证修复后的用户理解。"]
    });

    const report = await generateReviewReport({
      review_id: "review-punctuation-only-dimension",
      session_id: "session-review",
      scenario: answerOnlyScenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected punctuation-only dimension review to succeed with guarded conclusion");
    }
    expect(report.dimensions[0]).toMatchObject({
      name: "ownership",
      conclusion: expect.stringContaining("模型未返回有效维度结论"),
      evidence_refs: answers.map(ref)
    });
    expect(report.dimensions[0]?.conclusion).not.toBe("。");
    if (report.evidence_summary === undefined) {
      throw new Error("expected evidence summary for succeeded review");
    }
    expect(report.evidence_summary.confidence).toBe("medium");
    expect(report.credibility_checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "evidence_gap", severity: "warning", message: expect.stringContaining("ownership") })
    ]));
  });

  it("does not expose punctuation-only summary or recommendations", async () => {
    const answers = Array.from({ length: 8 }, (_, index) => userAnswerCommitted({
      id: `event-answer-empty-visible-text-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答覆盖了事实、推断、修复项和验证策略。`
    }));
    const content = JSON.stringify({
      summary: "。",
      dimensions: [{ name: "ownership", conclusion: "八条回答都有证据支撑。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [
        { text: "继续把行动项补充负责人和截止时间。", evidence_refs: answers.map(ref) },
        { text: "。", evidence_refs: answers.map(ref) },
        { text: "本次演练仅有7条用户回答，样本较短。", evidence_refs: answers.map(ref) }
      ],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["仍需真实用户理解度验证。"]
    });

    const report = await generateReviewReport({
      review_id: "review-punctuation-only-visible-text",
      session_id: "session-review",
      scenario: answerOnlyScenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected punctuation-only visible text review to succeed with sanitized output");
    }
    expect(report.summary).toBe("本次复盘引用 8 条用户回答，结论以本轮可观察证据为准。");
    expect(report.recommendations.map((recommendation) => recommendation.text)).toEqual([
      "继续把行动项补充负责人和截止时间。"
    ]);
  });

  it("removes orphan leading punctuation from visible generated text", async () => {
    const answers = Array.from({ length: 8 }, (_, index) => userAnswerCommitted({
      id: `event-answer-leading-punctuation-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答覆盖了行动项、风险和验证。`
    }));
    const content = JSON.stringify({
      summary: "。所有结论仅基于本次演练中的 8 条用户回答。",
      dimensions: [{ name: "ownership", conclusion: "。但仍可判断回答覆盖了行动项和验证风险。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "。继续明确负责人。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["。仍需真实验证。"]
    });

    const report = await generateReviewReport({
      review_id: "review-leading-punctuation",
      session_id: "session-review",
      scenario: answerOnlyScenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected leading punctuation review to succeed with sanitized output");
    }
    expect(report.summary).toBe("所有结论仅基于本次演练中的 8 条用户回答。");
    expect(report.dimensions[0]?.conclusion).toBe("但仍可判断回答覆盖了行动项和验证风险。");
    expect(report.recommendations[0]?.text).toBe("继续明确负责人。");
    expect(report.uncertainty_notes[0]).toBe("仍需真实验证。");
  });

  it("does not expose generic fallback as a required dimension conclusion", async () => {
    const answers = Array.from({ length: 8 }, (_, index) => userAnswerCommitted({
      id: `event-answer-cleaned-dimension-${index + 1}`,
      sequence: index + 1,
      answer: `第 ${index + 1} 条回答讨论了风险、边界和发布验证。`
    }));
    const content = JSON.stringify({
      summary: "用户围绕风险处理给出了讨论。",
      dimensions: [{ name: "ownership", conclusion: "本次演练仅有7条用户回答，样本较短。", evidence_refs: answers.map(ref) }],
      key_moments: answers.map((event, index) => ({ title: `关键片段 ${index + 1}`, description: "用户回答被引用。", evidence_ref: ref(event) })),
      recommendations: [{ text: "继续明确验证计划。", evidence_refs: answers.map(ref) }],
      evidence_refs: answers.map(ref),
      uncertainty_notes: ["仍需真实发布验证。"]
    });

    const report = await generateReviewReport({
      review_id: "review-cleaned-dimension-fallback",
      session_id: "session-review",
      scenario: answerOnlyScenario,
      events: answers,
      adapter: fakeAdapter(content),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(report.status).toBe("succeeded");
    if (report.status !== "succeeded") {
      throw new Error("expected cleaned dimension review to succeed with dimension-specific fallback");
    }
    expect(report.dimensions[0]).toMatchObject({
      name: "ownership",
      conclusion: expect.stringContaining("模型未返回有效维度结论")
    });
    expect(report.dimensions[0]?.conclusion).not.toBe("本次复盘引用 8 条用户回答，结论以本轮可观察证据为准。");
    if (report.evidence_summary === undefined) {
      throw new Error("expected evidence summary for succeeded review");
    }
    expect(report.evidence_summary.confidence).toBe("medium");
  });

  it("returns schema invalid instead of leaking provider content when normalized output still violates the contract", async () => {
    const malformed = await generateReviewReport({
      review_id: "review-malformed",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: fakeAdapter(JSON.stringify({
        summary: "Candidate gave a concrete ownership answer.",
        dimensions: [{ name: "ownership", refs: [ref()] }],
        key_moments: [{ title: "Ownership example", refs: [ref()] }],
        recommendations: [{ text: "Quantify the adoption result more explicitly.", refs: [ref()] }],
        evidence_refs: [ref()],
        uncertainty_notes: "The answer did not include a numeric outcome."
      })),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(malformed).toMatchObject({ status: "failed", error_message: "review_schema_invalid" });
    expect(JSON.stringify(malformed)).not.toContain("Candidate gave a concrete ownership answer.");

    const unparsable = await generateReviewReport({
      review_id: "review-unparsable",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: fakeAdapter("{not json"),
      now: () => "2026-06-19T01:10:00.000Z"
    });

    expect(unparsable).toMatchObject({ status: "failed", error_message: "json_parse_failed" });
  });

  it("returns failed for invalid refs and empty evidence", async () => {
    const invalidRef = await generateReviewReport({
      review_id: "review-invalid-ref",
      session_id: "session-review",
      scenario,
      events: [committed()],
      adapter: fakeAdapter(validModelContent(committed({ id: "other-event", sequence: 99 }))),
      now: () => "2026-06-19T01:11:00.000Z"
    });
    expect(invalidRef).toMatchObject({ status: "failed", error_message: "review_evidence_ref_invalid" });

    const noEvidence = await generateReviewReport({
      review_id: "review-no-evidence",
      session_id: "session-review",
      scenario,
      events: [failedAttempt],
      adapter: fakeAdapter(validModelContent()),
      now: () => "2026-06-19T01:12:00.000Z"
    });
    expect(noEvidence).toMatchObject({ status: "failed", error_message: "review_evidence_empty" });
  });
});
