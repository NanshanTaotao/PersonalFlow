import { describe, expect, it } from "vitest";

import { projectForkedSessionView } from "./fork-projector";
import { projectSessionView } from "./view-projector";
import { buildDraftFromComplexConfig, jobInterviewFixture, jobInterviewSmokeFixture, promotionReviewFixture, thesisDefenseFixture } from "./testing/scenarios";

describe("projectSessionView", () => {
  it("projects only product-safe visible transcript entries from committed events", () => {
    const view = projectSessionView({
      sessionId: "session-visible-transcript",
      scenario: jobInterviewSmokeFixture,
      status: "running",
      stateVersion: 0,
      state: jobInterviewSmokeFixture.initial_state,
      events: [
        {
          id: "event-start",
          session_id: "session-visible-transcript",
          sequence: 0,
          state_version_before: 0,
          state_version_after: 0,
          created_at: "runtime-sequence-0",
          type: "SessionStarted",
          payload: { scenario_id: jobInterviewSmokeFixture.id, initial_state: jobInterviewSmokeFixture.initial_state }
        },
        {
          id: "event-step",
          session_id: "session-visible-transcript",
          sequence: 1,
          state_version_before: 0,
          state_version_after: 0,
          created_at: "runtime-sequence-1",
          type: "StepCommitted",
          payload: {
            step_id: "ask_question",
            actor_id: "ai_interviewer",
            args: { question: "What did you launch?", prompt_hash: "prompt_hash_secret" },
            state_patch: jobInterviewSmokeFixture.initial_state
          }
        }
      ]
    });

    expect(view.visible_transcript).toEqual([
      {
        id: "event-step:visible",
        event_id: "event-step",
        sequence: 1,
        actor_id: "ai_interviewer",
        actor_kind: "ai",
        actor_name: "Interviewer",
        text: "What did you launch?"
      }
    ]);
    expect(JSON.stringify(view.visible_transcript)).not.toContain("prompt_hash");
  });

  it("keeps ordinary user response args visible while filtering raw provider response args", () => {
    const view = projectSessionView({
      sessionId: "session-visible-response",
      scenario: jobInterviewSmokeFixture,
      status: "running",
      stateVersion: 1,
      state: jobInterviewSmokeFixture.initial_state,
      events: [
        {
          id: "event-user-response",
          session_id: "session-visible-response",
          sequence: 1,
          state_version_before: 0,
          state_version_after: 1,
          created_at: "runtime-sequence-1",
          type: "StepCommitted",
          payload: {
            step_id: "answer_question",
            actor_id: "user_candidate",
            args: {
              response: "Visible business response",
              provider_response: "hidden raw provider response"
            },
            state_patch: jobInterviewSmokeFixture.initial_state
          }
        }
      ]
    });

    expect(view.visible_transcript[0]?.text).toBe("Visible business response");
    expect(JSON.stringify(view.visible_transcript)).not.toContain("hidden raw provider response");
  });

  it("projects actor kind locators for visible transcript entries", () => {
    const view = projectSessionView({
      sessionId: "session-visible-actor-kind",
      scenario: jobInterviewSmokeFixture,
      status: "running",
      stateVersion: 1,
      state: { turn_count: 1 },
      events: [
        {
          id: "event-user-response",
          session_id: "session-visible-actor-kind",
          sequence: 1,
          state_version_before: 0,
          state_version_after: 1,
          created_at: "runtime-sequence-1",
          type: "StepCommitted",
          payload: {
            step_id: "answer_question",
            actor_id: "user_candidate",
            args: { answer: "I owned the migration plan." },
            state_patch: { turn_count: 1 }
          }
        },
        {
          id: "event-ended",
          session_id: "session-visible-actor-kind",
          sequence: 2,
          state_version_before: 1,
          state_version_after: 1,
          created_at: "runtime-sequence-2",
          type: "RuntimeCommandCommitted",
          payload: {
            command: "end_session",
            args: {}
          }
        }
      ]
    });

    expect(view.visible_transcript).toEqual([
      expect.objectContaining({ event_id: "event-user-response", actor_kind: "user" }),
      expect.objectContaining({ event_id: "event-ended", actor_kind: "system" })
    ]);
  });

  it("recomputes forked child view from copied prefix events instead of parent view", () => {
    const events = [
      {
        id: "child:0:SessionStarted",
        session_id: "child",
        sequence: 0,
        state_version_before: 0,
        state_version_after: 0,
        created_at: "2026-07-10T00:00:00.000Z",
        type: "SessionStarted",
        payload: { scenario_id: jobInterviewSmokeFixture.id, initial_state: jobInterviewSmokeFixture.initial_state }
      },
      {
        id: "child:1:StepCommitted",
        session_id: "child",
        sequence: 1,
        state_version_before: 0,
        state_version_after: 0,
        created_at: "2026-07-10T00:01:00.000Z",
        type: "StepCommitted",
        payload: {
          step_id: "ask_question",
          actor_id: "ai_interviewer",
          args: { question: "Which system did you own?" },
          state_patch: jobInterviewSmokeFixture.initial_state
        }
      }
    ] as const;

    const view = projectForkedSessionView({
      sessionId: "child",
      scenario: jobInterviewSmokeFixture,
      events
    });

    expect(view.session_id).toBe("child");
    expect(view.status).toBe("running");
    expect(view.visible_transcript).toEqual([
      expect.objectContaining({
        event_id: "child:1:StepCommitted",
        actor_kind: "ai",
        text: "Which system did you own?"
      })
    ]);
    expect(view.allowed_steps.some((step) => step.actor_kind === "user")).toBe(true);
  });

  it("projects terminal fork prefixes as non-continuable sessions", () => {
    const completedEvents = [
      {
        id: "child-completed:0:SessionStarted",
        session_id: "child-completed",
        sequence: 0,
        state_version_before: 0,
        state_version_after: 0,
        created_at: "2026-07-10T00:00:00.000Z",
        type: "SessionStarted",
        payload: { scenario_id: jobInterviewSmokeFixture.id, initial_state: jobInterviewSmokeFixture.initial_state }
      },
      {
        id: "child-completed:1:StepCommitted",
        session_id: "child-completed",
        sequence: 1,
        state_version_before: 0,
        state_version_after: 1,
        created_at: "2026-07-10T00:01:00.000Z",
        type: "StepCommitted",
        payload: {
          step_id: "answer_question",
          actor_id: "user_candidate",
          args: { answer: "Final answer" },
          state_patch: { ...jobInterviewSmokeFixture.initial_state, turn_count: 3 }
        }
      }
    ] as const;

    const view = projectForkedSessionView({
      sessionId: "child-completed",
      scenario: jobInterviewSmokeFixture,
      events: completedEvents
    });

    expect(view.status).toBe("completed");
    expect(view.allowed_steps).toEqual([]);
  });

  it("does not project task 5 visible context or event-window trimming", () => {
    const view = projectSessionView({
      sessionId: "session-minimal-view",
      scenario: jobInterviewSmokeFixture,
      status: "running",
      stateVersion: 0,
      state: jobInterviewSmokeFixture.initial_state,
      events: []
    });

    expect(view).not.toHaveProperty("visible_context");
  });

  it("projects product stage, actor and next action labels for a multi-AI thesis defense turn", () => {
    const view = projectSessionView({
      sessionId: "session-thesis-method-probe",
      scenario: thesisDefenseFixture,
      status: "running",
      stateVersion: 3,
      state: {
        response_count: 1,
        panel_stage: "evidence",
        awaiting_response: false,
        synthesis_complete: false
      },
      events: []
    });

    expect(view.current_stage_label).toBe("证据追问");
    expect(view.current_actor_name).toBe("方法评审");
    expect(view.next_user_action_label).toBe("等待方法评审继续提问，可点击让 AI 提问。");
    expect(JSON.stringify({
      stage: view.current_stage_label,
      actor: view.current_actor_name,
      action: view.next_user_action_label
    })).not.toMatch(/actor_id|step_id|allowed_steps|panel_stage|method_evidence_probe|ai_method_reviewer/);
  });

  it("projects job interview stages and distinct AI interview panel speakers", () => {
    const technicalView = projectSessionView({
      sessionId: "session-job-technical-probe",
      scenario: jobInterviewFixture,
      status: "running",
      stateVersion: 2,
      state: {
        turn_count: 1,
        interview_stage: "technical_probe",
        awaiting_answer: false,
        closing_complete: false
      },
      events: []
    });

    expect(technicalView.current_stage_label).toBe("技术追问");
    expect(technicalView.current_actor_name).toBe("技术评审");
    expect(technicalView.next_user_action_label).toBe("等待技术评审继续提问，可点击让 AI 提问。");

    const behavioralView = projectSessionView({
      sessionId: "session-job-behavioral-probe",
      scenario: jobInterviewFixture,
      status: "running",
      stateVersion: 4,
      state: {
        turn_count: 2,
        interview_stage: "behavioral_probe",
        awaiting_answer: false,
        closing_complete: false
      },
      events: []
    });

    expect(behavioralView.current_stage_label).toBe("协作追问");
    expect(behavioralView.current_actor_name).toBe("行为面试官");
    expect(behavioralView.next_user_action_label).toBe("等待行为面试官继续提问，可点击让 AI 提问。");
    expect(JSON.stringify({
      stage: behavioralView.current_stage_label,
      actor: behavioralView.current_actor_name,
      action: behavioralView.next_user_action_label
    })).not.toMatch(/actor_id|step_id|allowed_steps|interview_stage|technical_probe|behavioral_probe|ai_technical_reviewer/);
  });

  it("projects promotion review stages and distinct calibration panel speakers", () => {
    const calibrationView = projectSessionView({
      sessionId: "session-promotion-calibration",
      scenario: promotionReviewFixture,
      status: "running",
      stateVersion: 2,
      state: {
        story_count: 1,
        promotion_stage: "calibration",
        awaiting_story: false,
        growth_plan_complete: false
      },
      events: []
    });

    expect(calibrationView.current_stage_label).toBe("级别校准");
    expect(calibrationView.current_actor_name).toBe("校准评审");
    expect(calibrationView.next_user_action_label).toBe("等待校准评审继续提问，可点击让 AI 提问。");

    const collaborationView = projectSessionView({
      sessionId: "session-promotion-collaboration",
      scenario: promotionReviewFixture,
      status: "running",
      stateVersion: 4,
      state: {
        story_count: 2,
        promotion_stage: "collaboration",
        awaiting_story: false,
        growth_plan_complete: false
      },
      events: []
    });

    expect(collaborationView.current_stage_label).toBe("协作观察");
    expect(collaborationView.current_actor_name).toBe("协作观察者");
    expect(collaborationView.next_user_action_label).toBe("等待协作观察者继续提问，可点击让 AI 提问。");
    expect(JSON.stringify({
      stage: collaborationView.current_stage_label,
      actor: collaborationView.current_actor_name,
      action: collaborationView.next_user_action_label
    })).not.toMatch(/actor_id|step_id|allowed_steps|promotion_stage|calibration|collaboration|ai_calibration_reviewer/);
  });

  it("projects the landing reviewer as the next default thesis defense reviewer before synthesis", () => {
    const view = projectSessionView({
      sessionId: "session-thesis-impact-probe",
      scenario: thesisDefenseFixture,
      status: "running",
      stateVersion: 5,
      state: {
        response_count: 2,
        panel_stage: "risk",
        awaiting_response: false,
        synthesis_complete: false
      },
      events: []
    });

    expect(view.current_stage_label).toBe("风险澄清");
    expect(view.current_actor_name).toBe("落地评审");
    expect(view.next_user_action_label).toBe("等待落地评审继续提问，可点击让 AI 提问。");
    expect(JSON.stringify({
      stage: view.current_stage_label,
      actor: view.current_actor_name,
      action: view.next_user_action_label
    })).not.toMatch(/impact_risk_probe|ai_impact_reviewer|step_id|allowed_steps/);
  });

  it("projects configured complex scenario stages from Runtime state into product-visible labels", () => {
    const draft = buildDraftFromComplexConfig({
      title: "增长平台项目评审",
      goal: "验证增长平台方案的证据链、风险和落地计划",
      user_role: "方案负责人",
      ai_roles: [
        { name: "业务评审", focus: "业务目标、指标口径和收益证据" },
        { name: "技术评审", focus: "系统复杂度、稳定性和上线风险" }
      ],
      stages: [
        { name: "开场", rounds: 1, follow_up_strategy: "确认目标和背景" },
        { name: "证据追问", rounds: 2, follow_up_strategy: "连续追问指标证据和取舍" },
        { name: "风险收束", rounds: 1, follow_up_strategy: "收束风险、限制和下一步计划" }
      ],
      termination: "完成风险收束后结束并进入复盘"
    });

    const view = projectSessionView({
      sessionId: "session-complex-config-stage",
      scenario: draft.scenario,
      status: "running",
      stateVersion: 2,
      state: {
        turn_count: 1,
        slot_index: 1,
        current_stage: "证据追问",
        awaiting_response: false,
        complete: false
      },
      events: []
    });

    expect(view.current_stage_label).toBe("证据追问");
    expect(view.current_actor_name).toBe("技术评审");
    expect(view.next_user_action_label).toBe("等待技术评审继续提问，可点击让 AI 提问。");
    expect(JSON.stringify({
      stage: view.current_stage_label,
      actor: view.current_actor_name,
      action: view.next_user_action_label
    })).not.toMatch(/current_stage|slot_index|actor_id|step_id|allowed_steps|complex_config/);
  });

  it("projects a neutral user input prompt without review-domain wording", () => {
    const view = projectSessionView({
      sessionId: "session-neutral-human-prompt",
      scenario: jobInterviewSmokeFixture,
      status: "running",
      stateVersion: 1,
      state: jobInterviewSmokeFixture.initial_state,
      events: []
    });

    expect(view.current_actor_name).toBe("Candidate");
    expect(view.next_user_action_label).toBe("请在输入框回应当前问题或提示。");
    expect(view.next_user_action_label).not.toContain("评审的问题");
  });

  it("projects blocked status and summary from the latest RuntimeBlockedCommitted event", () => {
    const view = projectSessionView({
      sessionId: "session-runtime-blocked",
      scenario: jobInterviewSmokeFixture,
      status: "running",
      stateVersion: 0,
      state: jobInterviewSmokeFixture.initial_state,
      events: [
        {
          id: "event-start",
          session_id: "session-runtime-blocked",
          sequence: 0,
          state_version_before: 0,
          state_version_after: 0,
          created_at: "runtime-sequence-0",
          type: "SessionStarted",
          payload: { scenario_id: jobInterviewSmokeFixture.id, initial_state: jobInterviewSmokeFixture.initial_state }
        },
        {
          id: "event-blocked",
          session_id: "session-runtime-blocked",
          sequence: 1,
          state_version_before: 0,
          state_version_after: 0,
          created_at: "runtime-sequence-1",
          type: "RuntimeBlockedCommitted",
          payload: {
            reason: "no_allowed_step",
            stage_id: "conversation",
            diagnostics: ["No candidate step passed guards."]
          }
        }
      ]
    });

    expect(view.status).toBe("blocked");
    expect(view.allowed_steps).toEqual([]);
    expect(view.current_stage_label).toBe("运行时已阻断");
    expect(view.current_actor_name).toBeNull();
    expect(view.next_user_action_label).toContain("阻断");
    expect(view.blocked_summary).toEqual({
      reason: "no_allowed_step",
      message: "No allowed step is available for the active stage. 当前阶段没有可执行步骤，演练已阻断。",
      stage_id: "conversation"
    });
  });

  it.each([
    ["paused", "演练已暂停", null, "演练已暂停，可点击继续恢复。"],
    ["completed", "演练已完成", null, "演练已完成，可查看复盘。"],
    ["ended", "演练已结束", null, "演练已结束，可查看复盘。"],
    ["failed", "演练失败", null, "演练失败，请刷新或稍后重试。"]
  ] as const)("projects stable product labels for %s sessions without runnable actor prompts", (status, stageLabel, actorName, actionLabel) => {
    const view = projectSessionView({
      sessionId: `session-${status}`,
      scenario: thesisDefenseFixture,
      status,
      stateVersion: 7,
      state: {
        response_count: 1,
        panel_stage: "evidence",
        awaiting_response: true,
        synthesis_complete: false
      },
      events: []
    });

    expect(view.current_stage_label).toBe(stageLabel);
    expect(view.current_actor_name).toBe(actorName);
    expect(view.next_user_action_label).toBe(actionLabel);
    expect(view.allowed_steps).toEqual([]);
  });
});
