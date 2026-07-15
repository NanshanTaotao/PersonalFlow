import fs from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductApiClient, type ApiClient, type ComplexScenarioConfigInput } from "../api/client";
import type { ApiResult, DraftView, ScenarioCheckResult, SceneArchiveSummary, SessionHistoryView, SessionView, StepView } from "../api/types";
import { Layout } from "../components/Layout";
import { ScenePreview } from "../components/ScenePreview";
import { formatElapsedDuration, SessionTimer } from "../components/SessionTimer";
import { SessionTranscript } from "../components/SessionTranscript";
import { nextNoticeForPage, NoticeMessage, selectRestoredModelConfig } from "./App";
import { DebugPage } from "./DebugPage";
import { HomePage } from "./HomePage";
import { ImportExportPage } from "./ImportExportPage";
import { ReviewPage } from "./ReviewPage";
import { SceneCheckPanel, SceneConfirmPage } from "./SceneConfirmPage";
import { SessionHistoryPage } from "./SessionHistoryPage";
import { createComplexScenarioDraft, defaultComplexScenarioConfig, ScenarioBuilderPage } from "./ScenarioBuilderPage";
import { createSessionCommandPayload, runInitialAiTurnIfNeeded, SessionPage, submitUserInputAndMaybeRunAiTurn, withdrawEntryAndSwitchSession } from "./SessionPage";
import { buildDeleteModelConfigIdempotencyKey, deleteModelConfigConfirmationText, initialSettingsState, SettingsPage, settingsReducer, testSavedModelConfigConnection } from "./SettingsPage";
import { MaterialsPage } from "./MaterialsPage";
import { SceneManagementPage } from "./SceneManagementPage";
import * as ScenarioBuilder from "./ScenarioBuilderPage";
import { TemplatePage } from "./TemplatePage";

type AiTurnResult = ApiResult<{
  readonly session: SessionView;
  readonly ai_turn_observability: {
    readonly adapter_kind: string;
    readonly model_config_id: string;
    readonly provider: string;
    readonly model: string;
    readonly visible_history: ReadonlyArray<{
      readonly event_id: string;
      readonly sequence: number;
      readonly actor_id?: string;
      readonly step_id?: string;
      readonly text_summary: string;
    }>;
  };
}>;

const collectRenderedText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectRenderedText).join("");
  }
  if (React.isValidElement<{ readonly children?: React.ReactNode }>(node)) {
    return collectRenderedText(node.props.children);
  }
  return "";
};

const clickButtonByText = (node: unknown, text: string): boolean => {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((child) => clickButtonByText(child, text));
  }
  if (!React.isValidElement<{ readonly children?: React.ReactNode; readonly onClick?: () => void }>(node)) {
    return false;
  }
  if (node.type === "button" && collectRenderedText(node.props.children).includes(text)) {
    node.props.onClick?.();
    return true;
  }
  return clickButtonByText(node.props.children, text);
};

const expectNoFutureCapabilityCopy = (html: string) => {
  for (const word of ["综合评分", "总评分", "雷达", "平均得分", "得分趋势", "本周目标", "导出全部", "清除全部数据", "Ollama", "MVP", "Debug"]) {
    expect(html).not.toContain(word);
  }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const countButtonLabelOccurrences = (html: string, label: string): number =>
  html.match(new RegExp(`<button[^>]*>\\s*${escapeRegExp(label)}\\s*</button>`, "g"))?.length ?? 0;

interface ComplexScenarioBuilderHelpers {
  readonly addComplexAiRole?: (config: ComplexScenarioConfigInput) => ComplexScenarioConfigInput;
  readonly updateComplexAiRole?: (
    config: ComplexScenarioConfigInput,
    index: number,
    patch: Partial<ComplexScenarioConfigInput["ai_roles"][number]>
  ) => ComplexScenarioConfigInput;
  readonly removeComplexAiRole?: (config: ComplexScenarioConfigInput, index: number) => ComplexScenarioConfigInput;
  readonly ComplexScenarioPreview?: React.ComponentType<{ readonly config: ComplexScenarioConfigInput }>;
}

const requireComplexScenarioBuilderHelpers = () => {
  const helpers = ScenarioBuilder as typeof ScenarioBuilder & ComplexScenarioBuilderHelpers;
  expect(typeof helpers.addComplexAiRole).toBe("function");
  expect(typeof helpers.updateComplexAiRole).toBe("function");
  expect(typeof helpers.removeComplexAiRole).toBe("function");
  expect(typeof helpers.ComplexScenarioPreview).toBe("function");
  return helpers as typeof ScenarioBuilder & Required<ComplexScenarioBuilderHelpers>;
};

describe("Task 11 web MVP session page boundaries", () => {
  const userStep: StepView = { id: "answer_interview_question", actor_id: "user_candidate", actor_kind: "user", args_schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } };
  const aiStep: StepView = { id: "ask_interview_question", actor_id: "ai_interviewer", actor_kind: "ai", args_schema: { type: "object", required: ["question"], properties: { question: { type: "string" } } } };
  const baseSession = (status: SessionView["status"], stateVersion: number, allowedSteps: StepView[] = [userStep]): SessionView => ({
    id: "session-auto-ai",
    scenario_id: "scenario_1",
    status,
    view: {
      session_id: "session-auto-ai",
      scenario_id: "scenario_1",
      status,
      state_version: stateVersion,
      state: {},
      allowed_steps: allowedSteps,
      visible_transcript: [],
      current_stage_label: status === "running" ? "证据追问" : "演练已结束",
      current_actor_name: status === "running" ? "候选人" : null,
      next_user_action_label: status === "running" ? "请在输入框回应当前问题或提示。" : "演练已结束，可查看复盘。"
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderSessionHtml = (session: SessionView): string => renderToStaticMarkup(
    <SessionPage
      session={session}
      api={{} as never}
      onSessionUpdated={() => undefined}
      onReviewRequested={() => undefined}
      onError={() => undefined}
    />
  );

  it("keeps local dev API proxy enabled by default", () => {
    const configText = fs.readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");

    expect(configText).toContain('process.env.VITE_PERSONALFLOW_API_TARGET ?? "http://127.0.0.1:3000"');
    expect(configText).toContain('"/api": apiTarget');
    expect(configText).toContain('"/health": apiTarget');
  });

  it("formats session elapsed time from product timing metadata", () => {
    expect(formatElapsedDuration({
      startedAt: "2026-07-11T10:00:00.000Z",
      now: new Date("2026-07-11T10:08:30.000Z")
    })).toBe("已进行 8 分钟");

    expect(formatElapsedDuration({
      startedAt: "2026-07-11T10:00:00.000Z",
      now: new Date("2026-07-11T10:00:20.000Z")
    })).toBe("刚刚开始");

    expect(formatElapsedDuration({
      startedAt: "not-a-date",
      now: new Date("2026-07-11T10:00:20.000Z")
    })).toBe("时间未记录");

    expect(formatElapsedDuration({
      startedAt: "2026-07-11T10:01:20.000Z",
      now: new Date("2026-07-11T10:00:20.000Z")
    })).toBe("刚刚开始");
  });

  it("renders timer without pretending to enforce a hard countdown", () => {
    const html = renderToStaticMarkup(
      <SessionTimer
        status="running"
        timing={{
          started_at: "2026-07-11T10:00:00.000Z",
          updated_at: "2026-07-11T10:05:00.000Z",
          suggested_duration_label: "建议约 15 分钟"
        }}
        now={new Date("2026-07-11T10:08:00.000Z")}
      />
    );

    expect(html).toContain("已进行 8 分钟");
    expect(html).toContain("建议约 15 分钟");
    expect(html).not.toContain("剩余");
    expectNoFutureCapabilityCopy(html);
  });

  it("renders failed timer status without implying the session is still running", () => {
    const html = renderToStaticMarkup(
      <SessionTimer
        status="failed"
        timing={{
          started_at: "2026-07-11T10:00:00.000Z",
          updated_at: "2026-07-11T10:05:00.000Z"
        }}
        now={new Date("2026-07-11T10:08:00.000Z")}
      />
    );

    expect(html).toContain("演练失败");
    expect(html).not.toContain("演练中");
  });


  it("automatically runs the next AI turn after a successful user submit when the returned session allows an AI step", async () => {
    const initialSession = baseSession("running", 4);
    const submittedSession: SessionView = {
      ...initialSession,
      view: {
        ...initialSession.view,
        state_version: 5,
        allowed_steps: [aiStep]
      }
    };
    const aiSession: SessionView = {
      ...submittedSession,
      view: {
        ...submittedSession.view,
        state_version: 6,
        allowed_steps: []
      }
    };
    const observability = {
      adapter_kind: "real",
      model_config_id: "model_real",
      provider: "openai-compatible",
      model: "gpt-test",
      visible_history: []
    };
    const submitUserInput = vi.fn(async () => ({ ok: true, data: { session: submittedSession } }));
    const runAiTurn = vi.fn(async () => ({ ok: true, data: { session: aiSession, ai_turn_observability: observability } }));
    const api = { submitUserInput, runAiTurn } as unknown as ApiClient;
    const updatedSessions: SessionView[] = [];
    const observedTurns: unknown[] = [];
    const errors: unknown[] = [];

    await submitUserInputAndMaybeRunAiTurn({
      session: initialSession,
      api,
      input: "I led the launch.",
      modelConfigId: "model_real",
      onSessionUpdated: (session) => updatedSessions.push(session),
      onAiTurnObserved: (turn) => observedTurns.push(turn),
      onError: (error) => errors.push(error)
    });

    expect(api.submitUserInput).toHaveBeenCalledWith("session-auto-ai", expect.objectContaining({
      input: "I led the launch.",
      expected_state_version: 4
    }));
    expect(JSON.stringify(submitUserInput.mock.calls)).not.toMatch(/actor_id|step_id/);
    expect(api.runAiTurn).toHaveBeenCalledWith("session-auto-ai", expect.objectContaining({
      actor_id: "ai_interviewer",
      expected_state_version: 5,
      model_config_id: "model_real"
    }));
    expect(updatedSessions).toEqual([aiSession]);
    expect(observedTurns).toEqual([observability]);
    expect(errors).toEqual([]);
  });

  it("uses actor kind instead of actor id prefixes when auto-running AI while product input omits step internals", async () => {
    const neutralUserStep = { ...userStep, actor_id: "candidate", actor_kind: "user" } as StepView;
    const neutralAiStep = { ...aiStep, actor_id: "reviewer", actor_kind: "ai" } as StepView;
    const initialSession = baseSession("running", 4, [neutralUserStep]);
    const submittedSession = baseSession("running", 5, [neutralAiStep]);
    const aiSession = baseSession("running", 6, []);
    const submitUserInput = vi.fn(async () => ({ ok: true, data: { session: submittedSession } }));
    const runAiTurn = vi.fn(async () => ({
      ok: true,
      data: {
        session: aiSession,
        ai_turn_observability: {
          adapter_kind: "fake",
          model_config_id: "model_fake",
          provider: "openai-compatible",
          model: "gpt-test",
          visible_history: []
        }
      }
    }));
    const api = {
      submitUserInput,
      runAiTurn
    } as unknown as ApiClient;
    const updatedSessions: SessionView[] = [];
    const errors: unknown[] = [];

    const result = await submitUserInputAndMaybeRunAiTurn({
      session: initialSession,
      api,
      input: "I can explain the tradeoff.",
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: (error) => errors.push(error)
    });

    expect(result).toEqual({ submitted: true, ranAiTurn: true });
    expect(api.submitUserInput).toHaveBeenCalledWith("session-auto-ai", expect.objectContaining({
      input: "I can explain the tradeoff.",
      expected_state_version: 4
    }));
    expect(JSON.stringify(submitUserInput.mock.calls)).not.toMatch(/actor_id|step_id|answer_interview_question/);
    expect(api.runAiTurn).toHaveBeenCalledWith("session-auto-ai", expect.objectContaining({
      actor_id: "reviewer",
      expected_state_version: 5
    }));
    expect(updatedSessions).toEqual([aiSession]);
    expect(errors).toEqual([]);
  });

  it.each(["completed", "ended", "paused", "blocked"] as const)("does not automatically run AI after submit when the returned session is %s", async (status) => {
    const initialSession = baseSession("running", 4);
    const submittedSession = baseSession(status, 5, [aiStep]);
    const api = {
      submitUserInput: vi.fn(async () => ({ ok: true, data: { session: submittedSession } })),
      runAiTurn: vi.fn()
    } as unknown as ApiClient;
    const updatedSessions: SessionView[] = [];

    await submitUserInputAndMaybeRunAiTurn({
      session: initialSession,
      api,
      input: "I led the launch.",
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: () => undefined
    });

    expect(api.runAiTurn).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([submittedSession]);
  });

  it("does not automatically run AI after submit when the returned session has no AI step", async () => {
    const initialSession = baseSession("running", 4);
    const submittedSession = baseSession("running", 5, [userStep]);
    const api = {
      submitUserInput: vi.fn(async () => ({ ok: true, data: { session: submittedSession } })),
      runAiTurn: vi.fn()
    } as unknown as ApiClient;
    const updatedSessions: SessionView[] = [];

    await submitUserInputAndMaybeRunAiTurn({
      session: initialSession,
      api,
      input: "I led the launch.",
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: () => undefined
    });

    expect(api.runAiTurn).not.toHaveBeenCalled();
    expect(updatedSessions).toEqual([submittedSession]);
  });

  it("keeps the submitted session visible and reports an error when the automatic AI turn fails", async () => {
    const initialSession = baseSession("running", 4);
    const submittedSession = baseSession("running", 5, [aiStep]);
    const api = {
      submitUserInput: vi.fn(async () => ({ ok: true, data: { session: submittedSession } })),
      runAiTurn: vi.fn(async () => ({ ok: false, error: { code: "provider_error", message: "provider timeout" } }))
    } as unknown as ApiClient;
    const updatedSessions: SessionView[] = [];
    const errors: unknown[] = [];

    await submitUserInputAndMaybeRunAiTurn({
      session: initialSession,
      api,
      input: "I led the launch.",
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: (error) => errors.push(error)
    });

    expect(updatedSessions).toEqual([submittedSession]);
    expect(errors).toEqual([{ code: "provider_error", message: "provider timeout" }]);
  });

  it("automatically runs the initial AI step once per session version", async () => {
    const initialSession = baseSession("running", 0, [aiStep]);
    const aiSession = baseSession("running", 1, [userStep]);
    const api = {
      runAiTurn: vi.fn(async () => ({
        ok: true,
        data: {
          session: aiSession,
          ai_turn_observability: {
            adapter_kind: "fake",
            model_config_id: "model_fake",
            provider: "openai-compatible",
            model: "gpt-test",
            visible_history: []
          }
        }
      }))
    } as unknown as ApiClient;
    const triggeredKeys = new Set<string>();
    const updatedSessions: SessionView[] = [];
    const errors: unknown[] = [];

    await runInitialAiTurnIfNeeded({
      session: initialSession,
      api,
      triggeredKeys,
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: (error) => errors.push(error)
    });
    await runInitialAiTurnIfNeeded({
      session: initialSession,
      api,
      triggeredKeys,
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: (error) => errors.push(error)
    });
    await runInitialAiTurnIfNeeded({
      session: baseSession("paused", 0, [aiStep]),
      api,
      triggeredKeys,
      onSessionUpdated: (session) => updatedSessions.push(session),
      onError: (error) => errors.push(error)
    });

    expect(api.runAiTurn).toHaveBeenCalledTimes(1);
    expect(api.runAiTurn).toHaveBeenCalledWith("session-auto-ai", expect.objectContaining({
      actor_id: "ai_interviewer",
      expected_state_version: 0,
      idempotency_key: "ai-initial-session-auto-ai-0"
    }));
    expect(updatedSessions).toEqual([aiSession]);
    expect(errors).toEqual([]);
  });

  it("does not submit or expose step names when there is not exactly one human step", async () => {
    const session = baseSession("running", 4, [
      userStep,
      { id: "clarify_interview_answer", actor_id: "user_candidate", actor_kind: "user", args_schema: true }
    ]);
    const api = {
      submitUserInput: vi.fn(),
      runAiTurn: vi.fn()
    } as unknown as ApiClient;
    const errors: unknown[] = [];

    const result = await submitUserInputAndMaybeRunAiTurn({
      session,
      api,
      input: "I led the launch.",
      onSessionUpdated: () => undefined,
      onError: (error) => errors.push(error)
    });

    expect(result).toEqual({ submitted: false, ranAiTurn: false });
    expect(api.submitUserInput).not.toHaveBeenCalled();
    expect(JSON.stringify(errors)).toContain("当前无法提交回答，请刷新或稍后重试。");
    expect(JSON.stringify(errors)).not.toMatch(/answer_interview_question|clarify_interview_answer|step|action|allowed/i);
  });

  it("keeps the Web API client ai-turn type aligned with observability DTOs", () => {
    const assertRunAiTurnType = (api: ApiClient): Promise<AiTurnResult> =>
      api.runAiTurn("session_1", { actor_id: "ai_interviewer", expected_state_version: 0 });
    const assertSubmitUserInputType = (api: ApiClient) =>
      api.submitUserInput("session_1", { input: "answer", expected_state_version: 0 });
    expect(typeof assertRunAiTurnType).toBe("function");
    expect(typeof assertSubmitUserInputType).toBe("function");
  });

  it("keeps the import/export API client boundary without exposing it as primary navigation", () => {
    const api = new ProductApiClient() as unknown as Record<string, unknown>;
    const html = renderToStaticMarkup(
      <Layout currentPage="home" session={null} error={null} onNavigate={() => undefined}>
        <p>首页内容</p>
      </Layout>
    );

    expect(html).not.toContain("导入导出");
    expect(html).not.toMatch(/export_json|schema_version|normalized_hash|scene_id|session_id|state_version|step_id/i);
    expect(typeof api["exportScene"]).toBe("function");
    expect(typeof api["importScene"]).toBe("function");
  });

  it("renders P2 navigation entries for materials and scene management", () => {
    const html = renderToStaticMarkup(
      <Layout currentPage="home" session={null} error={null} onNavigate={() => undefined}>
        <p>首页内容</p>
      </Layout>
    );

    expect(html).toContain("材料");
    expect(html).toContain("我的场景");
    expect(html).not.toMatch(/material_id|scene_id|draft_id|review_id|session_id|RuntimeEvent|raw prompt|provider raw/i);
  });

  it("renders lightweight material creation and safe summaries without raw material internals", () => {
    const html = renderToStaticMarkup(
      <MaterialsPage
        materials={[
          {
            id: "material_1",
            title: "答辩背景材料",
            source_label: "手动粘贴",
            summary: "项目目标是提升复盘质量。",
            created_at: "2026-06-20T00:00:00.000Z"
          }
        ]}
        status="ready"
        message=""
        api={{} as never}
        onMaterialsChanged={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("我的材料");
    expect(html).toContain("材料管理");
    expect(html).not.toContain(">Materials<");
    expect(html).toContain("materials-page");
    expect(html).toContain("materials-hero");
    expect(html).toContain("materials-layout");
    expect(html).toContain("materials-card");
    expect(html).toContain("materials-list");
    expect(html).toContain("材料名称");
    expect(html).toContain("材料正文");
    expect(html).toContain("保存到材料库");
    expect(html).toContain("答辩背景材料");
    expect(html).toContain("项目目标是提升复盘质量。");
    expect(html).not.toMatch(/material_1|material_id|content_json|Authorization|Bearer|api[_-]?key|raw prompt|provider raw|storage row/i);
  });

  it("renders material attachment on scene confirmation using product copy", () => {
    const confidentialFullText = "CONFIDENTIAL_FULL_MATERIAL_SHOULD_NOT_RENDER";
    const safeSummary = "已保存 42 字材料，可用于演练上下文。";
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_1",
          template_id: "thesis_defense",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "论文答辩", is_default: false },
            materials: [{ label: "评审背景", value: "项目评审", is_default: false }],
            attached_materials: [{
              label: "答辩背景材料",
              value: safeSummary,
              is_default: false,
              source_label: "手动粘贴",
              source_ref: "material:material_1",
              source_type: "library_text"
            }]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        materials={[{ id: "material_1", title: "答辩背景材料", source_label: "手动粘贴", summary: safeSummary, created_at: "now" }]}
        onMaterialAttached={() => undefined}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("模板背景");
    expect(html).toContain("评审背景");
    expect(html).toContain("已附加材料");
    expect(html).toContain("答辩背景材料");
    expect(html).toContain("手动粘贴");
    expect(html).toContain(safeSummary);
    expect(html).not.toContain(confidentialFullText);
    expect(html).not.toMatch(/material_1|draft_1|material_id|draft_id|content_json|raw JSON|raw prompt|provider raw/i);
  });

  it("falls back when attached material preview value is not a recognized safe summary", () => {
    const confidentialFullText = "CONFIDENTIAL_FULL_MATERIAL_SHOULD_NOT_RENDER";
    const fallback = "已附加为演练上下文，不展示材料正文。";
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_1",
          template_id: "thesis_defense",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "论文答辩", is_default: false },
            attached_materials: [{
              label: "答辩背景材料",
              value: confidentialFullText,
              is_default: false,
              source_label: "手动粘贴",
              source_ref: "material:material_1",
              source_type: "library_text"
            }]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        materials={[]}
        onMaterialAttached={() => undefined}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("已附加材料");
    expect(html).toContain("答辩背景材料");
    expect(html).toContain("手动粘贴");
    expect(html).toContain(fallback);
    expect(html).not.toContain(confidentialFullText);
    expect(html).not.toMatch(/material_1|draft_1|material_id|draft_id|content_json|raw prompt|provider raw/i);
  });

  it("renders material library copy and scene material workspace controls", () => {
    const confidentialFullText = "CONFIDENTIAL_FULL_MATERIAL_SHOULD_NOT_RENDER";
    const safeSummary = "已保存 42 字材料，可用于演练上下文。";
    const materialsHtml = renderToStaticMarkup(
      <MaterialsPage
        materials={[]}
        status="ready"
        message=""
        api={{} as never}
        onMaterialsChanged={() => undefined}
        onError={() => undefined}
      />
    );
    expect(materialsHtml).toContain("材料库");
    expect(materialsHtml).toContain("材料管理");
    expect(materialsHtml).not.toContain(">Materials<");
    expect(materialsHtml).toContain("开始前确认页引用");
    expect(materialsHtml).toContain("保存到材料库");

    const sceneHtml = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_1",
          template_id: "thesis_defense",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "论文答辩", is_default: false },
            attached_materials: [{
              label: "答辩背景材料",
              value: safeSummary,
              is_default: false,
              source_label: "手动粘贴",
              source_ref: "material:material_1",
              source_type: "library_text"
            }]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        materials={[{ id: "material_1", title: "答辩背景材料", source_label: "手动粘贴", summary: safeSummary, created_at: "now" }]}
        onMaterialAttached={() => undefined}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );
    expect(sceneHtml).toContain("场景材料");
    expect(sceneHtml).toContain("引用材料库");
    expect(sceneHtml).toContain("已引用");
    expect(sceneHtml).toContain("disabled");
    expect(sceneHtml).toContain("添加临时文本材料");
    expect(sceneHtml).toContain("只用于当前草稿，不会保存到材料库");
    expect(sceneHtml).toContain("当前仅支持文本，文件材料后续支持");
    expect(sceneHtml).toContain(safeSummary);
    expect(sceneHtml).not.toContain(confidentialFullText);
    expect(sceneHtml).not.toMatch(/material_1|draft_1|material_id|draft_id|content_json|raw prompt|provider raw/i);
  });

  it("renders attached material visibility cards without exposing material body or internal terms", () => {
    const confidentialFullText = "CONFIDENTIAL_FULL_MATERIAL_SHOULD_NOT_RENDER";
    const safeSummary = "已保存 42 字材料，可用于演练上下文。";
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_1",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now",
          visibility_options: {
            roles: [
              { id: "user_candidate", display_name: "候选人", kind: "user" },
              { id: "ai_interviewer", display_name: "面试官", kind: "ai" }
            ],
            stages: [
              { id: "opening", title: "开场" },
              { id: "deep_dive", title: "正式追问" }
            ]
          },
          preview: {
            title: { value: "求职面试", is_default: false },
            attached_materials: [{
              label: "候选人简历",
              value: safeSummary,
              is_default: false,
              source_label: "手动粘贴",
              source_ref: "material:resume_safe",
              source_type: "library_text"
            }]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        materials={[]}
        onMaterialAttached={() => undefined}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("已附加材料与可见性配置");
    expect(html).toContain("候选人简历");
    expect(html).toContain("手动粘贴");
    expect(html).toContain(safeSummary);
    expect(html).toContain("全部角色全文可见");
    expect(html).toContain("配置可见性");
    expect(html).not.toContain(confidentialFullText);
    expect(html).not.toMatch(/source_ref|material_key|visibility_policy|context_text|redacted|raw prompt|provider raw/i);
  });

  it("paginates material library and attached material cards on scene confirmation", () => {
    const summary = "已保存 42 字材料，可用于演练上下文。";
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_1",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now",
          visibility_options: {
            roles: [
              { id: "user_candidate", display_name: "候选人", kind: "user" },
              { id: "ai_interviewer", display_name: "面试官", kind: "ai" }
            ],
            stages: [{ id: "opening", title: "开场" }]
          },
          preview: {
            title: { value: "求职面试", is_default: false },
            attached_materials: [
              { label: "已附加材料 1", value: summary, is_default: false, source_label: "手动粘贴", source_ref: "material:attached_1", source_type: "library_text" },
              { label: "已附加材料 2", value: summary, is_default: false, source_label: "手动粘贴", source_ref: "material:attached_2", source_type: "library_text" },
              { label: "已附加材料 3", value: summary, is_default: false, source_label: "手动粘贴", source_ref: "material:attached_3", source_type: "library_text" }
            ]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        materials={[
          { id: "material_1", title: "材料库材料 1", source_label: "手动粘贴", summary, created_at: "now" },
          { id: "material_2", title: "材料库材料 2", source_label: "手动粘贴", summary, created_at: "now" },
          { id: "material_3", title: "材料库材料 3", source_label: "手动粘贴", summary, created_at: "now" },
          { id: "material_4", title: "材料库材料 4", source_label: "手动粘贴", summary, created_at: "now" }
        ]}
        onMaterialAttached={() => undefined}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("材料库 1-3 / 4");
    expect(html).toContain("已附加 1-2 / 3");
    expect(html).toContain("材料库材料 1");
    expect(html).toContain("材料库材料 3");
    expect(html).not.toContain("材料库材料 4");
    const visibilitySectionHtml = html.slice(html.indexOf("已附加材料与可见性配置"));
    expect(visibilitySectionHtml).toContain("已附加材料 1");
    expect(visibilitySectionHtml).toContain("已附加材料 2");
    expect(visibilitySectionHtml).not.toContain("已附加材料 3");
  });

  it("defines the material visibility editor controls and layout safeguards", () => {
    const source = fs.readFileSync(new URL("./SceneConfirmPage.tsx", import.meta.url), "utf8");
    const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(source).toContain("全部全文");
    expect(source).toContain("全部摘要");
    expect(source).toContain("全部不可见");
    expect(source).toContain("全文会进入角色上下文");
    expect(source).toContain("按阶段单独配置");
    expect(source).toContain("将当前阶段设置复制到全部阶段");
    expect(source).toContain("恢复全部阶段全文可见");
    expect(source).toContain("updateDraftMaterialVisibility");
    expect(source).toContain("setVisibilityError");
    expect(source).toContain("material-visibility-modal-backdrop");
    expect(source).toContain("aria-label={`");
    expect(source).not.toMatch(/redacted|visibility_policy|context_text/);

    expect(styles).toContain(".scene-materials-pagination");
    expect(styles).toContain(".material-visibility-card");
    expect(styles).toContain(".material-visibility-modal");
    expect(styles).toContain(".material-visibility-editor");
    expect(styles).toContain(".visibility-role-row");
    expect(styles).toContain(".visibility-access-options");
    expect(styles).toContain("overflow-x: auto");
    expect(styles).toContain("-webkit-line-clamp");
  });

  it("renders semantic scenario preview without raw runtime protocol fields", () => {
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_semantic",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "求职面试", is_default: false }
          },
          semantic_preview: {
            title: "求职面试",
            roles: [{ title: "候选人", kind: "user", goal: "回答有证据的问题。" }],
            stages: [{ title: "开场与背景确认", goal: "确认背景。", roles: ["候选人", "面试官"], tools: ["Mock RAG"] }],
            visibility: [{ subject: "候选人 / 开场与背景确认", target: "材料：interview_context", access: "摘要可见" }],
            review_dimensions: [{ title: "证据密度", evidence_requirement: "required" }],
            quality: { status: "ready", ok: true, issues: [] }
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("角色");
    expect(html).toContain("候选人");
    expect(html).toContain("开场与背景确认");
    expect(html).toContain("复盘维度");
    expect(html).toContain("证据密度");
    expect(html).toContain("需要可观察证据");
    expect(html).not.toContain("required");
    expect(html).not.toMatch(/Mock RAG|可用工具|质量门禁|完整可见|摘要可见|interview_context|actor_id|step_id|RuntimeEvent|raw prompt|state_version|draft_semantic/i);
  });

  it("renders repractice CTA on successful reviews without exposing review or session ids", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("ended", 9, [])}
        review={{
          id: "review_1",
          session_id: "session-auto-ai",
          created_at: "now",
          status: "succeeded",
          summary: "回答结构清晰。",
          dimensions: [{ name: "结构化表达", conclusion: "回答包含背景、行动和结果。", evidence_refs: [] }],
          key_moments: [],
          evidence_refs: [],
          recommendations: [{ text: "补充量化指标。", evidence_refs: [] }],
          uncertainty_notes: ["证据较少。"],
          completed_at: "now"
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onRepracticeStarted={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("重新练习");
    expect(html).toContain("证据较少。");
    expect(html).not.toMatch(/review_1|session-auto-ai|review_id|session_id|RuntimeEvent|raw state/i);
  });

  it("renders basic scene management actions and history entries with readable copy", () => {
    const html = renderToStaticMarkup(
      <SceneManagementPage
        recent={{
          drafts: [{ id: "draft_1", title: "论文答辩草稿", status: "draft", template_id: "thesis_defense", created_at: "now", updated_at: "now" }],
          scenes: [{ id: "scene_1", title: "论文答辩", status: "confirmed", draft_id: "draft_1", scenario_id: "scenario_thesis", created_at: "now", updated_at: "now" }],
          sessions: [{ id: "session_1", title: "论文答辩", status: "ended", scenario_id: "scenario_thesis", created_at: "now", updated_at: "now" }],
          reviews: [{ id: "review_1", title: "论文答辩复盘", status: "succeeded", session_id: "session_1", created_at: "now", updated_at: "now" }]
        }}
        status="ready"
        api={{} as never}
        onOpenDraft={() => undefined}
        onOpenReview={() => undefined}
        onSceneCopied={() => undefined}
        onSceneDeleted={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("我的场景");
    expect(html).toContain("复制场景");
    expect(html).toContain("删除场景");
    expect(html).toContain("继续编辑草稿");
    expect(html).toContain("历史复盘");
    expect(html).toContain("论文答辩复盘");
    expect(html).not.toMatch(/scene_1|draft_1|session_1|review_1|scenario_thesis|scenario_id|draft_id|review_id|session_id|raw JSON/i);
  });

  it("renders review records archive when no single history session is selected", () => {
    const longReviewTitle = "这是一段非常长的复盘记录标题，不应在归档卡片里完整铺开，因为它会破坏列表视觉层级。";
    const html = renderToStaticMarkup(
      <SessionHistoryPage
        history={null}
        status="ready"
        error=""
        archive={{
          sessions: [{
            id: "session_1",
            title: "求职面试",
            status: "completed",
            status_label: "已完成",
            scenario_id: "scenario_1",
            created_at: "2026-07-11T09:58:00.000Z",
            updated_at: "2026-07-11T10:00:00.000Z"
          }],
          reviews: [{
            id: "review_1",
            title: longReviewTitle,
            status: "succeeded",
            session_id: "session_1",
            created_at: "2026-07-11T10:06:00.000Z",
            updated_at: "2026-07-11T10:08:00.000Z"
          }]
        }}
        onOpenReview={() => undefined}
        onOpenSessionArchive={() => undefined}
        onRepractice={() => undefined}
      />
    );

    expect(html).toContain("复盘记录");
    expect(html).toContain("查看复盘");
    expect(html).toContain("查看关联练习");
    expect(html).toContain(`aria-label="查看 ${longReviewTitle}"`);
    expect(html).toContain("aria-label=\"查看 求职面试 的关联练习\"");
    expect(html).not.toContain("请选择一条历史演练");
    expect(html).not.toContain(`<h3>${longReviewTitle}</h3>`);
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/review_1|session_1|scenario_1|session_id|scenario_id|event_id|actor_id|step_id|state_version/i);
  });

  it("paginates review archive records and practice archive records", () => {
    const html = renderToStaticMarkup(
      <SessionHistoryPage
        history={null}
        status="ready"
        error=""
        archive={{
          sessions: Array.from({ length: 7 }, (_, index) => ({
            id: `unreviewed_session_${index}`,
            title: `未复盘练习 ${index + 1}`,
            status: "completed" as const,
            scenario_id: "scenario_job_interview",
            created_at: "2026-07-11T09:58:00.000Z",
            updated_at: "2026-07-11T10:00:00.000Z"
          })),
          reviews: Array.from({ length: 7 }, (_, index) => ({
            id: `archive_review_${index}`,
            title: `分页复盘 ${index + 1}`,
            status: "succeeded" as const,
            session_id: `reviewed_session_${index}`,
            created_at: "2026-07-11T10:06:00.000Z",
            updated_at: "2026-07-11T10:08:00.000Z"
          }))
        }}
        onOpenReview={() => undefined}
        onOpenSessionArchive={() => undefined}
        onRepractice={() => undefined}
      />
    );

    expect(html).toContain("分页复盘 6");
    expect(html).not.toContain("分页复盘 7");
    expect(html).toContain("未复盘练习 3");
    expect(html).not.toContain("未复盘练习 4");
    expect(html).toContain("第 1 / 2 页 · 共 7 项");
    expect(html).toContain("第 1 / 3 页 · 共 7 项");
    expect(html).toContain("pagination-controls");
    expect(html).not.toMatch(/archive_review_|unreviewed_session_|reviewed_session_|session_id|scenario_id|review_id/i);
  });

  it("lays out six completed review records as two full rows on desktop", () => {
    const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.review-archive-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[\s\S]*\.review-archive-grid,\s*\.scene-management-hero/s);
  });

  it("guards history branch tree refreshes against stale archive detail requests", () => {
    const appSource = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(appSource).toContain("const refreshBranchTree = useCallback(async (sessionId: string, expectedHistoryRequestVersion?: number)");
    expect(appSource).toContain("if (expectedHistoryRequestVersion !== undefined && sessionHistoryRequestVersion.current !== expectedHistoryRequestVersion)");
    expect(appSource).toContain("setBranchTree(null);\n    void refreshBranchTree(sessionId, requestVersion);");
  });

  it("renders session history details as a user-facing practice archive without internal ids", () => {
    const history: SessionHistoryView = {
      title: "论文答辩",
      status: "ended",
      created_at: "2026-06-21T08:00:00.000Z",
      updated_at: "2026-06-21T08:10:00.000Z",
      rounds: 2,
      model_summary: { label: "Fake LLM", mode: "fake" },
      scene: { title: "论文答辩", archived: true },
      transcript: [
        { sequence: 1, speaker: "主评审", text: "请介绍你的研究问题。" },
        { sequence: 2, speaker: "答辩人", text: "我的研究关注可解释性。" }
      ],
      reviews: [{ id: "review_1", title: "论文答辩复盘", status: "succeeded" }]
    };
    const html = renderToStaticMarkup(
      <SessionHistoryPage
        history={history}
        status="ready"
        error=""
        onOpenReview={() => undefined}
        onRepractice={() => undefined}
      />
    );

    expect(html).toContain("练习档案");
    expect(html).toContain("论文答辩");
    expect(html).toContain("已归档场景");
    expect(html).toContain("完整对话");
    expect(html).toContain("主评审");
    expect(html).toContain("请介绍你的研究问题。");
    expect(html).toContain("关联复盘");
    expect(html).toContain("Fake LLM");
    expect(html).toContain("查看关联复盘");
    expect(html).not.toMatch(/session_id|scenario_id|event_id|actor_id|step_id|state_version|RuntimeEvent|review_1|scene_1|session_1|raw state/i);
  });

  it("renders SessionHistoryPage as archive cards with transcript, reviews and branch context", () => {
    const history: SessionHistoryView = {
      title: "论文答辩",
      status: "ended",
      created_at: "2026-06-21T08:00:00.000Z",
      updated_at: "2026-06-21T08:10:00.000Z",
      rounds: 2,
      model_summary: { label: "Fake LLM", mode: "fake" },
      scene: { title: "论文答辩", archived: true },
      transcript: [
        { sequence: 1, speaker: "主评审", text: "请介绍你的研究问题。" },
        { sequence: 2, speaker: "答辩人", text: "我的研究关注可解释性。" }
      ],
      reviews: [{ id: "review_history_style", title: "论文答辩复盘", status: "succeeded" }]
    };
    const html = renderToStaticMarkup(
      <SessionHistoryPage
        history={history}
        status="ready"
        error=""
        branchTree={{
          root_session_id: "session-history-root",
          current_session_id: "session-history-child",
          nodes: [
            {
              session_id: "session-history-root",
              parent_session_id: null,
              label: "主线",
              status: "ended",
              rounds: 2,
              created_at: "now",
              is_current: false,
              has_review: true,
              children: []
            }
          ]
        }}
        onOpenReview={() => undefined}
        onOpenBranch={() => undefined}
        onCreateBranchReview={() => undefined}
        onRepractice={() => undefined}
      />
    );

    expect(html).toContain("history-page");
    expect(html).toContain("history-hero");
    expect(html).toContain("history-content-grid");
    expect(html).toContain("history-card");
    expect(html).toContain("history-transcript-list");
    expect(html).toContain("history-review-list");
    expect(html).toContain("branch-tree-card");
    expect(html).toContain("论文答辩复盘");
    expect(html).not.toMatch(/review_history_style|session-history-root|session-history-child|session_id|event_id|actor_id|step_id|state_version/i);
  });

  it("renders practice archive without score trends", () => {
    const history: SessionHistoryView = {
      title: "论文答辩",
      status: "ended",
      created_at: "2026-06-21T08:00:00.000Z",
      updated_at: "2026-06-21T08:10:00.000Z",
      rounds: 2,
      model_summary: { label: "Fake LLM", mode: "fake" },
      scene: { title: "论文答辩", archived: true },
      transcript: [
        { sequence: 1, speaker: "主评审", text: "请介绍你的研究问题。" },
        { sequence: 2, speaker: "答辩人", text: "我的研究关注可解释性。" }
      ],
      reviews: [{ id: "review_archive_truth", title: "论文答辩复盘", status: "succeeded" }]
    };
    const html = renderToStaticMarkup(
      <SessionHistoryPage
        history={history}
        status="ready"
        error=""
        onOpenReview={() => undefined}
        onRepractice={() => undefined}
      />
    );

    expect(html).toContain("练习档案");
    expect(html).toContain("完整对话");
    expect(html).toContain("关联复盘");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/得分趋势|平均得分|综合评分|雷达/);
  });

  it("lets users generate a review from terminal session history when no review exists", () => {
    const history: SessionHistoryView = {
      title: "求职面试",
      status: "completed",
      status_label: "已完成",
      created_at: "2026-07-10T03:08:45.193Z",
      updated_at: "2026-07-10T03:13:37.239Z",
      rounds: 41,
      model_summary: { label: "真实模型", mode: "real" },
      scene: { title: "求职面试", archived: false },
      transcript: [
        { sequence: 1, speaker: "面试官", text: "请介绍你的项目。" },
        { sequence: 2, speaker: "候选人", text: "我负责 RuntimeIR v3。" }
      ],
      reviews: []
    };
    const html = renderToStaticMarkup(
      <SessionHistoryPage
        history={history}
        status="ready"
        error=""
        onOpenReview={() => undefined}
        onCreateReview={() => undefined}
        onRepractice={() => undefined}
      />
    );

    expect(html).toContain("这次练习还没有生成复盘。");
    expect(html).toContain("生成复盘");
    expect(html).not.toMatch(/session_id|review_id|event_id|actor_id|step_id|state_version|RuntimeEvent|raw state/i);
  });

  it("renders scene archive library search, filters, rename, archive and history CTAs without internal ids", () => {
    const archive: SceneArchiveSummary[] = [
      {
        id: "scene_1",
        title: "论文答辩",
        archived: false,
        created_at: "2026-06-21T08:00:00.000Z",
        updated_at: "2026-06-21T08:10:00.000Z",
        session_count: 1,
        review_count: 1,
        latest_session: { id: "session_1", title: "论文答辩", status: "ended", created_at: "now", updated_at: "now" },
        latest_review: { id: "review_1", title: "论文答辩复盘", status: "succeeded", created_at: "now", updated_at: "now" }
      }
    ];
    const html = renderToStaticMarkup(
      <SceneManagementPage
        recent={{ drafts: [], scenes: [], sessions: [], reviews: [] }}
        archive={archive}
        status="ready"
        api={{} as never}
        onOpenDraft={() => undefined}
        onOpenSessionHistory={() => undefined}
        onOpenReview={() => undefined}
        onSceneCopied={() => undefined}
        onSceneRenamed={() => undefined}
        onSceneDeleted={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("练习档案库");
    expect(html).toContain("scene-management-page");
    expect(html).toContain("scene-management-hero");
    expect(html).toContain("scene-archive-toolbar");
    expect(html).toContain("scene-archive-grid");
    expect(html).toContain("scene-archive-card");
    expect(html).toContain("scene-management-grid");
    expect(html).toContain("scene-management-card");
    expect(html).toContain("搜索场景或复盘");
    expect(html).toContain("全部场景");
    expect(html).toContain("仅看已归档");
    expect(html).toContain("重命名");
    expect(html).toContain("归档场景");
    expect(html).toContain("查看演练详情");
    expect(html).toContain("查看关联复盘");
    expect(html).not.toMatch(/scene_1|session_1|review_1|scene_id|session_id|review_id|scenario_id|draft_id|raw JSON/i);
  });

  it("paginates scene management lists so the page does not grow without bounds", () => {
    const archive = Array.from({ length: 7 }, (_, index): SceneArchiveSummary => ({
      id: `archive_scene_${index}`,
      title: `场景档案 ${index + 1}`,
      archived: false,
      created_at: "2026-06-21T08:00:00.000Z",
      updated_at: `2026-06-21T08:${String(index).padStart(2, "0")}:00.000Z`,
      session_count: 1,
      review_count: 1,
      latest_session: { id: `archive_session_${index}`, title: `最近演练 ${index + 1}`, status: "ended", created_at: "now", updated_at: "now" },
      latest_review: { id: `archive_review_${index}`, title: `最近复盘 ${index + 1}`, status: "succeeded", created_at: "now", updated_at: "now" }
    }));
    const recent = {
      drafts: Array.from({ length: 4 }, (_, index) => ({ id: `draft_${index}`, title: `草稿 ${index + 1}`, status: "draft" as const, template_id: "job_interview", created_at: "now", updated_at: "now" })),
      scenes: Array.from({ length: 4 }, (_, index) => ({ id: `scene_${index}`, title: `已确认 ${index + 1}`, status: "confirmed" as const, draft_id: `draft_${index}`, scenario_id: "scenario_job_interview", created_at: "now", updated_at: "now" })),
      sessions: [],
      reviews: Array.from({ length: 4 }, (_, index) => ({ id: `review_${index}`, title: `复盘 ${index + 1}`, status: "succeeded" as const, session_id: `session_${index}`, created_at: "now", updated_at: "now" }))
    };

    const html = renderToStaticMarkup(
      <SceneManagementPage
        recent={recent}
        archive={archive}
        status="ready"
        api={{} as never}
        onOpenDraft={() => undefined}
        onOpenSessionHistory={() => undefined}
        onOpenReview={() => undefined}
        onSceneCopied={() => undefined}
        onSceneRenamed={() => undefined}
        onSceneDeleted={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("场景档案 3");
    expect(html).not.toContain("场景档案 4");
    expect(html).toContain("第 1 / 3 页 · 共 7 项");
    expect(html).toContain("已确认 3");
    expect(html).not.toContain("已确认 4");
    expect(html).toContain("草稿 3");
    expect(html).not.toContain("草稿 4");
    expect(html).toContain("复盘 3");
    expect(html).not.toContain("<strong>复盘 4</strong>");
    expect(html).toContain("第 1 / 2 页 · 共 4 项");
    expect(html).toContain("pagination-controls");
    expect(html).not.toMatch(/archive_scene_|archive_session_|archive_review_|draft_0|scene_0|review_0|scenario_id|session_id|review_id|draft_id/i);
  });

  it("keeps scene management section pagination controls on one baseline", () => {
    const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.scene-management-card\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto[\s\S]*align-content:\s*stretch/s);
    expect(css).toMatch(/\.scene-management-card\s*>\s*\.scene-mini-list\s*\{[\s\S]*align-self:\s*stretch[\s\S]*min-height:\s*0/s);
    expect(css).toMatch(/\.scene-management-card\s*>\s*\.pagination-controls\s*\{[\s\S]*align-self:\s*end[\s\S]*margin-top:\s*auto/s);
  });

  it("renders complex scenario builder controls and creates a draft from structured configuration", async () => {
    const createdDraft: DraftView = {
      id: "draft_complex",
      template_id: "complex_config",
      created_at: "now",
      updated_at: "now",
      preview: {
        title: { value: "增长平台项目评审", is_default: false },
        goal: { value: "验证增长平台方案", is_default: false },
        user_role: { value: "方案负责人", is_default: false },
        ai_role: { value: "业务评审 / 技术评审", is_default: false },
        flow: [
          { label: "流程 1", value: "开场：确认目标和背景（1 轮）", is_default: false },
          { label: "流程 2", value: "证据追问：连续追问指标证据和取舍（2 轮）", is_default: false },
          { label: "流程 3", value: "风险收束：收束风险、限制和下一步计划（1 轮）", is_default: false }
        ]
      }
    };
    const api = {
      createDraftFromComplexConfig: vi.fn(async () => ({ ok: true, data: { draft: createdDraft } }))
    } as unknown as ApiClient;
    const drafts: DraftView[] = [];
    const element = (
      <ScenarioBuilderPage
        api={api}
        onDraftCreated={(draft) => drafts.push(draft)}
        onError={() => undefined}
      />
    );
    const html = renderToStaticMarkup(element);

    expect(html).toContain("复杂场景配置");
    expect(html).toContain("scenario-builder-page");
    expect(html).toContain("scenario-builder-hero");
    expect(html).toContain("scenario-builder-grid");
    expect(html).toContain("scenario-builder-card");
    expect(html).toContain("场景标题");
    expect(html).toContain("演练目标");
    expect(html).toContain("用户角色");
    expect(html).toContain("AI 角色");
    expect(html).toContain("阶段");
    expect(html).toContain("每阶段轮次");
    expect(html).toContain("追问策略");
    expect(html).toContain("终止条件");
    expect(html).toContain("添加 AI 角色");
    expect(html).toContain("删除 AI 角色");
    expect(html).toContain("至少保留 2 个 AI 角色");
    expect(html).toContain("生成场景草稿");
    expect(html).not.toMatch(/actor_id|step_id|scheduler|RuntimeEvent|NormalizedScenario|提示词|运行协议|raw JSON/i);

    await createComplexScenarioDraft(api, defaultComplexScenarioConfig, (draft) => drafts.push(draft), () => undefined);
    expect(api.createDraftFromComplexConfig).toHaveBeenCalledWith(expect.objectContaining({
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
    }));
    expect(drafts).toEqual([createdDraft]);
  });

  it("builds and previews a four-AI-role complex review configuration", async () => {
    const helpers = requireComplexScenarioBuilderHelpers();
    const configWithFourRoles = [
      { name: "主持人", focus: "控制评审节奏、澄清共识和沉淀结论" },
      { name: "架构评审", focus: "架构边界、技术取舍和系统复杂度" },
      { name: "产品评审", focus: "用户价值、指标口径和范围取舍" },
      { name: "可靠性评审", focus: "SLO、降级预案、发布风险和可观测性" }
    ].reduce(
      (current, role, index) =>
        helpers.updateComplexAiRole(
          index < current.ai_roles.length ? current : helpers.addComplexAiRole(current),
          index,
          role
        ),
      defaultComplexScenarioConfig
    );
    const createdDraft: DraftView = {
      id: "draft_complex_four_roles",
      template_id: "complex_config",
      created_at: "now",
      updated_at: "now",
      preview: {
        title: { value: "增长平台项目评审", is_default: false },
        goal: { value: "验证增长平台方案", is_default: false },
        user_role: { value: "方案负责人", is_default: false },
        ai_role: { value: "主持人 / 架构评审 / 产品评审 / 可靠性评审", is_default: false },
        flow: []
      }
    };
    const api = {
      createDraftFromComplexConfig: vi.fn(async () => ({ ok: true, data: { draft: createdDraft } }))
    } as unknown as ApiClient;
    const drafts: DraftView[] = [];
    const previewHtml = renderToStaticMarkup(<helpers.ComplexScenarioPreview config={configWithFourRoles} />);

    expect(configWithFourRoles.ai_roles).toEqual([
      { name: "主持人", focus: "控制评审节奏、澄清共识和沉淀结论" },
      { name: "架构评审", focus: "架构边界、技术取舍和系统复杂度" },
      { name: "产品评审", focus: "用户价值、指标口径和范围取舍" },
      { name: "可靠性评审", focus: "SLO、降级预案、发布风险和可观测性" }
    ]);
    expect(previewHtml).toContain("主持人：控制评审节奏、澄清共识和沉淀结论");
    expect(previewHtml).toContain("架构评审：架构边界、技术取舍和系统复杂度");
    expect(previewHtml).toContain("产品评审：用户价值、指标口径和范围取舍");
    expect(previewHtml).toContain("可靠性评审：SLO、降级预案、发布风险和可观测性");
    expect(previewHtml).not.toMatch(/actor_id|step_id|scheduler|RuntimeEvent|NormalizedScenario|prompt|schema|提示词|运行协议|ai_role_\d|complex_config|raw JSON/i);

    await createComplexScenarioDraft(api, configWithFourRoles, (draft) => drafts.push(draft), () => undefined);
    expect(api.createDraftFromComplexConfig).toHaveBeenCalledWith(expect.objectContaining({
      ai_roles: [
        { name: "主持人", focus: "控制评审节奏、澄清共识和沉淀结论" },
        { name: "架构评审", focus: "架构边界、技术取舍和系统复杂度" },
        { name: "产品评审", focus: "用户价值、指标口径和范围取舍" },
        { name: "可靠性评审", focus: "SLO、降级预案、发布风险和可观测性" }
      ]
    }));
    expect(drafts).toEqual([createdDraft]);
  });

  it("omits the material summary section when a scene has no user-facing materials", () => {
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_without_materials",
          template_id: "complex_config",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "技术方案评审", is_default: false },
            materials: [],
            notes: [{ label: "结束条件", value: "形成评审结论后结束。", is_default: false }]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).not.toContain("材料摘要");
    expect(html).toContain("形成评审结论后结束。");
    expect(html).not.toMatch(/终止条件 ： 已附加为演练上下文|安全提醒 ： 已附加为演练上下文/);
  });

  it("keeps at least two AI roles when deleting from a complex scenario configuration", () => {
    const helpers = requireComplexScenarioBuilderHelpers();
    const threeRoleConfig = helpers.addComplexAiRole(defaultComplexScenarioConfig);
    const backToMinimum = helpers.removeComplexAiRole(threeRoleConfig, 2);
    const afterLowerBoundDelete = helpers.removeComplexAiRole(backToMinimum, 0);

    expect(threeRoleConfig.ai_roles).toHaveLength(3);
    expect(backToMinimum.ai_roles).toHaveLength(2);
    expect(afterLowerBoundDelete.ai_roles).toEqual(backToMinimum.ai_roles);
    expect(defaultComplexScenarioConfig.ai_roles).toHaveLength(2);
  });

  it("renders copied scene notices as stable status messages", () => {
    const html = renderToStaticMarkup(<NoticeMessage message="场景副本已创建，可继续编辑草稿。" />);

    expect(html).toContain("场景副本已创建，可继续编辑草稿。");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("renders the home workspace with creation, recent work, import and settings entries without internal ids", () => {
    const html = renderToStaticMarkup(
      <HomePage
        templates={[
          { id: "job_interview", title: "求职面试", description: "围绕目标岗位进行单人模拟面试。" }
        ]}
        session={baseSession("running", 3)}
        recentStatus="ready"
        recent={{
          drafts: [{ id: "draft_1", title: "求职面试草稿", status: "draft", template_id: "job_interview", created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:01:00.000Z" }],
          sessions: [{ id: "session_1", title: "求职面试演练", status: "running", scenario_id: "scenario_1", created_at: "2026-06-20T00:02:00.000Z", updated_at: "2026-06-20T00:03:00.000Z" }],
          reviews: [{ id: "review_1", title: "求职面试复盘", status: "succeeded", session_id: "session_1", created_at: "2026-06-20T00:04:00.000Z", updated_at: "2026-06-20T00:05:00.000Z" }]
        }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("下午好，继续精进");
    expect(html).toContain("开始一次演练");
    expect(html).toContain("自定义场景");
    expect(html).toContain("最近场景");
    expect(html).toContain("本地概览");
    expect(html).toContain("复盘提示");
    expect(html).toContain("home-start-band");
    expect(html).toContain("home-main-grid");
    expect(html).toContain("home-recent-scenes");
    expect(html).toContain("home-insight-rail");
    expect(html).not.toContain("推荐模板");
    expect(html).not.toContain("recent-work-grid");
    expect(html).toContain("求职面试草稿");
    expect(html).toContain("求职面试演练");
    expect(html).toContain("进行中");
    expect(html).toContain("求职面试复盘");
    expect(html).toContain("复盘已生成");
    expect(html).toContain("当前页面流程中有未完成演练");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/draft_1|session_1|review_1|scenario_1|session_id|scenario_id|draft_id|review_id|state_version|step_id|action_id|actor_id|allowed_steps|\bundefined\b|\bnull\b/i);
  });

  it("renders recent reviews with short titles and bounded summaries", () => {
    const longReviewTitle = "这是一段非常长的复盘总结，不应作为卡片主标题完整铺开，因为它会破坏首页布局。";
    const html = renderToStaticMarkup(
      <HomePage
        templates={[
          { id: "job_interview", title: "求职面试", description: "模拟面试" }
        ]}
        session={null}
        recentStatus="ready"
        recent={{
          drafts: [],
          sessions: [],
          reviews: [{
            id: "review_1",
            title: longReviewTitle,
            status: "succeeded",
            session_id: "session_1",
            created_at: "2026-07-11T09:58:00.000Z",
            updated_at: "2026-07-11T10:00:00.000Z"
          }, {
            id: "review_empty_title",
            title: "   ",
            status: "failed",
            session_id: "session_empty",
            created_at: "2026-07-11T09:50:00.000Z",
            updated_at: "2026-07-11T09:55:00.000Z"
          }]
        }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("recent-review-card");
    expect(html).toContain("查看复盘");
    expect(html).toContain("打开复盘查看完整报告。");
    expect(html).toContain("演练复盘");
    expect(html).not.toContain("复盘摘要");
    expect(html).not.toContain(longReviewTitle);
    const css = fs.readFileSync("apps/web/src/styles.css", "utf8");
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[\s\S]*\.recent-review-card\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[\s\S]*\.recent-review-card\s*>\s*span\s*\{[^}]*white-space:\s*normal/s);
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/review_1|review_empty_title|session_1|session_empty|review_id|session_id|model_config_id|Authorization|Bearer|api_key/i);
  });

  it("renders HomePage with a hero, primary actions, template cards and recent work cards", () => {
    const html = renderToStaticMarkup(
      <HomePage
        templates={[
          { id: "job_interview", title: "求职面试", description: "围绕目标岗位进行单人模拟面试。" }
        ]}
        session={baseSession("running", 3)}
        recentStatus="ready"
        recent={{
          drafts: [{ id: "draft_home_style", title: "求职面试草稿", status: "draft", template_id: "job_interview", created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:01:00.000Z" }],
          sessions: [{ id: "session_home_style", title: "求职面试演练", status: "running", scenario_id: "scenario_home_style", created_at: "2026-06-20T00:02:00.000Z", updated_at: "2026-06-20T00:03:00.000Z" }],
          reviews: [{ id: "review_home_style", title: "求职面试复盘", status: "succeeded", session_id: "session_home_style", created_at: "2026-06-20T00:04:00.000Z", updated_at: "2026-06-20T00:05:00.000Z" }]
        }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
        onGoToMaterials={() => undefined}
        onGoToSceneManagement={() => undefined}
      />
    );

    expect(html).toContain("home-page");
    expect(html).toContain("home-start-band");
    expect(html).toContain("primary-action");
    expect(html).toContain("home-main-grid");
    expect(html).toContain("home-recent-grid");
    expect(html).toContain("home-scene-card");
    expect(html).toContain("home-insight-rail");
    expect(html).toContain("home-resume-card");
    expect(html).not.toMatch(/draft_home_style|session_home_style|review_home_style|scenario_home_style|state_version|actor_id|step_id/i);
  });

  it("renders the template library with localized product copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(TemplatePage as unknown as React.ComponentType<Record<string, unknown>>, {
        template: null,
        templates: [
          {
            id: "job_interview",
            title: "求职面试",
            description: "围绕目标岗位进行单人模拟面试。"
          }
        ],
        params: {},
        onParamChange: () => undefined,
        onSelectTemplate: () => undefined,
        api: {} as ApiClient,
        onDraftCreated: () => undefined,
        onError: () => undefined
      })
    );

    expect(html).toContain("演练模板");
    expect(html).toContain("模板库");
    expect(html).toContain("求职面试");
    expect(html).toContain("开始演练");
    expect(html).not.toContain("Template Library");
  });

  it("keeps static page eyebrow labels localized", () => {
    const pageFiles = [
      "ScenarioBuilderPage.tsx",
      "SessionHistoryPage.tsx",
      "SceneManagementPage.tsx",
      "SettingsPage.tsx",
      "ImportExportPage.tsx",
      "MaterialsPage.tsx",
      "TemplatePage.tsx"
    ];
    const combinedSource = pageFiles
      .map((fileName) => fs.readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8"))
      .join("\n");

    expect(combinedSource).not.toMatch(/className="eyebrow">[A-Za-z]/);
    expect(combinedSource).not.toMatch(/className="eyebrow">(Template Library|Practice Library|Complex Scenario|Review Archive|Practice Archive|Default model|Portable Scene|Settings|Materials)</);
  });

  it("renders template creation errors on the template parameter page", () => {
    const html = renderToStaticMarkup(
      React.createElement(TemplatePage as unknown as React.ComponentType<Record<string, unknown>>, {
        template: {
          id: "job_interview",
          title: "求职面试",
          description: "基于目标岗位和面试重点生成可运行的结构化模拟面试。",
          param_schema: {
            type: "object",
            properties: {
              max_turns: { type: "integer", label: "轮次数", minimum: 3, maximum: 20, default: 20 }
            },
            required: ["max_turns"],
            additionalProperties: false
          },
          default_params: { max_turns: 20 }
        },
        params: { max_turns: "20" },
        onParamChange: () => undefined,
        api: {} as ApiClient,
        onDraftCreated: () => undefined,
        onError: () => undefined,
        creationError: { code: "validation_error", message: "轮次数最多支持 20，请调整后重试。" }
      })
    );

    expect(html).toContain("完善演练简报");
    expect(html).toContain("template-setup-page");
    expect(html).toContain("template-setup-grid");
    expect(html).toContain("template-form-card");
    expect(html).toContain("草稿创建失败");
    expect(html).toContain("轮次数最多支持 20，请调整后重试。");
    expect(html).toContain("role=\"alert\"");
  });

  it("renders template parameter descriptions so round count is understood as a target", () => {
    const html = renderToStaticMarkup(
      React.createElement(TemplatePage as unknown as React.ComponentType<Record<string, unknown>>, {
        template: {
          id: "job_interview",
          title: "求职面试",
          description: "基于目标岗位和面试重点生成可运行的结构化模拟面试。",
          param_schema: {
            type: "object",
            properties: {
              max_turns: {
                type: "integer",
                label: "建议目标轮次",
                description: "系统会围绕这个轮数安排追问并适时收束；你仍可提前结束演练。",
                minimum: 3,
                maximum: 20,
                default: 12
              }
            },
            required: ["max_turns"],
            additionalProperties: false
          },
          default_params: { max_turns: 12 }
        },
        params: { max_turns: "12" },
        onParamChange: () => undefined,
        api: {} as ApiClient,
        onDraftCreated: () => undefined,
        onError: () => undefined
      })
    );

    expect(html).toContain("建议目标轮次");
    expect(html).toContain("系统会围绕这个轮数安排追问并适时收束");
    expect(html).toContain("你仍可提前结束演练");
  });

  it("uses terminal recent session actions and hides unfinished-session copy after completion", () => {
    const completedHtml = renderToStaticMarkup(
      <HomePage
        templates={[]}
        session={baseSession("completed", 7, [])}
        recentStatus="ready"
        recent={{
          drafts: [],
          sessions: [{ id: "session_done", title: "论文答辩演练", status: "completed", scenario_id: "scenario_1", created_at: "2026-06-20T00:02:00.000Z", updated_at: "2026-06-20T00:03:00.000Z" }],
          reviews: []
        }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );
    const runningHtml = renderToStaticMarkup(
      <HomePage
        templates={[]}
        session={baseSession("running", 7, [])}
        recentStatus="ready"
        recent={{
          drafts: [],
          sessions: [{ id: "session_running", title: "求职面试演练", status: "running", scenario_id: "scenario_1", created_at: "2026-06-20T00:02:00.000Z", updated_at: "2026-06-20T00:03:00.000Z" }],
          reviews: []
        }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(completedHtml).toContain("已完成");
    expect(completedHtml).toContain("查看详情");
    expect(completedHtml).not.toContain("继续演练");
    expect(completedHtml).not.toContain("当前页面流程中有未完成演练");
    expect(runningHtml).toContain("继续演练");
    expect(runningHtml).toContain("当前页面流程中有未完成演练");
  });

  it("scopes notices so draft material messages do not leak into unrelated pages", () => {
    expect(nextNoticeForPage({ scope: "draft", message: "材料已附加到当前草稿。" }, "scene")).toEqual({ scope: "draft", message: "材料已附加到当前草稿。" });
    expect(nextNoticeForPage({ scope: "draft", message: "材料已附加到当前草稿。" }, "session")).toBeNull();
    expect(nextNoticeForPage({ scope: "draft", message: "材料已附加到当前草稿。" }, "review")).toBeNull();
    expect(nextNoticeForPage({ scope: "draft", message: "材料已附加到当前草稿。" }, "importExport")).toBeNull();
    expect(nextNoticeForPage({ scope: "scene-copy", message: "场景副本已创建，可继续编辑草稿。" }, "scene")).toEqual({ scope: "scene-copy", message: "场景副本已创建，可继续编辑草稿。" });
  });

  it("renders empty and failed recent work states while keeping home entries usable", () => {
    const emptyHtml = renderToStaticMarkup(
      <HomePage
        templates={[]}
        session={null}
        recentStatus="ready"
        recent={{ drafts: [], sessions: [], reviews: [] }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );
    const failedHtml = renderToStaticMarkup(
      <HomePage
        templates={[]}
        session={null}
        recentStatus="failed"
        recentError="最近记录读取失败，请刷新后重试。"
        recent={{ drafts: [], sessions: [], reviews: [] }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={() => undefined}
        onOpenRecentSession={() => undefined}
        onOpenRecentReview={() => undefined}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(emptyHtml).toContain("还没有草稿，可以从模板开始创建。");
    expect(emptyHtml).toContain("模板正在准备");
    expect(emptyHtml).not.toContain("使用模板");
    expect(emptyHtml).toContain("开始演练后会在这里继续。");
    expect(emptyHtml).toContain("完成一次演练后会在这里看到复盘。");
    expect(failedHtml).toContain("最近记录读取失败，请刷新后重试。");
    expect(failedHtml).toContain("模板正在准备");
    expect(failedHtml).not.toContain("使用模板");
    expect(failedHtml).toContain("导入场景");
    expect(failedHtml).toContain("模型设置");
    expect(`${emptyHtml}\n${failedHtml}`).not.toMatch(/\bundefined\b|\bnull\b|stack|sqlite|fetch dump|RuntimeEvent|state_version|session_id/i);
  });

  it("uses recent API client and product restore callbacks from the home workspace", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ drafts: [], scenes: [], sessions: [], reviews: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const api = new ProductApiClient();
    const result = await api.getRecent();

    expect(result).toEqual({ ok: true, data: { drafts: [], scenes: [], sessions: [], reviews: [] } });
    expect(calls).toEqual(["/api/recent"]);

    const opened: string[] = [];
    renderToStaticMarkup(
      <HomePage
        templates={[]}
        session={null}
        recentStatus="ready"
        recent={{
          drafts: [{ id: "draft_restore", title: "恢复草稿", status: "draft", template_id: null, created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" }],
          sessions: [{ id: "session_restore", title: "恢复演练", status: "paused", scenario_id: "scenario_restore", created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" }],
          reviews: [{ id: "review_restore", title: "恢复复盘", status: "failed", session_id: "session_restore", created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z" }]
        }}
        onSelectTemplate={() => undefined}
        onContinueSession={() => undefined}
        onOpenRecentDraft={(id) => opened.push(`draft:${id}`)}
        onOpenRecentSession={(id) => opened.push(`session:${id}`)}
        onOpenRecentReview={(id) => opened.push(`review:${id}`)}
        onGoToImport={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(typeof api.getDraft).toBe("function");
    expect(typeof api.getSession).toBe("function");
    expect(typeof api.getReview).toBe("function");
  });

  it.each([
    ["running", "演练进行中"],
    ["paused", "演练已暂停"],
    ["completed", "演练已完成"],
    ["ended", "演练已结束"],
    ["failed", "演练失败"],
    ["blocked", "演练已阻断"]
  ] as const)("renders a productized main header status for %s without session id or state version", (status, label) => {
    const html = renderToStaticMarkup(
      <Layout currentPage="session" session={baseSession(status, 7)} error={null} onNavigate={() => undefined}>
        <p>演练内容</p>
      </Layout>
    );

    expect(html).toContain(label);
    expect(html).not.toContain("session_");
    expect(html).not.toMatch(/\bv\d+\b/);
  });

  it("renders prototype-style product shell with sidebar identity and local status", () => {
    const html = renderToStaticMarkup(
      <Layout currentPage="home" session={baseSession("running", 7)} error={null} onNavigate={() => undefined}>
        <p>演练内容</p>
      </Layout>
    );

    expect(html).toContain("app-shell");
    expect(html).toContain("app-sidebar");
    expect(html).toContain("app-content-shell");
    expect(html).toContain("brand-mark");
    expect(html).toContain("PersonalFlow");
    expect(html).toContain("本地演练工作室");
    expect(html).toContain("本地数据");
    expect(html).toContain("数据全部保存在本地");
    expect(html).toContain("PersonalFlow 主导航");
    expect(html).toContain("工作台");
    expect(html).toContain("模板库");
    expect(html).toContain("我的场景");
    expect(html).toContain("复盘记录");
    expect(html).toContain("设置");
    expect(html).toContain("nav-pill nav-pill--active");
    expect(html).toContain("app-header-local-chip");
    expect(html).toContain("本地工作室");
    expect(html).toContain("新建演练");
    expect(html).toContain("app-user-avatar");
    expect(html).not.toContain("尚未开始演练");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/session-auto-ai|state_version|RuntimeEvent|actor_id|step_id/i);
  });

  it("uses evergreen product actions instead of blue purple gradients", () => {
    const css = fs.readFileSync("apps/web/src/styles.css", "utf8");

    expect(css).not.toContain("linear-gradient(135deg, #4f46e5");
    expect(css).toMatch(/\.primary-action,\s*\n\.primary-cta\s*\{[^}]*color:\s*var\(--pf-primary-foreground\)[^}]*background:\s*var\(--pf-primary\)/s);
    expect(css).toMatch(/\.nav-pill--active\s*\{[^}]*background:\s*var\(--pf-sidebar-accent\)/s);
    expect(css).toMatch(/\.app-sidebar\s*\{[^}]*background:\s*var\(--pf-sidebar\)/s);
    expect(css).toContain("--pf-shadow-lg:");
  });

  it("keeps the product shell usable for alerts and narrow viewports", () => {
    const css = fs.readFileSync("apps/web/src/styles.css", "utf8");

    expect(css).toMatch(/\.app-alert\s*\{[^}]*margin:\s*0 40px 18px/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[^}]*\.app-shell\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[\s\S]*\.app-sidebar\s*\{[^}]*position:\s*sticky/s);
  });

  it("renders ordinary alert messages without exposing API error codes", () => {
    const html = renderToStaticMarkup(
      <Layout
        currentPage="session"
        session={baseSession("running", 0)}
        error={{
          code: "model_error",
          message: "当前为真实模型模式，但还没有可用模型配置，请到设置页保存 OpenAI 兼容配置。"
        }}
        onNavigate={() => undefined}
      >
        <p>演练内容</p>
      </Layout>
    );

    expect(html).toContain("当前为真实模型模式，但还没有可用模型配置，请到设置页保存 OpenAI 兼容配置。");
    expect(html).not.toContain("model_error");
    expect(html).not.toMatch(/validation_error|scenario_error|RuntimeEvent|stack|provider raw|api[_-]?key/i);
  });

  it("carries expected_state_version for session commands", () => {
    expect(createSessionCommandPayload({ stateVersion: 7, idempotencyKey: "pause-7" })).toEqual({
      expected_state_version: 7,
      idempotency_key: "pause-7"
    });
  });

  it("renders only visible transcript fields without debug hashes", () => {
    const html = renderToStaticMarkup(
      <SessionTranscript
        entries={[
          {
            id: "entry-1",
            actorKind: "ai",
            actorName: "AI interviewer",
            text: "Tell me about a launch.",
            prompt_hash: "prompt_hash_secret"
          }
        ]}
      />
    );

    expect(html).toContain("Tell me about a launch.");
    expect(html).not.toContain("prompt_hash");
    expect(html).not.toContain("prompt_hash_secret");
  });

  it("renders transcript as readable chat bubbles with message actions", () => {
    const longAnswer = "我主导了模型服务平台迁移，覆盖系统设计、灰度、回滚和跨团队协作，并在迁移期间保留了完整的用户影响面监控。";
    const html = renderToStaticMarkup(
      <SessionTranscript
        entries={[
          {
            id: "visible-ai-chat",
            eventId: "event_ai",
            sequence: 1,
            actorKind: "ai",
            actorName: "面试官",
            text: "请介绍一个你主导的平台迁移案例。",
            createdAt: "2026-07-11T10:00:00.000Z"
          },
          {
            id: "visible-user-chat",
            eventId: "event_user",
            sequence: 2,
            actorKind: "user",
            actorName: "候选人",
            text: longAnswer,
            createdAt: "2026-07-11T10:01:00.000Z"
          },
          {
            id: "visible-system-chat",
            actorKind: "system",
            actorName: "系统",
            text: "演练已暂停，稍后可继续。"
          }
        ]}
        onFork={() => undefined}
        onWithdraw={() => undefined}
      />
    );

    expect(html).toContain("chat-thread");
    expect(html).toContain("chat-message chat-message--ai");
    expect(html).toContain("chat-message chat-message--user");
    expect(html).toContain("chat-message chat-message--system");
    expect(html).toContain("chat-bubble");
    expect(html).toContain(longAnswer);
    expect(html).toContain("chat-message__actions");
    expect(html).toContain("从这里分支");
    expect(html).toContain("撤回并重写");
    expect(html).not.toMatch(/transcript-list|transcript-entry|event_ai|event_user|step_id|actor_id|state_version|session_id/);
  });

  it("shows branch actions without rendering internal locators", () => {
    const session = {
      ...baseSession("running", 3, [userStep]),
      view: {
        ...baseSession("running", 3, [userStep]).view,
        visible_transcript: [
          {
            id: "visible-ai",
            event_id: "event-ai",
            sequence: 1,
            actor_id: "ai_interviewer",
            actor_kind: "ai",
            actor_name: "面试官",
            text: "请介绍一个项目。"
          },
          {
            id: "visible-user",
            event_id: "event-user",
            sequence: 2,
            actor_id: "user_candidate",
            actor_kind: "user",
            actor_name: "候选人",
            text: "我负责稳定性改造。"
          }
        ]
      }
    } satisfies SessionView;
    const html = renderToStaticMarkup(
      <SessionPage
        session={session}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html.match(/从这里分支/g)).toHaveLength(2);
    expect(html).toContain("撤回并重写");
    expect(html).toContain("请介绍一个项目。");
    expect(html).toContain("我负责稳定性改造。");
    expect(html).not.toMatch(/event-ai|event-user|actor_id|state_version|RuntimeEvent/);
  });

  it("renders session as prototype-style immersive workspace", () => {
    const session = {
      ...baseSession("running", 3, [userStep]),
      timing: {
        started_at: "2026-07-11T10:00:00.000Z",
        updated_at: "2026-07-11T10:04:00.000Z",
        suggested_duration_label: "建议约 15 分钟"
      },
      view: {
        ...baseSession("running", 3, [userStep]).view,
        visible_transcript: [
          {
            id: "visible-ai-style",
            event_id: "event-ai-style",
            sequence: 1,
            actor_id: "ai_interviewer",
            actor_kind: "ai",
            actor_name: "面试官",
            text: "请介绍一个项目。"
          },
          {
            id: "visible-user-style",
            event_id: "event-user-style",
            sequence: 2,
            actor_id: "user_candidate",
            actor_kind: "user",
            actor_name: "候选人",
            text: "我负责稳定性改造。"
          }
        ]
      }
    } satisfies SessionView;
    const html = renderToStaticMarkup(
      <SessionPage
        session={session}
        api={{} as never}
        branchTree={{
          root_session_id: "session-style-root",
          current_session_id: "session-style-child",
          nodes: [
            {
              session_id: "session-style-root",
              parent_session_id: null,
              label: "主线",
              status: "ended",
              rounds: 2,
              created_at: "now",
              is_current: false,
              has_review: false,
              children: [
                {
                  session_id: "session-style-child",
                  parent_session_id: "session-style-root",
                  label: "撤回后重写",
                  status: "running",
                  rounds: 1,
                  created_at: "now",
                  is_current: true,
                  has_review: false,
                  children: []
                }
              ]
            }
          ]
        }}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onExit={() => undefined}
        onOpenBranch={() => undefined}
        onCreateBranchReview={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("session-focus-shell");
    expect(html).toContain("session-topbar");
    expect(html).toContain("session-conversation");
    expect(html).toContain("session-input-dock");
    expect(html).toContain("session-input-frame");
    expect(html).toContain("session-start-chip");
    expect(html).toContain("session-context-panel");
    expect(html).toContain("session-exit-button");
    expect(html).toContain("chat-avatar");
    expect(html).toContain("退出演练");
    expect(html).toContain("专注演练");
    expect(html).toContain("演练计时");
    expect(html).toContain("建议约 15 分钟");
    expect(html).toContain("版本历史");
    expect(html).toContain("transcript-card");
    expect(html).toContain("branch-tree-card");
    expect(html).toContain("主线");
    expect(html).toContain("撤回后重写");
    expect(html).not.toContain("用户输入</h2>");
    expect(html).not.toContain("session-input-card");
    expect(html).not.toContain("分支树");
    expect(html).not.toMatch(/event-ai-style|event-user-style|session-style-root|session-style-child|state_version|actor_id|step_id/i);
    const appSource = fs.readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(appSource).toContain("session-route-shell");
    expectNoFutureCapabilityCopy(html);
  });

  it("keeps the input dock state clear across runnable, waiting, paused, blocked, failed and terminal sessions", () => {
    const humanInputHtml = renderSessionHtml(baseSession("running", 3, [userStep]));
    expect(humanInputHtml).toContain("session-input-dock");
    expect(humanInputHtml).not.toContain("session-input-dock--idle");
    expect(humanInputHtml).toContain("你的回答");
    expect(humanInputHtml).toContain("<textarea");
    expect(humanInputHtml).toContain("aria-label=\"提交回答\"");
    expect(countButtonLabelOccurrences(humanInputHtml, "让 AI 提问")).toBe(0);

    const aiWaitingHtml = renderSessionHtml({
      ...baseSession("running", 4, [aiStep]),
      view: {
        ...baseSession("running", 4, [aiStep]).view,
        current_actor_name: "面试官",
        next_user_action_label: "等待面试官继续提问。"
      }
    });
    expect(aiWaitingHtml).toContain("session-input-dock--idle");
    expect(aiWaitingHtml).toContain("等待 AI 提问后即可回答。");
    expect(aiWaitingHtml).not.toContain("<textarea");
    expect(countButtonLabelOccurrences(aiWaitingHtml, "让 AI 提问")).toBe(1);

    const pausedHtml = renderSessionHtml({
      ...baseSession("paused", 5, []),
      view: {
        ...baseSession("paused", 5, []).view,
        current_stage_label: "演练已暂停",
        next_user_action_label: "演练已暂停，可点击继续恢复。"
      }
    });
    expect(pausedHtml).toContain("演练已暂停，继续后即可回答。");
    expect(countButtonLabelOccurrences(pausedHtml, "继续")).toBe(1);
    expect(pausedHtml).not.toContain("<textarea");
    expect(countButtonLabelOccurrences(pausedHtml, "让 AI 提问")).toBe(0);

    const blockedHtml = renderSessionHtml({
      ...baseSession("blocked", 6, [userStep, aiStep]),
      view: {
        ...baseSession("blocked", 6, [userStep, aiStep]).view,
        current_stage_label: "运行时已阻断",
        next_user_action_label: "运行时已阻断，请查看阻断原因。",
        blocked_summary: {
          reason: "no_allowed_step",
          message: "当前阶段没有可执行步骤，演练已阻断。"
        }
      }
    });
    expect(blockedHtml).toContain("当前阶段没有可执行步骤，演练已阻断。");
    expect(countButtonLabelOccurrences(blockedHtml, "结束演练")).toBe(1);
    expect(blockedHtml).not.toContain("<textarea");
    expect(countButtonLabelOccurrences(blockedHtml, "让 AI 提问")).toBe(0);
    expect(blockedHtml).not.toContain("提交回答");

    const failedAiHtml = renderSessionHtml({
      ...baseSession("running", 7, [aiStep]),
      view: {
        ...baseSession("running", 7, [aiStep]).view,
        current_actor_name: "AI 面试官",
        next_user_action_label: "AI 本轮失败，可重试当前 AI 回合或刷新演练。",
        failure_summary: {
          message: "AI 本轮没有成功生成可用提问，已保留当前演练进度。",
          failed_attempts: 1,
          can_retry: true,
          action_label: "重试当前 AI 回合"
        }
      }
    });
    expect(failedAiHtml).toContain("AI 提问失败，可先使用恢复操作或刷新演练。");
    expect(failedAiHtml).toContain("重试当前 AI 回合");
    expect(failedAiHtml).not.toContain("<textarea");
    expect(countButtonLabelOccurrences(failedAiHtml, "让 AI 提问")).toBe(0);

    const terminalHtml = renderSessionHtml({
      ...baseSession("ended", 8, []),
      view: {
        ...baseSession("ended", 8, []).view,
        current_stage_label: "演练已结束",
        next_user_action_label: "演练已结束，可查看复盘。"
      }
    });
    expect(terminalHtml).toContain("演练已结束，可查看复盘。");
    expect(terminalHtml).not.toContain("<textarea");
    expect(countButtonLabelOccurrences(terminalHtml, "让 AI 提问")).toBe(0);
    expect(countButtonLabelOccurrences(terminalHtml, "查看复盘")).toBe(1);
  });

  it("uses internal locators only when branch action buttons are clicked", () => {
    const forked: unknown[] = [];
    const withdrawn: unknown[] = [];
    const element = SessionTranscript({
      entries: [
          {
            id: "visible-ai",
            eventId: "event-ai",
            sequence: 1,
            actorKind: "ai",
            actorName: "面试官",
            text: "请介绍一个项目。"
          },
          {
            id: "visible-user",
            eventId: "event-user",
            sequence: 2,
            actorKind: "user",
            actorName: "候选人",
            text: "我负责稳定性改造。"
          }
        ],
      onFork: (entry) => { forked.push(entry); },
      onWithdraw: (entry) => { withdrawn.push(entry); }
    });
    const html = renderToStaticMarkup(element);

      expect(html).toContain("演练对话");
      expect(html).not.toContain("可见演练记录");
    expect(html).not.toMatch(/event-ai|event-user|actor_id|state_version|RuntimeEvent/);
    expect(clickButtonByText(element, "从这里分支")).toBe(true);
    expect(clickButtonByText(element, "撤回并重写")).toBe(true);
    expect(forked).toEqual([expect.objectContaining({ eventId: "event-ai", actorKind: "ai" })]);
    expect(withdrawn).toEqual([expect.objectContaining({ eventId: "event-user", actorKind: "user" })]);
  });

  it("keeps older long-transcript branch controls visually quiet while preserving the actions", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      id: `visible-${index + 1}`,
      eventId: `event-${index + 1}`,
      sequence: index + 1,
      actorKind: index % 2 === 0 ? "ai" as const : "user" as const,
      actorName: index % 2 === 0 ? "面试官" : "候选人",
      text: `第 ${index + 1} 条可见发言。`
    }));
    const forked: unknown[] = [];
    const withdrawn: unknown[] = [];
    const element = SessionTranscript({
      entries,
      onFork: (entry) => { forked.push(entry); },
      onWithdraw: (entry) => { withdrawn.push(entry); }
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("chat-message__actions--quiet");
    expect(html).toContain("aria-label=\"第 1 轮操作\"");
    expect(html).toContain("aria-label=\"从第 1 轮分支\"");
    expect(html).toContain("aria-label=\"撤回第 2 轮并重写\"");
    expect(countButtonLabelOccurrences(html, "从这里分支")).toBe(10);
    expect(countButtonLabelOccurrences(html, "撤回并重写")).toBe(5);
    expect(clickButtonByText(element, "从这里分支")).toBe(true);
    expect(clickButtonByText(element, "撤回并重写")).toBe(true);
    expect(forked).toEqual([expect.objectContaining({ eventId: "event-1" })]);
    expect(withdrawn).toEqual([expect.objectContaining({ eventId: "event-2" })]);
  });

  it("withdraws a user answer, switches to the child branch, and can fill back the original answer", async () => {
    const parentSession = baseSession("running", 3, [userStep]);
    const childSession = {
      ...baseSession("running", 2, [userStep]),
      id: "session-child",
      view: {
        ...baseSession("running", 2, [userStep]).view,
        session_id: "session-child"
      }
    } satisfies SessionView;
    const api = {
      withdrawUserInput: vi.fn(async () => ({
        ok: true,
        data: {
          session: childSession,
          branch: {
            session_id: "session-child",
            parent_session_id: "session-auto-ai",
            label: "撤回后重写",
            status: "running",
            rounds: 1,
            created_at: "2026-07-10T00:00:00.000Z",
            is_current: true,
            has_review: false,
            children: []
          },
          tree: {
            root_session_id: "session-auto-ai",
            current_session_id: "session-child",
            nodes: []
          },
          withdrawn_input: { text: "我负责稳定性改造。", event_id: "event-user" }
        }
      }))
    } as unknown as ApiClient;
    const updatedSessions: SessionView[] = [];
    const forkedSessions: SessionView[] = [];
    const branchTreeRefreshes: string[] = [];
    let inputValue = "旧输入";
    let notice = "";
    let lastWithdrawnInput = "";

    const result = await withdrawEntryAndSwitchSession({
      session: parentSession,
      api,
      entry: {
        id: "visible-user",
        eventId: "event-user",
        sequence: 2,
        actorKind: "user",
        actorName: "候选人",
        text: "我负责稳定性改造。"
      },
      setInput: (next) => { inputValue = next; },
      setWithdrawNotice: (next) => { notice = next; },
      setLastWithdrawnInput: (next) => { lastWithdrawnInput = next; },
      onSessionUpdated: (next) => { updatedSessions.push(next); },
      onSessionForked: (next) => { forkedSessions.push(next); },
      onBranchTreeChanged: () => { branchTreeRefreshes.push("refresh"); },
      onError: () => undefined
    });

    expect(result).toBe(true);
    expect(api.withdrawUserInput).toHaveBeenCalledWith("session-auto-ai", expect.objectContaining({
      user_event_id: "event-user",
      branch_label: "撤回后重写"
    }));
    expect(updatedSessions).toEqual([childSession]);
    expect(forkedSessions).toEqual([childSession]);
    expect(branchTreeRefreshes).toEqual(["refresh"]);
    expect(inputValue).toBe("");
    expect(notice).toBe("已创建一个新版本，你可以重写刚才的回答。原版本仍保留在版本历史中。");
    expect(lastWithdrawnInput).toBe("我负责稳定性改造。");
  });

  it("renders the API visible transcript DTO instead of deriving transcript from raw state", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: "session-visible",
          scenario_id: "scenario_1",
          status: "running",
          view: {
            session_id: "session-visible",
            scenario_id: "scenario_1",
            status: "running",
            state_version: 3,
            state: { prompt_hash: "state_prompt_hash_secret" },
            allowed_steps: [],
            visible_transcript: [
              {
                id: "visible_1",
                event_id: "event_1",
                sequence: 1,
                actor_id: "ai_interviewer",
                actor_kind: "ai",
                actor_name: "Interviewer",
                text: "What did you launch?"
              }
            ],
            current_stage_label: "面试提问",
            current_actor_name: "Interviewer",
            next_user_action_label: "演练状态同步中，请刷新或稍后重试。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("What did you launch?");
    expect(html).not.toContain("state_prompt_hash_secret");
    expect(html).not.toContain("prompt_hash");
  });

  it("renders natural user input controls without allowed action internals", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: "session-natural-input",
          scenario_id: "scenario_1",
          status: "running",
          view: {
            session_id: "session-natural-input",
            scenario_id: "scenario_1",
            status: "running",
            state_version: 3,
            state: {},
            allowed_steps: [userStep],
            visible_transcript: [],
            current_stage_label: "证据追问",
            current_actor_name: "候选人",
            next_user_action_label: "请在输入框回应当前问题或提示。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("<textarea");
    expect(html).toContain("提交回答");
    expect(html).not.toMatch(/allowed actions|允许动作|当前用户动作|answer_interview_question|ask_interview_question|selected_step|step_id|allowed_steps|action/i);
  });

  it("renders SessionView stage, current actor and next action labels near the input", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: "session-product-context",
          scenario_id: "scenario_1",
          status: "running",
          view: {
            session_id: "session-product-context",
            scenario_id: "scenario_1",
            status: "running",
            state_version: 8,
            state: {},
            allowed_steps: [userStep],
            visible_transcript: [],
            current_stage_label: "证据追问",
            current_actor_name: "方法评审",
            next_user_action_label: "请在输入框回应当前问题或提示。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("当前阶段：证据追问");
    expect(html).toContain("当前发言者：方法评审");
    expect(html).toContain("你现在可以做什么：请在输入框回应当前问题或提示。");
    expect(html).not.toMatch(/session-product-context|scenario_1|state_version|step_id|actor_id|allowed_steps|undefined|null/i);
  });

  it("renders structured active stage and visible tool summaries without raw tool events", () => {
    const session = {
      id: "session-tool-summary",
      scenario_id: "scenario_1",
      status: "running",
      view: {
        session_id: "session-tool-summary",
        scenario_id: "scenario_1",
        status: "running",
        state_version: 8,
        state: {},
        allowed_steps: [userStep],
        visible_transcript: [],
        current_stage_label: "旧阶段标签",
        current_stage: { id: "opening", title: "开场与背景确认", goal: "确认背景。" },
        visible_tool_results: [
          {
            sequence: 2,
            actor_name: "面试官",
            tool_id: "mock_rag_query",
            summary: "Mock RAG result for: ownership evidence",
            source_ref: "mock_rag:chunk-1",
            trust_level: "medium"
          }
        ],
        current_actor_name: "方法评审",
        next_user_action_label: "请在输入框回应当前问题或提示。"
      }
    } as SessionView;
    const html = renderToStaticMarkup(
      <SessionPage
        session={session}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("当前阶段：开场与背景确认");
    expect(html).toContain("Mock RAG result for: ownership evidence");
    expect(html).toContain("mock_rag:chunk-1");
    expect(html).not.toMatch(/ToolCallCommitted|provider raw|request|doc_version_hash|chunk_id|session-tool-summary|state_version/i);
  });

  it("uses stable fallback copy when the current actor name is not available", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: "session-actor-fallback",
          scenario_id: "scenario_1",
          status: "running",
          view: {
            session_id: "session-actor-fallback",
            scenario_id: "scenario_1",
            status: "running",
            state_version: 8,
            state: {},
            allowed_steps: [],
            visible_transcript: [],
            current_stage_label: "等待下一步",
            current_actor_name: null,
            next_user_action_label: "演练状态同步中，请刷新或稍后重试。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("当前发言者：待系统确认");
    expect(html).toContain("你现在可以做什么：演练状态同步中，请刷新或稍后重试。");
    expect(html).not.toMatch(/\bundefined\b|\bnull\b|raw state|state_version|session_id|scenario_id/i);
  });

  it("renders the main flow with product copy instead of raw session, status or version semantics", () => {
    const draft = {
      id: "draft_1",
      template_id: "job_interview",
      created_at: "now",
      updated_at: "now",
      preview: { title: { value: "求职面试", is_default: false } }
    };
    const runningSession = baseSession("running", 3, [userStep]);
    const endedSession = baseSession("ended", 4, []);
    const sceneHtml = renderToStaticMarkup(
      <SceneConfirmPage
        draft={draft}
        scene={null}
        api={{} as never}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );
    const runningHtml = renderToStaticMarkup(
      <SessionPage
        session={runningSession}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );
    const endedHtml = renderToStaticMarkup(
      <SessionPage
        session={endedSession}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );
    const reviewHtml = renderToStaticMarkup(
      <ReviewPage
        session={endedSession}
        review={{
          id: "review_1",
          session_id: "session-auto-ai",
          created_at: "now",
          status: "succeeded",
          summary: "回答结构清晰。",
          dimensions: [],
          evidence_refs: [],
          recommendations: []
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );
    const combinedHtml = [sceneHtml, runningHtml, endedHtml, reviewHtml].join("\n");

    expect(combinedHtml).toContain("开始前确认");
    expect(combinedHtml).toContain("确认并开始演练");
    expect(combinedHtml).toContain("演练进行中");
    expect(combinedHtml).toContain("结束演练");
    expect(combinedHtml).toContain("刷新演练");
    expect(combinedHtml).toContain("复盘已生成");
    expect(combinedHtml).not.toMatch(/状态：(running|paused|completed|ended|failed|pending|succeeded)|结束 session|重新读取 session|开始 session|当前版本|state_version|\bv\d+\b/i);
  });

  it("renders scene check results as product states and disables start only when blocked", () => {
    const ready: ScenarioCheckResult = { status: "ready", ok: true, issues: [] };
    const warning: ScenarioCheckResult = {
      status: "warning",
      ok: true,
      issues: [{ severity: "warning", title: "复盘信息不足", message: "复盘信号偏少。", suggestion: "可以继续演练，之后补充更明确的材料。" }]
    };
    const blocked: ScenarioCheckResult = {
      status: "blocked",
      ok: false,
      issues: [{ severity: "blocked", title: "缺少用户角色", message: "这个草稿没有可扮演的用户角色。", suggestion: "请返回模板参数页重新创建草稿。" }]
    };

    const readyHtml = renderToStaticMarkup(<SceneCheckPanel result={ready} />);
    const warningHtml = renderToStaticMarkup(<SceneCheckPanel result={warning} />);
    const blockedHtml = renderToStaticMarkup(<SceneCheckPanel result={blocked} />);

    expect(readyHtml).toContain("场景检查通过");
    expect(readyHtml).not.toMatch(/\[\]|null|undefined|step_id|actor_id|scenario_id|session_id|schema|stack/i);
    expect(warningHtml).toContain("检查通过，有提醒");
    expect(warningHtml).toContain("复盘信息不足");
    expect(blockedHtml).toContain("需要修复");
    expect(blockedHtml).toContain("缺少用户角色");

    const draft = { id: "draft_1", template_id: "job_interview", created_at: "now", updated_at: "now", preview: { title: { value: "求职面试", is_default: false } } };
    const blockedPage = renderToStaticMarkup(
      <SceneConfirmPage
        draft={draft}
        scene={null}
        api={{ checkDraft: vi.fn(async () => ({ ok: true, data: blocked })) } as unknown as ApiClient}
        initialCheck={blocked}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );
    expect(blockedPage).toContain("确认并开始演练");
    expect(blockedPage).toContain("disabled");
    expect(blockedPage).toContain("需要修复后才能开始");
  });

  it("renders confirmation decision details, model status and reminders without exposing internal scene fields", () => {
    const draft = {
      id: "draft_1",
      template_id: "job_interview",
      created_at: "now",
      updated_at: "now",
      preview: {
        title: { value: "求职面试", is_default: false },
        goal: { value: "准备平台工程师面试", is_default: false },
        user_role: { value: "候选人", is_default: true },
        ai_role: { value: "面试官", is_default: true },
        flow: [{ label: "流程 1", value: "面试官提出岗位相关问题", is_default: true }],
        materials: [{ label: "面试关注点", value: "incident review ownership", is_default: false }],
        review_method: { value: "按 STAR 结构复盘。", is_default: true },
        estimated_duration: { value: "约 15 分钟", is_default: false },
        pressure_level: { value: "标准压力：会有追问，适合日常练习。", is_default: false },
        ready_summary: { value: "场景已检查，可以开始演练。", is_default: true },
        notes: [{ label: "提醒 1", value: "可以用自然语言回答，建议准备项目材料。", is_default: true }]
      }
    } as unknown as DraftView;
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={draft}
        scene={{
          id: "scene_1",
          draft_id: "draft_1",
          source_template_id: "job_interview",
          title: "求职面试",
          normalized_hash: "hash_should_not_render",
          created_at: "now"
        }}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("演练目标");
    expect(html).toContain("角色设定");
    expect(html).toContain("流程安排");
    expect(html).toContain("预计时长");
    expect(html).toContain("约 15 分钟");
    expect(html).toContain("压力程度");
    expect(html).toContain("标准压力");
    expect(html).toContain("可以开始");
    expect(html).toContain("模型配置");
    expect(html).toContain("本地演示模式");
    expect(html).toContain("去设置");
    expect(html).toContain("准备提醒");
    expect(html).toContain("自然语言回答");
    expect(html).not.toMatch(/hash_should_not_render|normalized_hash|scene_1|draft_1|scenario_id|step_id|state_version|\bundefined\b|\bnull\b|api_key|Authorization|Bearer|raw prompt|provider raw/i);
  });

  it("guards confirmation start against duplicate pending clicks", () => {
    const source = fs.readFileSync(new URL("./SceneConfirmPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("const [isStarting, setIsStarting] = useState(false)");
    expect(source).toContain("if (isStarting)");
    expect(source).toContain("setIsStarting(true)");
    expect(source).toContain("setIsStarting(false)");
    expect(source).toContain("const startDisabled = isStarting ||");
  });

  it("renders confirmation brief without duplicate role sections", () => {
    const html = renderToStaticMarkup(
      <ScenePreview
        draft={{
          id: "draft_confirmation_brief",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "求职面试", is_default: false },
            goal: { value: "准备平台工程师面试", is_default: false },
            user_role: { value: "候选人", is_default: true },
            ai_role: { value: "面试官与技术评审", is_default: true },
            flow: [{ label: "流程 1", value: "围绕项目经历追问", is_default: true }],
            review_method: { value: "基于回答证据复盘。", is_default: true }
          },
          semantic_preview: {
            title: "求职面试",
            roles: [
              { title: "候选人", kind: "user", goal: "回答有证据的问题。" },
              { title: "面试官", kind: "ai", goal: "追问岗位匹配和项目细节。" }
            ],
            stages: [{ title: "开场与背景确认", goal: "确认目标岗位和项目背景。", roles: ["候选人", "面试官"], tools: [] }],
            visibility: [],
            review_dimensions: [{ title: "证据密度", evidence_requirement: "required" }],
            quality: { status: "ready", ok: true, issues: [] }
          }
        }}
        scene={null}
      />
    );

    expect((html.match(/角色设定/g) ?? []).length).toBe(1);
    expect(html).toContain("演练目标");
    expect(html).toContain("复盘维度");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/综合评分|总分|雷达|趋势|平均得分|高置信能力/);
  });

  it("renders SceneConfirmPage as a confirmation workspace with preview, check, model, materials and actions", () => {
    const html = renderToStaticMarkup(
      <SceneConfirmPage
        draft={{
          id: "draft_scene_style",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now",
          preview: {
            title: { value: "求职面试", is_default: false },
            goal: { value: "准备平台工程师面试", is_default: false },
            notes: [{ label: "提醒", value: "建议准备项目材料。", is_default: false }]
          }
        }}
        scene={null}
        api={{} as never}
        initialCheck={{ status: "ready", ok: true, issues: [] }}
        modelConfig={null}
        materials={[{ id: "material_scene_style", title: "项目材料", source_label: "手动粘贴", summary: "完整正文不应渲染", created_at: "now" }]}
        onMaterialAttached={() => undefined}
        onChecked={() => undefined}
        onStarted={() => undefined}
        onError={() => undefined}
        onGoToSettings={() => undefined}
      />
    );

    expect(html).toContain("scene-confirm-page");
    expect(html).toContain("scene-confirm-layout");
    expect(html).toContain("scene-confirm-main");
    expect(html).toContain("scene-confirm-aside");
    expect(html).toContain("scene-preview-card");
    expect(html).toContain("scene-check-card");
    expect(html).toContain("model-card");
    expect(html).toContain("materials-card");
    expect(html).toContain("action-bar");
    expect(html).toContain("确认并开始演练");
      expect(html).toContain("开始前确认");
    expect(html).not.toMatch(/draft_scene_style|material_scene_style|draft_id|material_id|RuntimeEvent|state_version|actor_id|step_id/i);
  });

  it("renders a natural first-turn AI button without listing allowed steps", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: "session-start-ai",
          scenario_id: "scenario_1",
          status: "running",
          view: {
            session_id: "session-start-ai",
            scenario_id: "scenario_1",
            status: "running",
            state_version: 0,
            state: {},
            allowed_steps: [aiStep],
            visible_transcript: [],
            current_stage_label: "面试提问",
            current_actor_name: "Interviewer",
            next_user_action_label: "等待 Interviewer 继续提问，可点击让 AI 提问。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("让 AI 提问");
    expect(html).not.toMatch(/allowed actions|允许动作|ask_interview_question|answer_interview_question|selected_step|step_id|allowed_steps/i);
  });

  it("keeps pause and resume controls aligned with paused session semantics", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: "session-paused",
          scenario_id: "scenario_1",
          status: "paused",
          view: {
            session_id: "session-paused",
            scenario_id: "scenario_1",
            status: "paused",
            state_version: 3,
            state: {},
            allowed_steps: [],
            visible_transcript: [],
            current_stage_label: "演练已暂停",
            current_actor_name: null,
            next_user_action_label: "演练已暂停，可点击继续恢复。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain(`<button type="button" disabled="">暂停</button>`);
    expect(html).toContain(`<button type="button">继续</button>`);
  });

  it("renders blocked status copy and disables input, AI, pause and resume while keeping end available", () => {
    const blockedSession: SessionView = {
      id: "session-blocked",
      scenario_id: "scenario_1",
      status: "blocked",
      view: {
        session_id: "session-blocked",
        scenario_id: "scenario_1",
        status: "blocked",
        state_version: 3,
        state: {},
        allowed_steps: [userStep, aiStep],
        visible_transcript: [],
        current_stage_label: "运行时已阻断",
        current_actor_name: null,
        next_user_action_label: "运行时已阻断，请查看阻断原因。",
        blocked_summary: {
          reason: "no_allowed_step",
          message: "当前阶段没有可执行步骤，演练已阻断。",
          stage_id: "opening"
        }
      }
    };

    const html = renderToStaticMarkup(
      <SessionPage
        session={blockedSession}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("演练已阻断");
    expect(html).toContain("当前阶段没有可执行步骤，演练已阻断。");
    expect(html).toContain(`<button type="button">结束演练</button>`);
    expect(html).toContain("刷新演练");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("提交回答");
    expect(html).not.toContain("让 AI 提问");
    expect(html).not.toContain("暂停");
    expect(html).not.toContain("继续");
  });

  it.each(["completed", "ended"] as const)("renders a review entry for a %s terminal session", (status) => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: `session-${status}`,
          scenario_id: "scenario_1",
          status,
          view: {
            session_id: `session-${status}`,
            scenario_id: "scenario_1",
            status,
            state_version: 4,
            state: {},
            allowed_steps: [],
            visible_transcript: [],
            current_stage_label: status === "completed" ? "演练已完成" : "演练已结束",
            current_actor_name: null,
            next_user_action_label: status === "completed" ? "演练已完成，可查看复盘。" : "演练已结束，可查看复盘。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("查看复盘");
    expect(html).toContain(`<button type="button">查看复盘</button>`);
  });

  it.each(["completed", "ended"] as const)("hides practice input and progression controls for a %s terminal session", (status) => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: `session-${status}`,
          scenario_id: "scenario_1",
          status,
          view: {
            session_id: `session-${status}`,
            scenario_id: "scenario_1",
            status,
            state_version: 4,
            state: {},
            allowed_steps: [],
            visible_transcript: [{ id: "entry-1", event_id: "event-1", sequence: 1, actor_id: "candidate", actor_kind: "user", actor_name: "候选人", text: "我会保留转写内容。" }],
            current_stage_label: status === "completed" ? "演练已完成" : "演练已结束",
            current_actor_name: null,
            next_user_action_label: status === "completed" ? "演练已完成，可查看复盘。" : "演练已结束，可查看复盘。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("我会保留转写内容。");
    expect(html).toContain("查看复盘");
    expect(html).toContain("刷新演练");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("提交回答");
    expect(html).not.toContain("暂停");
    expect(html).not.toContain("继续");
    expect(html).not.toContain("结束演练");
  });

  it.each(["running", "paused"] as const)("does not render a review entry for a %s non-terminal session", (status) => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={{
          id: `session-${status}`,
          scenario_id: "scenario_1",
          status,
          view: {
            session_id: `session-${status}`,
            scenario_id: "scenario_1",
            status,
            state_version: 4,
            state: {},
            allowed_steps: [],
            visible_transcript: [],
            current_stage_label: status === "running" ? "等待下一步" : "演练已暂停",
            current_actor_name: null,
            next_user_action_label: status === "running" ? "演练状态同步中，请刷新或稍后重试。" : "演练已暂停，可点击继续恢复。"
          }
        }}
        api={{} as never}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).not.toContain("查看复盘");
  });

  it("renders auto-generating review state without asking for another click", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("ended", 4, [])}
        review={null}
        autoGenerate
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("正在生成复盘");
    expect(html).toContain("长对话复盘可能需要更久");
    expect(html).toContain("不要关闭页面");
    expect(html).not.toContain("生成复盘</button>");
  });

  it("renders review evidence without exposing event, actor or step identifiers", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_1",
          session_id: "session-auto-ai",
          created_at: "now",
          status: "succeeded",
          summary: "Candidate gave a concise launch story.",
          dimensions: [{ name: "结构化表达", conclusion: "回答包含背景、行动和结果。", evidence_refs: [] }],
          key_moments: [{
            title: "答辩人回应了证据链",
            description: "你解释了实验指标、用户反馈与方案调整之间的关系，支撑了复盘中关于论证完整度的判断。",
            evidence_ref: { session_id: "session-auto-ai", event_id: "event_1", sequence: 1, step_id: "answer_interview_question", actor_id: "user_candidate" }
          }],
          evidence_refs: [{ session_id: "session-auto-ai", event_id: "event_1", sequence: 1, step_id: "answer_interview_question", actor_id: "user_candidate" }],
          recommendations: [{ text: "补充量化指标。", evidence_refs: [] }]
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("Candidate gave a concise launch story.");
    expect(html).toContain("关键片段");
    expect(html).toContain("答辩人回应了证据链");
    expect(html).toContain("你解释了实验指标、用户反馈与方案调整之间的关系");
    expect(html).not.toContain("证据 1");
    expect(html).not.toMatch(/event_1|answer_interview_question|user_candidate|session-auto-ai|step_id|actor_id|event_id/);
  });

  it("renders ReviewPage as a report with summary, confidence, dimensions, moments and recommendations cards", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_style",
          session_id: "session-style-review",
          created_at: "now",
          status: "succeeded",
          summary: "回答需要更聚焦问题。",
          dimensions: [{ name: "可信度", conclusion: "回答存在跑题和矛盾风险。", evidence_refs: [] }],
          key_moments: [{
            title: "答辩人回答偏离问题",
            description: "回答没有回应当前问题。",
            evidence_ref: { session_id: "session-style-review", event_id: "event_style", sequence: 2, step_id: "answer_question", actor_id: "user_candidate" },
            evidence_locator: { sequence: 2, speaker: "答辩人", snippet: "我不知道你在问什么。" }
          }],
          evidence_refs: [],
          evidence_summary: { answer_count: 2, cited_answer_count: 1, coverage: "insufficient", confidence: "low" },
          credibility_checks: [{ kind: "evidence_gap", severity: "warning", message: "证据不足：本次复盘基于 1/2 条用户回答生成。" }],
          recommendations: [{ text: "先回答问题本身，再补充背景。", evidence_refs: [] }],
          uncertainty_notes: ["样本较短。"]
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("review-page");
    expect(html).toContain("review-report");
    expect(html).toContain("review-hero");
    expect(html).toContain("review-hero__copy");
    expect(html).toContain("review-hero__meta");
    expect(html).toContain("证据摘要");
    expect(html).toContain("review-summary-grid");
    expect(html).toContain("review-card");
    expect(html).toContain("review-confidence-card");
    expect(html).toContain("review-section-grid");
    expect(html).toContain("review-moment-card");
    expect(html).toContain("review-recommendation-card");
    expect(html).toContain("复盘报告");
    expect(html).toContain("本轮总结");
    expect(html).toContain("证据覆盖");
    expect(html).toContain("引用 1 条回答");
    expect(html).toContain("结论置信度：低");
    expect(html).toContain("做得好的地方");
    expect(html).toContain("本轮观察");
    expect(html).toContain("关键片段");
    expect(html).toContain("可以更好的地方");
    expect(html).toContain("不确定性说明");
    expect(html).toContain("回答需要更聚焦问题。");
    expect(html.indexOf("做得好的地方")).toBeLessThan(html.indexOf("本轮观察"));
    expect(html.indexOf("本轮观察")).toBeLessThan(html.indexOf("可信度：回答存在跑题和矛盾风险。"));
    expect(html).not.toContain("维度观察");
    expect(html).not.toContain("行动建议");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/review_style|session-style-review|session_id|event_id|actor_id|step_id|RuntimeEvent/i);
  });

  it("renders review report with report sections but no score UI", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_report_sections",
          session_id: "session-report-sections",
          created_at: "now",
          status: "succeeded",
          summary: "本轮回答能围绕项目经历展开，但量化证据还不够稳定。",
          dimensions: [
            { name: "结构化表达", conclusion: "回答包含背景、行动和结果。", evidence_refs: [] },
            { name: "风险处理", conclusion: "主动识别上线风险并给出灰度回滚方案。", evidence_refs: [] },
            { name: "证据密度", conclusion: "部分结论缺少量化指标支撑。", evidence_refs: [] }
          ],
          key_moments: [{
            title: "候选人解释项目取舍",
            description: "你说明了方案选择和上线风险，能够支撑结构化表达的观察。",
            evidence_ref: { session_id: "session-report-sections", event_id: "event_report", sequence: 3, step_id: "answer_technical_question", actor_id: "user_candidate" },
            evidence_locator: { sequence: 3, speaker: "候选人", snippet: "我先做灰度，再根据错误率决定是否扩大范围。" }
          }],
          evidence_refs: [],
          evidence_summary: { answer_count: 2, cited_answer_count: 1, coverage: "insufficient", confidence: "low" },
          credibility_checks: [{ kind: "evidence_gap", severity: "warning", message: "证据不足：本次复盘基于 1/2 条用户回答生成。" }],
          recommendations: [{ text: "补充影响范围、指标变化和你的具体职责。", evidence_refs: [], uncertainty_note: "当前样本较短，只能作为本轮观察。" }],
          uncertainty_notes: ["样本较短，不能代表稳定能力判断。"],
          completed_at: "now"
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("做得好的地方");
    expect(html).toContain("本轮观察");
    expect(html).toContain("可以更好的地方");
    expect(html).toContain("关键片段");
    expect(html).toContain("不确定性说明");
    const strengthsStart = html.indexOf("做得好的地方");
    const observationsStart = html.indexOf("本轮观察");
    const strengthsHtml = html.slice(strengthsStart, observationsStart);
    expect(strengthsHtml).toContain("结构化表达：回答包含背景、行动和结果。");
    expect(strengthsHtml).toContain("风险处理：主动识别上线风险并给出灰度回滚方案。");
    expect(strengthsHtml).not.toContain("本次复盘没有提取到足够明确的正向观察。");
    expect(html).toContain("样本较短");
    expect(html.indexOf("可以更好的地方")).toBeLessThan(html.indexOf("不确定性说明"));
    expect(html.indexOf("样本较短，不能代表稳定能力判断。")).toBeGreaterThan(html.indexOf("不确定性说明"));
    const reviewPageSource = fs.readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
    expect(reviewPageSource).toContain("(review.uncertainty_notes ?? []).map((note, index)");
    expect(reviewPageSource).toContain("key={`${index}-${note}`}");
    expect(html).not.toContain("维度观察");
    expect(html).not.toContain("行动建议");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/综合评分|总分|评分雷达|能力趋势|平均得分|高置信能力|event_report|answer_technical_question|user_candidate|session-report-sections/);
  });

  it("keeps long review and archive cards internally scrollable", () => {
    const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/--pf-scroll-card-max-height:\s*min\(42rem,\s*68vh\)/);
    expect(css).toMatch(/\.review-section-grid\s+\.review-card,\s*\.history-transcript-card,\s*\.review-archive-card,\s*\.scene-archive-card,\s*\.materials-list-card\s*\{[\s\S]*max-height:\s*var\(--pf-scroll-card-max-height\)[\s\S]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.review-section-grid\s+\.review-card\s*>\s*\.compact-list,\s*\.review-section-grid\s+\.review-card\s*>\s*\.moment-list,\s*\.review-section-grid\s+\.review-card\s*>\s*\.recommendation-list,\s*\.history-transcript-list,\s*\.materials-list\s*\{[\s\S]*min-height:\s*0/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*820px\)\s*\{[\s\S]*--pf-scroll-card-max-height:\s*60vh/s);
  });

  it("keeps template library action buttons aligned across uneven descriptions", () => {
    const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.template-card\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto[\s\S]*align-content:\s*stretch/s);
    expect(css).toMatch(/\.template-card\s*>\s*p\s*\{[\s\S]*min-height:\s*0[\s\S]*line-clamp:\s*3[\s\S]*-webkit-line-clamp:\s*3/s);
    expect(css).toMatch(/\.template-card\s*>\s*\.secondary-action\s*\{[\s\S]*align-self:\s*end[\s\S]*margin-top:\s*auto/s);
  });

  it("does not promote negative review dimensions into strengths", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_negative_strengths",
          session_id: "session-negative-strengths",
          created_at: "now",
          status: "succeeded",
          summary: "本轮有交付证据，但跨角色追问回应不够直接。",
          dimensions: [
            { name: "真实工作影响", conclusion: "PM 追问下未能充分阐明业务影响，缺乏指标口径。", evidence_refs: [] },
            { name: "协作问题", conclusion: "面对前端追问时出现回避和转移话题。", evidence_refs: [] },
            { name: "成长和后续计划", conclusion: "仍以同一案例重复作答，未提出可执行成长计划。", evidence_refs: [] },
            { name: "推进节奏", conclusion: "客户明确表达不满，多个异议悬而未决，下一步缺失。", evidence_refs: [] },
            { name: "风险承认", conclusion: "能够承认风险并提出后续计划。", evidence_refs: [] }
          ],
          key_moments: [],
          evidence_refs: [],
          evidence_summary: { answer_count: 18, cited_answer_count: 18, coverage: "sufficient", confidence: "high" },
          recommendations: [{ text: "优先补充 PM 和前端视角的直接证据。", evidence_refs: [] }]
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    const strengthsStart = html.indexOf("做得好的地方");
    const observationsStart = html.indexOf("本轮观察");
    const strengthsHtml = html.slice(strengthsStart, observationsStart);
    const observationsHtml = html.slice(observationsStart);

    expect(strengthsHtml).toContain("风险承认：能够承认风险并提出后续计划。");
    expect(strengthsHtml).not.toContain("真实工作影响：PM 追问下未能充分阐明业务影响，缺乏指标口径。");
    expect(strengthsHtml).not.toContain("协作问题：面对前端追问时出现回避和转移话题。");
    expect(strengthsHtml).not.toContain("成长和后续计划：仍以同一案例重复作答，未提出可执行成长计划。");
    expect(strengthsHtml).not.toContain("推进节奏：客户明确表达不满，多个异议悬而未决，下一步缺失。");
    expect(observationsHtml).toContain("真实工作影响：PM 追问下未能充分阐明业务影响，缺乏指标口径。");
    expect(observationsHtml).toContain("协作问题：面对前端追问时出现回避和转移话题。");
    expect(observationsHtml).toContain("成长和后续计划：仍以同一案例重复作答，未提出可执行成长计划。");
    expect(observationsHtml).toContain("推进节奏：客户明确表达不满，多个异议悬而未决，下一步缺失。");
  });

  it("renders evidence sufficiency, safe locators and credibility checks", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_1",
          session_id: "session-auto-ai",
          created_at: "now",
          status: "succeeded",
          summary: "回答需要更聚焦问题。",
          dimensions: [{ name: "可信度", conclusion: "回答存在跑题和矛盾风险。", evidence_refs: [] }],
          key_moments: [{
            title: "答辩人回答偏离问题",
            description: "回答没有回应当前问题。",
            evidence_ref: { session_id: "session-auto-ai", event_id: "event_1", sequence: 2, step_id: "answer_question", actor_id: "user_candidate" },
            evidence_locator: { sequence: 2, speaker: "答辩人", snippet: "我不知道你在问什么，今天午饭很好吃。" }
          }],
          evidence_refs: [{ session_id: "session-auto-ai", event_id: "event_1", sequence: 2, step_id: "answer_question", actor_id: "user_candidate" }],
          evidence_summary: { answer_count: 2, cited_answer_count: 1, coverage: "insufficient", confidence: "low" },
          credibility_checks: [
            { kind: "evidence_gap", severity: "warning", message: "证据不足：本次复盘基于 1/2 条用户回答生成。" },
            { kind: "off_topic", severity: "warning", message: "发现答非所问信号：有回答没有回应当前问题。" },
            { kind: "contradiction", severity: "warning", message: "发现前后矛盾信号：需要澄清真实职责。" }
          ],
          recommendations: [{ text: "先回答问题本身，再补充背景。", evidence_refs: [] }]
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("基于 2 条回答生成");
    expect(html).toContain("引用 1 条回答");
    expect(html).toContain("本次证据覆盖不足");
    expect(html).toContain("结论置信度：低");
    expect(html).not.toContain("证据充分");
    expect(html).not.toContain("可信度：低");
    expect(html).toContain("对应片段");
    expect(html).toContain("对话片段 2 · 答辩人");
    expect(html).not.toContain("第 2 轮");
    expect(html).toContain("我不知道你在问什么，今天午饭很好吃。");
    expect(html).toContain("答非所问");
    expect(html).toContain("前后矛盾");
    expect(html).not.toMatch(/event_1|answer_question|user_candidate|session-auto-ai|step_id|actor_id|event_id/);
  });

  it("renders short-sample review confidence without claiming sufficient evidence or high confidence", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_1",
          session_id: "session-auto-ai",
          created_at: "now",
          status: "succeeded",
          summary: "本次演练中回答结构清晰。",
          dimensions: [{ name: "结构化表达", conclusion: "回答包含背景、行动和结果。", evidence_refs: [] }],
          key_moments: [],
          evidence_refs: [{ session_id: "session-auto-ai", event_id: "event_1", sequence: 1, step_id: "answer_question", actor_id: "user_candidate" }],
          evidence_summary: { answer_count: 3, cited_answer_count: 3, coverage: "sufficient", confidence: "low" },
          credibility_checks: [
            { kind: "evidence_gap", severity: "info", message: "本次复盘仅基于 3 条用户回答，适合观察本轮演练中的表达和证据倾向，不能代表稳定能力判断。" }
          ],
          recommendations: [{ text: "补充更多样本后再判断稳定能力。", evidence_refs: [] }],
          uncertainty_notes: ["本次复盘仅基于 3 条用户回答，适合观察本轮演练中的表达和证据倾向，不能代表稳定能力判断。"]
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("基于 3 条回答生成");
    expect(html).toContain("本次证据覆盖较好");
    expect(html).toContain("结论置信度：低");
    expect(html).toContain("不能代表稳定能力判断");
    expect(html).not.toContain("证据充分");
    expect(html).not.toContain("可信度：高");
  });

  it("renders a safe key moment empty state without undefined, null or raw objects", () => {
    const html = renderToStaticMarkup(
      <ReviewPage
        session={baseSession("completed", 9, [])}
        review={{
          id: "review_1",
          session_id: "session-auto-ai",
          created_at: "now",
          status: "succeeded",
          summary: "回答结构清晰。",
          dimensions: [{ name: "结构化表达", conclusion: "回答包含背景、行动和结果。", evidence_refs: [] }],
          key_moments: [],
          evidence_refs: [{ session_id: "session-auto-ai", event_id: "event_1", sequence: 1, step_id: "answer_interview_question", actor_id: "user_candidate" }],
          recommendations: [{ text: "补充量化指标。", evidence_refs: [] }]
        }}
        api={{} as never}
        onReviewUpdated={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("关键片段");
    expect(html).toContain("本次复盘没有提取到足够明确的关键片段。");
    expect(html).not.toMatch(/\bundefined\b|\bnull\b|\[object Object\]|event_1|answer_interview_question|user_candidate|session-auto-ai|step_id|actor_id|event_id/);
  });

  it("restores the first safe model config after refresh without exposing API key material", () => {
    const restored = selectRestoredModelConfig({
      ok: true,
      data: {
        default_model_config_id: "model_1",
        model_configs: [
          {
            id: "model_1",
            provider: "openai-compatible",
            base_url: "https://example.test/v1",
            model: "gpt-test",
            display_name: "Local model",
            has_api_key: true
          }
        ]
      }
    });

    expect(restored).toMatchObject({ id: "model_1", has_api_key: true });
    expect(JSON.stringify(restored)).not.toContain("fixture-key-11-secret");
  });

  it("restores the server-persisted default model config after refresh", () => {
    const restored = selectRestoredModelConfig({
      ok: true,
      data: {
        default_model_config_id: "model_2",
        model_configs: [
          { id: "model_1", provider: "openai-compatible", base_url: "https://one.test/v1", model: "gpt-one", display_name: "One", has_api_key: true },
          { id: "model_2", provider: "openai-compatible", base_url: "https://two.test/v1", model: "gpt-two", display_name: "Two", has_api_key: true }
        ]
      }
    } as never);

    expect(restored).toMatchObject({ id: "model_2", model: "gpt-two", has_api_key: true });
  });

  it("clears a saved API key and keeps the dummy secret out of rendered output", () => {
    const secret = "fixture-key-11-secret";
    const state = settingsReducer(
      {
        ...initialSettingsState,
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "gpt-test",
        displayName: "Local model",
        apiKey: secret,
        status: "idle",
        message: ""
      },
      {
        type: "saveSucceeded",
        modelConfig: {
          id: "model_1",
          provider: "openai-compatible",
          base_url: "https://example.test/v1",
          model: "gpt-test",
          display_name: "Local model",
          has_api_key: true
        }
      }
    );

    const html = renderToStaticMarkup(<pre>{JSON.stringify(state)}</pre>);
    expect(state.apiKey).toBe("");
    expect(html).toContain("has_api_key");
    expect(html).not.toContain(secret);
  });

  it("renders product model mode copy without legacy smoke wording or secret material", () => {
    const html = renderToStaticMarkup(
      <SettingsPage
        state={initialSettingsState}
        dispatch={() => undefined}
        api={{} as ApiClient}
        onSaved={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("模型设置");
    expect(html).toContain("settings-layout");
    expect(html).toContain("settings-section-nav");
    expect(html).toContain("settings-content");
    expect(html).toContain("模型配置");
    expect(html).toContain("本地数据");
    expect(html).toContain("演练偏好");
    expect(html).toContain("PersonalFlow 优先使用本地数据");
    expect(html).toContain("当前支持 OpenAI 兼容服务");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/smoke|REAL_LLM_SMOKE|api_key_ciphertext|api_key_iv|api_key_tag|Authorization|Bearer|raw prompt|provider raw/i);
  });

  it("renders settings for existing model config capability only", () => {
    const html = renderToStaticMarkup(
      <SettingsPage
        state={initialSettingsState}
        dispatch={() => undefined}
        api={{} as ApiClient}
        onSaved={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("模型设置");
    expect(html).toContain("OpenAI 兼容");
    expect(html).toContain("测试连接");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toContain("导出全部");
    expect(html).not.toContain("清除全部数据");
    expect(html).not.toContain("Ollama");
  });

  it("explains import/export is limited to a single scenario file", () => {
    const html = renderToStaticMarkup(
      <ImportExportPage
        scene={null}
        api={{} as ApiClient}
        onImported={() => undefined}
        onGoToScene={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("场景导入导出");
    expect(html).toContain("import-export-hero");
    expect(html).toContain("import-export-grid");
    expect(html).toContain("这里导入导出的是单个场景文件，不是完整工作区备份。");
    expectNoFutureCapabilityCopy(html);
  });

  it("uses PATCH, default selection and DELETE web client methods for saved model config mutations without sending a full config object", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ model_config: { id: "model_1", provider: "openai-compatible", base_url: "https://next.test/v1", model: "gpt-next", display_name: "Next model", has_api_key: true }, default_model_config_id: "model_1", deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const api = new ProductApiClient();

    await (api as unknown as {
      patchModelConfig: (id: string, input: Record<string, string>) => Promise<unknown>;
      deleteModelConfig: (id: string, idempotencyKey: string, reason: string) => Promise<unknown>;
    }).patchModelConfig("model_1", {
      display_name: "Next model",
      base_url: "https://next.test/v1",
      model: "gpt-next",
      api_key: "dummy-new-secret",
      idempotency_key: "update-model-1"
    });
    await (api as unknown as {
      setDefaultModelConfig: (id: string, idempotencyKey: string) => Promise<unknown>;
    }).setDefaultModelConfig("model_1", "default-model-1");
    await (api as unknown as {
      deleteModelConfig: (id: string, idempotencyKey: string, reason: string) => Promise<unknown>;
    }).deleteModelConfig("model_1", "delete-model-1", "user_requested");

    expect(calls[0]).toMatchObject({ url: "/api/model-configs/model_1", init: { method: "PATCH" } });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      display_name: "Next model",
      base_url: "https://next.test/v1",
      model: "gpt-next",
      api_key: "dummy-new-secret",
      idempotency_key: "update-model-1"
    });
    expect(calls[1]).toMatchObject({ url: "/api/model-configs/model_1/default", init: { method: "PATCH" } });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      idempotency_key: "default-model-1"
    });
    expect(calls[2]).toMatchObject({ url: "/api/model-configs/model_1", init: { method: "DELETE" } });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      idempotency_key: "delete-model-1",
      reason: "user_requested"
    });
    expect(JSON.stringify(calls)).not.toMatch(/api_key_ciphertext|api_key_iv|api_key_tag|Authorization|Bearer|storage row|Drizzle/i);
  });

  it("uses PATCH web client method for draft material visibility updates", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        draft: {
          id: "draft_1",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));
    const api = new ProductApiClient();

    await api.updateDraftMaterialVisibility("draft_1", {
      source_ref: "material:resume_safe",
      visibility: {
        mode: "all_stages",
        entries: [
          { role_id: "user_candidate", access: "summary" },
          { role_id: "ai_interviewer", access: "full" }
        ]
      },
      idempotency_key: "update-material-visibility-1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/drafts/draft_1/materials/visibility", init: { method: "PATCH" } });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      source_ref: "material:resume_safe",
      visibility: {
        mode: "all_stages",
        entries: [
          { role_id: "user_candidate", access: "summary" },
          { role_id: "ai_interviewer", access: "full" }
        ]
      },
      idempotency_key: "update-material-visibility-1"
    });
  });

  it("uses dangerous confirmation copy and a stable idempotency key when deleting a model config", () => {
    const modelConfig = {
      id: "model_1",
      provider: "openai-compatible",
      base_url: "https://primary.test/v1",
      model: "gpt-primary",
      display_name: "Primary model",
      has_api_key: true
    };

    expect(deleteModelConfigConfirmationText(modelConfig)).toContain("删除模型配置 Primary model");
    expect(deleteModelConfigConfirmationText(modelConfig)).toContain("不可撤销");
    expect(deleteModelConfigConfirmationText(modelConfig)).toContain("如需继续，请确认删除。");
    expect(buildDeleteModelConfigIdempotencyKey(modelConfig)).toBe("delete-model-config-model_1");
    expect(buildDeleteModelConfigIdempotencyKey(modelConfig)).toBe(buildDeleteModelConfigIdempotencyKey(modelConfig));
  });

  it("renders saved model management controls, default marker, empty state and safe key status", () => {
    const secret = "test-render-secret";
    const state = {
      ...initialSettingsState,
      modelConfig: {
        id: "model_1",
        provider: "openai-compatible",
        base_url: "https://primary.test/v1",
        model: "gpt-primary",
        display_name: "Primary model",
        has_api_key: true
      }
    };
    const html = renderToStaticMarkup(
      <SettingsPage
        state={state}
        dispatch={() => undefined}
        api={{} as ApiClient}
        onSaved={() => undefined}
        onError={() => undefined}
      />
    );
    const emptyHtml = renderToStaticMarkup(
      <SettingsPage
        state={initialSettingsState}
        dispatch={() => undefined}
        api={{} as ApiClient}
        onSaved={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("已保存模型");
    expect(html).toContain("Primary model");
    expect(html).toContain("OpenAI 兼容服务");
    expect(html).not.toContain("openai-compatible");
    expect(html).toContain("https://primary.test/v1");
    expect(html).toContain("gpt-primary");
    expect(html).toContain("已保存密钥");
    expect(html).toContain("当前默认");
    expect(html).toContain("设为默认");
    expect(html).toContain("编辑配置");
    expect(html).toContain("删除配置");
    expect(html).toContain("测试连接");
    expect(emptyHtml).toContain("还没有保存模型配置");
    expect(emptyHtml).toContain("请先新增一条 OpenAI 兼容配置");
    expect(emptyHtml).toContain("请先保存或选择模型配置");
    expect(`${html}${emptyHtml}`).not.toContain(secret);
    expect(`${html}${emptyHtml}`).not.toMatch(/masked \/ has_api_key|api_key_ciphertext|api_key_iv|api_key_tag|Authorization|Bearer|raw prompt|provider raw|storage row|Drizzle/i);
  });

  it("prioritizes saved default model over new model form", () => {
    const element = (
      <SettingsPage
        state={{
          ...initialSettingsState,
          provider: "openai-compatible",
          baseUrl: "https://unsaved.example/v1",
          model: "unsaved-model",
          displayName: "unsaved draft",
          modelConfigs: [{
            id: "model_1",
            provider: "openai-compatible",
            base_url: "https://api.example.test/v1",
            model: "example-model-pro",
            display_name: "Example saved model",
            has_api_key: true
          }],
          defaultModelConfigId: "model_1"
        }}
        dispatch={() => undefined}
        api={{} as ApiClient}
        onSaved={() => undefined}
        onError={() => undefined}
      />
    );
    const html = renderToStaticMarkup(element);

    expect(html).toContain("当前默认模型");
    expect(html.indexOf("当前默认模型")).toBeLessThan(html.indexOf("新增模型配置"));
    expect(html).toContain("form-field");
    expect(html).toContain("Example saved model");
    expect(html).toContain("OpenAI 兼容服务");
    expect(html).not.toContain("openai-compatible");
    expect(html).toContain("https://api.example.test/v1");
    expect(html).toContain("example-model-pro");
    expect(html).toContain("已保存密钥");
    expect(html).toContain("测试连接");
    const settingsSource = fs.readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
    expect(settingsSource).toContain("onClick={() => void testConnection(selectedModelConfig)}");
    expectNoFutureCapabilityCopy(html);
    expect(html).not.toMatch(/model_1|model_config_id|api_key|Authorization|Bearer/i);
  });

  it("tests the model config selected by each saved model row", async () => {
    const primaryModel = {
      id: "model_primary",
      provider: "openai-compatible",
      base_url: "https://primary.test/v1",
      model: "gpt-primary",
      display_name: "Primary model",
      has_api_key: true
    };
    const backupModel = {
      id: "model_backup",
      provider: "openai-compatible",
      base_url: "https://backup.test/v1",
      model: "gpt-backup",
      display_name: "Backup model",
      has_api_key: true
    };
    const api = {
      testModelConfig: vi.fn(async () => ({ ok: true, data: { ok: true, model: "gpt-backup" } }))
    } as unknown as ApiClient;
    const dispatched: unknown[] = [];
    const errors: unknown[] = [];
    const html = renderToStaticMarkup(
      <SettingsPage
        state={{
          ...initialSettingsState,
          modelConfigs: [primaryModel, backupModel],
          defaultModelConfigId: primaryModel.id,
          modelConfig: primaryModel
        }}
        dispatch={(action) => { dispatched.push(action); }}
        api={api}
        onSaved={() => undefined}
        onError={(error) => { errors.push(error); }}
      />
    );

    expect(html).toContain("aria-label=\"测试连接 Backup model\"");
    await testSavedModelConfigConnection({
      api,
      dispatch: (action) => { dispatched.push(action); },
      modelConfig: backupModel,
      onError: (error) => { errors.push(error); },
      idempotencyKey: "test-backup-model"
    });

    expect(api.testModelConfig).toHaveBeenCalledWith("model_backup", "test-backup-model");
    expect(dispatched).toContainEqual({ type: "testing" });
    expect(dispatched).toContainEqual({ type: "testSucceeded", message: "连接成功：gpt-backup" });
    expect(errors).toEqual([]);
  });

  it("treats model config business failure as a failed connection test", async () => {
    const modelConfig = {
      id: "model_protocol",
      provider: "openai-compatible",
      base_url: "https://protocol.test/v1",
      model: "gpt-protocol",
      display_name: "Protocol model",
      has_api_key: true
    };
    const api = {
      testModelConfig: vi.fn(async () => ({
        ok: true,
        data: {
          ok: false,
          provider: "openai-compatible",
          base_url: "https://protocol.test/v1",
          model: "gpt-protocol",
          protocol_valid: false,
          message: "连接可用但模型未按演练协议输出，请检查模型能力或提示配置。"
        }
      }))
    } as unknown as ApiClient;
    const dispatched: unknown[] = [];
    const errors: unknown[] = [];

    await testSavedModelConfigConnection({
      api,
      dispatch: (action) => { dispatched.push(action); },
      modelConfig,
      onError: (error) => { errors.push(error); },
      idempotencyKey: "test-protocol-model"
    });

    expect(api.testModelConfig).toHaveBeenCalledWith("model_protocol", "test-protocol-model");
    expect(dispatched).toContainEqual({ type: "testing" });
    expect(dispatched).toContainEqual({
      type: "failed",
      error: {
        code: "model_connection_failed",
        message: "连接可用但模型未按演练协议输出，请检查模型能力或提示配置。"
      }
    });
    expect(dispatched).not.toContainEqual(expect.objectContaining({ type: "testSucceeded" }));
    expect(errors).toEqual([{
      code: "model_connection_failed",
      message: "连接可用但模型未按演练协议输出，请检查模型能力或提示配置。"
    }]);
  });

  it("does not call the model config test API when no config is selected", async () => {
    const api = {
      testModelConfig: vi.fn(async () => ({ ok: true, data: { ok: true, model: "unused" } }))
    } as unknown as ApiClient;
    const dispatched: unknown[] = [];
    const errors: unknown[] = [];

    await testSavedModelConfigConnection({
      api,
      dispatch: (action) => { dispatched.push(action); },
      modelConfig: undefined,
      onError: (error) => { errors.push(error); },
      idempotencyKey: "test-no-config"
    });

    expect(api.testModelConfig).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{
      type: "failed",
      error: {
        code: "validation_error",
        message: "请先保存或选择模型配置。"
      }
    }]);
    expect(errors).toEqual([{
      code: "validation_error",
      message: "请先保存或选择模型配置。"
    }]);
  });

  it("renders recoverable AI turn failure actions and protocol-aware connection test messages", async () => {
    const failedSession = {
      ...baseSession("running", 5, [aiStep]),
      view: {
        ...baseSession("running", 5, [aiStep]).view,
        current_actor_name: "AI 面试官",
        next_user_action_label: "AI 本轮失败，可重试当前 AI 回合或刷新演练。",
        failure_summary: {
          message: "AI 本轮没有成功生成可用提问，已保留当前演练进度。",
          failed_attempts: 1,
          can_retry: true,
          action_label: "重试当前 AI 回合"
        }
      }
    } satisfies SessionView;
    const api = {
      runAiTurn: vi.fn(async () => ({ ok: false, error: { code: "model_error", message: "模型暂时不可用，请稍后重试。" } })),
      getSession: vi.fn(async () => ({ ok: true, data: { session: failedSession } }))
    } as unknown as ApiClient;
    const html = renderToStaticMarkup(
      <SessionPage
        session={failedSession}
        api={api}
        onSessionUpdated={() => undefined}
        onReviewRequested={() => undefined}
        onError={() => undefined}
      />
    );

    expect(html).toContain("AI 本轮没有成功生成可用提问");
    expect(html).toContain("失败次数：1");
    expect(html).toContain("重试当前 AI 回合");
    expect(html).toContain("刷新演练");
    expect(html).toContain("查看失败复盘");
    expect(html).toContain("去模型配置");

    const state = settingsReducer(initialSettingsState, {
      type: "testSucceeded",
      message: "连接可用但模型未按演练协议输出，请检查模型能力或提示配置。"
    });
    expect(state.message).toContain("模型未按演练协议输出");
  });

  it("tracks default model degradation after deleting the current default without retaining the deleted id", () => {
    const stateWithDefault = {
      ...initialSettingsState,
      modelConfigs: [
        { id: "model_1", provider: "openai-compatible", base_url: "https://one.test/v1", model: "gpt-one", display_name: "One", has_api_key: true },
        { id: "model_2", provider: "openai-compatible", base_url: "https://two.test/v1", model: "gpt-two", display_name: "Two", has_api_key: true }
      ],
      defaultModelConfigId: "model_1",
      modelConfig: { id: "model_1", provider: "openai-compatible", base_url: "https://one.test/v1", model: "gpt-one", display_name: "One", has_api_key: true }
    };
    const switched = settingsReducer(stateWithDefault as never, { type: "deleteSucceeded", modelConfigId: "model_1" } as never) as unknown as {
      readonly modelConfigs: ReadonlyArray<{ readonly id: string }>;
      readonly defaultModelConfigId: string | null;
      readonly message: string;
    };
    const cleared = settingsReducer({ ...stateWithDefault, modelConfigs: [stateWithDefault.modelConfigs[0]] } as never, { type: "deleteSucceeded", modelConfigId: "model_1" } as never) as unknown as {
      readonly modelConfigs: ReadonlyArray<{ readonly id: string }>;
      readonly defaultModelConfigId: string | null;
      readonly message: string;
    };

    expect(switched.modelConfigs.map((config) => config.id)).toEqual(["model_2"]);
    expect(switched.defaultModelConfigId).toBe("model_2");
    expect(switched.message).toContain("默认模型已切换");
    expect(cleared.modelConfigs).toEqual([]);
    expect(cleared.defaultModelConfigId).toBeNull();
    expect(cleared.message).toContain("当前没有默认模型");
  });

  it("forces Playwright API webServer to Fake model mode for automation isolation", () => {
    const configText = fs.readFileSync("playwright.config.ts", "utf8");

    expect(configText).toContain("PERSONALFLOW_MODEL_MODE");
    expect(configText).toContain("\"fake\"");
  });

  it("renders Debug page from safe summaries without serializing raw prompt, provider response or secrets", () => {
    const secret = "dummy-secret-for-security-check-only";
    const html = renderToStaticMarkup(
      <DebugPage
        draft={{
          id: "draft_1",
          template_id: "job_interview",
          created_at: "now",
          updated_at: "now",
          preview: { title: { value: "Safe draft", is_default: false } },
          raw_prompt: `FULL PROMPT ${secret}`
        } as never}
        scene={{
          id: "scene_1",
          draft_id: "draft_1",
          source_template_id: "job_interview",
          title: "Safe scene",
          normalized_hash: "hash_safe",
          created_at: "now",
          provider_response: `raw provider response ${secret}`
        } as never}
        session={{
          id: "session_1",
          scenario_id: "scenario_1",
          status: "running",
          provider_request: { authorization: `Bearer ${secret}` },
          view: {
            session_id: "session_1",
            scenario_id: "scenario_1",
            status: "running",
            state_version: 0,
            state: { prompt: `FULL PROMPT ${secret}` },
            allowed_steps: [],
            visible_transcript: []
          }
        } as never}
        review={{
          id: "review_1",
          session_id: "session_1",
          status: "failed",
          created_at: "now",
          error_message: "review_parse_failed",
          review_adapter_kind: "mock",
          raw_response: `raw provider response ${secret}`,
          evidence_refs: [{ session_id: "session_1", event_id: "event_1", sequence: 1, step_id: "ask_question", actor_id: "ai_interviewer" }]
        } as never}
        aiTurnObservability={{
          adapter_kind: "fake",
          model_config_id: "model_safe",
          provider: "openai-compatible",
          model: "gpt-safe",
          raw_prompt: `FULL PROMPT ${secret}`,
          provider_raw_response: `raw provider response ${secret}`,
          visible_history: [
            {
              event_id: "event_1",
              sequence: 1,
              actor_id: "ai_interviewer",
              step_id: "ask_question",
              text_summary: "Safe launch question."
            },
            {
              event_id: "event_2",
              sequence: 2,
              actor_id: "user_candidate",
              step_id: "answer_question",
              text_summary: "Safe launch answer."
            }
          ]
        } as never}
      />
    );

    expect(html).toContain("draft_1");
    expect(html).toContain("review_1");
    expect(html).toContain("mock");
    expect(html).toContain("fake");
    expect(html).toContain("model_safe");
    expect(html).toContain("openai-compatible");
    expect(html).toContain("gpt-safe");
    expect(html).toContain("Safe launch question.");
    expect(html).toContain("Safe launch answer.");
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(/Authorization|Bearer|FULL PROMPT|raw provider response|provider_request|raw_response|raw_prompt|provider_raw_response/);
  });
});
