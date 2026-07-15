import type {
  RuntimeEvent,
  RuntimeEventStore,
  RuntimeSessionRecord,
  RuntimeSessionStore,
  RuntimeStoreContext,
  RuntimeUnitOfWork,
  SessionView
} from "@personalflow/contracts";

import { RuntimeConflictError, RuntimeValidationError } from "../errors";
import { cloneJson } from "../state";

const cloneSessionRecord = (session: RuntimeSessionRecord): RuntimeSessionRecord =>
  cloneJson(session);

const cloneEvent = (event: RuntimeEvent): RuntimeEvent => cloneJson(event);

const cloneView = (view: SessionView): SessionView => cloneJson(view);

class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  constructor(private readonly sessions: Map<string, RuntimeSessionRecord>) {}

  async create(session: RuntimeSessionRecord): Promise<RuntimeSessionRecord> {
    if (this.sessions.has(session.session_id)) {
      throw new RuntimeConflictError("Session already exists.");
    }
    const stored = cloneSessionRecord(session);
    this.sessions.set(session.session_id, stored);
    return cloneSessionRecord(stored);
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : cloneSessionRecord(session);
  }

  async saveView(view: SessionView): Promise<SessionView> {
    const current = this.sessions.get(view.session_id);
    if (current === undefined) {
      throw new RuntimeValidationError("Session does not exist.");
    }
    if (current.scenario === undefined) {
      throw new RuntimeValidationError("Session scenario does not exist.");
    }

    const next: RuntimeSessionRecord = {
      session_id: view.session_id,
      scenario_id: view.scenario_id,
      status: view.status,
      state_version: view.state_version,
      scenario: current.scenario,
      view: cloneView(view)
    };
    this.sessions.set(view.session_id, cloneSessionRecord(next));
    return cloneView(view);
  }
}

class InMemoryRuntimeEventStore implements RuntimeEventStore {
  constructor(private readonly events: Map<string, RuntimeEvent[]>) {}

  async append(event: RuntimeEvent): Promise<RuntimeEvent> {
    const sessionEvents = this.events.get(event.session_id) ?? [];
    const expectedSequence = sessionEvents.length;
    if (event.sequence !== expectedSequence) {
      throw new RuntimeConflictError("Event sequence conflict.");
    }
    const stored = cloneEvent(event);
    this.events.set(event.session_id, [...sessionEvents, stored]);
    return cloneEvent(stored);
  }

  async listBySession(sessionId: string): Promise<RuntimeEvent[]> {
    return (this.events.get(sessionId) ?? []).map((event) => cloneEvent(event));
  }
}

export class InMemoryRuntimeStore implements RuntimeUnitOfWork {
  private sessions = new Map<string, RuntimeSessionRecord>();
  private events = new Map<string, RuntimeEvent[]>();

  async transaction<T>(fn: (stores: RuntimeStoreContext) => Promise<T>): Promise<T> {
    const sessionsSnapshot = new Map(this.sessions);
    const eventsSnapshot = new Map([...this.events].map(([sessionId, events]) => [sessionId, [...events]]));

    const context: RuntimeStoreContext = {
      sessions: new InMemoryRuntimeSessionStore(sessionsSnapshot),
      events: new InMemoryRuntimeEventStore(eventsSnapshot)
    };

    const result = await fn(context);
    this.sessions = sessionsSnapshot;
    this.events = eventsSnapshot;
    return result;
  }
}
