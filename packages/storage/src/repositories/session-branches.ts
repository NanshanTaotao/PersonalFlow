import type { CreateSessionBranchInput, SessionBranchRecord } from "@personalflow/contracts";
import { SessionBranchRecordSchema } from "@personalflow/contracts";

import type { StorageDatabase } from "../db";
import { toStorageError } from "../errors";

interface SessionBranchRow {
  readonly session_id: string;
  readonly root_session_id: string;
  readonly parent_session_id: string | null;
  readonly forked_from_event_id: string | null;
  readonly forked_from_sequence: number | null;
  readonly forked_from_state_version: number | null;
  readonly fork_boundary_sequence: number | null;
  readonly fork_boundary_state_version: number | null;
  readonly include_selected_event: number | null;
  readonly fork_mode: string;
  readonly branch_label: string;
  readonly created_at: string;
}

const rowToBranch = (row: SessionBranchRow): SessionBranchRecord =>
  SessionBranchRecordSchema.parse({
    session_id: row.session_id,
    root_session_id: row.root_session_id,
    parent_session_id: row.parent_session_id,
    forked_from_event_id: row.forked_from_event_id,
    forked_from_sequence: row.forked_from_sequence,
    forked_from_state_version: row.forked_from_state_version,
    fork_boundary_sequence: row.fork_boundary_sequence,
    fork_boundary_state_version: row.fork_boundary_state_version,
    include_selected_event: row.include_selected_event === null ? null : row.include_selected_event === 1,
    fork_mode: row.fork_mode,
    branch_label: row.branch_label,
    created_at: row.created_at
  });

export class SqliteSessionBranchRepository {
  constructor(private readonly database: StorageDatabase) {}

  async ensureRoot(input: {
    readonly session_id: string;
    readonly branch_label: string;
    readonly created_at: string;
  }): Promise<SessionBranchRecord> {
    const existing = await this.get(input.session_id);
    if (existing !== null) {
      return existing;
    }
    return this.create({
      session_id: input.session_id,
      root_session_id: input.session_id,
      parent_session_id: null,
      forked_from_event_id: null,
      forked_from_sequence: null,
      forked_from_state_version: null,
      fork_boundary_sequence: null,
      fork_boundary_state_version: null,
      include_selected_event: null,
      fork_mode: "root",
      branch_label: input.branch_label,
      created_at: input.created_at
    });
  }

  async create(input: CreateSessionBranchInput): Promise<SessionBranchRecord> {
    try {
      const parsed = SessionBranchRecordSchema.parse(input);
      this.database.sqlite
        .prepare(
          `insert into session_branches (
            session_id, root_session_id, parent_session_id, forked_from_event_id,
            forked_from_sequence, forked_from_state_version, fork_boundary_sequence,
            fork_boundary_state_version, include_selected_event, fork_mode, branch_label, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.session_id,
          parsed.root_session_id,
          parsed.parent_session_id,
          parsed.forked_from_event_id,
          parsed.forked_from_sequence,
          parsed.forked_from_state_version,
          parsed.fork_boundary_sequence,
          parsed.fork_boundary_state_version,
          parsed.include_selected_event === null ? null : parsed.include_selected_event ? 1 : 0,
          parsed.fork_mode,
          parsed.branch_label,
          parsed.created_at
        );
      return parsed;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async get(sessionId: string): Promise<SessionBranchRecord | null> {
    try {
      const row = this.database.sqlite.prepare("select * from session_branches where session_id = ?").get(sessionId) as
        | SessionBranchRow
        | undefined;
      return row === undefined ? null : rowToBranch(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listByRootSession(rootSessionId: string): Promise<SessionBranchRecord[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from session_branches where root_session_id = ? order by created_at asc, session_id asc")
        .all(rootSessionId) as SessionBranchRow[];
      return rows.map(rowToBranch);
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export const createSessionBranchRepository = (database: StorageDatabase): SqliteSessionBranchRepository =>
  new SqliteSessionBranchRepository(database);
