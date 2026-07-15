import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const modelConfigs = sqliteTable("model_configs", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  displayName: text("display_name").notNull(),
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
  apiKeyIv: text("api_key_iv").notNull(),
  apiKeyTag: text("api_key_tag").notNull(),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const sceneTemplates = sqliteTable("scene_templates", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  bodyJson: text("body_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const sceneDrafts = sqliteTable("scene_drafts", {
  id: text("id").primaryKey(),
  templateId: text("template_id"),
  bodyJson: text("body_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const confirmedScenes = sqliteTable("confirmed_scenes", {
  id: text("id").primaryKey(),
  draftId: text("draft_id"),
  scenarioJson: text("scenario_json").notNull(),
  createdAt: text("created_at").notNull(),
  deletedAt: text("deleted_at")
});

export const sessions = sqliteTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  status: text("status").notNull(),
  stateVersion: integer("state_version").notNull(),
  scenarioJson: text("scenario_json"),
  viewJson: text("view_json")
});

export const runtimeEvents = sqliteTable(
  "runtime_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    sequence: integer("sequence").notNull(),
    stateVersionBefore: integer("state_version_before").notNull(),
    stateVersionAfter: integer("state_version_after").notNull(),
    type: text("type").notNull(),
    eventJson: text("event_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("runtime_events_session_sequence_idx").on(table.sessionId, table.sequence),
    index("runtime_events_session_order_idx").on(table.sessionId, table.sequence)
  ]
);

export const sessionBranches = sqliteTable(
  "session_branches",
  {
    sessionId: text("session_id").primaryKey(),
    rootSessionId: text("root_session_id").notNull(),
    parentSessionId: text("parent_session_id"),
    forkedFromEventId: text("forked_from_event_id"),
    forkedFromSequence: integer("forked_from_sequence"),
    forkedFromStateVersion: integer("forked_from_state_version"),
    forkBoundarySequence: integer("fork_boundary_sequence"),
    forkBoundaryStateVersion: integer("fork_boundary_state_version"),
    includeSelectedEvent: integer("include_selected_event", { mode: "boolean" }),
    forkMode: text("fork_mode").notNull(),
    branchLabel: text("branch_label").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("session_branches_root_idx").on(table.rootSessionId),
    index("session_branches_parent_idx").on(table.parentSessionId)
  ]
);

export const reviewReports = sqliteTable(
  "review_reports",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    status: text("status").notNull(),
    summary: text("summary"),
    dimensionsJson: text("dimensions_json"),
    keyMomentsJson: text("key_moments_json"),
    recommendationsJson: text("recommendations_json"),
    evidenceRefsJson: text("evidence_refs_json"),
    evidenceSummaryJson: text("evidence_summary_json"),
    credibilityChecksJson: text("credibility_checks_json"),
    uncertaintyNotesJson: text("uncertainty_notes_json"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    errorMessage: text("error_message"),
    reviewAdapterKind: text("review_adapter_kind")
  },
  (table) => [index("review_reports_session_idx").on(table.sessionId)]
);

export const materials = sqliteTable("materials", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  contentJson: text("content_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const schema = {
  modelConfigs,
  sceneTemplates,
  sceneDrafts,
  confirmedScenes,
  sessions,
  runtimeEvents,
  sessionBranches,
  reviewReports,
  materials
};

export type StorageSchema = typeof schema;
