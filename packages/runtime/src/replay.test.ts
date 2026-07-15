import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "@personalflow/contracts";

import { replayState, ReplayStateVersionError } from "./index";

const sessionStarted = {
  id: "event-0",
  session_id: "session-replay",
  sequence: 0,
  state_version_before: 0,
  state_version_after: 0,
  created_at: "runtime",
  type: "SessionStarted",
  payload: {
    scenario_id: "scenario",
    initial_state: { turn_count: 0 }
  }
} satisfies RuntimeEvent;

const committed = {
  id: "event-1",
  session_id: "session-replay",
  sequence: 1,
  state_version_before: 0,
  state_version_after: 1,
  created_at: "runtime",
  type: "StepCommitted",
  payload: {
    step_id: "answer_question",
    actor_id: "user_candidate",
    args: { answer: "example" },
    state_patch: { turn_count: 1 }
  }
} satisfies RuntimeEvent;

const failed = {
  id: "event-2",
  session_id: "session-replay",
  sequence: 2,
  state_version_before: 1,
  state_version_after: 1,
  created_at: "runtime",
  type: "StepAttemptFailed",
  payload: {
    step_id: "missing_step",
    actor_id: "user_candidate",
    reason: "Step is not declared.",
    error_code: "validation_error"
  }
} satisfies RuntimeEvent;

const toolCommitted = {
  id: "event-tool",
  session_id: "session-replay",
  sequence: 3,
  state_version_before: 1,
  state_version_after: 1,
  created_at: "runtime",
  type: "ToolCallCommitted",
  payload: {
    actor_id: "ai_interviewer",
    stage_id: "conversation",
    tool_id: "mock_rag_query",
    request: { query: "example" },
    result: {
      summary: "Mock RAG result for: example",
      source_ref: "mock_rag:chunk-1",
      doc_version_hash: "mock-doc-v1",
      chunk_id: "chunk-1",
      visibility_label: "participant",
      trust_level: "medium"
    }
  }
} satisfies RuntimeEvent;

const blocked = {
  id: "event-blocked",
  session_id: "session-replay",
  sequence: 4,
  state_version_before: 1,
  state_version_after: 1,
  created_at: "runtime",
  type: "RuntimeBlockedCommitted",
  payload: {
    reason: "runtime_limit_exceeded",
    stage_id: "conversation",
    diagnostics: ["max_failed_attempts exceeded."]
  }
} satisfies RuntimeEvent;

describe("replayState", () => {
  it("rebuilds committed state while ignoring failed attempts and tool calls", () => {
    const result = replayState({ turn_count: 0 }, [sessionStarted, committed, failed, toolCommitted]);

    expect(result).toEqual({
      state: { turn_count: 1 },
      state_version: 1
    });
  });

  it("ignores RuntimeBlockedCommitted without changing state or state version", () => {
    const result = replayState({ turn_count: 0 }, [sessionStarted, committed, blocked]);

    expect(result).toEqual({
      state: { turn_count: 1 },
      state_version: 1
    });
  });

  it("rejects version gaps, duplicates, and mismatched patches", () => {
    expect(() =>
      replayState({ turn_count: 0 }, [
        sessionStarted,
        { ...committed, state_version_before: 1, state_version_after: 2 }
      ])
    ).toThrow(ReplayStateVersionError);

    expect(() =>
      replayState({ turn_count: 0 }, [
        sessionStarted,
        committed,
        { ...committed, id: "event-duplicate", sequence: 2 }
      ])
    ).toThrow(ReplayStateVersionError);

    expect(() =>
      replayState({ turn_count: 0 }, [
        sessionStarted,
        { ...committed, payload: { ...committed.payload, state_patch: { turn_count: 0 } } }
      ])
    ).toThrow(ReplayStateVersionError);
  });
});
