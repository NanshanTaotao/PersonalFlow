import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client";
import type { AiTurnObservabilityView, ApiFailure, BranchTreeView, SessionCommandPayload, SessionView, StepView } from "../api/types";
import { BranchTreePanel } from "../components/BranchTreePanel";
import { SessionTimer } from "../components/SessionTimer";
import { SessionTranscript, type VisibleTranscriptEntry } from "../components/SessionTranscript";

export const createSessionCommandPayload = ({ stateVersion, idempotencyKey }: { readonly stateVersion: number; readonly idempotencyKey?: string }): SessionCommandPayload => ({
  expected_state_version: stateVersion,
  ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey })
});

const visibleTranscript = (session: SessionView): VisibleTranscriptEntry[] => session.view.visible_transcript.map((entry) => ({
  id: entry.id,
  eventId: entry.event_id,
  sequence: entry.sequence,
  actorKind: entry.actor_kind,
  actorName: entry.actor_name,
  text: entry.text
}));

const isAiStep = (step: StepView): boolean => step.actor_kind === "ai";
const isHumanStep = (step: StepView): boolean => step.actor_kind === "user";

const findUniqueHumanStep = (session: SessionView): StepView | undefined => {
  const humanSteps = session.status === "running" ? session.view.allowed_steps.filter(isHumanStep) : [];
  return humanSteps.length === 1 ? humanSteps[0] : undefined;
};

const findRunnableAiStep = (session: SessionView): StepView | undefined =>
  session.status === "running" ? session.view.allowed_steps.find(isAiStep) : undefined;

const sessionStatusLabels: Record<SessionView["status"], string> = {
  running: "演练进行中",
  paused: "演练已暂停",
  completed: "演练已完成",
  ended: "演练已结束",
  failed: "演练失败",
  blocked: "演练已阻断"
};

const currentStageTitle = (session: SessionView): string =>
  session.view.current_stage?.title ?? session.view.current_stage_label;

const commandErrorLabels: Record<"pause" | "resume" | "end", string> = {
  pause: "暂停演练失败，请刷新后再试。",
  resume: "继续演练失败，请刷新后再试。",
  end: "结束演练失败，请刷新后再试。"
};

const sidebarActionHint = (session: SessionView): string => {
  if (session.status === "blocked") {
    return "请查看左侧阻断原因，并按需要结束演练或刷新。";
  }
  if (session.status === "completed" || session.status === "ended") {
    return "本次演练已收束，可在主操作区查看复盘。";
  }
  if (session.status === "paused") {
    return "演练已暂停，可在主操作区继续。";
  }
  return "请参考左侧主操作区继续当前步骤。";
};

interface SessionPageProps {
  readonly session: SessionView | null;
  readonly api: ApiClient;
  readonly modelConfigId?: string;
  readonly onSessionUpdated: (session: SessionView) => void;
  readonly onAiTurnObserved?: (observability: AiTurnObservabilityView) => void;
  readonly onReviewRequested: () => void;
  readonly onExit?: () => void;
  readonly onSettingsRequested?: () => void;
  readonly branchTree?: BranchTreeView | null;
  readonly onSessionForked?: (session: SessionView) => void;
  readonly onBranchTreeChanged?: () => void;
  readonly onOpenBranch?: (sessionId: string) => void;
  readonly onCreateBranchReview?: (sessionId: string) => void;
  readonly onError: (error: ApiFailure) => void;
}

interface SubmitUserInputAndMaybeRunAiTurnInput {
  readonly session: SessionView;
  readonly api: ApiClient;
  readonly input: string;
  readonly modelConfigId?: string;
  readonly onSessionUpdated: (session: SessionView) => void;
  readonly onAiTurnObserved?: (observability: AiTurnObservabilityView) => void;
  readonly onError: (error: ApiFailure) => void;
}

interface RunInitialAiTurnIfNeededInput {
  readonly session: SessionView;
  readonly api: ApiClient;
  readonly modelConfigId?: string;
  readonly triggeredKeys: Set<string>;
  readonly onSessionUpdated: (session: SessionView) => void;
  readonly onAiTurnObserved?: (observability: AiTurnObservabilityView) => void;
  readonly onError: (error: ApiFailure) => void;
}

interface WithdrawEntryAndSwitchSessionInput {
  readonly session: SessionView;
  readonly api: ApiClient;
  readonly entry: VisibleTranscriptEntry;
  readonly setInput: (next: string) => void;
  readonly setWithdrawNotice: (next: string) => void;
  readonly setLastWithdrawnInput: (next: string) => void;
  readonly onSessionUpdated: (session: SessionView) => void;
  readonly onSessionForked?: (session: SessionView) => void;
  readonly onBranchTreeChanged?: () => void;
  readonly onError: (error: ApiFailure) => void;
}

export const submitUserInputAndMaybeRunAiTurn = async ({
  session,
  api,
  input,
  modelConfigId,
  onSessionUpdated,
  onAiTurnObserved,
  onError
}: SubmitUserInputAndMaybeRunAiTurnInput): Promise<{ readonly submitted: boolean; readonly ranAiTurn: boolean }> => {
  const selectedStep = findUniqueHumanStep(session);
  if (selectedStep === undefined) {
    onError({ code: "validation_error", message: "当前无法提交回答，请刷新或稍后重试。" });
    return { submitted: false, ranAiTurn: false };
  }

  const submitResult = await api.submitUserInput(session.id, {
    input: input.trim(),
    expected_state_version: session.view.state_version,
    idempotency_key: `input-${session.id}-${session.view.state_version}-${Date.now()}`
  });
  if (!submitResult.ok || submitResult.data === undefined) {
    onError(submitResult.error ?? { code: "api_error", message: "回答提交失败，未在本地追加演练记录。可刷新后重试。" });
    return { submitted: false, ranAiTurn: false };
  }

  const submittedSession = submitResult.data.session;
  const aiStep = findRunnableAiStep(submittedSession);
  if (aiStep === undefined) {
    onSessionUpdated(submittedSession);
    return { submitted: true, ranAiTurn: false };
  }

  const aiResult = await api.runAiTurn(submittedSession.id, {
    actor_id: aiStep.actor_id,
    expected_state_version: submittedSession.view.state_version,
    ...(modelConfigId === undefined ? {} : { model_config_id: modelConfigId }),
    idempotency_key: `ai-${submittedSession.id}-${submittedSession.view.state_version}-${Date.now()}`
  });
  if (!aiResult.ok || aiResult.data === undefined) {
    onSessionUpdated(submittedSession);
    onError(aiResult.error ?? { code: "api_error", message: "AI 提问失败，可刷新后重试。" });
    return { submitted: true, ranAiTurn: false };
  }

  onSessionUpdated(aiResult.data.session);
  onAiTurnObserved?.(aiResult.data.ai_turn_observability);
  return { submitted: true, ranAiTurn: true };
};

export const runInitialAiTurnIfNeeded = async ({
  session,
  api,
  modelConfigId,
  triggeredKeys,
  onSessionUpdated,
  onAiTurnObserved,
  onError
}: RunInitialAiTurnIfNeededInput): Promise<boolean> => {
  const aiStep = findRunnableAiStep(session);
  if (aiStep === undefined) {
    return false;
  }
  const key = `${session.id}:${session.view.state_version}`;
  if (triggeredKeys.has(key)) {
    return false;
  }
  triggeredKeys.add(key);
  const result = await api.runAiTurn(session.id, {
    actor_id: aiStep.actor_id,
    expected_state_version: session.view.state_version,
    ...(modelConfigId === undefined ? {} : { model_config_id: modelConfigId }),
    idempotency_key: `ai-initial-${session.id}-${session.view.state_version}`
  });
  if (!result.ok || result.data === undefined) {
    onError(result.error ?? { code: "api_error", message: "AI 提问失败，可点击按钮重试。" });
    return false;
  }
  onSessionUpdated(result.data.session);
  onAiTurnObserved?.(result.data.ai_turn_observability);
  return true;
};

export const withdrawEntryAndSwitchSession = async ({
  session,
  api,
  entry,
  setInput,
  setWithdrawNotice,
  setLastWithdrawnInput,
  onSessionUpdated,
  onSessionForked,
  onBranchTreeChanged,
  onError
}: WithdrawEntryAndSwitchSessionInput): Promise<boolean> => {
  if (entry.eventId === undefined) {
    onError({ code: "validation_error", message: "撤回失败，请刷新后重试。" });
    return false;
  }
  const result = await api.withdrawUserInput(session.id, {
    user_event_id: entry.eventId,
    branch_label: "撤回后重写",
    idempotency_key: `withdraw-${session.id}-${entry.eventId}-${Date.now()}`
  });
  if (!result.ok || result.data === undefined) {
    onError(result.error ?? { code: "api_error", message: "撤回失败，请刷新后重试。" });
    return false;
  }
  setInput("");
  setLastWithdrawnInput(result.data.withdrawn_input.text);
  setWithdrawNotice("已创建一个新版本，你可以重写刚才的回答。原版本仍保留在版本历史中。");
  onSessionUpdated(result.data.session);
  onSessionForked?.(result.data.session);
  onBranchTreeChanged?.();
  return true;
};

export function SessionPage({
  session,
  api,
  modelConfigId,
  onSessionUpdated,
  onAiTurnObserved,
  onReviewRequested,
  onExit,
  onSettingsRequested,
  branchTree,
  onSessionForked,
  onBranchTreeChanged,
  onOpenBranch,
  onCreateBranchReview,
  onError
}: SessionPageProps) {
  const [input, setInput] = useState("");
  const [withdrawNotice, setWithdrawNotice] = useState("");
  const [lastWithdrawnInput, setLastWithdrawnInput] = useState("");
  const [pendingAction, setPendingAction] = useState<"ai" | "command" | "input" | "reload" | null>(null);
  const pendingActionRef = useRef(false);
  const initialAiTriggeredKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (session === null || pendingActionRef.current) {
      return;
    }
    void runInitialAiTurnIfNeeded({
      session,
      api,
      ...(modelConfigId === undefined ? {} : { modelConfigId }),
      triggeredKeys: initialAiTriggeredKeys.current,
      onSessionUpdated,
      ...(onAiTurnObserved === undefined ? {} : { onAiTurnObserved }),
      onError
    });
  }, [api, modelConfigId, onAiTurnObserved, onError, onSessionUpdated, session]);

  if (session === null) {
    return <section className="empty-state-card"><h2>专注演练</h2><p>请先确认场景并开始演练。</p></section>;
  }

  const updateOrError = (result: { readonly ok: boolean; readonly data?: { readonly session: SessionView }; readonly error?: ApiFailure }, fallback: string) => {
    if (!result.ok || result.data === undefined) {
      onError(result.error ?? { code: "api_error", message: fallback });
      return;
    }
    onSessionUpdated(result.data.session);
  };

  const startPendingAction = (action: "ai" | "command" | "input" | "reload"): boolean => {
    if (pendingActionRef.current) {
      return false;
    }
    pendingActionRef.current = true;
    setPendingAction(action);
    return true;
  };

  const finishPendingAction = () => {
    pendingActionRef.current = false;
    setPendingAction(null);
  };

  const runAi = async (step: StepView) => {
    if (!startPendingAction("ai")) {
      return;
    }
    try {
      const result = await api.runAiTurn(session.id, {
        actor_id: step.actor_id,
        expected_state_version: session.view.state_version,
        ...(modelConfigId === undefined ? {} : { model_config_id: modelConfigId }),
        idempotency_key: `ai-${session.id}-${session.view.state_version}-${Date.now()}`
      });
      if (!result.ok || result.data === undefined) {
        onError(result.error ?? { code: "api_error", message: "AI 提问失败，可刷新后重试。" });
        return;
      }
      onSessionUpdated(result.data.session);
      onAiTurnObserved?.(result.data.ai_turn_observability);
    } finally {
      finishPendingAction();
    }
  };

  const submitInput = async () => {
    if (pendingActionRef.current) {
      return;
    }
    if (input.trim() === "") {
      onError({ code: "validation_error", message: "请先填写回答。" });
      return;
    }
    if (!startPendingAction("input")) {
      return;
    }
    try {
      const result = await submitUserInputAndMaybeRunAiTurn({
        session,
        api,
        input,
        ...(modelConfigId === undefined ? {} : { modelConfigId }),
        onSessionUpdated,
        ...(onAiTurnObserved === undefined ? {} : { onAiTurnObserved }),
        onError
      });
      if (result.submitted) {
        setInput("");
      }
    } finally {
      finishPendingAction();
    }
  };

  const command = async (name: "pause" | "resume" | "end") => {
    if (!startPendingAction("command")) {
      return;
    }
    try {
      const payload = createSessionCommandPayload({ stateVersion: session.view.state_version, idempotencyKey: `${name}-${session.id}-${session.view.state_version}-${Date.now()}` });
      const result = name === "pause" ? await api.pauseSession(session.id, payload) : name === "resume" ? await api.resumeSession(session.id, payload) : await api.endSession(session.id, payload);
      updateOrError(result, commandErrorLabels[name]);
      if (name === "end" && result.ok) {
        onReviewRequested();
      }
    } finally {
      finishPendingAction();
    }
  };

  const reload = async () => {
    if (!startPendingAction("reload")) {
      return;
    }
    try {
      const result = await api.getSession(session.id);
      updateOrError(result, "刷新演练失败。");
    } finally {
      finishPendingAction();
    }
  };

  const forkFromEntry = async (entry: VisibleTranscriptEntry) => {
    if (entry.eventId === undefined || !startPendingAction("command")) {
      return;
    }
    try {
      const branchLabel = entry.sequence === undefined ? "从这里分支" : `从第 ${entry.sequence} 轮开始`;
      const result = await api.createFork(session.id, {
        fork_point_event_id: entry.eventId,
        include_selected_event: true,
        branch_label: branchLabel,
        idempotency_key: `fork-${session.id}-${entry.eventId}-${Date.now()}`
      });
      if (!result.ok || result.data === undefined) {
        onError(result.error ?? { code: "api_error", message: "分支创建失败，请刷新后重试。" });
        return;
      }
      setWithdrawNotice("");
      onSessionUpdated(result.data.session);
      onSessionForked?.(result.data.session);
      onBranchTreeChanged?.();
    } finally {
      finishPendingAction();
    }
  };

  const withdrawEntry = async (entry: VisibleTranscriptEntry) => {
    if (!startPendingAction("command")) {
      return;
    }
    try {
      await withdrawEntryAndSwitchSession({
        session,
        api,
        entry,
        setInput,
        setWithdrawNotice,
        setLastWithdrawnInput,
        onSessionUpdated,
        ...(onSessionForked === undefined ? {} : { onSessionForked }),
        ...(onBranchTreeChanged === undefined ? {} : { onBranchTreeChanged }),
        onError
      });
    } finally {
      finishPendingAction();
    }
  };

  const isBusy = pendingAction !== null;
  const canRequestReview = session.status === "completed" || session.status === "ended";
  const isTerminalSession = canRequestReview;
  const isBlockedSession = session.status === "blocked";
  const humanStep = findUniqueHumanStep(session);
  const aiStep = findRunnableAiStep(session);
  const canSubmitInput = session.status === "running" && humanStep !== undefined && !isBusy;
  const canEndSession = (session.status === "running" || session.status === "paused" || session.status === "blocked") && !isBusy;
  const actorLabel = session.view.current_actor_name ?? "待系统确认";
  const failureSummary = session.view.failure_summary;
  const blockedSummary = session.view.blocked_summary;
  const visibleToolResults = session.view.visible_tool_results ?? [];
  const inputDockHint = (() => {
    if (isBusy) {
      return "正在提交，请稍候。";
    }
    if (failureSummary !== undefined) {
      return "AI 提问失败，可先使用恢复操作或刷新演练。";
    }
    if (isBlockedSession) {
      return blockedSummary?.message ?? "运行时已阻断，请结束本次演练或刷新后查看最新状态。";
    }
    if (isTerminalSession) {
      return session.view.next_user_action_label;
    }
    if (session.status === "paused") {
      return "演练已暂停，继续后即可回答。";
    }
    if (aiStep !== undefined && humanStep === undefined) {
      return "等待 AI 提问后即可回答。";
    }
    return session.view.next_user_action_label;
  })();

  return (
    <section className="session-focus-shell">
      <header className="session-topbar">
        <div className="session-topbar__identity">
          <div className="session-topbar__title-row">
            <button type="button" className="session-exit-button" onClick={onExit}>退出演练</button>
            <span aria-hidden="true" />
            <div>
              <p className="eyebrow">专注演练</p>
              <h2>{currentStageTitle(session)}</h2>
              <p>当前进度：<strong role="status" aria-live="polite">{sessionStatusLabels[session.status]}</strong></p>
            </div>
          </div>
        </div>
        <SessionTimer status={session.status} {...(session.timing === undefined ? {} : { timing: session.timing })} />
        <div className="session-topbar__controls">
          {isTerminalSession ? null : (
            <>
              {isBlockedSession ? null : (
                <>
                  <button type="button" onClick={() => command("pause")} disabled={session.status !== "running" || isBusy}>暂停</button>
                  <button type="button" onClick={() => command("resume")} disabled={session.status !== "paused" || isBusy}>继续</button>
                </>
              )}
              <button type="button" onClick={() => command("end")} disabled={!canEndSession}>结束演练</button>
            </>
          )}
          <button type="button" onClick={reload} disabled={isBusy}>刷新演练</button>
        </div>
        {isBusy ? <p role="status" className="inline-status">正在提交，请稍候。</p> : null}
      </header>

      <div className="session-focus-grid">
        <main className="session-conversation">
          <div className="session-start-chip" role="note">演练开始 · 全程本地进行，内容不上传</div>
          {failureSummary === undefined ? null : (
            <section aria-label="AI 失败恢复" className="status-card status-card--warning">
              <p role="alert">{failureSummary.message}</p>
              <p>失败次数：{failureSummary.failed_attempts}</p>
              <div className="control-row">
                {aiStep !== undefined && failureSummary.can_retry ? <button type="button" onClick={() => runAi(aiStep)} disabled={isBusy}>{failureSummary.action_label}</button> : null}
                <button type="button" onClick={reload} disabled={isBusy}>刷新演练</button>
                <button type="button" onClick={onReviewRequested} disabled={isBusy}>查看失败复盘</button>
                <button type="button" onClick={onSettingsRequested}>去模型配置</button>
              </div>
            </section>
          )}
          {isBlockedSession ? (
            <section aria-label="演练阻断状态" className="status-card status-card--warning">
              <p>当前阶段：{currentStageTitle(session)}</p>
              <p role="alert">{blockedSummary?.message ?? "运行时已阻断，请结束本次演练或刷新后查看最新状态。"}</p>
              <p>{session.view.next_user_action_label}</p>
            </section>
          ) : isTerminalSession ? (
            <section aria-label="演练完成状态" className="status-card">
              <p>当前阶段：{currentStageTitle(session)}</p>
              <p>{session.view.next_user_action_label}</p>
            </section>
          ) : null}
          <SessionTranscript
            entries={visibleTranscript(session)}
            disabled={isBusy}
            onFork={forkFromEntry}
            onWithdraw={withdrawEntry}
            {...(isBlockedSession ? { emptyMessage: "演练已阻断，当前没有可回看的可见发言。" } : {})}
          />
          {withdrawNotice === "" ? null : (
            <section aria-label="撤回结果" className="status-card">
              <p role="status">{withdrawNotice}</p>
              <button type="button" className="secondary-cta" onClick={() => setInput(lastWithdrawnInput)}>填回原回答</button>
            </section>
          )}
        </main>

        <aside className="session-context-panel">
          <section className="session-context-card">
            <h3>当前目标</h3>
            <p>当前阶段：{currentStageTitle(session)}</p>
            <p>当前发言者：{actorLabel}</p>
            <p>你现在可以做什么：{session.view.next_user_action_label}</p>
            <p>{sidebarActionHint(session)}</p>
          </section>
          {visibleToolResults.length === 0 ? null : (
            <section aria-label="可见工具结果" className="tool-result-card">
              <h3>工具结果摘要</h3>
              <ul className="compact-list">
                {visibleToolResults.map((result) => (
                  <li key={`${result.sequence}-${result.tool_id}`}>
                    {result.actor_name}：{result.summary}
                    <p>来源：{result.source_ref} · 可信度：{result.trust_level}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <BranchTreePanel
            tree={branchTree ?? null}
            onOpenSession={(sessionId) => onOpenBranch?.(sessionId)}
            onCreateReview={(sessionId) => onCreateBranchReview?.(sessionId)}
          />
        </aside>
      </div>

      <section aria-label="演练输入" className={`session-input-dock${canSubmitInput ? "" : " session-input-dock--idle"}`}>
        <div className="session-input-dock__body">
          {canSubmitInput ? (
            <div className="session-input-frame">
              <span className="session-input-mic" aria-hidden="true">⌕</span>
              <label className="session-input-dock__label">
                <span>你的回答</span>
                <textarea
                  className="session-input-dock__textarea"
                  value={input}
                  onChange={(event) => setInput(event.currentTarget.value)}
                  rows={3}
                  cols={70}
                  disabled={!canSubmitInput}
                />
              </label>
              <button type="button" aria-label="提交回答" className="session-send-button" onClick={submitInput} disabled={!canSubmitInput}>发送</button>
            </div>
          ) : (
            <p className="session-input-dock__hint" role={isBusy ? "status" : undefined}>{inputDockHint}</p>
          )}
          {aiStep !== undefined && failureSummary === undefined && !isTerminalSession ? (
            <button type="button" className="primary-cta" onClick={() => runAi(aiStep)} disabled={isBusy}>让 AI 提问</button>
          ) : null}
          {isTerminalSession ? <button type="button" onClick={onReviewRequested} disabled={isBusy}>查看复盘</button> : null}
        </div>
      </section>
    </section>
  );
}
