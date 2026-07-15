import type { RuntimeEvent } from "./runtime";
import type { NormalizedScenarioV1 } from "./scenario";
import type { SessionStatusSchema, SessionView } from "./session-view";
import type { z } from "zod";

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export interface RuntimeSessionRecord {
  readonly session_id: string;
  readonly scenario_id: string;
  readonly status: SessionStatus;
  readonly state_version: number;
  readonly scenario?: NormalizedScenarioV1;
  readonly view?: SessionView;
}

export interface RuntimeSessionStore {
  create(session: RuntimeSessionRecord): Promise<RuntimeSessionRecord>;
  get(sessionId: string): Promise<RuntimeSessionRecord | null>;
  saveView(view: SessionView): Promise<SessionView>;
}

export interface RuntimeEventStore {
  append(event: RuntimeEvent): Promise<RuntimeEvent>;
  listBySession(sessionId: string): Promise<RuntimeEvent[]>;
}

export interface RuntimeStoreContext {
  readonly sessions: RuntimeSessionStore;
  readonly events: RuntimeEventStore;
}

export interface RuntimeUnitOfWork {
  transaction<T>(fn: (stores: RuntimeStoreContext) => Promise<T>): Promise<T>;
}
