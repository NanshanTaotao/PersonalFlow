import type {
  ApiFailure,
  ApiResult,
  AiTurnObservabilityView,
  BranchTreeView,
  CreateForkResponseView,
  DraftView,
  JsonObject,
  MaterialVisibilityInput,
  MaterialSummaryView,
  ModelConfigListView,
  ModelConfigView,
  RecentWorkView,
  ReviewReport,
  ScenarioCheckResult,
  SceneArchiveSummary,
  SceneExportResponse,
  SceneImportResponse,
  SceneView,
  SessionCommandPayload,
  SessionHistoryView,
  SessionView,
  TemplateDetail,
  TemplateSummary,
  WithdrawUserInputResponseView
} from "./types";

export interface ModelConfigInput {
  readonly provider: string;
  readonly base_url: string;
  readonly model: string;
  readonly display_name: string;
  readonly api_key: string;
  readonly idempotency_key?: string;
}

export interface ModelConfigPatchInput {
  readonly provider?: string;
  readonly base_url?: string;
  readonly model?: string;
  readonly display_name?: string;
  readonly api_key?: string;
  readonly idempotency_key?: string;
}

export interface ComplexScenarioConfigInput {
  readonly title: string;
  readonly goal: string;
  readonly user_role: string;
  readonly ai_roles: ReadonlyArray<{
    readonly name: string;
    readonly focus: string;
  }>;
  readonly stages: ReadonlyArray<{
    readonly name: string;
    readonly rounds: number;
    readonly follow_up_strategy: string;
  }>;
  readonly termination: string;
  readonly idempotency_key?: string;
}

export interface ApiClient {
  getRecent(): Promise<ApiResult<RecentWorkView>>;
  listMaterials(): Promise<ApiResult<{ materials: MaterialSummaryView[] }>>;
  createMaterial(input: { title: string; text: string; source?: string; idempotency_key?: string }): Promise<ApiResult<{ material: MaterialSummaryView }>>;
  listTemplates(): Promise<ApiResult<{ templates: TemplateSummary[] }>>;
  getTemplate(templateId: string): Promise<ApiResult<{ template: TemplateDetail }>>;
  createDraftFromTemplate(input: { template_id: string; params: JsonObject; idempotency_key?: string }): Promise<ApiResult<{ draft: DraftView }>>;
  createDraftFromComplexConfig(input: ComplexScenarioConfigInput): Promise<ApiResult<{ draft: DraftView }>>;
  getDraft(draftId: string): Promise<ApiResult<{ draft: DraftView }>>;
  checkDraft(draftId: string): Promise<ApiResult<ScenarioCheckResult & { draft: DraftView }>>;
  attachMaterialToDraft(draftId: string, materialId: string, idempotencyKey?: string): Promise<ApiResult<{ draft: DraftView }>>;
  attachTemporaryTextMaterialToDraft(draftId: string, input: { title: string; text: string; idempotency_key?: string }): Promise<ApiResult<{ draft: DraftView }>>;
  updateDraftMaterialVisibility(draftId: string, input: { source_ref: string; visibility: MaterialVisibilityInput; idempotency_key?: string }): Promise<ApiResult<{ draft: DraftView }>>;
  confirmDraft(draftId: string, idempotencyKey?: string): Promise<ApiResult<{ scene: SceneView }>>;
  exportScene(sceneId: string): Promise<ApiResult<SceneExportResponse>>;
  importScene(exportJson: unknown, idempotencyKey?: string): Promise<ApiResult<SceneImportResponse>>;
  copyScene(sceneId: string, idempotencyKey?: string): Promise<ApiResult<{ draft: DraftView }>>;
  renameScene(sceneId: string, title: string, idempotencyKey?: string): Promise<ApiResult<{ scene: SceneView }>>;
  deleteScene(sceneId: string, idempotencyKey?: string): Promise<ApiResult<{ deleted: boolean; message: string }>>;
  listSceneArchive(): Promise<ApiResult<{ scenes: SceneArchiveSummary[] }>>;
  startSession(sceneId: string, idempotencyKey?: string): Promise<ApiResult<{ session: SessionView }>>;
  getSession(sessionId: string): Promise<ApiResult<{ session: SessionView }>>;
  getBranchTree(sessionId: string): Promise<ApiResult<{ tree: BranchTreeView }>>;
  createFork(sessionId: string, input: { fork_point_event_id: string; include_selected_event?: boolean; branch_label?: string; idempotency_key?: string }): Promise<ApiResult<CreateForkResponseView>>;
  withdrawUserInput(sessionId: string, input: { user_event_id: string; branch_label?: string; idempotency_key?: string }): Promise<ApiResult<WithdrawUserInputResponseView>>;
  getSessionHistory(sessionId: string): Promise<ApiResult<{ history: SessionHistoryView }>>;
  submitUserInput(sessionId: string, input: { input: string; expected_state_version: number; idempotency_key?: string }): Promise<ApiResult<{ session: SessionView }>>;
  runAiTurn(sessionId: string, input: { actor_id: string; expected_state_version: number; model_config_id?: string; idempotency_key?: string }): Promise<ApiResult<{ session: SessionView; ai_turn_observability: AiTurnObservabilityView }>>;
  pauseSession(sessionId: string, payload: SessionCommandPayload): Promise<ApiResult<{ session: SessionView }>>;
  resumeSession(sessionId: string, payload: SessionCommandPayload): Promise<ApiResult<{ session: SessionView }>>;
  endSession(sessionId: string, payload: SessionCommandPayload): Promise<ApiResult<{ session: SessionView }>>;
  listModelConfigs(): Promise<ApiResult<ModelConfigListView>>;
  createModelConfig(input: ModelConfigInput): Promise<ApiResult<{ model_config: ModelConfigView }>>;
  patchModelConfig(modelConfigId: string, input: ModelConfigPatchInput): Promise<ApiResult<{ model_config: ModelConfigView }>>;
  setDefaultModelConfig(modelConfigId: string, idempotencyKey?: string): Promise<ApiResult<{ model_config: ModelConfigView; default_model_config_id: string }>>;
  deleteModelConfig(modelConfigId: string, idempotencyKey?: string, reason?: string): Promise<ApiResult<{ deleted: boolean }>>;
  testModelConfig(modelConfigId: string, idempotencyKey?: string): Promise<ApiResult<{ ok: boolean; provider: string; base_url: string; model: string; provider_reachable?: boolean; auth_valid?: boolean; json_parseable?: boolean; protocol_valid?: boolean; message?: string }>>;
  createReview(sessionId: string, idempotencyKey?: string): Promise<ApiResult<{ review: ReviewReport }>>;
  getReview(reviewId: string): Promise<ApiResult<{ review: ReviewReport }>>;
  retryReview(reviewId: string, idempotencyKey?: string): Promise<ApiResult<{ review: ReviewReport }>>;
  repracticeReview(reviewId: string, idempotencyKey?: string): Promise<ApiResult<{ session: SessionView }>>;
}

const productError = (message: string, code = "network_error"): ApiFailure => ({ code, message });

const isApiFailureBody = (value: unknown): value is { error: { code?: string; message?: string } } => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  return error !== null && typeof error === "object";
};

export class ProductApiClient implements ApiClient {
  constructor(private readonly baseUrl = "") {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
    try {
      const response = await fetch(this.baseUrl + path, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options.headers ?? {})
        }
      });
      const body = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        if (isApiFailureBody(body)) {
          return { ok: false, error: productError(body.error.message ?? "请求失败。", body.error.code ?? "api_error") };
        }
        return { ok: false, error: productError("请求失败，请刷新后重试。", "api_error") };
      }
      return { ok: true, data: body as T };
    } catch {
      return { ok: false, error: productError("无法连接本地 PersonalFlow API，请确认服务已启动。") };
    }
  }

  getRecent() { return this.request<RecentWorkView>("/api/recent"); }
  listMaterials() { return this.request<{ materials: MaterialSummaryView[] }>("/api/materials"); }
  createMaterial(input: { title: string; text: string; source?: string; idempotency_key?: string }) { return this.request<{ material: MaterialSummaryView }>("/api/materials", { method: "POST", body: JSON.stringify(input) }); }
  listTemplates() { return this.request<{ templates: TemplateSummary[] }>("/api/templates"); }
  getTemplate(templateId: string) { return this.request<{ template: TemplateDetail }>(`/api/templates/${encodeURIComponent(templateId)}`); }
  createDraftFromTemplate(input: { template_id: string; params: JsonObject; idempotency_key?: string }) { return this.request<{ draft: DraftView }>("/api/drafts/from-template", { method: "POST", body: JSON.stringify(input) }); }
  createDraftFromComplexConfig(input: ComplexScenarioConfigInput) { return this.request<{ draft: DraftView }>("/api/drafts/from-complex-config", { method: "POST", body: JSON.stringify(input) }); }
  getDraft(draftId: string) { return this.request<{ draft: DraftView }>(`/api/drafts/${encodeURIComponent(draftId)}`); }
  checkDraft(draftId: string) { return this.request<ScenarioCheckResult & { draft: DraftView }>(`/api/drafts/${encodeURIComponent(draftId)}/check`, { method: "POST", body: JSON.stringify({}) }); }
  attachMaterialToDraft(draftId: string, materialId: string, idempotencyKey?: string) { return this.request<{ draft: DraftView }>(`/api/drafts/${encodeURIComponent(draftId)}/materials`, { method: "POST", body: JSON.stringify({ kind: "library", material_id: materialId, idempotency_key: idempotencyKey }) }); }
  attachTemporaryTextMaterialToDraft(draftId: string, input: { title: string; text: string; idempotency_key?: string }) { return this.request<{ draft: DraftView }>(`/api/drafts/${encodeURIComponent(draftId)}/materials`, { method: "POST", body: JSON.stringify({ kind: "temporary_text", ...input }) }); }
  updateDraftMaterialVisibility(draftId: string, input: { source_ref: string; visibility: MaterialVisibilityInput; idempotency_key?: string }) { return this.request<{ draft: DraftView }>(`/api/drafts/${encodeURIComponent(draftId)}/materials/visibility`, { method: "PATCH", body: JSON.stringify(input) }); }
  confirmDraft(draftId: string, idempotencyKey?: string) { return this.request<{ scene: SceneView }>(`/api/drafts/${encodeURIComponent(draftId)}/confirm`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  exportScene(sceneId: string) { return this.request<SceneExportResponse>(`/api/scenes/${encodeURIComponent(sceneId)}/export`); }
  importScene(exportJson: unknown, idempotencyKey?: string) { return this.request<SceneImportResponse>("/api/scenes/import", { method: "POST", body: JSON.stringify({ export_json: exportJson, idempotency_key: idempotencyKey }) }); }
  copyScene(sceneId: string, idempotencyKey?: string) { return this.request<{ draft: DraftView }>(`/api/scenes/${encodeURIComponent(sceneId)}/copy`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  renameScene(sceneId: string, title: string, idempotencyKey?: string) { return this.request<{ scene: SceneView }>(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: "PATCH", body: JSON.stringify({ title, idempotency_key: idempotencyKey }) }); }
  deleteScene(sceneId: string, idempotencyKey?: string) { return this.request<{ deleted: boolean; message: string }>(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: "DELETE", body: JSON.stringify({ idempotency_key: idempotencyKey, confirm: true }) }); }
  listSceneArchive() { return this.request<{ scenes: SceneArchiveSummary[] }>("/api/scenes/archive"); }
  startSession(sceneId: string, idempotencyKey?: string) { return this.request<{ session: SessionView }>(`/api/scenes/${encodeURIComponent(sceneId)}/sessions`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  getSession(sessionId: string) { return this.request<{ session: SessionView }>(`/api/sessions/${encodeURIComponent(sessionId)}`); }
  getBranchTree(sessionId: string) { return this.request<{ tree: BranchTreeView }>(`/api/sessions/${encodeURIComponent(sessionId)}/branch-tree`); }
  createFork(sessionId: string, input: { fork_point_event_id: string; include_selected_event?: boolean; branch_label?: string; idempotency_key?: string }) { return this.request<CreateForkResponseView>(`/api/sessions/${encodeURIComponent(sessionId)}/forks`, { method: "POST", body: JSON.stringify(input) }); }
  withdrawUserInput(sessionId: string, input: { user_event_id: string; branch_label?: string; idempotency_key?: string }) { return this.request<WithdrawUserInputResponseView>(`/api/sessions/${encodeURIComponent(sessionId)}/withdraw`, { method: "POST", body: JSON.stringify(input) }); }
  getSessionHistory(sessionId: string) { return this.request<{ history: SessionHistoryView }>(`/api/sessions/${encodeURIComponent(sessionId)}/history`); }
  submitUserInput(sessionId: string, input: { input: string; expected_state_version: number; idempotency_key?: string }) { return this.request<{ session: SessionView }>(`/api/sessions/${encodeURIComponent(sessionId)}/input`, { method: "POST", body: JSON.stringify(input) }); }
  runAiTurn(sessionId: string, input: { actor_id: string; expected_state_version: number; model_config_id?: string; idempotency_key?: string }) { return this.request<{ session: SessionView; ai_turn_observability: AiTurnObservabilityView }>(`/api/sessions/${encodeURIComponent(sessionId)}/ai-turn`, { method: "POST", body: JSON.stringify(input) }); }
  pauseSession(sessionId: string, payload: SessionCommandPayload) { return this.request<{ session: SessionView }>(`/api/sessions/${encodeURIComponent(sessionId)}/pause`, { method: "POST", body: JSON.stringify(payload) }); }
  resumeSession(sessionId: string, payload: SessionCommandPayload) { return this.request<{ session: SessionView }>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, { method: "POST", body: JSON.stringify(payload) }); }
  endSession(sessionId: string, payload: SessionCommandPayload) { return this.request<{ session: SessionView }>(`/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST", body: JSON.stringify(payload) }); }
  listModelConfigs() { return this.request<ModelConfigListView>("/api/model-configs"); }
  createModelConfig(input: ModelConfigInput) { return this.request<{ model_config: ModelConfigView }>("/api/model-configs", { method: "POST", body: JSON.stringify(input) }); }
  patchModelConfig(modelConfigId: string, input: ModelConfigPatchInput) { return this.request<{ model_config: ModelConfigView }>(`/api/model-configs/${encodeURIComponent(modelConfigId)}`, { method: "PATCH", body: JSON.stringify(input) }); }
  setDefaultModelConfig(modelConfigId: string, idempotencyKey?: string) { return this.request<{ model_config: ModelConfigView; default_model_config_id: string }>(`/api/model-configs/${encodeURIComponent(modelConfigId)}/default`, { method: "PATCH", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  deleteModelConfig(modelConfigId: string, idempotencyKey?: string, reason?: string) { return this.request<{ deleted: boolean }>(`/api/model-configs/${encodeURIComponent(modelConfigId)}`, { method: "DELETE", body: JSON.stringify({ idempotency_key: idempotencyKey, reason }) }); }
  testModelConfig(modelConfigId: string, idempotencyKey?: string) { return this.request<{ ok: boolean; provider: string; base_url: string; model: string; provider_reachable?: boolean; auth_valid?: boolean; json_parseable?: boolean; protocol_valid?: boolean; message?: string }>(`/api/model-configs/${encodeURIComponent(modelConfigId)}/test`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  createReview(sessionId: string, idempotencyKey?: string) { return this.request<{ review: ReviewReport }>(`/api/sessions/${encodeURIComponent(sessionId)}/reviews`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  getReview(reviewId: string) { return this.request<{ review: ReviewReport }>(`/api/reviews/${encodeURIComponent(reviewId)}`); }
  retryReview(reviewId: string, idempotencyKey?: string) { return this.request<{ review: ReviewReport }>(`/api/reviews/${encodeURIComponent(reviewId)}/retry`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
  repracticeReview(reviewId: string, idempotencyKey?: string) { return this.request<{ session: SessionView }>(`/api/reviews/${encodeURIComponent(reviewId)}/repractice`, { method: "POST", body: JSON.stringify({ idempotency_key: idempotencyKey }) }); }
}

export const apiClient = new ProductApiClient();
