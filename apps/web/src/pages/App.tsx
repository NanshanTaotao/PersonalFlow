import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { apiClient, type ApiClient } from "../api/client";
import type { AiTurnObservabilityView, ApiFailure, BranchTreeView, DraftView, MaterialSummaryView, ModelConfigView, RecentWorkView, ReviewReport, SceneArchiveSummary, SceneView, SessionHistoryView, SessionView, TemplateDetail, TemplateSummary } from "../api/types";
import { Layout, type PageKey } from "../components/Layout";
import { DebugPage } from "./DebugPage";
import { HomePage } from "./HomePage";
import { ImportExportPage } from "./ImportExportPage";
import { MaterialsPage } from "./MaterialsPage";
import { ReviewPage } from "./ReviewPage";
import { SceneConfirmPage } from "./SceneConfirmPage";
import { SceneManagementPage } from "./SceneManagementPage";
import { ScenarioBuilderPage } from "./ScenarioBuilderPage";
import { SessionHistoryPage } from "./SessionHistoryPage";
import { SessionPage } from "./SessionPage";
import { initialSettingsState, SettingsPage, settingsReducer } from "./SettingsPage";
import { TemplatePage } from "./TemplatePage";

export const selectRestoredModelConfig = (result: Awaited<ReturnType<ApiClient["listModelConfigs"]>>): ModelConfigView | null =>
  result.ok && result.data !== undefined
    ? result.data.model_configs.find((modelConfig) => modelConfig.id === result.data?.default_model_config_id) ?? result.data.model_configs[0] ?? null
    : null;

const emptyRecentWork: RecentWorkView = { drafts: [], scenes: [], sessions: [], reviews: [] };

export function NoticeMessage({ message }: { readonly message: string }) {
  return <p role="status" aria-live="polite">{message}</p>;
}

export type NoticeScope = "draft" | "scene-copy" | "global";

export interface ScopedNotice {
  readonly scope: NoticeScope;
  readonly message: string;
}

export const nextNoticeForPage = (notice: ScopedNotice | null, page: PageKey): ScopedNotice | null => {
  if (notice === null) {
    return null;
  }
  if (notice.scope === "global") {
    return notice;
  }
  if (notice.scope === "draft") {
    return page === "scene" ? notice : null;
  }
  return page === "scene" ? notice : null;
};

export function App({ api = apiClient }: { readonly api?: ApiClient }) {
  const [page, setPage] = useState<PageKey>("home");
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [scene, setScene] = useState<SceneView | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [review, setReview] = useState<ReviewReport | null>(null);
  const [autoGenerateReview, setAutoGenerateReview] = useState(false);
  const [recent, setRecent] = useState<RecentWorkView>(emptyRecentWork);
  const [sceneArchive, setSceneArchive] = useState<SceneArchiveSummary[]>([]);
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryView | null>(null);
  const [branchTree, setBranchTree] = useState<BranchTreeView | null>(null);
  const [sessionHistoryStatus, setSessionHistoryStatus] = useState<"loading" | "ready" | "failed">("ready");
  const [sessionHistoryError, setSessionHistoryError] = useState("");
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);
  const [materials, setMaterials] = useState<MaterialSummaryView[]>([]);
  const [materialsStatus, setMaterialsStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [materialsMessage, setMaterialsMessage] = useState("");
  const [recentStatus, setRecentStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [recentError, setRecentError] = useState("");
  const [aiTurnObservability, setAiTurnObservability] = useState<AiTurnObservabilityView | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfigView | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<ScopedNotice | null>(null);
  const [suppressNextSceneCheckNotice, setSuppressNextSceneCheckNotice] = useState(false);
  const [settings, dispatchSettings] = useReducer(settingsReducer, initialSettingsState);
  const sessionHistoryRequestVersion = useRef(0);

  const goToPage = useCallback((next: PageKey) => {
    setError(null);
    setNotice((current) => nextNoticeForPage(current, next));
    if (next === "history") {
      sessionHistoryRequestVersion.current += 1;
      setSessionHistory(null);
      setSelectedHistorySessionId(null);
      setSessionHistoryStatus("ready");
      setSessionHistoryError("");
      setBranchTree(null);
    }
    if (next === "template") {
      setTemplate(null);
      setParams({});
    }
    setPage(next);
  }, []);

  const handleSettingsSaved = useCallback(() => {
    setError(null);
  }, []);

  const handleDefaultModelConfigChanged = useCallback((next: ModelConfigView | null) => {
    setModelConfig(next);
    setError(null);
  }, []);

  const refreshRecent = useCallback(async () => {
    setRecentStatus("loading");
    const result = await api.getRecent();
    if (result.ok && result.data !== undefined) {
      setRecent(result.data);
      setRecentStatus("ready");
      setRecentError("");
      return;
    }
    setRecentStatus("failed");
    setRecentError(result.error?.message ?? "最近记录读取失败，请刷新后重试。");
  }, [api]);

  const refreshSceneArchive = useCallback(async () => {
    const result = await api.listSceneArchive();
    if (result.ok && result.data !== undefined) {
      setSceneArchive(result.data.scenes);
    }
  }, [api]);

  const refreshBranchTree = useCallback(async (sessionId: string, expectedHistoryRequestVersion?: number) => {
    const result = await api.getBranchTree(sessionId);
    if (expectedHistoryRequestVersion !== undefined && sessionHistoryRequestVersion.current !== expectedHistoryRequestVersion) {
      return;
    }
    if (result.ok && result.data !== undefined) {
      setBranchTree(result.data.tree);
    }
  }, [api]);

  useEffect(() => {
    void api.listTemplates().then((result) => {
      if (result.ok && result.data !== undefined) {
        setTemplates(result.data.templates);
      } else {
        setError(result.error ?? { code: "api_error", message: "模板列表读取失败。" });
      }
    });
  }, [api]);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  useEffect(() => {
    void refreshSceneArchive();
  }, [refreshSceneArchive]);

  useEffect(() => {
    if (page === "sceneManagement") {
      void refreshSceneArchive();
    }
  }, [page, refreshSceneArchive]);

  useEffect(() => {
    void api.listMaterials().then((result) => {
      if (result.ok && result.data !== undefined) {
        setMaterials(result.data.materials);
        setMaterialsStatus("ready");
        return;
      }
      setMaterialsStatus("failed");
    });
  }, [api]);

  useEffect(() => {
    void api.listModelConfigs().then((result) => {
      const restored = selectRestoredModelConfig(result);
      if (result.ok && result.data !== undefined) {
        dispatchSettings({ type: "listSucceeded", modelConfigs: result.data.model_configs, defaultModelConfigId: result.data.default_model_config_id });
      }
      if (restored !== null) {
        setModelConfig(restored);
      }
    });
  }, [api]);

  const selectTemplate = async (templateId: string) => {
    setError(null);
    const result = await api.getTemplate(templateId);
    if (!result.ok || result.data === undefined) {
      setError(result.error ?? { code: "api_error", message: "模板详情读取失败。" });
      return;
    }
    setTemplate(result.data.template);
    setParams(Object.fromEntries(Object.entries(result.data.template.default_params).map(([key, value]) => [key, String(value)])));
    setPage("template");
  };

  const openRecentDraft = async (draftId: string, options: { readonly suppressCheckNotice?: boolean } = {}) => {
    setError(null);
    setSuppressNextSceneCheckNotice(options.suppressCheckNotice ?? false);
    const result = await api.getDraft(draftId);
    if (!result.ok || result.data === undefined) {
      setSuppressNextSceneCheckNotice(false);
      setError(result.error ?? { code: "api_error", message: "草稿恢复失败，请刷新后重试。" });
      return;
    }
    setDraft(result.data.draft);
    setScene(null);
    setPage("scene");
  };

  const openRecentSession = async (sessionId: string) => {
    setError(null);
    const result = await api.getSession(sessionId);
    if (!result.ok || result.data === undefined) {
      setError(result.error ?? { code: "api_error", message: "演练恢复失败，请刷新后重试。" });
      return;
    }
    setSession(result.data.session);
    void refreshBranchTree(result.data.session.id);
    setReview(null);
    setAutoGenerateReview(false);
    setPage("session");
  };

  const createReviewFromHistory = async (sessionId: string) => {
    setError(null);
    const result = await api.getSession(sessionId);
    if (!result.ok || result.data === undefined) {
      setError(result.error ?? { code: "api_error", message: "演练恢复失败，请刷新后重试。" });
      return;
    }
    setSession(result.data.session);
    setReview(null);
    setAutoGenerateReview(true);
    setPage("review");
  };

  const openSessionHistory = async (sessionId: string) => {
    setError(null);
    const requestVersion = sessionHistoryRequestVersion.current + 1;
    sessionHistoryRequestVersion.current = requestVersion;
    setSelectedHistorySessionId(sessionId);
    setSessionHistoryStatus("loading");
    setPage("history");
    setBranchTree(null);
    void refreshBranchTree(sessionId, requestVersion);
    const result = await api.getSessionHistory(sessionId);
    if (sessionHistoryRequestVersion.current !== requestVersion) {
      return;
    }
    if (!result.ok || result.data === undefined) {
      setSessionHistory(null);
      setSelectedHistorySessionId(null);
      setSessionHistoryStatus("failed");
      setSessionHistoryError(result.error?.message ?? "练习详情读取失败，请刷新后重试。");
      return;
    }
    setSessionHistory(result.data.history);
    setSessionHistoryStatus("ready");
    setSessionHistoryError("");
  };

  const openRecentReview = async (reviewId: string) => {
    setError(null);
    const result = await api.getReview(reviewId);
    if (!result.ok || result.data === undefined) {
      setError(result.error ?? { code: "api_error", message: "复盘读取失败，请刷新后重试。" });
      return;
    }
    setReview(result.data.review);
    setAutoGenerateReview(false);
    setPage("review");
  };

  const content = useMemo(() => {
    switch (page) {
      case "home":
        return (
          <HomePage
            templates={templates}
            session={session}
            recent={recent}
            recentStatus={recentStatus}
            recentError={recentError}
            onSelectTemplate={selectTemplate}
            onContinueSession={() => goToPage("session")}
            onOpenRecentDraft={openRecentDraft}
            onOpenRecentSession={openSessionHistory}
            onOpenRecentReview={openRecentReview}
            onGoToImport={() => goToPage("importExport")}
            onGoToSettings={() => goToPage("settings")}
            onGoToMaterials={() => goToPage("materials")}
            onGoToSceneManagement={() => goToPage("sceneManagement")}
          />
        );
      case "settings":
        return <SettingsPage state={settings} dispatch={dispatchSettings} api={api} onSaved={handleSettingsSaved} onDefaultChanged={handleDefaultModelConfigChanged} onError={setError} />;
      case "materials":
        return <MaterialsPage materials={materials} status={materialsStatus} message={materialsMessage} api={api} onMaterialsChanged={(next, message) => { setMaterials(next); setMaterialsStatus("ready"); setMaterialsMessage(message); setError(null); }} onError={setError} />;
      case "sceneManagement":
        return <SceneManagementPage recent={recent} archive={sceneArchive} status={recentStatus} api={api} onOpenDraft={openRecentDraft} onOpenSessionHistory={openSessionHistory} onOpenReview={openRecentReview} onOpenScenarioBuilder={() => goToPage("scenarioBuilder")} onSceneCopied={(draftId, message) => { setNotice({ scope: "scene-copy", message }); void openRecentDraft(draftId, { suppressCheckNotice: true }); void refreshRecent(); void refreshSceneArchive(); }} onSceneRenamed={(message) => { setNotice({ scope: "global", message }); void refreshRecent(); void refreshSceneArchive(); }} onSceneDeleted={(message) => { setNotice({ scope: "global", message }); void refreshRecent(); void refreshSceneArchive(); }} onError={setError} />;
      case "scenarioBuilder":
        return <ScenarioBuilderPage api={api} onDraftCreated={(next) => { setDraft(next); setScene(null); setNotice({ scope: "draft", message: "复杂场景草稿已生成，请完成检查后开始演练。" }); void refreshRecent(); goToPage("scene"); }} onError={setError} />;
      case "template":
        return <TemplatePage template={template} templates={templates} params={params} onParamChange={(key, value) => setParams((current) => ({ ...current, [key]: value }))} onSelectTemplate={(templateId) => { void selectTemplate(templateId); }} api={api} onDraftCreated={(next) => { setDraft(next); setScene(null); setNotice({ scope: "draft", message: "草稿已创建。" }); void refreshRecent(); goToPage("scene"); }} onError={setError} creationError={error} />;
      case "scene":
        return <SceneConfirmPage draft={draft} scene={scene} api={api} modelConfig={modelConfig} materials={materials} onMaterialAttached={(nextDraft, message) => { setDraft(nextDraft); setNotice({ scope: "draft", message }); }} onChecked={(message) => {
          if (suppressNextSceneCheckNotice) {
            setSuppressNextSceneCheckNotice(false);
            return;
          }
          setNotice({ scope: "draft", message });
        }} onStarted={(nextScene, nextSession) => { setScene(nextScene); setSession(nextSession); setReview(null); setAutoGenerateReview(false); setNotice(null); setError(null); void refreshBranchTree(nextSession.id); void refreshRecent(); goToPage("session"); }} onError={setError} onGoToSettings={() => goToPage("settings")} />;
      case "session":
        return <SessionPage session={session} api={api} {...(modelConfig === null ? {} : { modelConfigId: modelConfig.id })} branchTree={branchTree} onSessionUpdated={(next) => { setSession(next); setError(null); void refreshBranchTree(next.id); }} onAiTurnObserved={setAiTurnObservability} onReviewRequested={() => { setAutoGenerateReview(true); goToPage("review"); }} onExit={() => goToPage("home")} onSettingsRequested={() => goToPage("settings")} onSessionForked={(next) => { setSession(next); setError(null); void refreshBranchTree(next.id); void refreshRecent(); }} onBranchTreeChanged={() => undefined} onOpenBranch={(sessionId) => { void openRecentSession(sessionId); void refreshBranchTree(sessionId); }} onCreateBranchReview={(sessionId) => { void createReviewFromHistory(sessionId); }} onError={setError} />;
      case "history":
        return <SessionHistoryPage history={sessionHistory} status={sessionHistoryStatus} error={sessionHistoryError} archive={{ sessions: recent.sessions, reviews: recent.reviews }} branchTree={branchTree} onOpenReview={(reviewId) => { void openRecentReview(reviewId); }} onOpenSessionArchive={(sessionId) => { void openSessionHistory(sessionId); }} {...(selectedHistorySessionId === null ? {} : { onContinue: () => { void openRecentSession(selectedHistorySessionId); }, onCreateReview: () => { void createReviewFromHistory(selectedHistorySessionId); } })} onOpenBranch={(sessionId) => { void openRecentSession(sessionId); void refreshBranchTree(sessionId); }} onCreateBranchReview={(sessionId) => { void createReviewFromHistory(sessionId); }} onRepractice={() => goToPage("sceneManagement")} />;
      case "review":
        return <ReviewPage session={session} review={review} autoGenerate={autoGenerateReview} api={api} onReviewUpdated={(next) => { setReview(next); setAutoGenerateReview(false); setError(null); void refreshRecent(); void refreshSceneArchive(); }} onRepracticeStarted={(nextSession) => { setSession(nextSession); setReview(null); setAutoGenerateReview(false); setNotice({ scope: "global", message: "已创建新的练习。" }); setError(null); void refreshBranchTree(nextSession.id); void refreshRecent(); goToPage("session"); }} onError={setError} />;
      case "importExport":
        return <ImportExportPage scene={scene} api={api} onImported={(next) => { setScene(next); setDraft(null); setSession(null); setReview(null); setError(null); void refreshRecent(); }} onGoToScene={() => goToPage("scene")} onError={setError} />;
      case "debug":
        return <DebugPage draft={draft} scene={scene} session={session} review={review} aiTurnObservability={aiTurnObservability} />;
    }
  }, [aiTurnObservability, api, autoGenerateReview, branchTree, draft, goToPage, handleDefaultModelConfigChanged, handleSettingsSaved, materials, materialsMessage, materialsStatus, modelConfig, page, params, recent, recentError, recentStatus, refreshBranchTree, refreshRecent, refreshSceneArchive, review, scene, sceneArchive, selectedHistorySessionId, session, sessionHistory, sessionHistoryError, sessionHistoryStatus, settings, template, templates]);

  if (page === "session") {
    return (
      <main className="session-route-shell">
        {notice === null ? null : <NoticeMessage message={notice.message} />}
        {error === null ? null : (
          <section role="alert" className="app-alert app-alert--session">
            <strong>提示</strong>：{error.message}
          </section>
        )}
        {content}
      </main>
    );
  }

  return (
    <Layout currentPage={page} session={session} error={error} onNavigate={goToPage}>
      {notice === null ? null : <NoticeMessage message={notice.message} />}
      {content}
    </Layout>
  );
}
