export interface ApiFailure {
  readonly code: string;
  readonly message: string;
}

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: ApiFailure;
}

export interface TemplateSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface TemplateDetail extends TemplateSummary {
  readonly param_schema: JsonSchemaObject;
  readonly default_params: JsonObject;
  readonly preview_metadata?: JsonObject;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonSchemaObject {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchemaProperty>;
  readonly required?: string[];
  readonly additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  readonly type?: string;
  readonly label?: string;
  readonly title?: string;
  readonly description?: string;
  readonly default?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
}

export interface PreviewValue {
  readonly value: string;
  readonly is_default: boolean;
}

export type MaterialSourceType = "library_text" | "temporary_text" | "future_file";
export type MaterialVisibilityAccess = "full" | "summary" | "hidden";
export type MaterialVisibilityMode = "all_stages" | "per_stage";

export interface MaterialVisibilityEntryView {
  readonly role_id: string;
  readonly stage_id?: string;
  readonly access: MaterialVisibilityAccess;
}

export interface MaterialVisibilityInput {
  readonly mode: MaterialVisibilityMode;
  readonly entries: readonly MaterialVisibilityEntryView[];
}

export interface AttachedMaterialVisibilityPreview extends MaterialVisibilityInput {
  readonly source_ref: string;
  readonly material_key: string;
  readonly summary_label: string;
}

export interface PreviewListItem extends PreviewValue {
  readonly label: string;
  readonly source_label?: string;
  readonly source_ref?: string;
  readonly source_type?: MaterialSourceType;
  readonly visibility?: AttachedMaterialVisibilityPreview;
}

export interface TemplatePreview {
  readonly title?: PreviewValue;
  readonly goal?: PreviewValue;
  readonly user_role?: PreviewValue;
  readonly ai_role?: PreviewValue;
  readonly flow?: PreviewListItem[];
  readonly materials?: PreviewListItem[];
  readonly attached_materials?: PreviewListItem[];
  readonly review_method?: PreviewValue;
  readonly estimated_duration?: PreviewValue;
  readonly pressure_level?: PreviewValue;
  readonly ready_summary?: PreviewValue;
  readonly notes?: PreviewListItem[];
  readonly quality?: ScenarioCheckResult;
}

export interface ScenarioSemanticPreview {
  readonly title: string;
  readonly roles: Array<{ readonly title: string; readonly kind: string; readonly goal: string }>;
  readonly stages: Array<{ readonly title: string; readonly goal: string; readonly roles: string[]; readonly tools: string[] }>;
  readonly visibility: Array<{ readonly subject: string; readonly target: string; readonly access: string }>;
  readonly review_dimensions: Array<{ readonly title: string; readonly evidence_requirement: string }>;
  readonly quality: ScenarioCheckResult;
}

export interface DraftView {
  readonly id: string;
  readonly template_id: string | null;
  readonly preview?: TemplatePreview;
  readonly semantic_preview?: ScenarioSemanticPreview;
  readonly visibility_options?: {
    readonly roles: readonly {
      readonly id: string;
      readonly display_name: string;
      readonly kind: "user" | "ai";
    }[];
    readonly stages: readonly {
      readonly id: string;
      readonly title: string;
    }[];
  };
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ScenarioCheckIssue {
  readonly severity: "warning" | "blocked";
  readonly title: string;
  readonly message: string;
  readonly suggestion: string;
}

export interface ScenarioCheckResult {
  readonly status: "ready" | "warning" | "blocked";
  readonly ok: boolean;
  readonly issues: ScenarioCheckIssue[];
}

export interface SceneView {
  readonly id: string;
  readonly draft_id: string | null;
  readonly source_template_id: string;
  readonly title: string;
  readonly normalized_hash: string;
  readonly created_at: string;
}

export interface SceneExportResponse {
  readonly export_json: unknown;
}

export interface SceneImportResponse {
  readonly scene: SceneView;
}

export interface RecentDraftSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "draft";
  readonly template_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecentSceneSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "confirmed";
  readonly draft_id: string | null;
  readonly scenario_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecentSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "running" | "paused" | "completed" | "ended" | "failed" | "blocked";
  readonly status_label?: string;
  readonly scenario_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecentReviewSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly session_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecentWorkView {
  readonly drafts: RecentDraftSummary[];
  readonly scenes: RecentSceneSummary[];
  readonly sessions: RecentSessionSummary[];
  readonly reviews: RecentReviewSummary[];
}

export interface SessionHistoryView {
  readonly title: string;
  readonly status: RecentSessionSummary["status"];
  readonly status_label?: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly rounds: number;
  readonly model_summary: {
    readonly label: string;
    readonly mode: "fake" | "real";
  };
  readonly scene: {
    readonly title: string;
    readonly archived: boolean;
  };
  readonly transcript: Array<{
    readonly sequence: number;
    readonly speaker: string;
    readonly text: string;
  }>;
  readonly reviews: Array<{
    readonly id: string;
    readonly title: string;
    readonly status: RecentReviewSummary["status"];
    readonly status_label?: string;
  }>;
}

export interface SceneArchiveSummary {
  readonly id: string;
  readonly title: string;
  readonly archived: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly session_count: number;
  readonly review_count: number;
  readonly latest_session: Omit<RecentSessionSummary, "scenario_id"> | null;
  readonly latest_review: Omit<RecentReviewSummary, "session_id"> | null;
}

export interface MaterialSummaryView {
  readonly id: string;
  readonly title: string;
  readonly source_label: string;
  readonly summary: string;
  readonly created_at: string;
}

export interface StepView {
  readonly id: string;
  readonly actor_id: string;
  readonly actor_kind: "user" | "ai" | "system";
  readonly args_schema?: JsonSchemaObject | boolean;
  readonly review_tags?: string[];
}

export interface VisibleTranscriptEntryView {
  readonly id: string;
  readonly event_id: string;
  readonly sequence: number;
  readonly actor_id: string;
  readonly actor_kind: "user" | "ai" | "system";
  readonly actor_name: string;
  readonly text: string;
}

export interface BranchTreeNodeView {
  readonly session_id: string;
  readonly parent_session_id: string | null;
  readonly label: string;
  readonly forked_from_sequence?: number;
  readonly status: RecentSessionSummary["status"];
  readonly rounds: number;
  readonly created_at: string;
  readonly is_current: boolean;
  readonly has_review: boolean;
  readonly latest_review?: {
    readonly id: string;
    readonly title: string;
    readonly status: RecentReviewSummary["status"];
  };
  readonly children: BranchTreeNodeView[];
}

export interface BranchTreeView {
  readonly root_session_id: string;
  readonly current_session_id: string;
  readonly nodes: BranchTreeNodeView[];
}

export interface CreateForkResponseView {
  readonly session: SessionView;
  readonly branch: BranchTreeNodeView;
  readonly tree: BranchTreeView;
}

export interface WithdrawUserInputResponseView extends CreateForkResponseView {
  readonly withdrawn_input: {
    readonly text: string;
    readonly event_id: string;
  };
}

export interface SessionStateView {
  readonly session_id: string;
  readonly scenario_id: string;
  readonly status: "running" | "paused" | "completed" | "ended" | "failed" | "blocked";
  readonly state_version: number;
  readonly state: JsonObject;
  readonly allowed_steps: StepView[];
  readonly visible_transcript: VisibleTranscriptEntryView[];
  readonly current_stage_label: string;
  readonly current_stage?: {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
  };
  readonly visible_tool_results?: Array<{
    readonly sequence: number;
    readonly actor_name: string;
    readonly tool_id: string;
    readonly summary: string;
    readonly source_ref: string;
    readonly trust_level: "high" | "medium" | "low";
  }>;
  readonly current_actor_name: string | null;
  readonly next_user_action_label: string;
  readonly failure_summary?: {
    readonly message: string;
    readonly failed_attempts: number;
    readonly can_retry: boolean;
    readonly action_label: string;
  };
  readonly blocked_summary?: {
    readonly reason: "no_active_stage" | "no_allowed_step" | "runtime_limit_exceeded";
    readonly message: string;
    readonly stage_id?: string;
  };
}

export interface SessionTimingView {
  readonly started_at: string;
  readonly updated_at: string;
  readonly suggested_duration_label?: string;
}

export interface SessionView {
  readonly id: string;
  readonly scenario_id: string;
  readonly status: SessionStateView["status"];
  readonly timing?: SessionTimingView;
  readonly view: SessionStateView;
}

export interface AiTurnObservabilityView {
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
  readonly visible_materials?: ReadonlyArray<{
    readonly title: string;
    readonly source_label: string;
    readonly summary: string;
  }>;
}

export interface ModelConfigView {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string;
  readonly display_name: string;
  readonly has_api_key: boolean;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface ModelConfigListView {
  readonly model_configs: ModelConfigView[];
  readonly default_model_config_id: string | null;
}

export interface ReviewEvidenceRef {
  readonly session_id: string;
  readonly event_id: string;
  readonly sequence: number;
  readonly step_id: string;
  readonly actor_id: string;
}

export interface ReviewEvidenceLocator {
  readonly sequence: number;
  readonly speaker: string;
  readonly snippet: string;
}

export interface ReviewEvidenceSummary {
  readonly answer_count: number;
  readonly cited_answer_count: number;
  readonly coverage: "sufficient" | "insufficient";
  readonly confidence: "high" | "medium" | "low";
}

export interface ReviewCredibilityCheck {
  readonly kind: "evidence_gap" | "off_topic" | "contradiction";
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly evidence_refs?: ReviewEvidenceRef[];
}

export interface ReviewReport {
  readonly id: string;
  readonly session_id: string;
  readonly created_at: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly review_adapter_kind?: string;
  readonly completed_at?: string;
  readonly error_message?: string;
  readonly summary?: string;
  readonly dimensions?: Array<{ readonly name: string; readonly conclusion: string; readonly evidence_refs: ReviewEvidenceRef[] }>;
  readonly key_moments?: Array<{ readonly title: string; readonly description: string; readonly evidence_ref: ReviewEvidenceRef; readonly evidence_locator?: ReviewEvidenceLocator }>;
  readonly recommendations?: Array<{ readonly text: string; readonly evidence_refs?: ReviewEvidenceRef[]; readonly uncertainty_note?: string }>;
  readonly evidence_refs?: ReviewEvidenceRef[];
  readonly evidence_summary?: ReviewEvidenceSummary;
  readonly credibility_checks?: ReviewCredibilityCheck[];
  readonly uncertainty_notes?: string[];
}

export interface SessionCommandPayload {
  readonly expected_state_version: number;
  readonly idempotency_key?: string;
}
