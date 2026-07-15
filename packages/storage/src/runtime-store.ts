import type {
  NormalizedScenarioV1,
  RuntimeEvent,
  RuntimeEventStore,
  RuntimeSessionRecord,
  RuntimeSessionStore,
  RuntimeUnitOfWork,
  RuntimeStoreContext,
  SessionView
} from "@personalflow/contracts";
import {
  NormalizedScenarioV1Schema,
  RuntimeEventSchema,
  SessionStatusSchema,
  SessionViewSchema
} from "@personalflow/contracts";

import type { StorageDatabase } from "./db";
import { StorageError, toStorageError } from "./errors";
import { parseJson, parseNullableJson, stringifyJson } from "./json";

interface SessionRow {
  readonly session_id: string;
  readonly scenario_id: string;
  readonly status: string;
  readonly state_version: number;
  readonly scenario_json: string | null;
  readonly view_json: string | null;
}

interface EventRow {
  readonly event_json: string;
}

interface RecentSessionRow {
  readonly session_id: string;
  readonly scenario_id: string;
  readonly status: string;
  readonly scenario_json: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

export interface RecentRuntimeSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: SessionView["status"];
  readonly scenario_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const mapSessionRow = (row: SessionRow): RuntimeSessionRecord => {
  const scenario = parseNullableJson(row.scenario_json, NormalizedScenarioV1Schema);
  const view = parseNullableJson(row.view_json, SessionViewSchema);
  return {
    session_id: row.session_id,
    scenario_id: row.scenario_id,
    status: SessionStatusSchema.parse(row.status),
    state_version: row.state_version,
    ...(scenario === undefined ? {} : { scenario }),
    ...(view === undefined ? {} : { view })
  };
};

const clampRecentLimit = (limit = 10): number =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;

const safeRecentScenario = (raw: string | null): NormalizedScenarioV1 | null => {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = NormalizedScenarioV1Schema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const recentSessionFromRow = (row: RecentSessionRow): RecentRuntimeSessionSummary | null => {
  const status = SessionStatusSchema.safeParse(row.status);
  if (!status.success) {
    return null;
  }
  const scenario = safeRecentScenario(row.scenario_json);
  if (row.scenario_json !== null && scenario === null) {
    return null;
  }
  const updatedAt = row.updated_at ?? "";
  return {
    id: row.session_id,
    title: scenario?.title ?? "历史演练",
    status: status.data,
    scenario_id: row.scenario_id,
    created_at: row.created_at ?? updatedAt,
    updated_at: updatedAt
  };
};

const compact = <T>(items: readonly (T | null)[]): T[] =>
  items.filter((item): item is T => item !== null);

export class SqliteRuntimeSessionStore implements RuntimeSessionStore {
  constructor(private readonly database: StorageDatabase) {}

  async create(session: RuntimeSessionRecord): Promise<RuntimeSessionRecord> {
    try {
      this.database.sqlite
        .prepare(
          `insert into sessions (
            session_id, scenario_id, status, state_version, scenario_json, view_json
          ) values (?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.session_id,
          session.scenario_id,
          session.status,
          session.state_version,
          session.scenario === undefined ? null : stringifyJson(NormalizedScenarioV1Schema.parse(session.scenario)),
          session.view === undefined ? null : stringifyJson(SessionViewSchema.parse(session.view))
        );
      return session;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    try {
      const row = this.database.sqlite.prepare("select * from sessions where session_id = ?").get(sessionId) as
        | SessionRow
        | undefined;
      return row === undefined ? null : mapSessionRow(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async saveView(view: SessionView): Promise<SessionView> {
    try {
      const parsed = SessionViewSchema.parse(view);
      const result = this.database.sqlite
        .prepare(
          `update sessions
           set scenario_id = ?, status = ?, state_version = ?, view_json = ?
           where session_id = ?`
        )
        .run(parsed.scenario_id, parsed.status, parsed.state_version, stringifyJson(parsed), parsed.session_id);
      if (result.changes !== 1) {
        throw new StorageError("storage_not_found", "Session does not exist.");
      }
      return parsed;
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export class SqliteRuntimeEventStore implements RuntimeEventStore {
  constructor(private readonly database: StorageDatabase) {}

  async append(event: RuntimeEvent): Promise<RuntimeEvent> {
    try {
      const parsed = RuntimeEventSchema.parse(event);
      const count = this.database.sqlite
        .prepare("select count(*) as count from runtime_events where session_id = ?")
        .get(parsed.session_id) as { count: number };
      if (parsed.sequence !== count.count) {
        throw new StorageError("storage_conflict", "Event sequence conflict.");
      }
      this.database.sqlite
        .prepare(
          `insert into runtime_events (
            id, session_id, sequence, state_version_before, state_version_after, type, event_json, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.id,
          parsed.session_id,
          parsed.sequence,
          parsed.state_version_before,
          parsed.state_version_after,
          parsed.type,
          stringifyJson(parsed),
          parsed.created_at
        );
      return parsed;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listBySession(sessionId: string): Promise<RuntimeEvent[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select event_json from runtime_events where session_id = ? order by sequence asc")
        .all(sessionId) as EventRow[];
      return rows.map((row) => parseJson(row.event_json, RuntimeEventSchema));
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export class SqliteRuntimeStore implements RuntimeUnitOfWork {
  constructor(private readonly database: StorageDatabase) {}

  async transaction<T>(fn: (stores: RuntimeStoreContext) => Promise<T>): Promise<T> {
    this.database.sqlite.exec("begin immediate");
    try {
      const context: RuntimeStoreContext = {
        sessions: new SqliteRuntimeSessionStore(this.database),
        events: new SqliteRuntimeEventStore(this.database)
      };
      const result = await fn(context);
      this.database.sqlite.exec("commit");
      return result;
    } catch (error) {
      this.database.sqlite.exec("rollback");
      throw error;
    }
  }

  async listRecentSessions(limit = 10): Promise<RecentRuntimeSessionSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare(
          `select
             s.session_id,
             s.scenario_id,
             s.status,
             s.scenario_json,
             coalesce(b.created_at, min(e.created_at)) as created_at,
             case
               when b.created_at is not null
                 and b.created_at > coalesce(max(case when e.created_at like '____-__-__T%' then e.created_at end), '')
                 then b.created_at
               else coalesce(max(case when e.created_at like '____-__-__T%' then e.created_at end), max(e.created_at), '')
             end as updated_at
           from sessions s
           left join runtime_events e on e.session_id = s.session_id
           left join session_branches b on b.session_id = s.session_id
           group by s.session_id, s.scenario_id, s.status, s.scenario_json, b.created_at
           order by updated_at desc, s.session_id desc`
        )
        .all() as RecentSessionRow[];
      return compact(rows.map(recentSessionFromRow)).slice(0, clampRecentLimit(limit));
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export const createRuntimeStore = (database: StorageDatabase): SqliteRuntimeStore => new SqliteRuntimeStore(database);
