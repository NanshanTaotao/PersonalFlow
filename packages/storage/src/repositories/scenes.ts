import type { JsonObject, NormalizedScenarioV1 } from "@personalflow/contracts";
import { JsonObjectSchema, NormalizedScenarioV1Schema } from "@personalflow/contracts";

import type { StorageDatabase } from "../db";
import { toStorageError } from "../errors";
import { parseJson, stringifyJson } from "../json";

export interface SceneDraftRecord {
  readonly id: string;
  readonly template_id: string | null;
  readonly body: JsonObject;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateSceneDraftInput {
  readonly id: string;
  readonly template_id: string | null;
  readonly body: JsonObject;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface UpdateSceneDraftInput {
  readonly body: JsonObject;
  readonly updated_at: string;
}

export interface ConfirmedSceneRecord {
  readonly id: string;
  readonly draft_id: string | null;
  readonly scenario: NormalizedScenarioV1;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

export interface RecentSceneDraftSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "draft";
  readonly template_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecentConfirmedSceneSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "confirmed";
  readonly draft_id: string | null;
  readonly scenario_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SceneArchiveSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "running" | "paused" | "completed" | "ended" | "failed";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SceneArchiveReviewSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SceneArchiveSummary {
  readonly id: string;
  readonly title: string;
  readonly archived: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly session_count: number;
  readonly review_count: number;
  readonly latest_session: SceneArchiveSessionSummary | null;
  readonly latest_review: SceneArchiveReviewSummary | null;
}

export interface CreateConfirmedSceneInput {
  readonly id: string;
  readonly draft_id: string | null;
  readonly scenario: NormalizedScenarioV1;
  readonly created_at: string;
}

export interface CopyConfirmedSceneToDraftInput {
  readonly source_scene_id: string;
  readonly draft_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RenameConfirmedSceneInput {
  readonly title: string;
}

interface DraftRow {
  readonly id: string;
  readonly template_id: string | null;
  readonly body_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ConfirmedSceneRow {
  readonly id: string;
  readonly draft_id: string | null;
  readonly scenario_json: string;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

interface SessionArchiveRow {
  readonly session_id: string;
  readonly status: "running" | "paused" | "completed" | "ended" | "failed";
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

interface ReviewArchiveRow {
  readonly id: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly summary: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

const draftFromRow = (row: DraftRow): SceneDraftRecord => ({
  id: row.id,
  template_id: row.template_id,
  body: parseJson(row.body_json, JsonObjectSchema),
  created_at: row.created_at,
  updated_at: row.updated_at
});

const confirmedFromRow = (row: ConfirmedSceneRow): ConfirmedSceneRecord => ({
  id: row.id,
  draft_id: row.draft_id,
  scenario: parseJson(row.scenario_json, NormalizedScenarioV1Schema),
  created_at: row.created_at,
  deleted_at: row.deleted_at
});

const safeScenarioFromRaw = (raw: string): NormalizedScenarioV1 | null => {
  try {
    const parsed = NormalizedScenarioV1Schema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const confirmedRecordFromSafeScenario = (row: ConfirmedSceneRow, scenario: NormalizedScenarioV1): ConfirmedSceneRecord => ({
  id: row.id,
  draft_id: row.draft_id,
  scenario,
  created_at: row.created_at,
  deleted_at: row.deleted_at
});

const clampRecentLimit = (limit = 10): number =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const draftTitle = (draft: SceneDraftRecord): string => {
  const body = draft.body as Record<string, unknown>;
  const preview = body.preview as Record<string, unknown> | undefined;
  const previewTitle = preview?.title as Record<string, unknown> | undefined;
  return stringValue(previewTitle?.value) ?? stringValue(body.title) ?? stringValue(draft.template_id) ?? "未命名草稿";
};

const draftSummaryFromRow = (row: DraftRow): RecentSceneDraftSummary => {
  const draft = draftFromRow(row);
  return {
    id: draft.id,
    title: draftTitle(draft),
    status: "draft",
    template_id: draft.template_id,
    created_at: draft.created_at,
    updated_at: draft.updated_at
  };
};

const confirmedSummaryFromRow = (row: ConfirmedSceneRow): RecentConfirmedSceneSummary | null => {
  const scenario = safeScenarioFromRaw(row.scenario_json);
  if (scenario === null) {
    return null;
  }
  const scene = confirmedRecordFromSafeScenario(row, scenario);
  return {
    id: scene.id,
    title: scene.scenario.title,
    status: "confirmed",
    draft_id: scene.draft_id,
    scenario_id: scene.scenario.id,
    created_at: scene.created_at,
    updated_at: scene.created_at
  };
};

const compact = <T>(items: readonly (T | null)[]): T[] =>
  items.filter((item): item is T => item !== null);

export class SceneDraftsRepository {
  constructor(private readonly database: StorageDatabase) {}

  async create(input: CreateSceneDraftInput): Promise<SceneDraftRecord> {
    try {
      const body = JsonObjectSchema.parse(input.body);
      this.database.sqlite
        .prepare(
          `insert into scene_drafts (id, template_id, body_json, created_at, updated_at)
           values (?, ?, ?, ?, ?)`
        )
        .run(input.id, input.template_id, stringifyJson(body), input.created_at, input.updated_at);
      const created = await this.get(input.id);
      if (created === null) {
        throw new Error("Created draft cannot be read.");
      }
      return created;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async update(id: string, input: UpdateSceneDraftInput): Promise<SceneDraftRecord> {
    try {
      const body = JsonObjectSchema.parse(input.body);
      this.database.sqlite
        .prepare("update scene_drafts set body_json = ?, updated_at = ? where id = ?")
        .run(stringifyJson(body), input.updated_at, id);
      const updated = await this.get(id);
      if (updated === null) {
        throw new Error("Updated draft cannot be read.");
      }
      return updated;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async get(id: string): Promise<SceneDraftRecord | null> {
    try {
      const row = this.database.sqlite.prepare("select * from scene_drafts where id = ?").get(id) as
        | DraftRow
        | undefined;
      return row === undefined ? null : draftFromRow(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listRecent(limit = 10): Promise<RecentSceneDraftSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from scene_drafts order by updated_at desc, created_at desc, id desc limit ?")
        .all(clampRecentLimit(limit)) as DraftRow[];
      return rows.map(draftSummaryFromRow);
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export class ConfirmedScenesRepository {
  constructor(private readonly database: StorageDatabase) {}

  async create(input: CreateConfirmedSceneInput): Promise<ConfirmedSceneRecord> {
    try {
      const scenario = NormalizedScenarioV1Schema.parse(input.scenario);
      this.database.sqlite
        .prepare(
          `insert into confirmed_scenes (id, draft_id, scenario_json, created_at)
           values (?, ?, ?, ?)`
        )
        .run(input.id, input.draft_id, stringifyJson(scenario), input.created_at);
      const created = await this.get(input.id);
      if (created === null) {
        throw new Error("Created confirmed scene cannot be read.");
      }
      return created;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async get(id: string): Promise<ConfirmedSceneRecord | null> {
    try {
      const row = this.database.sqlite.prepare("select * from confirmed_scenes where id = ?").get(id) as
        | ConfirmedSceneRow
        | undefined;
      return row === undefined ? null : confirmedFromRow(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async getByScenarioId(scenarioId: string): Promise<ConfirmedSceneRecord | null> {
    try {
      const rows = this.database.sqlite.prepare("select * from confirmed_scenes order by created_at desc, id desc").all() as ConfirmedSceneRow[];
      for (const row of rows) {
        const scenario = safeScenarioFromRaw(row.scenario_json);
        if (scenario?.id === scenarioId) {
          return confirmedRecordFromSafeScenario(row, scenario);
        }
      }
      return null;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listRecent(limit = 10): Promise<RecentConfirmedSceneSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from confirmed_scenes where deleted_at is null order by created_at desc, id desc")
        .all() as ConfirmedSceneRow[];
      return compact(rows.map(confirmedSummaryFromRow)).slice(0, clampRecentLimit(limit));
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listArchive(): Promise<SceneArchiveSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from confirmed_scenes order by coalesce(deleted_at, created_at) desc, created_at desc, id desc")
        .all() as ConfirmedSceneRow[];
      return compact(rows.map((row) => {
        const scenario = safeScenarioFromRaw(row.scenario_json);
        if (scenario === null) {
          return null;
        }
        const scene = confirmedRecordFromSafeScenario(row, scenario);
        const sessions = this.database.sqlite
          .prepare(
            `select
               s.session_id,
               s.status,
               min(e.created_at) as created_at,
               max(e.created_at) as updated_at
             from sessions s
             left join runtime_events e on e.session_id = s.session_id
             where s.scenario_id = ?
             group by s.session_id, s.status
             order by coalesce(max(e.created_at), '') desc, s.session_id desc`
          )
          .all(scene.scenario.id) as SessionArchiveRow[];
        const reviews = this.database.sqlite
          .prepare(
            `select r.id, r.status, r.summary, r.created_at, r.completed_at
             from review_reports r
             inner join sessions s on s.session_id = r.session_id
             where s.scenario_id = ?
             order by coalesce(r.completed_at, r.created_at) desc, r.created_at desc, r.id desc`
          )
          .all(scene.scenario.id) as ReviewArchiveRow[];
        const latestSession = sessions[0];
        const latestReview = reviews[0];
        const updatedAt = latestSession?.updated_at ?? latestReview?.completed_at ?? row.deleted_at ?? row.created_at;
        return {
          id: scene.id,
          title: scene.scenario.title,
          archived: scene.deleted_at !== null,
          created_at: scene.created_at,
          updated_at: updatedAt,
          session_count: sessions.length,
          review_count: reviews.length,
          latest_session: latestSession === undefined ? null : {
            id: latestSession.session_id,
            title: scene.scenario.title,
            status: latestSession.status,
            created_at: latestSession.created_at ?? latestSession.updated_at ?? scene.created_at,
            updated_at: latestSession.updated_at ?? latestSession.created_at ?? scene.created_at
          },
          latest_review: latestReview === undefined ? null : {
            id: latestReview.id,
            title: `${scene.scenario.title}复盘`,
            status: latestReview.status,
            created_at: latestReview.created_at,
            updated_at: latestReview.completed_at ?? latestReview.created_at
          }
        };
      }));
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async rename(id: string, input: RenameConfirmedSceneInput): Promise<ConfirmedSceneRecord> {
    try {
      const scene = await this.get(id);
      if (scene === null) {
        throw new Error("Scene does not exist.");
      }
      const scenario = NormalizedScenarioV1Schema.parse({ ...scene.scenario, title: input.title });
      const result = this.database.sqlite
        .prepare("update confirmed_scenes set scenario_json = ? where id = ?")
        .run(stringifyJson(scenario), id);
      if (result.changes !== 1) {
        throw new Error("Scene does not exist.");
      }
      const updated = await this.get(id);
      if (updated === null) {
        throw new Error("Renamed scene cannot be read.");
      }
      return updated;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async copyToDraft(input: CopyConfirmedSceneToDraftInput): Promise<SceneDraftRecord> {
    try {
      const source = await this.get(input.source_scene_id);
      if (source === null) {
        throw new Error("Source scene cannot be read.");
      }
      const title = `${source.scenario.title} 的副本`;
      const scenario = NormalizedScenarioV1Schema.parse({ ...source.scenario, title });
      const body = JsonObjectSchema.parse({
        template_id: sourceTemplateId(scenario),
        params: {},
        preview: {
          title: { value: title, is_default: false },
          goal: { value: scenario.description, is_default: false },
          materials: []
        },
        scenario
      });
      this.database.sqlite
        .prepare(
          `insert into scene_drafts (id, template_id, body_json, created_at, updated_at)
           values (?, ?, ?, ?, ?)`
        )
        .run(input.draft_id, sourceTemplateId(scenario), stringifyJson(body), input.created_at, input.updated_at);
      const row = this.database.sqlite.prepare("select * from scene_drafts where id = ?").get(input.draft_id) as
        | DraftRow
        | undefined;
      if (row === undefined) {
        throw new Error("Copied draft cannot be read.");
      }
      return draftFromRow(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async softDelete(id: string, deletedAt: string): Promise<void> {
    try {
      const result = this.database.sqlite
        .prepare("update confirmed_scenes set deleted_at = ? where id = ?")
        .run(deletedAt, id);
      if (result.changes !== 1) {
        throw new Error("Scene does not exist.");
      }
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

const sourceTemplateId = (scenario: NormalizedScenarioV1): string => {
  if (scenario.id.includes("complex_config")) {
    return "complex_config";
  }
  if (scenario.id.includes("thesis")) {
    return "thesis_defense";
  }
  if (scenario.id.includes("promotion")) {
    return "promotion_review";
  }
  return "job_interview";
};

export const createSceneDraftsRepository = (database: StorageDatabase): SceneDraftsRepository =>
  new SceneDraftsRepository(database);

export const createConfirmedScenesRepository = (database: StorageDatabase): ConfirmedScenesRepository =>
  new ConfirmedScenesRepository(database);
