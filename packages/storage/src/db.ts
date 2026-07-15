import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { schema, type StorageSchema } from "./schema";

export interface DatabaseOptions {
  readonly path?: string;
  readonly encryptionKey: Uint8Array;
}

export interface TestDatabaseOptions {
  readonly path?: string;
  readonly encryptionKey: Uint8Array;
}

export interface StorageDatabase {
  readonly sqlite: Database.Database;
  readonly db: BetterSQLite3Database<StorageSchema>;
  readonly encryptionKey: Uint8Array;
  close(): void;
}

export interface TestDatabase extends StorageDatabase {
  cleanup(): void;
}

const assertEncryptionKey = (key: Uint8Array): Uint8Array => {
  if (key.byteLength !== 32) {
    throw new Error("Storage encryptionKey must be exactly 32 bytes for AES-256-GCM.");
  }
  return new Uint8Array(key);
};

const createSchema = (sqlite: Database.Database): void => {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    create table if not exists model_configs (
      id text primary key,
      provider text not null,
      base_url text not null,
      model text not null,
      display_name text not null,
      api_key_ciphertext text not null,
      api_key_iv text not null,
      api_key_tag text not null,
      is_default integer not null default 0,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists scene_templates (
      id text primary key,
      title text not null,
      body_json text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists scene_drafts (
      id text primary key,
      template_id text,
      body_json text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists confirmed_scenes (
      id text primary key,
      draft_id text,
      scenario_json text not null,
      created_at text not null,
      deleted_at text
    );

    create table if not exists sessions (
      session_id text primary key,
      scenario_id text not null,
      status text not null,
      state_version integer not null,
      scenario_json text,
      view_json text
    );

    create table if not exists runtime_events (
      id text primary key,
      session_id text not null,
      sequence integer not null,
      state_version_before integer not null,
      state_version_after integer not null,
      type text not null,
      event_json text not null,
      created_at text not null
    );

    create unique index if not exists runtime_events_session_sequence_idx
      on runtime_events (session_id, sequence);
    create index if not exists runtime_events_session_order_idx
      on runtime_events (session_id, sequence);

    create table if not exists session_branches (
      session_id text primary key,
      root_session_id text not null,
      parent_session_id text,
      forked_from_event_id text,
      forked_from_sequence integer,
      forked_from_state_version integer,
      fork_boundary_sequence integer,
      fork_boundary_state_version integer,
      include_selected_event integer,
      fork_mode text not null,
      branch_label text not null,
      created_at text not null
    );

    create index if not exists session_branches_root_idx
      on session_branches (root_session_id);
    create index if not exists session_branches_parent_idx
      on session_branches (parent_session_id);

    create table if not exists review_reports (
      id text primary key,
      session_id text not null,
      status text not null,
      summary text,
      dimensions_json text,
      key_moments_json text,
      recommendations_json text,
      evidence_refs_json text,
      evidence_summary_json text,
      credibility_checks_json text,
      uncertainty_notes_json text,
      created_at text not null,
      completed_at text,
      error_message text,
      review_adapter_kind text
    );

    create index if not exists review_reports_session_idx on review_reports (session_id);

    create table if not exists materials (
      id text primary key,
      source text not null,
      title text not null,
      content_json text not null,
      created_at text not null
    );
  `);
  const reviewReportColumns = sqlite.pragma("table_info(review_reports)") as Array<{ readonly name: string }>;
  if (!reviewReportColumns.some((column) => column.name === "review_adapter_kind")) {
    sqlite.exec("alter table review_reports add column review_adapter_kind text");
  }
  if (!reviewReportColumns.some((column) => column.name === "evidence_summary_json")) {
    sqlite.exec("alter table review_reports add column evidence_summary_json text");
  }
  if (!reviewReportColumns.some((column) => column.name === "credibility_checks_json")) {
    sqlite.exec("alter table review_reports add column credibility_checks_json text");
  }
  const confirmedSceneColumns = sqlite.pragma("table_info(confirmed_scenes)") as Array<{ readonly name: string }>;
  if (!confirmedSceneColumns.some((column) => column.name === "deleted_at")) {
    sqlite.exec("alter table confirmed_scenes add column deleted_at text");
  }
  const modelConfigColumns = sqlite.pragma("table_info(model_configs)") as Array<{ readonly name: string }>;
  if (!modelConfigColumns.some((column) => column.name === "is_default")) {
    sqlite.exec("alter table model_configs add column is_default integer not null default 0");
  }
};

export const createDatabase = (options: DatabaseOptions): StorageDatabase => {
  if (options.path !== undefined && options.path !== ":memory:") {
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
  }
  const sqlite = new Database(options.path ?? ":memory:");
  createSchema(sqlite);
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    encryptionKey: assertEncryptionKey(options.encryptionKey),
    close: () => sqlite.close()
  };
};

export const createTestDatabase = (options: TestDatabaseOptions): TestDatabase => {
  const databasePath = options.path ?? path.join(os.tmpdir(), `personalflow-storage-${randomUUID()}.sqlite`);
  const database = createDatabase({ path: databasePath, encryptionKey: options.encryptionKey });
  return {
    ...database,
    cleanup: () => {
      database.close();
      if (databasePath !== ":memory:") {
        try {
          for (const suffix of ["", "-wal", "-shm"]) {
            const filePath = databasePath + suffix;
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          }
        } catch {
          // Best-effort cleanup for isolated test databases.
        }
      }
    }
  };
};
