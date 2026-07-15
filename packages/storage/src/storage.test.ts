import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@personalflow/contracts";
import { RuntimeKernel, replayState } from "@personalflow/runtime";
import { jobInterviewSmokeFixture } from "@personalflow/templates";

import {
  createProductStore,
  createRuntimeStore,
  createTestDatabase,
  createRepositories,
  StorageError,
  type TestDatabase
} from "./index";

const dummyEncryptionKey = new Uint8Array(32).fill(7);
const dummyApiKey = "fixture-key-7-secret";

const databases: TestDatabase[] = [];

const createIsolatedDatabase = () => {
  const database = createTestDatabase({ encryptionKey: dummyEncryptionKey });
  databases.push(database);
  return database;
};

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.cleanup();
  }
});

describe("SQLite runtime store", () => {
  it("runs the smoke scenario through RuntimeKernel without changing runtime code", async () => {
    const database = createIsolatedDatabase();
    const runtime = new RuntimeKernel({ store: createRuntimeStore(database) });

    const started = await runtime.startSession({
      sessionId: "sqlite-session-smoke",
      scenario: jobInterviewSmokeFixture
    });
    expect(started.state_version).toBe(0);

    const afterAi = await runtime.submitStructuredAction({
      sessionId: "sqlite-session-smoke",
      actorId: "ai_interviewer",
      stepId: "ask_question",
      args: { question: "Which system did you own?" },
      expectedStateVersion: 0
    });
    expect(afterAi.state_version).toBe(0);

    const afterUser = await runtime.submitUserInput({
      sessionId: "sqlite-session-smoke",
      input: "I owned the migration and rollout plan.",
      expectedStateVersion: 0
    });
    expect(afterUser.state_version).toBe(1);

    const failed = await runtime.submitStructuredAction({
      sessionId: "sqlite-session-smoke",
      actorId: "user_candidate",
      stepId: "missing_step",
      args: {},
      expectedStateVersion: 1
    });
    expect(failed.state_version).toBe(1);

    const events = await runtime.listEvents("sqlite-session-smoke");
    expect(events.map((event) => [event.sequence, event.type, event.state_version_after])).toEqual([
      [0, "SessionStarted", 0],
      [1, "StepCommitted", 0],
      [2, "StepCommitted", 1],
      [3, "StepAttemptFailed", 1]
    ]);
    expect(replayState(jobInterviewSmokeFixture.initial_state, events)).toEqual({
      state: afterUser.state,
      state_version: 1
    });
  });

  it("rolls back appended events and session view changes when transaction callback throws", async () => {
    const database = createIsolatedDatabase();
    const store = createRuntimeStore(database);
    const runtime = new RuntimeKernel({ store });
    await runtime.startSession({ sessionId: "sqlite-session-rollback", scenario: jobInterviewSmokeFixture });

    await expect(
      store.transaction(async (stores) => {
        await stores.events.append({
          id: "rollback-event",
          session_id: "sqlite-session-rollback",
          sequence: 1,
          state_version_before: 0,
          state_version_after: 1,
          created_at: "runtime-sequence-1",
          type: "StepCommitted",
          payload: {
            step_id: "answer_question",
            actor_id: "user_candidate",
            args: { answer: "rolled back" },
            state_patch: { turn_count: 1 }
          }
        });
        const current = await stores.sessions.get("sqlite-session-rollback");
        if (current?.view === undefined) {
          throw new Error("missing view");
        }
        await stores.sessions.saveView({
          ...current.view,
          state_version: 1,
          state: { turn_count: 1 }
        });
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    const events = await runtime.listEvents("sqlite-session-rollback");
    const view = await runtime.getView("sqlite-session-rollback");
    expect(events.map((event) => event.type)).toEqual(["SessionStarted"]);
    expect(view.state_version).toBe(0);
    expect(view.state).toEqual({ turn_count: 0 });
  });

  it("returns stable storage errors instead of raw SQLite driver exceptions", async () => {
    const database = createIsolatedDatabase();
    const store = createRuntimeStore(database);
    const runtime = new RuntimeKernel({ store });
    await runtime.startSession({ sessionId: "sqlite-session-conflict", scenario: jobInterviewSmokeFixture });

    await expect(
      store.transaction((stores) =>
        stores.events.append({
          id: "bad-sequence",
          session_id: "sqlite-session-conflict",
          sequence: 99,
          state_version_before: 0,
          state_version_after: 0,
          created_at: "runtime-sequence-99",
          type: "StepAttemptFailed",
          payload: {
            step_id: "missing_step",
            actor_id: "user_candidate",
            reason: "bad sequence",
            error_code: "validation_error"
          }
        })
      )
    ).rejects.toMatchObject({ code: "storage_conflict" } satisfies Pick<StorageError, "code">);
  });
});

describe("SQLite session branch store", () => {
  it("creates root and child branch rows in product transactions", async () => {
    const database = createIsolatedDatabase();
    const productStore = createProductStore(database);

    await productStore.transaction(async (stores) => {
      await stores.branches.ensureRoot({
        session_id: "session-root-branch",
        branch_label: "主线",
        created_at: "2026-07-10T00:00:00.000Z"
      });
      const root = await stores.branches.get("session-root-branch");
      expect(root).toMatchObject({
        session_id: "session-root-branch",
        root_session_id: "session-root-branch",
        parent_session_id: null,
        fork_mode: "root",
        branch_label: "主线"
      });

      await stores.branches.create({
        session_id: "session-child-branch",
        root_session_id: "session-root-branch",
        parent_session_id: "session-root-branch",
        forked_from_event_id: "session-root-branch:0:SessionStarted",
        forked_from_sequence: 0,
        forked_from_state_version: 0,
        fork_boundary_sequence: 0,
        fork_boundary_state_version: 0,
        include_selected_event: true,
        fork_mode: "manual_fork",
        branch_label: "从开场分支",
        created_at: "2026-07-10T00:01:00.000Z"
      });

      expect(await stores.branches.listByRootSession("session-root-branch")).toHaveLength(2);
    });
  });

  it("rolls back branch rows with the surrounding product transaction", async () => {
    const database = createIsolatedDatabase();
    const productStore = createProductStore(database);
    await expect(
      productStore.transaction(async (stores) => {
        await stores.branches.ensureRoot({
          session_id: "session-rollback-root",
          branch_label: "主线",
          created_at: "2026-07-10T00:00:00.000Z"
        });
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    await productStore.transaction(async (stores) => {
      expect(await stores.branches.get("session-rollback-root")).toBeNull();
    });
  });

  it("uses branch created_at as recent session updated_at when it is newer than copied events", async () => {
    const database = createIsolatedDatabase();
    const productStore = createProductStore(database);
    const runtime = new RuntimeKernel({ store: createRuntimeStore(database) });

    await runtime.startSession({ sessionId: "session-recent-parent", scenario: jobInterviewSmokeFixture });
    await productStore.transaction(async (stores) => {
      await stores.branches.ensureRoot({
        session_id: "session-recent-parent",
        branch_label: "主线",
        created_at: "2026-07-10T10:00:00.000Z"
      });
      await stores.runtime.sessions.create({
        session_id: "session-recent-child",
        scenario_id: jobInterviewSmokeFixture.id,
        status: "running",
        state_version: 0,
        scenario: jobInterviewSmokeFixture,
        view: {
          session_id: "session-recent-child",
          scenario_id: jobInterviewSmokeFixture.id,
          status: "running",
          state_version: 0,
          state: jobInterviewSmokeFixture.initial_state,
          allowed_steps: [],
          visible_transcript: [],
          current_stage_label: "演练进行中",
          current_actor_name: null,
          next_user_action_label: "请继续演练。"
        }
      });
      await stores.branches.create({
        session_id: "session-recent-child",
        root_session_id: "session-recent-parent",
        parent_session_id: "session-recent-parent",
        forked_from_event_id: "session-recent-parent:0:SessionStarted",
        forked_from_sequence: 0,
        forked_from_state_version: 0,
        fork_boundary_sequence: 0,
        fork_boundary_state_version: 0,
        include_selected_event: true,
        fork_mode: "manual_fork",
        branch_label: "晚间分支",
        created_at: "2026-07-10T22:00:00.000Z"
      });
    });

    expect((await createRuntimeStore(database).listRecentSessions(10))[0]).toMatchObject({
      id: "session-recent-child",
      created_at: "2026-07-10T22:00:00.000Z",
      updated_at: "2026-07-10T22:00:00.000Z"
    });
  });

  it("rolls back runtime session creation and root branch creation together", async () => {
    const database = createIsolatedDatabase();
    const productStore = createProductStore(database);
    const sessionId = "session-root-rollback";

    await expect(
      productStore.transaction(async (stores) => {
        await stores.runtime.sessions.create({
          session_id: sessionId,
          scenario_id: jobInterviewSmokeFixture.id,
          status: "running",
          state_version: 0,
          scenario: jobInterviewSmokeFixture,
          view: {
            session_id: sessionId,
            scenario_id: jobInterviewSmokeFixture.id,
            status: "running",
            state_version: 0,
            state: jobInterviewSmokeFixture.initial_state,
            allowed_steps: [],
            visible_transcript: [],
            current_stage_label: "演练进行中",
            current_actor_name: null,
            next_user_action_label: "请继续演练。"
          }
        });
        await stores.branches.ensureRoot({
          session_id: sessionId,
          branch_label: "主线",
          created_at: "2026-07-10T00:00:00.000Z"
        });
        throw new Error("force rollback after root branch");
      })
    ).rejects.toThrow("force rollback after root branch");

    await productStore.transaction(async (stores) => {
      expect(await stores.runtime.sessions.get(sessionId)).toBeNull();
      expect(await stores.branches.get(sessionId)).toBeNull();
    });
  });
});

describe("SQLite repositories", () => {
  it("stores lightweight materials as safe summaries and supports scene copy/delete management", async () => {
    const database = createIsolatedDatabase();
    const repositories = createRepositories(database);
    const secretLikeText = "Authorization: Bearer test-material-secret should stay out of summaries.";

    const material = await repositories.materials.create({
      id: "material-p2",
      source: "manual",
      title: "项目背景材料",
      content: { text: `这是一段可用于答辩的项目背景。${secretLikeText}` },
      created_at: "2026-06-20T00:00:00.000Z"
    });

    const summaries = await repositories.materials.listRecent(10);
    expect(summaries).toEqual([
      expect.objectContaining({
        id: material.id,
        title: "项目背景材料",
        source_label: "手动粘贴",
        summary: expect.stringContaining("可用于演练上下文")
      })
    ]);
    expect(JSON.stringify(summaries)).not.toMatch(/content_json|Authorization|Bearer|test-material-secret/i);

    const draft = await repositories.sceneDrafts.create({
      id: "draft-copy-source",
      template_id: "job_interview",
      body: { preview: { title: { value: "求职面试" } }, scenario: JSON.parse(JSON.stringify(jobInterviewSmokeFixture)) },
      created_at: "2026-06-20T00:01:00.000Z",
      updated_at: "2026-06-20T00:01:00.000Z"
    });
    const confirmed = await repositories.confirmedScenes.create({
      id: "scene-copy-source",
      draft_id: draft.id,
      scenario: jobInterviewSmokeFixture,
      created_at: "2026-06-20T00:02:00.000Z"
    });

    const copied = await repositories.confirmedScenes.copyToDraft({
      source_scene_id: confirmed.id,
      draft_id: "draft-copy-target",
      created_at: "2026-06-20T00:03:00.000Z",
      updated_at: "2026-06-20T00:03:00.000Z"
    });
    expect(copied.body.preview).toMatchObject({ title: { value: expect.stringMatching(/副本$/) } });
    expect(copied.body.scenario).toMatchObject({ title: expect.stringMatching(/副本$/) });

    await repositories.confirmedScenes.softDelete("scene-copy-source", "2026-06-20T00:04:00.000Z");
    expect(await repositories.confirmedScenes.get("scene-copy-source")).toMatchObject({ id: "scene-copy-source" });
    expect(await repositories.confirmedScenes.listRecent(10)).toEqual([]);
  });

  it("lists recent safe summaries in reverse update order with bounded limits", async () => {
    const database = createIsolatedDatabase();
    const repositories = createRepositories(database);
    const store = createRuntimeStore(database);
    const runtime = new RuntimeKernel({ store });
    const scenarioJson = JSON.parse(JSON.stringify(jobInterviewSmokeFixture)) as JsonObject;

    await repositories.sceneDrafts.create({
      id: "draft-old",
      template_id: "template-smoke",
      body: { preview: { title: { value: "Old draft" } }, scenario: scenarioJson },
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z"
    });
    await repositories.sceneDrafts.create({
      id: "draft-new",
      template_id: "template-smoke",
      body: { preview: { title: { value: "New draft" } }, scenario: scenarioJson, normalized_scenario: { secret: true } },
      created_at: "2026-06-19T00:01:00.000Z",
      updated_at: "2026-06-19T00:02:00.000Z"
    });
    await repositories.confirmedScenes.create({
      id: "scene-1",
      draft_id: "draft-new",
      scenario: jobInterviewSmokeFixture,
      created_at: "2026-06-19T00:03:00.000Z"
    });
    await runtime.startSession({ sessionId: "session-1", scenario: jobInterviewSmokeFixture });
    await repositories.reviewReports.createPending({
      id: "review-1",
      session_id: "session-1",
      created_at: "2026-06-19T00:04:00.000Z"
    });

    const summaries = {
      drafts: await repositories.sceneDrafts.listRecent(1),
      scenes: await repositories.confirmedScenes.listRecent(10),
      sessions: await store.listRecentSessions(10),
      reviews: await repositories.reviewReports.listRecent(10)
    };

    expect(summaries.drafts).toEqual([
      expect.objectContaining({ id: "draft-new", title: "New draft", status: "draft", updated_at: "2026-06-19T00:02:00.000Z" })
    ]);
    expect(summaries.scenes).toEqual([
      expect.objectContaining({ id: "scene-1", title: jobInterviewSmokeFixture.title, status: "confirmed" })
    ]);
    expect(summaries.sessions).toEqual([
      expect.objectContaining({ id: "session-1", title: jobInterviewSmokeFixture.title, status: "running" })
    ]);
    expect(summaries.reviews).toEqual([
      expect.objectContaining({ id: "review-1", title: "复盘待生成", status: "pending" })
    ]);
    expect(await repositories.sceneDrafts.listRecent(500)).toHaveLength(2);
    expect(JSON.stringify(summaries)).not.toMatch(/normalized_scenario|RuntimeEvent|api[_-]?key|ciphertext|provider raw|state_version|step_id/i);
  });

  it("encrypts API keys and only exposes the original key through getForModelCall", async () => {
    const database = createIsolatedDatabase();
    const repositories = createRepositories(database);

    const created = await repositories.modelConfigs.create({
      id: "model-openai",
      provider: "openai-compatible",
      base_url: "https://example.test/v1",
      model: "gpt-test",
      display_name: "Dummy model",
      api_key: dummyApiKey,
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z"
    });

    expect(created).toMatchObject({
      id: "model-openai",
      provider: "openai-compatible",
      has_api_key: true,
      api_key_masked: "fix...cret"
    });
    expect(JSON.stringify(created)).not.toContain(dummyApiKey);
    expect(JSON.stringify(created)).not.toContain("ciphertext");

    const safeList = await repositories.modelConfigs.listSafe();
    const safeDetail = await repositories.modelConfigs.getSafe("model-openai");
    expect(JSON.stringify(safeList)).not.toContain(dummyApiKey);
    expect(JSON.stringify(safeDetail)).not.toContain(dummyApiKey);
    expect(JSON.stringify(safeList)).not.toMatch(/api_key_(ciphertext|iv|tag)/);
    expect(JSON.stringify(safeDetail)).not.toMatch(/api_key_(ciphertext|iv|tag)/);

    const modelCall = await repositories.modelConfigs.getForModelCall("model-openai");
    expect(modelCall?.api_key).toBe(dummyApiKey);

    const rawRows = database.sqlite
      .prepare("select * from model_configs where id = ?")
      .all("model-openai") as Record<string, unknown>[];
    expect(rawRows).toHaveLength(1);
    expect(JSON.stringify(rawRows)).not.toContain(dummyApiKey);
    expect(Object.hasOwn(rawRows[0] ?? {}, "api_key")).toBe(false);
    expect(typeof rawRows[0]?.api_key_ciphertext).toBe("string");
    expect(typeof rawRows[0]?.api_key_iv).toBe("string");
    expect(typeof rawRows[0]?.api_key_tag).toBe("string");

    await repositories.modelConfigs.delete("model-openai");
    await expect(repositories.modelConfigs.getForModelCall("model-openai")).resolves.toBeNull();
    await expect(repositories.modelConfigs.getSafe("model-openai")).resolves.toBeNull();
  });

  it("keeps scene drafts, confirmed scenes, review reports, and materials isolated from API key data", async () => {
    const database = createIsolatedDatabase();
    const repositories = createRepositories(database);

    await repositories.modelConfigs.create({
      id: "model-isolated",
      provider: "openai-compatible",
      base_url: "https://example.test/v1",
      model: "gpt-test",
      display_name: "Dummy model",
      api_key: dummyApiKey,
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z"
    });

    const draftBody = {
      title: "Draft",
      fields: { purpose: "practice" }
    } satisfies JsonObject;
    const draft = await repositories.sceneDrafts.create({
      id: "draft-1",
      template_id: "template-smoke",
      body: draftBody,
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z"
    });
    expect(draft.body).toEqual(draftBody);

    const updatedDraft = await repositories.sceneDrafts.update("draft-1", {
      body: { ...draftBody, fields: { purpose: "interview" } },
      updated_at: "2026-06-19T00:01:00.000Z"
    });
    expect(updatedDraft.body).toEqual({ title: "Draft", fields: { purpose: "interview" } });

    const confirmed = await repositories.confirmedScenes.create({
      id: "confirmed-1",
      draft_id: "draft-1",
      scenario: jobInterviewSmokeFixture,
      created_at: "2026-06-19T00:02:00.000Z"
    });
    await repositories.sceneDrafts.update("draft-1", {
      body: { title: "Mutated draft" },
      updated_at: "2026-06-19T00:03:00.000Z"
    });
    expect((await repositories.confirmedScenes.get("confirmed-1"))?.scenario).toEqual(confirmed.scenario);

    const pending = await repositories.reviewReports.createPending({
      id: "review-1",
      session_id: "session-review",
      created_at: "2026-06-19T00:04:00.000Z"
    });
    expect(pending.status).toBe("pending");
    const evidenceRef = {
      session_id: "session-review",
      event_id: "event-review",
      sequence: 1,
      step_id: "answer_question",
      actor_id: "user_candidate"
    };
    const succeeded = await repositories.reviewReports.saveSucceeded("review-1", {
      summary: "Useful review",
      dimensions: [{ name: "clarity", conclusion: "Clear", evidence_refs: [evidenceRef] }],
      key_moments: [{ title: "Answer", description: "Candidate answered with ownership.", evidence_ref: evidenceRef }],
      recommendations: [{ text: "Add one metric.", evidence_refs: [evidenceRef] }],
      evidence_refs: [evidenceRef],
      uncertainty_notes: ["Only one evidence event was available."],
      completed_at: "2026-06-19T00:05:00.000Z"
    });
    expect(succeeded).toMatchObject({
      status: "succeeded",
      summary: "Useful review",
      evidence_refs: [evidenceRef],
      dimensions: [{ evidence_refs: [evidenceRef] }]
    });
    const failed = await repositories.reviewReports.saveFailed("review-1", {
      error_message: "regenerated failure",
      completed_at: "2026-06-19T00:06:00.000Z"
    });
    expect(failed).toMatchObject({ status: "failed", error_message: "regenerated failure" });

    const material = await repositories.materials.create({
      id: "material-1",
      source: "manual",
      title: "Resume notes",
      content: { note: "No secrets here" },
      created_at: "2026-06-19T00:07:00.000Z"
    });
    expect(await repositories.materials.get("material-1")).toEqual(material);

    const safePayload = JSON.stringify({
      draft: await repositories.sceneDrafts.get("draft-1"),
      confirmed: await repositories.confirmedScenes.get("confirmed-1"),
      review: await repositories.reviewReports.get("review-1"),
      material: await repositories.materials.get("material-1"),
      modelConfigs: await repositories.modelConfigs.listSafe()
    });
    expect(safePayload).not.toContain(dummyApiKey);
    expect(safePayload).not.toMatch(/api_key_(ciphertext|iv|tag)/);
  });
});
