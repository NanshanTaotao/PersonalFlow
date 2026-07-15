import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase as createStorageDatabase, createRepositories, createTestDatabase, type TestDatabase } from "@personalflow/storage";
import { buildDraftFromTemplate, hashNormalizedScenario, type ExportedScene } from "@personalflow/templates";

import { buildApp } from "./app";
import { createProductApiContext } from "./context";
import { isEndedForReview } from "./routes/reviews";

const encryptionKey = new Uint8Array(32).fill(9);
const databases: TestDatabase[] = [];

const createDatabase = (): TestDatabase => {
  const database = createTestDatabase({ encryptionKey });
  databases.push(database);
  return database;
};

const createDraftSceneAndSession = async () => {
  const database = createDatabase();
  const context = createProductApiContext({ database });
  const app = buildApp({ context, logger: false });
  const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "draft-session" } });
  const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "confirm-session" } });
  const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "start-session" } });
  return { app, context, database, sceneId: confirmed.json().scene.id, sessionId: started.json().session.id, started: started.json() };
};

const createBlockedSceneAndSession = async () => {
  const database = createDatabase();
  const context = createProductApiContext({ database });
  const app = buildApp({ context, logger: false });
  const built = buildDraftFromTemplate("job_interview", {});
  const scenario = {
    ...built.scenario,
    id: "scenario_api_runtime_blocked",
    steps: built.scenario.steps.map((step) => ({
      ...step,
      preconditions: [{ op: "eq" as const, path: "$.state.turn_count", value: 99 }]
    }))
  };
  const scene = await context.repositories.confirmedScenes.create({
    id: "scene_api_runtime_blocked",
    draft_id: null,
    scenario,
    created_at: context.now()
  });
  const started = await app.inject({
    method: "POST",
    url: `/api/scenes/${scene.id}/sessions`,
    payload: { idempotency_key: "api-blocked-start" }
  });
  return { app, database, scene, sessionId: started.json().session.id as string, started };
};

const reviewReportCount = (database: TestDatabase): number => {
  const row = database.sqlite.prepare("select count(*) as count from review_reports").get() as { count: number };
  return row.count;
};

const assertNoSecurityLeak = (value: unknown, secrets: readonly string[] = []): void => {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).not.toMatch(/api_key_(ciphertext|iv|tag)/i);
  expect(serialized).not.toMatch(/"api_key"\s*:/i);
  expect(serialized).not.toMatch(/authorization|bearer|ciphertext|provider raw|raw response|request_headers/i);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (databases.length > 0) {
    databases.pop()?.cleanup();
  }
});

describe("PersonalFlow product API", () => {
  it("attaches reusable and temporary text materials once and exposes them to AI safely", async () => {
    const database = createDatabase();
    const context = createProductApiContext({ database });
    const app = buildApp({ context, logger: false });
    const materialSecret = "Authorization: Bearer test-material-api-secret";
    const libraryFullText = "LIBRARY_FULL_MATERIAL_SHOULD_NOT_RENDER";
    const temporaryFullText = "TEMPORARY_FULL_MATERIAL_SHOULD_NOT_RENDER";

    const createdMaterial = await app.inject({
      method: "POST",
      url: "/api/materials",
      payload: {
        title: "答辩背景材料",
        text: `${libraryFullText} 项目目标是提升复盘质量。${materialSecret}`,
        source: "manual",
        idempotency_key: "material-create"
      }
    });
    expect(createdMaterial.statusCode).toBe(201);

    const draft = await app.inject({
      method: "POST",
      url: "/api/drafts/from-template",
      payload: { template_id: "thesis_defense", params: {}, idempotency_key: "material-draft" }
    });
    const draftId = draft.json().draft.id;
    const materialId = createdMaterial.json().material.id;

    const invalidTemporaryTitle = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: {
        kind: "temporary_text",
        title: "   ",
        text: "有效临时正文",
        idempotency_key: "material-attach-temporary-invalid-title"
      }
    });
    expect(invalidTemporaryTitle.statusCode).toBe(400);
    expect(invalidTemporaryTitle.json().error.code).toBe("validation_error");

    const invalidTemporaryText = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: {
        kind: "temporary_text",
        title: "有效临时标题",
        text: "   ",
        idempotency_key: "material-attach-temporary-invalid-text"
      }
    });
    expect(invalidTemporaryText.statusCode).toBe(400);
    expect(invalidTemporaryText.json().error.code).toBe("validation_error");

    const firstLibraryAttach = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: { kind: "library", material_id: materialId, idempotency_key: "material-attach-library-1" }
    });
    expect(firstLibraryAttach.statusCode).toBe(200);

    const duplicateLibraryAttach = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: { material_id: materialId, idempotency_key: "material-attach-library-2" }
    });
    expect(duplicateLibraryAttach.statusCode).toBe(200);

    const temporaryAttach = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: {
        kind: "temporary_text",
        title: "本场临时重点",
        text: `${temporaryFullText} 本场重点追问证据链和限制说明。`,
        idempotency_key: "material-attach-temporary-1"
      }
    });
    expect(temporaryAttach.statusCode).toBe(200);

    const duplicateTemporaryAttach = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: {
        kind: "temporary_text",
        title: "本场临时重点",
        text: `${temporaryFullText} 本场重点追问证据链和限制说明。`,
        idempotency_key: "material-attach-temporary-2"
      }
    });
    expect(duplicateTemporaryAttach.statusCode).toBe(200);

    const whitespaceDuplicateTemporaryAttach = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: {
        kind: "temporary_text",
        title: "  本场临时重点  ",
        text: ` \n ${temporaryFullText}   本场重点追问证据链和限制说明。 \t `,
        idempotency_key: "material-attach-temporary-3"
      }
    });
    expect(whitespaceDuplicateTemporaryAttach.statusCode).toBe(200);

    const attachedDraft = whitespaceDuplicateTemporaryAttach.json().draft;
    expect(attachedDraft.preview.materials).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "评审背景" })
    ]));
    expect(attachedDraft.preview.attached_materials).toHaveLength(2);
    expect(attachedDraft.preview.attached_materials.filter((material: { source_type: string; label: string }) =>
      material.source_type === "temporary_text" && material.label === "本场临时重点"
    )).toHaveLength(1);
    expect(attachedDraft.preview.attached_materials).toEqual([
      expect.objectContaining({
        label: "答辩背景材料",
        source_label: "手动粘贴",
        source_ref: expect.stringMatching(/^material:/),
        source_type: "library_text",
        value: expect.stringContaining("可用于演练上下文"),
        visibility: expect.objectContaining({
          mode: "all_stages",
          summary_label: "全部角色全文可见",
          entries: expect.arrayContaining([
            expect.objectContaining({ role_id: "ai_chair_reviewer", access: "full" })
          ])
        })
      }),
      expect.objectContaining({
        label: "本场临时重点",
        source_label: "临时文本",
        source_ref: expect.stringMatching(/^temporary_text:/),
        source_type: "temporary_text",
        value: expect.stringContaining("可用于演练上下文"),
        visibility: expect.objectContaining({
          mode: "all_stages",
          summary_label: "全部角色全文可见",
          entries: expect.arrayContaining([
            expect.objectContaining({ role_id: "ai_chair_reviewer", access: "full" })
          ])
        })
      })
    ]);
    expect(attachedDraft.visibility_options.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ai_chair_reviewer", kind: "ai" })
    ]));
    expect(attachedDraft.visibility_options.stages.length).toBeGreaterThan(0);

    const storedDraft = await context.repositories.sceneDrafts.get(draftId);
    expect(storedDraft).not.toBeNull();
    const storedScenario = (storedDraft?.body as unknown as { readonly scenario: { readonly resources: Record<string, unknown>; readonly visibility_policy: { readonly rules: readonly { readonly id: string; readonly target: { readonly kind: string; readonly path: string }; readonly access: string }[] } } }).scenario;
    const materialKeys = Object.keys(storedScenario.resources.user_materials_by_ref as Record<string, unknown>);
    expect(materialKeys).toHaveLength(2);
    expect(storedScenario.resources.user_material_visibility).toBeDefined();
    expect(storedScenario.visibility_policy.rules.some((rule) => rule.id === "user_materials_visible" || rule.target.path === "$.resources.user_materials")).toBe(false);
    expect(storedScenario.visibility_policy.rules.filter((rule) => rule.id.startsWith("user_material_visibility_"))).toEqual(
      expect.arrayContaining(materialKeys.map((materialKey) => expect.objectContaining({
        target: { kind: "resource", path: `$.resources.user_materials_by_ref.${materialKey}` },
        access: "full"
      })))
    );
    assertNoSecurityLeak(createdMaterial.json(), [materialSecret, libraryFullText]);
    assertNoSecurityLeak(attachedDraft, [materialSecret, libraryFullText, temporaryFullText]);

    const listedMaterials = await app.inject({ method: "GET", url: "/api/materials" });
    expect(listedMaterials.json().materials.map((material: { title: string }) => material.title)).toContain("答辩背景材料");
    expect(listedMaterials.json().materials.map((material: { title: string }) => material.title)).not.toContain("本场临时重点");

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/confirm`,
      payload: { idempotency_key: "material-confirm" }
    });
    const started = await app.inject({
      method: "POST",
      url: `/api/scenes/${confirmed.json().scene.id}/sessions`,
      payload: { idempotency_key: "material-session" }
    });
    const aiTurn = await app.inject({
      method: "POST",
      url: `/api/sessions/${started.json().session.id}/ai-turn`,
      payload: { actor_id: "ai_chair_reviewer", expected_state_version: 0, idempotency_key: "material-ai-turn" }
    });
    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().ai_turn_observability.visible_materials).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/^\$\.resources\.user_materials_by_ref\.um_/),
        value: [expect.objectContaining({ title: "答辩背景材料", source_type: "library_text" })]
      }),
      expect.objectContaining({
        path: expect.stringMatching(/^\$\.resources\.user_materials_by_ref\.um_/),
        value: [expect.objectContaining({ title: "本场临时重点", source_type: "temporary_text" })]
      })
    ]);
    assertNoSecurityLeak(aiTurn.json(), [materialSecret, libraryFullText, temporaryFullText]);
  });

  it("updates one material visibility by source_ref without duplicate or conflicting rules", async () => {
    const database = createDatabase();
    const context = createProductApiContext({ database });
    const app = buildApp({ context, logger: false });
    const materialFullText = "PATCH_VISIBILITY_FULL_CONTEXT_MARKER";

    const createdMaterial = await app.inject({
      method: "POST",
      url: "/api/materials",
      payload: {
        title: "候选人简历",
        text: `${materialFullText} 有 8 年后端经验。`,
        source: "manual",
        idempotency_key: "visibility-material-create"
      }
    });
    const draft = await app.inject({
      method: "POST",
      url: "/api/drafts/from-template",
      payload: { template_id: "job_interview", params: {}, idempotency_key: "visibility-draft" }
    });
    const draftId = draft.json().draft.id as string;
    const attached = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/materials`,
      payload: { kind: "library", material_id: createdMaterial.json().material.id, idempotency_key: "visibility-attach" }
    });
    const sourceRef = attached.json().draft.preview.attached_materials[0].source_ref as string;
    const roles = attached.json().draft.visibility_options.roles as Array<{ id: string; kind: "user" | "ai" }>;
    const aiRole = roles.find((role) => role.kind === "ai");
    expect(aiRole).toBeDefined();

    const summaryVisibility = {
      mode: "all_stages",
      entries: roles.map((role) => ({
        role_id: role.id,
        access: role.id === aiRole?.id ? "summary" : "hidden"
      }))
    };
    const firstPatch = await app.inject({
      method: "PATCH",
      url: `/api/drafts/${draftId}/materials/visibility`,
      payload: {
        source_ref: sourceRef,
        visibility: summaryVisibility,
        idempotency_key: "visibility-patch-summary-1"
      }
    });
    expect(firstPatch.statusCode).toBe(200);
    expect(firstPatch.json().draft.preview.attached_materials[0].visibility).toMatchObject({
      source_ref: sourceRef,
      mode: "all_stages",
      summary_label: "自定义可见性",
      entries: expect.arrayContaining([
        expect.objectContaining({ role_id: aiRole?.id, access: "summary" })
      ])
    });

    const duplicatePatch = await app.inject({
      method: "PATCH",
      url: `/api/drafts/${draftId}/materials/visibility`,
      payload: {
        source_ref: sourceRef,
        visibility: summaryVisibility,
        idempotency_key: "visibility-patch-summary-2"
      }
    });
    expect(duplicatePatch.statusCode).toBe(200);

    const storedAfterDuplicate = await context.repositories.sceneDrafts.get(draftId);
    const storedScenario = (storedAfterDuplicate?.body as unknown as { readonly scenario: { readonly resources: Record<string, unknown>; readonly visibility_policy: { readonly rules: readonly { readonly id: string; readonly subject: { readonly role_ids?: readonly string[] }; readonly target: { readonly path: string }; readonly access: string }[] } } }).scenario;
    const materialKey = Object.keys(storedScenario.resources.user_materials_by_ref as Record<string, unknown>)[0];
    const generatedRules = storedScenario.visibility_policy.rules.filter((rule) => rule.id.startsWith(`user_material_visibility_${materialKey}_`));
    expect(generatedRules).toHaveLength(1);
    expect(generatedRules[0]).toMatchObject({
      subject: { role_ids: [aiRole?.id] },
      target: { path: `$.resources.user_materials_by_ref.${materialKey}` },
      access: "summary"
    });
    expect(storedScenario.visibility_policy.rules.some((rule) => rule.target.path === "$.resources.user_materials")).toBe(false);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/drafts/${draftId}/confirm`,
      payload: { idempotency_key: "visibility-confirm-summary" }
    });
    const started = await app.inject({
      method: "POST",
      url: `/api/scenes/${confirmed.json().scene.id}/sessions`,
      payload: { idempotency_key: "visibility-start-summary" }
    });
    const aiTurn = await app.inject({
      method: "POST",
      url: `/api/sessions/${started.json().session.id}/ai-turn`,
      payload: { actor_id: aiRole?.id, expected_state_version: 0, idempotency_key: "visibility-ai-summary" }
    });
    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().ai_turn_observability.visible_materials).toEqual([
      expect.objectContaining({
        path: `$.resources.user_materials_by_ref.${materialKey}`,
        value: [expect.objectContaining({ title: "候选人简历", summary: expect.stringContaining("可用于演练上下文") })]
      })
    ]);
    assertNoSecurityLeak(aiTurn.json(), [materialFullText]);

    const hiddenPatch = await app.inject({
      method: "PATCH",
      url: `/api/drafts/${draftId}/materials/visibility`,
      payload: {
        source_ref: sourceRef,
        visibility: {
          mode: "all_stages",
          entries: roles.map((role) => ({ role_id: role.id, access: "hidden" }))
        },
        idempotency_key: "visibility-patch-hidden"
      }
    });
    expect(hiddenPatch.statusCode).toBe(200);
    const storedAfterHidden = await context.repositories.sceneDrafts.get(draftId);
    const hiddenScenario = (storedAfterHidden?.body as unknown as { readonly scenario: { readonly visibility_policy: { readonly rules: readonly { readonly id: string }[] } } }).scenario;
    expect(hiddenScenario.visibility_policy.rules.filter((rule) => rule.id.startsWith(`user_material_visibility_${materialKey}_`))).toHaveLength(0);
  });

  it("creates a new independent session when restarting practice from a review", async () => {
    const { app, database, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/ai-turn`, payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "repractice-ai" } });
    const answer = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/input`,
      payload: { input: "我用指标验证了项目收益。", expected_state_version: opening.json().session.view.state_version, idempotency_key: "repractice-answer" }
    });
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload: { expected_state_version: answer.json().session.view.state_version, idempotency_key: "repractice-end" } });
    const review = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/reviews`, payload: { idempotency_key: "repractice-review" } });

    const restarted = await app.inject({
      method: "POST",
      url: `/api/reviews/${review.json().review.id}/repractice`,
      payload: { idempotency_key: "repractice-new-session" }
    });

    expect(restarted.statusCode).toBe(201);
    expect(restarted.json().session.id).not.toBe(sessionId);
    expect(restarted.json().session.status).toBe("running");
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json().session.status).toBe("ended");
    expect(reviewReportCount(database)).toBe(1);
    expect(JSON.stringify(restarted.json())).not.toMatch(/review_id|RuntimeEvent|raw state|storage row/i);
  });

  it("copies confirmed scenes to drafts and soft-deletes scenes without breaking historical reviews", async () => {
    const { app, sceneId, sessionId, started } = await createDraftSceneAndSession();
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload: { expected_state_version: started.session.view.state_version, idempotency_key: "scene-manage-end" } });
    const review = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/reviews`, payload: { idempotency_key: "scene-manage-review" } });
    const copied = await app.inject({
      method: "POST",
      url: `/api/scenes/${sceneId}/copy`,
      payload: { idempotency_key: "scene-copy" }
    });
    expect(copied.statusCode).toBe(201);
    expect(copied.json().draft.preview.title.value).toMatch(/副本/);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/scenes/${sceneId}`,
      payload: { idempotency_key: "scene-delete", confirm: true }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, message: "场景已从默认列表移除，历史演练和复盘仍可查看。" });
    expect((await app.inject({ method: "GET", url: "/api/recent" })).json().scenes).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/reviews/${review.json().review.id}` })).statusCode).toBe(200);
  });

  it("returns safe session history details with transcript, model summary, timing and review links", async () => {
    const { app, sceneId, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/ai-turn`, payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "history-ai" } });
    const answer = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/input`,
      payload: { input: "我负责了平台稳定性改造。", expected_state_version: opening.json().session.view.state_version, idempotency_key: "history-answer" }
    });
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload: { expected_state_version: answer.json().session.view.state_version, idempotency_key: "history-end" } });
    const review = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/reviews`, payload: { idempotency_key: "history-review" } });

    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });

    expect(history.statusCode).toBe(200);
    expect(history.json().history).toMatchObject({
      title: "求职面试",
      status: "ended",
      scene: { title: "求职面试", archived: false },
      rounds: 2,
      model_summary: { label: "Fake LLM", mode: "fake" },
      reviews: [{ id: review.json().review.id, title: "求职面试复盘", status: "succeeded" }]
    });
    expect(history.json().history.created_at).toEqual(expect.any(String));
    expect(history.json().history.updated_at).toEqual(expect.any(String));
    expect(history.json().history.transcript).toEqual([
      expect.objectContaining({ speaker: "后端面试官", text: "Simulated AI response." }),
      expect.objectContaining({ speaker: "候选人", text: "我负责了平台稳定性改造。" })
    ]);
    expect(JSON.stringify(history.json())).not.toMatch(new RegExp(`${sessionId}|${sceneId}|session_id|scenario_id|event_id|actor_id|step_id|state_version|RuntimeEvent|raw state`, "i"));
  });

  it("aggregates scene archive summaries and keeps history readable after scene deletion while blocking new sessions", async () => {
    const { app, sceneId, sessionId, started } = await createDraftSceneAndSession();
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload: { expected_state_version: started.session.view.state_version, idempotency_key: "archive-end" } });
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/reviews`, payload: { idempotency_key: "archive-review" } });
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/scenes/${sceneId}`,
      payload: { title: "后端平台面试", idempotency_key: "archive-rename" }
    });
    expect(renamed.statusCode).toBe(200);

    const beforeDelete = await app.inject({ method: "GET", url: "/api/scenes/archive" });
    expect(beforeDelete.statusCode).toBe(200);
    expect(beforeDelete.json().scenes).toEqual([
      expect.objectContaining({
        title: "后端平台面试",
        archived: false,
        session_count: 1,
        review_count: 1,
        latest_session: expect.objectContaining({ title: "后端平台面试", status: "ended" })
      })
    ]);

    await app.inject({ method: "DELETE", url: `/api/scenes/${sceneId}`, payload: { confirm: true, idempotency_key: "archive-delete" } });
    const restart = await app.inject({ method: "POST", url: `/api/scenes/${sceneId}/sessions`, payload: { idempotency_key: "archive-restart" } });
    expect(restart.statusCode).toBe(400);
    expect(restart.json().error.message).toMatch(/已归档|不能开始/);

    const historyAfterDelete = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(historyAfterDelete.statusCode).toBe(200);
    expect(historyAfterDelete.json().history.scene.archived).toBe(true);
    expect(historyAfterDelete.json().history.title).toBe("后端平台面试");
    expect(JSON.stringify(historyAfterDelete.json())).not.toMatch(/session_id|scenario_id|event_id|actor_id|step_id|state_version/i);
  });

  it("keeps recent and archive list APIs readable when legacy rows with invalid scenarios would otherwise fill the page", async () => {
    const { app, database, sceneId, sessionId } = await createDraftSceneAndSession();
    const rawLegacyScenario = JSON.stringify({
      schema_version: "legacy",
      id: "legacy_thesis_raw_id",
      title: "LEGACY_RAW_SCENARIO_SHOULD_NOT_LEAK",
      stack: "ZodError: legacy scenario shape"
    });
    for (const index of Array.from({ length: 12 }, (_item, itemIndex) => itemIndex)) {
      const timestamp = `9999-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      database.sqlite
        .prepare("insert into confirmed_scenes (id, draft_id, scenario_json, created_at, deleted_at) values (?, ?, ?, ?, ?)")
        .run(`scene_legacy_bad_${index}`, null, rawLegacyScenario, timestamp, null);
      database.sqlite
        .prepare("insert into sessions (session_id, scenario_id, status, state_version, scenario_json, view_json) values (?, ?, ?, ?, ?, ?)")
        .run(`session_legacy_bad_${index}`, "legacy_thesis_raw_id", "ended", 1, rawLegacyScenario, null);
      database.sqlite
        .prepare(
          "insert into runtime_events (id, session_id, sequence, state_version_before, state_version_after, type, event_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(`event_legacy_bad_${index}`, `session_legacy_bad_${index}`, 1, 0, 1, "LegacyInvalid", "{}", timestamp);
    }
    database.sqlite
      .prepare(
        `insert into review_reports (
          id, session_id, status, summary, dimensions_json, key_moments_json, recommendations_json,
          evidence_refs_json, evidence_summary_json, credibility_checks_json, uncertainty_notes_json,
          created_at, completed_at, error_message, review_adapter_kind
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("review_legacy_bad", "session_legacy_bad_0", "succeeded", "历史复盘摘要", "[]", "[]", "[]", "[]", null, null, "[]", "9999-01-01T00:00:00.000Z", "9999-01-01T00:00:01.000Z", null, "legacy");

    const recent = await app.inject({ method: "GET", url: "/api/recent?limit=10" });
    const archive = await app.inject({ method: "GET", url: "/api/scenes/archive" });

    expect(recent.statusCode).toBe(200);
    expect(archive.statusCode).toBe(200);
    expect(recent.json().scenes).toEqual(expect.arrayContaining([expect.objectContaining({ id: sceneId, title: "求职面试" })]));
    expect(recent.json().sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: sessionId, title: "求职面试" })]));
    expect(archive.json().scenes).toEqual(expect.arrayContaining([expect.objectContaining({ id: sceneId, title: "求职面试" })]));
    expect(JSON.stringify({ recent: recent.json(), archive: archive.json() })).not.toMatch(
      /storage_error|ZodError|stack|sqlite|sql\b|storage row|raw scenario|RuntimeEvent|LEGACY_RAW_SCENARIO_SHOULD_NOT_LEAK|schema_version|legacy_thesis_raw_id/i
    );
  });

  it("lists only product template summaries and details", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const list = await app.inject({ method: "GET", url: "/api/templates" });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.templates).toHaveLength(5);
    expect(body.templates[0]).toMatchObject({ id: "job_interview", title: "求职面试" });
    expect(body.templates[3]).toMatchObject({ id: "debate_match", title: "辩论赛" });
    expect(body.templates[4]).toMatchObject({ id: "b2b_sales_discovery", title: "B2B 销售客户发现与异议处理" });
    expect(JSON.stringify(body)).not.toContain("NormalizedScenario");
    const detail = await app.inject({ method: "GET", url: "/api/templates/job_interview" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ template: { id: "job_interview", param_schema: { additionalProperties: false }, default_params: { target_role: "后端工程师" } } });
    const missing = await app.inject({ method: "GET", url: "/api/templates/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("scenario_error");
  });

  it("creates a complex config scenario draft from structured product configuration without exposing runtime internals", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/drafts/from-complex-config",
      payload: {
        title: "增长平台项目评审",
        goal: "验证增长平台方案的证据链、风险和落地计划",
        user_role: "方案负责人",
        ai_roles: [
          { name: "业务评审", focus: "业务目标、指标口径和收益证据" },
          { name: "技术评审", focus: "系统复杂度、稳定性和上线风险" }
        ],
        stages: [
          { name: "开场", rounds: 1, follow_up_strategy: "确认目标和背景" },
          { name: "证据追问", rounds: 2, follow_up_strategy: "连续追问指标证据和取舍" },
          { name: "风险收束", rounds: 1, follow_up_strategy: "收束风险、限制和下一步计划" }
        ],
        termination: "完成风险收束后结束并进入复盘",
        idempotency_key: "complex-config-draft"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().draft).toMatchObject({
      template_id: "complex_config",
      preview: {
        title: { value: "增长平台项目评审" },
        user_role: { value: "方案负责人" },
        ai_role: { value: expect.stringContaining("业务评审") },
        flow: expect.arrayContaining([
          expect.objectContaining({ value: "开场：确认目标和背景（1 轮）" }),
          expect.objectContaining({ value: "证据追问：连续追问指标证据和取舍（2 轮）" }),
          expect.objectContaining({ value: "风险收束：收束风险、限制和下一步计划（1 轮）" })
        ])
      }
    });
    expect(created.json().draft.semantic_preview.visibility.map((item: { target: string }) => item.target)).toEqual(
      expect.arrayContaining([
        "演练状态：轮次进度",
        "演练状态：当前阶段",
        "演练状态：等待回应状态",
        "材料：场景配置摘要"
      ])
    );
    expect(created.json().draft.semantic_preview.review_dimensions.map((item: { title: string }) => item.title)).toEqual(
      expect.arrayContaining(["目标清晰度", "证据质量", "风险处理", "承诺可执行性"])
    );
    expect(JSON.stringify(created.json())).not.toMatch(/actor_id|step_id|scheduler|NormalizedScenario|RuntimeEvent|raw JSON/i);
    expect(JSON.stringify(created.json().draft.semantic_preview)).not.toMatch(
      /turn_count|slot_index|current_stage|awaiting_response|complex_config/
    );

    const checked = await app.inject({ method: "POST", url: `/api/drafts/${created.json().draft.id}/check`, payload: {} });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ status: "ready", ok: true });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/drafts/${created.json().draft.id}/confirm`,
      payload: { idempotency_key: "complex-config-confirm" }
    });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().scene.title).toBe("增长平台项目评审");
  });

  it("creates drafts, confirms scenes, starts sessions through SQLite, and enforces idempotency", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: { target_role: "平台工程师" }, idempotency_key: "draft-key-1" } });
    expect(draft.statusCode).toBe(201);
    const draftBody = draft.json();
    expect(draftBody.draft).toMatchObject({ template_id: "job_interview", preview: { title: { value: "求职面试" } } });
    expect(draftBody.draft.preview.quality.status).toBe("ready");
    expect(draftBody.draft.semantic_preview.quality.status).toBe("ready");
    expect(JSON.stringify(draftBody)).not.toContain("steps");
    expect(JSON.stringify(draftBody.draft.semantic_preview)).not.toMatch(/step_id|actor_id|RuntimeEvent|raw prompt/i);
    const draftReplay = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: { target_role: "平台工程师" }, idempotency_key: "draft-key-1" } });
    expect(draftReplay.statusCode).toBe(201);
    expect(draftReplay.json()).toEqual(draftBody);
    const draftConflict = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: { target_role: "后端工程师" }, idempotency_key: "draft-key-1" } });
    expect(draftConflict.statusCode).toBe(409);
    expect(draftConflict.json().error.code).toBe("conflict");
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draftBody.draft.id + "/confirm", payload: { idempotency_key: "confirm-key-1" } });
    expect(confirmed.statusCode).toBe(201);
    const confirmedBody = confirmed.json();
    expect(confirmedBody.scene).toMatchObject({ source_template_id: "job_interview" });
    expect(JSON.stringify(confirmedBody)).not.toContain("steps");
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmedBody.scene.id + "/sessions", payload: { idempotency_key: "session-key-1" } });
    expect(started.statusCode).toBe(201);
    const startedBody = started.json();
    expect(startedBody.session.view.state_version).toBe(0);
    expect(startedBody.session.view.allowed_steps[0]).toMatchObject({ id: "ask_opening_1" });
    expect(startedBody.session.timing).toEqual(expect.objectContaining({
      started_at: expect.any(String),
      updated_at: expect.any(String),
      suggested_duration_label: expect.stringMatching(/^建议约 \d+ 分钟$/)
    }));
    expect(startedBody.session.view).not.toHaveProperty("timing");
    expect(database.sqlite.prepare("select count(*) as count from runtime_events").get()).toEqual({ count: 1 });
    const replay = await app.inject({ method: "POST", url: "/api/scenes/" + confirmedBody.scene.id + "/sessions", payload: { idempotency_key: "session-key-1" } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(startedBody);
    expect(database.sqlite.prepare("select count(*) as count from runtime_events").get()).toEqual({ count: 1 });
  });

  it("returns productized errors instead of 500 when imported scene hash is tampered", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "tamper-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "tamper-confirm" } });
    const exported = await app.inject({ method: "GET", url: "/api/scenes/" + confirmed.json().scene.id + "/export" });
    const tampered = JSON.parse(JSON.stringify(exported.json().export_json)) as ExportedScene & { normalized_hash: string };
    tampered.normalized_hash = "0".repeat(hashNormalizedScenario(tampered.scene.scenario_package.runtime_ir).length);

    const imported = await app.inject({ method: "POST", url: "/api/scenes/import", payload: { export_json: tampered, idempotency_key: "tampered-import" } });

    expect(imported.statusCode).toBe(400);
    expect(imported.json().error).toMatchObject({
      code: "scenario_error",
      message: "场景文件校验失败，请重新导出后再导入。"
    });
    expect(JSON.stringify(imported.json())).not.toMatch(/Internal API operation failed|storage_error|normalized_hash mismatch|ZodError|stack|schema_version|RuntimeEvent|step_id|action_id|session_id/i);
  });

  it("checks drafts with real product status and blocks unusable scenarios without leaking internals", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const repositories = createRepositories(database);
    const valid = buildDraftFromTemplate("job_interview", {});
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "check-ready" } });

    const ready = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/check", payload: {} });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready", ok: true, issues: [], draft: { id: draft.json().draft.id } });
    expect(JSON.stringify(ready.json())).not.toMatch(/NormalizedScenario|ZodError|stack|schema_version|RuntimeEvent|step_id|action_id|actor_id|scenario_id|session_id/);

    const blockedScenario = {
      ...valid.scenario,
      roles: valid.scenario.roles.filter((actor) => actor.kind !== "user")
    };
    const blockedDraft = await repositories.sceneDrafts.create({
      id: "draft-missing-user",
      template_id: "job_interview",
      body: JSON.parse(JSON.stringify({ ...valid.body, scenario: blockedScenario })),
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z"
    });
    const blocked = await app.inject({ method: "POST", url: "/api/drafts/" + blockedDraft.id + "/check", payload: {} });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ status: "blocked", ok: false });
    expect(blocked.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "blocked",
        title: expect.any(String),
        message: expect.stringMatching(/用户|扮演|角色/),
        suggestion: expect.any(String)
      })
    ]));

    const confirmBlocked = await app.inject({ method: "POST", url: "/api/drafts/" + blockedDraft.id + "/confirm", payload: { idempotency_key: "blocked-confirm" } });
    expect(confirmBlocked.statusCode).toBe(400);
    expect(confirmBlocked.json().error.code).toBe("scenario_quality_blocked");
    expect(confirmBlocked.json().error.message).toMatch(/修复|不能开始|无法开始/);
    expect(JSON.stringify(confirmBlocked.json())).not.toMatch(/ZodError|stack|schema_version|RuntimeEvent|step_id|action_id|actor_id|scenario_id|session_id/);
  });

  it("returns product errors for draft check edge cases without raw exception details", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const repositories = createRepositories(database);
    const valid = buildDraftFromTemplate("job_interview", {});
    const blockedEvidenceScenario = {
      ...valid.scenario,
      steps: valid.scenario.steps.map((step) => ({ ...step, review_tags: [] }))
    };
    const blockedEvidenceDraft = await repositories.sceneDrafts.create({
      id: "draft-blocked-evidence",
      template_id: "job_interview",
      body: JSON.parse(JSON.stringify({ ...valid.body, scenario: blockedEvidenceScenario })),
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z"
    });
    const blockedEvidence = await app.inject({ method: "POST", url: "/api/drafts/" + blockedEvidenceDraft.id + "/check", payload: {} });
    expect(blockedEvidence.statusCode).toBe(200);
    expect(blockedEvidence.json()).toMatchObject({ status: "blocked", ok: false });
    expect(blockedEvidence.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "blocked", title: expect.any(String), message: expect.stringMatching(/复盘|证据/), suggestion: expect.any(String) })
    ]));

    const corruptDraft = await repositories.sceneDrafts.create({
      id: "draft-corrupt",
      template_id: "job_interview",
      body: JSON.parse(JSON.stringify({ ...valid.body, scenario: { damaged: true } })),
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z"
    });
    const corrupt = await app.inject({ method: "POST", url: "/api/drafts/" + corruptDraft.id + "/check", payload: {} });
    expect(corrupt.statusCode).toBe(200);
    expect(corrupt.json()).toMatchObject({ status: "blocked", ok: false });
    expect(corrupt.json().issues[0]).toMatchObject({ severity: "blocked", title: expect.any(String), message: expect.any(String), suggestion: expect.any(String) });

    const missing = await app.inject({ method: "POST", url: "/api/drafts/not-found/check", payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toMatch(/找不到|重新创建|返回首页/);

    expect(JSON.stringify([blockedEvidence.json(), corrupt.json(), missing.json()])).not.toMatch(/NormalizedScenario|ZodError|stack|schema_version|RuntimeEvent|step_id|action_id|actor_id|scenario_id|session_id|sqlite|drizzle/i);
  });

  it("lists recent local work items without exposing internal payloads", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const draft = await app.inject({
      method: "POST",
      url: "/api/drafts/from-template",
      payload: { template_id: "job_interview", params: {}, idempotency_key: "recent-draft" }
    });
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/drafts/" + draft.json().draft.id + "/confirm",
      payload: { idempotency_key: "recent-confirm" }
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/scenes/" + confirmed.json().scene.id + "/sessions",
      payload: { idempotency_key: "recent-session" }
    });
    const opening = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "recent-ai" }
    });
    await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/end",
      payload: { expected_state_version: opening.json().session.view.state_version, idempotency_key: "recent-end" }
    });
    await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/reviews",
      payload: { idempotency_key: "recent-review" }
    });

    const recent = await app.inject({ method: "GET", url: "/api/recent" });

    expect(recent.statusCode).toBe(200);
    expect(recent.json().drafts).toEqual([
      expect.objectContaining({ id: draft.json().draft.id, title: "求职面试", status: "draft" })
    ]);
    expect(recent.json().scenes).toEqual([
      expect.objectContaining({ id: confirmed.json().scene.id, title: "求职面试", status: "confirmed" })
    ]);
    expect(recent.json().sessions).toEqual([
      expect.objectContaining({ id: started.json().session.id, title: "求职面试", status: "ended" })
    ]);
    expect(recent.json().reviews).toEqual([
      expect.objectContaining({ status: "succeeded", title: "求职面试复盘" })
    ]);
    expect(JSON.stringify(recent.json())).not.toMatch(/normalized_scenario|RuntimeEvent|api[_-]?key|ciphertext|provider raw|raw prompt|state_version|step_id/i);
  });

  it("uses real ISO timestamps for recent session summaries", async () => {
    const database = createDatabase();
    const timestamps = [
      "2026-06-21T10:30:00.000Z",
      "2026-06-21T10:31:00.000Z",
      "2026-06-21T10:32:00.000Z"
    ];
    let index = 0;
    const context = createProductApiContext({
      database,
      now: () => {
        const timestamp = timestamps[Math.min(index++, timestamps.length - 1)];
        return timestamp ?? "2026-06-21T10:32:00.000Z";
      }
    });
    const app = buildApp({ context, logger: false });
    const draft = await app.inject({
      method: "POST",
      url: "/api/drafts/from-template",
      payload: { template_id: "job_interview", params: {}, idempotency_key: "recent-iso-draft" }
    });
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/drafts/" + draft.json().draft.id + "/confirm",
      payload: { idempotency_key: "recent-iso-confirm" }
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/scenes/" + confirmed.json().scene.id + "/sessions",
      payload: { idempotency_key: "recent-iso-session" }
    });

    const recent = await app.inject({ method: "GET", url: "/api/recent" });

    expect(recent.statusCode).toBe(200);
    expect(recent.json().sessions).toEqual([
      expect.objectContaining({
        id: started.json().session.id,
        created_at: "2026-06-21T10:32:00.000Z",
        updated_at: "2026-06-21T10:32:00.000Z"
      })
    ]);
  });

  it("restores recent records after recreating API context with the same SQLite file", async () => {
    const databasePath = path.join(os.tmpdir(), "personalflow-recent-" + Date.now() + ".sqlite");
    const firstDatabase = createStorageDatabase({ path: databasePath, encryptionKey });
    const firstApp = buildApp({ database: firstDatabase, logger: false });
    const draft = await firstApp.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "restart-draft" } });
    const confirmed = await firstApp.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "restart-confirm" } });
    const started = await firstApp.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "restart-session" } });
    firstDatabase.close();

    const secondDatabase = createTestDatabase({ path: databasePath, encryptionKey });
    databases.push(secondDatabase);
    const secondApp = buildApp({ database: secondDatabase, logger: false });
    const recent = await secondApp.inject({ method: "GET", url: "/api/recent" });

    expect(recent.statusCode).toBe(200);
    expect(recent.json().drafts[0]).toMatchObject({ id: draft.json().draft.id, title: "求职面试" });
    expect(recent.json().scenes[0]).toMatchObject({ id: confirmed.json().scene.id, title: "求职面试" });
    expect(recent.json().sessions[0]).toMatchObject({ id: started.json().session.id, title: "求职面试" });
  });

  it("uses an isolated stable SQLite file when no explicit path is configured", async () => {
    const originalCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "personalflow-default-"));
    vi.stubEnv("PERSONALFLOW_SQLITE_PATH", undefined);
    process.chdir(tempDir);
    try {
      const context = createProductApiContext();
      const app = buildApp({ context, logger: false });
      const recent = await app.inject({ method: "GET", url: "/api/recent" });
      expect(recent.statusCode).toBe(200);
      expect(recent.json()).toEqual({ drafts: [], scenes: [], sessions: [], reviews: [] });
      expect(fs.existsSync(path.join(tempDir, ".personalflow", "personalflow.sqlite"))).toBe(true);
      context.database.close();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("requires expected_state_version and avoids duplicate model calls", async () => {
    const { app, sessionId } = await createDraftSceneAndSession();
    const missingVersion = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/input", payload: { input: "I owned the launch.", idempotency_key: "input-missing-version" } });
    expect(missingVersion.statusCode).toBe(400);
    expect(missingVersion.json().error.code).toBe("validation_error");
    const aiTurn = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "ai-key-1" } });
    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().session.view.state_version).toBe(1);
    expect(aiTurn.json().session.view.allowed_steps.map((step: { id: string }) => step.id)).toContain("answer_opening_1");
    const aiReplay = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "ai-key-1" } });
    expect(aiReplay.statusCode).toBe(200);
    expect(aiReplay.json()).toEqual(aiTurn.json());
    const forbiddenInternals = await app.inject({
      method: "POST",
      url: "/api/sessions/" + sessionId + "/input",
      payload: {
        actor_id: "user_candidate",
        step_id: "answer_opening_1",
        input: "I owned the launch.",
        expected_state_version: aiTurn.json().session.view.state_version,
        idempotency_key: "input-forbidden-internals"
      }
    });
    expect(forbiddenInternals.statusCode).toBe(400);
    expect(forbiddenInternals.json().error.code).toBe("validation_error");
    const stale = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/input", payload: { input: "I owned the launch.", expected_state_version: 99, idempotency_key: "input-stale-version" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("conflict");
  });

  it("returns blocked product labels and allows blocked sessions to end while pause and resume stay blocked", async () => {
    const { app, database, sessionId, started } = await createBlockedSceneAndSession();

    expect(started.statusCode).toBe(201);
    expect(started.json().session.status).toBe("blocked");
    expect(started.json().session.view.blocked_summary).toMatchObject({
      reason: "no_allowed_step",
      message: expect.stringContaining("No allowed step")
    });

    const recent = await app.inject({ method: "GET", url: "/api/recent" });
    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const pause = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/pause`, payload: { expected_state_version: 0, idempotency_key: "api-blocked-pause" } });
    const resume = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/resume`, payload: { expected_state_version: 0, idempotency_key: "api-blocked-resume" } });
    const ended = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/end`, payload: { expected_state_version: 0, idempotency_key: "api-blocked-end" } });

    expect(recent.statusCode).toBe(200);
    expect(recent.json().sessions[0]).toMatchObject({
      id: sessionId,
      status: "blocked",
      status_label: "运行时已阻断"
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().history).toMatchObject({
      status: "blocked",
      status_label: "运行时已阻断"
    });
    expect(pause.statusCode).toBe(400);
    expect(resume.statusCode).toBe(400);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().session.status).toBe("ended");
    expect(reviewReportCount(database)).toBe(0);
  });

  it("returns safe AI turn adapter and selected model route observability", async () => {
    const { app, sessionId } = await createDraftSceneAndSession();
    const aiTurn = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "ai-observability-default" } });

    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().ai_turn_observability).toEqual({
      adapter_kind: "fake",
      model_config_id: "default",
      provider: "fake",
      model: "fake-llm",
      visible_history: []
    });
    assertNoSecurityLeak(aiTurn.json(), ["dummy-secret-for-debug-observability-only"]);
  });

  it("returns safe AI turn observability for saved model configs without exposing key material", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const secret = "dummy-secret-for-debug-observability-only";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-observable", display_name: "Observable model", api_key: secret, idempotency_key: "observable-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "observable-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "observable-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "observable-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "observable-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().ai_turn_observability).toEqual({
      adapter_kind: "fake",
      model_config_id: "default",
      provider: "fake",
      model: "fake-llm",
      visible_history: []
    });
    assertNoSecurityLeak(aiTurn.json(), [secret]);
    expect(JSON.stringify(aiTurn.json())).not.toMatch(/base_url|api_key|headers|request_headers/i);
  });

  it("returns the safe visible_history text_summary used by the current AI turn prompt", async () => {
    const { app, sessionId } = await createDraftSceneAndSession();
    const firstAi = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "visible-summary-first-ai" } });
    const userInput = await app.inject({
      method: "POST",
      url: "/api/sessions/" + sessionId + "/input",
      payload: {
        input: "I shipped the launch checklist.",
        expected_state_version: firstAi.json().session.view.state_version,
        idempotency_key: "visible-summary-user"
      }
    });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + sessionId + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: userInput.json().session.view.state_version, idempotency_key: "visible-summary-second-ai" }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().ai_turn_observability.visible_history).toEqual([
      expect.objectContaining({
        step_id: "ask_opening_1",
        text_summary: "Simulated AI response."
      }),
      expect.objectContaining({
        step_id: "answer_opening_1",
        text_summary: "I shipped the launch checklist."
      })
    ]);
    assertNoSecurityLeak(aiTurn.json(), ["FULL PROMPT", "provider raw response", "test-credential-like-secret"]);
    expect(JSON.stringify(aiTurn.json().session.view.visible_transcript.map((entry: { text: string }) => entry.text))).not.toMatch(/ask_interview_question|answer_opening_1/);
    expect(JSON.stringify(aiTurn.json().ai_turn_observability)).not.toMatch(/raw_prompt|FULL PROMPT|provider raw|secret|credential|args/i);
  });

  it("keeps saved OpenAI-compatible configs on Fake LLM unless the local real smoke switch is enabled", async () => {
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const secret = "dummy-secret-for-real-smoke-switch-test";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-smoke", display_name: "Local smoke model", api_key: secret, idempotency_key: "smoke-disabled-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "smoke-disabled-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "smoke-disabled-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "smoke-disabled-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "smoke-disabled-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().session.view.visible_transcript[0].text).toContain("Simulated AI response.");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("keeps Fake LLM as the default product mode even when saved configs exist", async () => {
    const database = createDatabase();
    const fetchCalls: string[] = [];
    const context = createProductApiContext({
      database,
      openAICompatibleFetch: async (input) => {
        fetchCalls.push(input);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: "step",
                      selected_step: "ask_opening_1",
                      content: "Unexpected real mode call.",
                      args: { question: "Unexpected real mode call." }
                    })
                  }
                }
              ]
            };
          }
        };
      }
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-default-fake-product-mode";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-default-fake", display_name: "Default fake model", api_key: secret, idempotency_key: "default-fake-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "default-fake-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "default-fake-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "default-fake-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "default-fake-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(fetchCalls).toEqual([]);
    expect(aiTurn.json().ai_turn_observability.adapter_kind).toBe("fake");
    expect(aiTurn.json().session.view.visible_transcript[0].text).toContain("Simulated AI response.");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("routes to OpenAI-compatible adapter when PERSONALFLOW_MODEL_MODE=real and a saved config exists", async () => {
    vi.stubEnv("PERSONALFLOW_MODEL_MODE", "real");
    const database = createDatabase();
    const fetchCalls: Array<{ input: string; init: { method: "POST"; headers: Record<string, string>; body: string } }> = [];
    const context = createProductApiContext({
      database,
      openAICompatibleFetch: async (input, init) => {
        fetchCalls.push({ input, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: "step",
                      selected_step: "ask_opening_1",
                      content: "Real product mode question?",
                      args: { question: "Real product mode question?" }
                    })
                  }
                }
              ]
            };
          }
        };
      }
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-real-product-mode";
    await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-product-real", display_name: "Real product model", api_key: secret, idempotency_key: "product-real-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "product-real-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "product-real-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "product-real-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "product-real-ai" }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe("https://provider.test/v1/chat/completions");
    expect(fetchCalls[0]?.init.headers.authorization).toBe("Bearer " + secret);
    expect(aiTurn.json().ai_turn_observability).toMatchObject({
      adapter_kind: "openai-compatible",
      provider: "openai-compatible",
      model: "gpt-product-real"
    });
    expect(aiTurn.json().session.view.visible_transcript[0].text).toBe("Real product mode question?");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("lets PERSONALFLOW_MODEL_MODE=fake override the legacy real smoke flag", async () => {
    vi.stubEnv("PERSONALFLOW_MODEL_MODE", "fake");
    vi.stubEnv("PERSONALFLOW_REAL_LLM_SMOKE", "1");
    const database = createDatabase();
    const fetchCalls: string[] = [];
    const context = createProductApiContext({
      database,
      openAICompatibleFetch: async (input) => {
        fetchCalls.push(input);
        return { ok: false, status: 401, text: async () => "Authorization: Bearer dummy-secret-for-mode-conflict" };
      }
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-mode-conflict";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-conflict", display_name: "Conflict model", api_key: secret, idempotency_key: "mode-conflict-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "mode-conflict-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "mode-conflict-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "mode-conflict-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "mode-conflict-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(fetchCalls).toEqual([]);
    expect(aiTurn.json().ai_turn_observability.adapter_kind).toBe("fake");
    expect(aiTurn.json().session.view.visible_transcript[0].text).toContain("Simulated AI response.");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("falls back to Fake LLM for invalid PERSONALFLOW_MODEL_MODE values even when the legacy flag is set", async () => {
    vi.stubEnv("PERSONALFLOW_MODEL_MODE", "openai");
    vi.stubEnv("PERSONALFLOW_REAL_LLM_SMOKE", "1");
    const database = createDatabase();
    const fetchCalls: string[] = [];
    const context = createProductApiContext({
      database,
      openAICompatibleFetch: async (input) => {
        fetchCalls.push(input);
        return { ok: false, status: 401, text: async () => "provider raw response" };
      }
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-invalid-mode";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-invalid-mode", display_name: "Invalid mode model", api_key: secret, idempotency_key: "invalid-mode-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "invalid-mode-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "invalid-mode-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "invalid-mode-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "invalid-mode-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(fetchCalls).toEqual([]);
    expect(aiTurn.json().ai_turn_observability.adapter_kind).toBe("fake");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("returns a product error in real model mode when no OpenAI-compatible config is saved without polluting session state", async () => {
    vi.stubEnv("PERSONALFLOW_MODEL_MODE", "real");
    const database = createDatabase();
    const app = buildApp({ database, logger: false });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "real-missing-config-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "real-missing-config-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "real-missing-config-start" } });
    const sessionId = started.json().session.id;

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + sessionId + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "real-missing-config-ai" }
    });

    expect(aiTurn.statusCode).toBe(400);
    expect(aiTurn.json().error).toMatchObject({
      code: "model_error",
      message: "当前为真实模型模式，但还没有可用模型配置，请到设置页保存 OpenAI 兼容配置。"
    });
    assertNoSecurityLeak(aiTurn.json());
    expect(JSON.stringify(aiTurn.json())).not.toMatch(/Cannot read|stack|provider raw|raw response|api_key|ciphertext/i);
    expect((await app.inject({ method: "GET", url: "/api/sessions/" + sessionId })).json().session.view.state_version).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/sessions/" + sessionId })).json().session.view.visible_transcript).toEqual([]);
    const events = await app.inject({ method: "GET", url: "/api/sessions/" + sessionId });
    expect(events.statusCode).toBe(200);
    expect((await createProductApiContext({ database }).runtime.listEvents(sessionId)).map((event) => event.type)).toEqual(["SessionStarted"]);
  });

  it("uses the saved OpenAI-compatible config only when the local real smoke switch is enabled", async () => {
    const database = createDatabase();
    const fetchCalls: Array<{ input: string; init: { method: "POST"; headers: Record<string, string>; body: string } }> = [];
    const context = createProductApiContext({
      database,
      enableOpenAICompatibleAdapter: true,
      openAICompatibleFetch: async (input, init) => {
        fetchCalls.push({ input, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: "step",
                      selected_step: "ask_opening_1",
                      content: "Real smoke question?",
                      args: { question: "Real smoke question?" }
                    })
                  }
                }
              ]
            };
          }
        };
      }
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-real-smoke-enabled-test";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-smoke", display_name: "Local smoke model", api_key: secret, idempotency_key: "smoke-enabled-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "smoke-enabled-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "smoke-enabled-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "smoke-enabled-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "smoke-enabled-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe("https://provider.test/v1/chat/completions");
    expect(fetchCalls[0]?.init.headers.authorization).toBe("Bearer " + secret);
    expect(JSON.parse(fetchCalls[0]?.init.body ?? "{}")).toMatchObject({ model: "gpt-smoke" });
    expect(aiTurn.json().session.view.visible_transcript[0].text).toBe("Real smoke question?");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("uses global fetch for OpenAI-compatible configs only through the local real smoke environment switch", async () => {
    vi.stubEnv("PERSONALFLOW_REAL_LLM_SMOKE", "1");
    const database = createDatabase();
    const fetchCalls: Array<{ input: string; init: { method: "POST"; headers: Record<string, string>; body: string } }> = [];
    const globalFetch = vi.fn(async (input: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => {
      fetchCalls.push({ input, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: "step",
                    selected_step: "ask_opening_1",
                    content: "Real smoke env question?",
                    args: { question: "Real smoke env question?" }
                  })
                }
              }
            ]
          };
        }
      };
    });
    vi.stubGlobal("fetch", globalFetch);
    const context = createProductApiContext({ database });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-real-smoke-env-test";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-smoke-env", display_name: "Local smoke env model", api_key: secret, idempotency_key: "smoke-env-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "smoke-env-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "smoke-env-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "smoke-env-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "smoke-env-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(fetchCalls[0]?.input).toBe("https://provider.test/v1/chat/completions");
    expect(fetchCalls[0]?.init.headers.authorization).toBe("Bearer " + secret);
    expect(aiTurn.json().session.view.visible_transcript[0].text).toBe("Real smoke env question?");
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("does not relax the Agent protocol for OpenAI-compatible real smoke responses", async () => {
    const database = createDatabase();
    const context = createProductApiContext({
      database,
      enableOpenAICompatibleAdapter: true,
      openAICompatibleFetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    step_id: "ask_opening_1",
                    content: "Wrong protocol.",
                    args: { question: "Wrong protocol." }
                  })
                }
              }
            ]
          };
        }
      })
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-real-smoke-protocol-test";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-smoke", display_name: "Local smoke model", api_key: secret, idempotency_key: "smoke-protocol-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "smoke-protocol-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "smoke-protocol-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "smoke-protocol-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "smoke-protocol-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().session.view.visible_transcript).toEqual([]);
    expect(aiTurn.json().session.view.state_version).toBe(0);
    assertNoSecurityLeak(aiTurn.json(), [secret, "Wrong protocol."]);
  });

  it("requires an injected mock transport before OpenAI-compatible model configs can run", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch touched Authorization: Bearer dummy-secret-for-failure-matrix-only");
    });
    vi.stubGlobal("fetch", globalFetch);
    const database = createDatabase();
    const context = createProductApiContext({
      database,
      enableOpenAICompatibleAdapter: true
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-failure-matrix-only";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-failure-matrix", display_name: "Failure matrix model", api_key: secret, idempotency_key: "failure-matrix-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "failure-matrix-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "failure-matrix-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "failure-matrix-start" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: {
        actor_id: "ai_backend_interviewer",
        expected_state_version: 0,
        model_config_id: created.json().model_config.id,
        idempotency_key: "failure-matrix-ai"
      }
    });

    expect(aiTurn.statusCode).toBe(200);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(aiTurn.json().session.view.visible_transcript).toEqual([]);
    expect(aiTurn.json().session.view.state_version).toBe(0);
    const events = await context.runtime.listEvents(started.json().session.id);
    expect(events.map((event) => event.type)).toEqual(["SessionStarted", "StepAttemptFailed"]);
    assertNoSecurityLeak(aiTurn.json(), [secret]);
  });

  it("keeps provider auth, 5xx, timeout and invalid JSON failures out of session state and API DTOs", async () => {
    const secret = "dummy-secret-for-provider-failure-matrix";
    const rawProviderBody = "Authorization: Bearer " + secret + "; provider raw response";
    const cases = [
      {
        name: "401",
        fetch: async () => ({ ok: false, status: 401, text: async () => rawProviderBody })
      },
      {
        name: "403",
        fetch: async () => ({ ok: false, status: 403, text: async () => rawProviderBody })
      },
      {
        name: "500",
        fetch: async () => ({ ok: false, status: 500, text: async () => rawProviderBody })
      },
      {
        name: "502",
        fetch: async () => ({ ok: false, status: 502, text: async () => rawProviderBody })
      },
      {
        name: "503",
        fetch: async () => ({ ok: false, status: 503, text: async () => rawProviderBody })
      },
      {
        name: "timeout",
        fetch: async () => {
          throw new Error("timeout " + rawProviderBody);
        }
      },
      {
        name: "invalid-json",
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("invalid JSON " + rawProviderBody);
          }
        })
      }
    ] as const;

    for (const item of cases) {
      const database = createDatabase();
      const context = createProductApiContext({
        database,
        enableOpenAICompatibleAdapter: true,
        openAICompatibleFetch: item.fetch
      });
      const app = buildApp({ context, logger: false });
      const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-failure-matrix", display_name: "Failure matrix model", api_key: secret, idempotency_key: "provider-failure-model-" + item.name } });
      const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "provider-failure-draft-" + item.name } });
      const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "provider-failure-confirm-" + item.name } });
      const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "provider-failure-start-" + item.name } });

      const aiTurn = await app.inject({
        method: "POST",
        url: "/api/sessions/" + started.json().session.id + "/ai-turn",
        payload: {
          actor_id: "ai_backend_interviewer",
          expected_state_version: 0,
          model_config_id: created.json().model_config.id,
          idempotency_key: "provider-failure-ai-" + item.name
        }
      });

      expect(aiTurn.statusCode, item.name).toBe(200);
      expect(aiTurn.json().session.view.visible_transcript, item.name).toEqual([]);
      expect(aiTurn.json().session.view.state_version, item.name).toBe(0);
      const events = await context.runtime.listEvents(started.json().session.id);
      expect(events.map((event) => event.type), item.name).toEqual(["SessionStarted", "StepAttemptFailed"]);
      assertNoSecurityLeak({ response: aiTurn.json(), events }, [secret, rawProviderBody]);
    }
  });

  it("returns a recoverable AI failure summary and keeps the submitted user answer after a real provider failure", async () => {
    const secret = "dummy-secret-for-recoverable-ai-failure";
    const database = createDatabase();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                kind: "step",
                selected_step: "ask_opening_1",
                content: "请介绍一个你主导的项目。",
                args: { question: "请介绍一个你主导的项目。" }
              })
            }
          }]
        })
      })
      .mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Authorization: Bearer " + secret + "; provider raw response"
      });
    const context = createProductApiContext({
      database,
      enableOpenAICompatibleAdapter: true,
      openAICompatibleFetch: fetchImpl
    });
    const app = buildApp({ context, logger: false });
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-recover", display_name: "Recoverable model", api_key: secret, idempotency_key: "recover-model" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "recover-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "recover-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "recover-start" } });
    const firstAi = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, model_config_id: created.json().model_config.id, idempotency_key: "recover-first-ai" }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/input",
      payload: {
        input: "我保留这次已经提交的回答。",
        expected_state_version: firstAi.json().session.view.state_version,
        idempotency_key: "recover-answer"
      }
    });

    const failedAi = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: answer.json().session.view.state_version, model_config_id: created.json().model_config.id, idempotency_key: "recover-second-ai" }
    });
    const reloaded = await app.inject({ method: "GET", url: "/api/sessions/" + started.json().session.id });
    const review = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/reviews",
      payload: { idempotency_key: "recover-failure-review" }
    });

    expect(failedAi.statusCode).toBe(200);
    expect(failedAi.json().session.view.visible_transcript.map((entry: { text: string }) => entry.text)).toContain("我保留这次已经提交的回答。");
    expect(failedAi.json().session.view.failure_summary).toMatchObject({
      can_retry: true,
      failed_attempts: 1,
      action_label: "重试当前 AI 回合"
    });
    expect(reloaded.json().session.view.failure_summary).toEqual(failedAi.json().session.view.failure_summary);
    expect(review.statusCode).toBe(202);
    expect(review.json().review).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("AI 回合失败"),
      review_adapter_kind: "failure-summary"
    });
    expect(review.json().review.error_message).toContain("重试当前 AI 回合");
    assertNoSecurityLeak({ failed: failedAi.json(), reloaded: reloaded.json() }, [secret]);
  });

  it("reports connection test layers separately when provider is reachable but the agent protocol is invalid", async () => {
    const database = createDatabase();
    const context = createProductApiContext({
      database,
      enableOpenAICompatibleAdapter: true,
      openAICompatibleFetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ step_id: "connection_test", content: "Wrong protocol.", args: { ok: "yes" } }) } }]
        })
      })
    });
    const app = buildApp({ context, logger: false });
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-protocol", display_name: "Protocol model", api_key: "dummy-secret-for-protocol-test", idempotency_key: "protocol-model" } });

    const tested = await app.inject({
      method: "POST",
      url: "/api/model-configs/" + created.json().model_config.id + "/test",
      payload: { idempotency_key: "protocol-test" }
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      ok: false,
      provider_reachable: true,
      auth_valid: true,
      json_parseable: true,
      protocol_valid: false,
      message: "连接可用但模型未按演练协议输出，请检查模型能力或提示配置。"
    });
    assertNoSecurityLeak(tested.json(), ["dummy-secret-for-protocol-test", "Wrong protocol."]);
  });

  it("sends a strict AgentAction prompt for OpenAI-compatible connection tests", async () => {
    const prompts: string[] = [];
    const context = createProductApiContext({
      database: createDatabase(),
      enableOpenAICompatibleAdapter: true,
      openAICompatibleFetch: async (_input, init) => {
        const body = JSON.parse(init.body) as { messages?: Array<{ content?: unknown }> };
        const prompt = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
        prompts.push(prompt);
        const hasStrictProtocolInstructions =
          prompt.includes("\"kind\"") &&
          prompt.includes("\"selected_step\"") &&
          prompt.includes("\"content\"") &&
          prompt.includes("\"args\"") &&
          prompt.includes("connection_test") &&
          prompt.includes("additionalProperties") &&
          prompt.includes("step_id") &&
          prompt.includes("selectedStep") &&
          prompt.includes("markdown");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: hasStrictProtocolInstructions
                  ? JSON.stringify({
                      kind: "step",
                      selected_step: "connection_test",
                      content: "连接测试通过。",
                      args: { ok: "yes" }
                    })
                  : JSON.stringify({ step_id: "connection_test", content: "Wrong protocol.", args: { ok: "yes" } })
              }
            }]
          })
        };
      }
    });
    const app = buildApp({ context, logger: false });
    const secret = "dummy-secret-for-strict-connection-prompt";
    const created = await app.inject({
      method: "POST",
      url: "/api/model-configs",
      payload: {
        provider: "openai-compatible",
        base_url: "https://provider.test/v1",
        model: "gpt-connection-prompt",
        display_name: "Connection prompt model",
        api_key: secret,
        idempotency_key: "connection-prompt-model"
      }
    });

    const tested = await app.inject({
      method: "POST",
      url: "/api/model-configs/" + created.json().model_config.id + "/test",
      payload: { idempotency_key: "connection-prompt-test" }
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      ok: true,
      provider_reachable: true,
      auth_valid: true,
      json_parseable: true,
      protocol_valid: true
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("connection_test");
    expect(prompts[0]).toContain('"kind"');
    expect(prompts[0]).toContain('"selected_step"');
    expect(prompts[0]).toContain('"args"');
    assertNoSecurityLeak({ response: tested.json(), prompt: prompts[0] }, [secret]);
  });

  it("keeps model config safe, uses injected connection test adapter, and does not create review rows for invalid sessions", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const secret = "fixture-key-9-secret";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://example.test/v1", model: "gpt-test", display_name: "Local test model", api_key: secret, idempotency_key: "model-create" } });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain(secret);
    expect(created.json().model_config).toMatchObject({ has_api_key: true });
    const tested = await app.inject({ method: "POST", url: "/api/model-configs/" + created.json().model_config.id + "/test", payload: { idempotency_key: "model-test" } });
    expect(tested.statusCode).toBe(200);
    expect(JSON.stringify(tested.json())).not.toContain(secret);
    expect(tested.json()).toMatchObject({ ok: true, model: "gpt-test" });
    const { app: reviewApp, database: reviewDatabase, sessionId } = await createDraftSceneAndSession();
    const review = await reviewApp.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/reviews", payload: { idempotency_key: "review-running" } });
    expect(review.statusCode).toBe(409);
    expect(review.json().error.code).toBe("conflict");
    expect(reviewReportCount(reviewDatabase)).toBe(0);

    const missing = await reviewApp.inject({ method: "POST", url: "/api/sessions/session_missing/reviews", payload: { idempotency_key: "review-missing" } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("scenario_error");
    expect(reviewReportCount(reviewDatabase)).toBe(0);
  });

  it("persists the selected default model config on the server and returns it after refresh", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const first = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://one.test/v1", model: "gpt-one", display_name: "One", api_key: "dummy-secret-one", idempotency_key: "default-model-one" } });
    const second = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://two.test/v1", model: "gpt-two", display_name: "Two", api_key: "dummy-secret-two", idempotency_key: "default-model-two" } });

    const initialList = await app.inject({ method: "GET", url: "/api/model-configs" });
    expect(initialList.statusCode).toBe(200);
    expect(initialList.json().default_model_config_id).toBe(first.json().model_config.id);

    const selected = await app.inject({
      method: "PATCH",
      url: "/api/model-configs/" + second.json().model_config.id + "/default",
      payload: { idempotency_key: "select-default-two" }
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().default_model_config_id).toBe(second.json().model_config.id);

    const afterRefresh = await app.inject({ method: "GET", url: "/api/model-configs" });
    expect(afterRefresh.json().default_model_config_id).toBe(second.json().model_config.id);
    assertNoSecurityLeak(afterRefresh.json(), ["dummy-secret-one", "dummy-secret-two"]);
  });

  it("uses the persisted default model config for real API practice when ai-turn omits model_config_id", async () => {
    const fetchCalls: Array<{ readonly input: string; readonly body: unknown; readonly authorization: string | undefined }> = [];
    const context = createProductApiContext({
      database: createDatabase(),
      enableOpenAICompatibleAdapter: true,
      openAICompatibleFetch: async (input, init) => {
        fetchCalls.push({
          input,
          body: JSON.parse(init.body) as unknown,
          authorization: init.headers.authorization
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  kind: "step",
                  selected_step: "ask_opening_1",
                  content: "真实默认模型提问。",
                  args: { question: "真实默认模型提问。" }
                })
              }
            }]
          })
        };
      }
    });
    const app = buildApp({ context, logger: false });
    const first = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://one.test/v1", model: "gpt-one", display_name: "One", api_key: "dummy-secret-one", idempotency_key: "real-default-one" } });
    const second = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://two.test/v1", model: "gpt-two", display_name: "Two", api_key: "dummy-secret-two", idempotency_key: "real-default-two" } });
    await app.inject({ method: "PATCH", url: "/api/model-configs/" + second.json().model_config.id + "/default", payload: { idempotency_key: "real-select-two" } });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "real-default-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "real-default-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "real-default-session" } });

    const aiTurn = await app.inject({
      method: "POST",
      url: "/api/sessions/" + started.json().session.id + "/ai-turn",
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "real-default-ai" }
    });

    expect(first.statusCode).toBe(201);
    expect(aiTurn.statusCode).toBe(200);
    expect(aiTurn.json().ai_turn_observability).toMatchObject({
      adapter_kind: "openai-compatible",
      model_config_id: second.json().model_config.id,
      provider: "openai-compatible",
      model: "gpt-two"
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe("https://two.test/v1/chat/completions");
    expect(fetchCalls[0]?.body).toMatchObject({ model: "gpt-two" });
    expect(fetchCalls[0]?.authorization).toBe("Bearer dummy-secret-two");
    assertNoSecurityLeak(aiTurn.json(), ["dummy-secret-one", "dummy-secret-two"]);
  });

  it("keeps every model config DTO response free of reversible key material and raw provider fields", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const secret = "dummy-secret-for-security-check-only";
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://example.test/v1", model: "gpt-test", display_name: "Security DTO model", api_key: secret, idempotency_key: "secure-model-create" } });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: "/api/model-configs" });
    const detailed = await app.inject({ method: "GET", url: "/api/model-configs/" + created.json().model_config.id });
    const updated = await app.inject({ method: "PATCH", url: "/api/model-configs/" + created.json().model_config.id, payload: { display_name: "Security DTO model updated", api_key: "dummy-secret-updated-security-check-only", idempotency_key: "secure-model-update" } });
    const tested = await app.inject({ method: "POST", url: "/api/model-configs/" + created.json().model_config.id + "/test", payload: { idempotency_key: "secure-model-test" } });
    const invalid = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://example.test/v1", model: "gpt-test", display_name: "Security DTO model", api_key: "", idempotency_key: "secure-model-invalid" } });

    for (const response of [created, listed, detailed, updated, tested, invalid]) {
      assertNoSecurityLeak(response.json(), [secret, "dummy-secret-updated-security-check-only"]);
    }
    expect(created.json().model_config).toMatchObject({ has_api_key: true, api_key_masked: expect.any(String) });
    expect(listed.json().model_configs[0]).toMatchObject({ has_api_key: true });
    expect(detailed.json().model_config).toMatchObject({ id: created.json().model_config.id, has_api_key: true });
    expect(updated.json().model_config).toMatchObject({ display_name: "Security DTO model updated", has_api_key: true });
    expect(tested.json()).toMatchObject({
      ok: true,
      provider: "openai-compatible",
      base_url: "https://example.test/v1",
      model: "gpt-test",
      provider_reachable: true,
      auth_valid: true,
      json_parseable: true,
      protocol_valid: true
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("replays model config update and delete idempotently and rejects key reuse with a different payload", async () => {
    const app = buildApp({ database: createDatabase(), logger: false });
    const created = await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://example.test/v1", model: "gpt-test", display_name: "Local test model", api_key: "fixture-key-9-secret", idempotency_key: "model-create-for-mutation" } });
    const modelConfigId = created.json().model_config.id;

    const updated = await app.inject({ method: "PATCH", url: "/api/model-configs/" + modelConfigId, payload: { display_name: "Renamed model", idempotency_key: "model-update-key" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().model_config.display_name).toBe("Renamed model");

    const updateReplay = await app.inject({ method: "PATCH", url: "/api/model-configs/" + modelConfigId, payload: { display_name: "Renamed model", idempotency_key: "model-update-key" } });
    expect(updateReplay.statusCode).toBe(200);
    expect(updateReplay.json()).toEqual(updated.json());

    const updateConflict = await app.inject({ method: "PATCH", url: "/api/model-configs/" + modelConfigId, payload: { display_name: "Different model", idempotency_key: "model-update-key" } });
    expect(updateConflict.statusCode).toBe(409);
    expect(updateConflict.json().error.code).toBe("conflict");

    const deleted = await app.inject({ method: "DELETE", url: "/api/model-configs/" + modelConfigId, payload: { idempotency_key: "model-delete-key" } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const deleteReplay = await app.inject({ method: "DELETE", url: "/api/model-configs/" + modelConfigId, payload: { idempotency_key: "model-delete-key" } });
    expect(deleteReplay.statusCode).toBe(200);
    expect(deleteReplay.json()).toEqual({ deleted: true });

    const deleteConflict = await app.inject({ method: "DELETE", url: "/api/model-configs/" + modelConfigId, payload: { reason: "different", idempotency_key: "model-delete-key" } });
    expect(deleteConflict.statusCode).toBe(409);
    expect(deleteConflict.json().error.code).toBe("conflict");
  });

  it("generates evidence-based reviews for ended sessions and replays idempotently", async () => {
    const { app, database, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "review-ai" } });
    await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/end", payload: { expected_state_version: opening.json().session.view.state_version, idempotency_key: "review-end" } });

    const review = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/reviews", payload: { idempotency_key: "review-create" } });
    expect(review.statusCode).toBe(201);
    expect(review.json().review).toMatchObject({ status: "succeeded", summary: expect.any(String), review_adapter_kind: "fake", evidence_refs: [expect.objectContaining({ session_id: sessionId })] });
    expect(JSON.stringify(review.json())).not.toContain("EVIDENCE_JSON_START");
    expect(JSON.stringify(review.json())).not.toContain("raw");

    const fetched = await app.inject({ method: "GET", url: "/api/reviews/" + review.json().review.id });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().review).toMatchObject({
      id: review.json().review.id,
      status: "succeeded",
      review_adapter_kind: "fake"
    });

    const replay = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/reviews", payload: { idempotency_key: "review-create" } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(review.json());

    const retrySucceeded = await app.inject({ method: "POST", url: "/api/reviews/" + review.json().review.id + "/retry", payload: { idempotency_key: "review-retry-succeeded" } });
    expect(retrySucceeded.statusCode).toBe(409);
    expect(retrySucceeded.json().error.code).toBe("conflict");
    expect(reviewReportCount(database)).toBe(1);
  });

  it("uses the saved OpenAI-compatible review adapter during local real LLM smoke without leaking provider data", async () => {
    vi.stubEnv("PERSONALFLOW_REAL_LLM_SMOKE", "1");
    const database = createDatabase();
    const secret = "dummy-secret-for-review-real-smoke";
    const fetchCalls: Array<{ input: string; init: { method: "POST"; headers: Record<string, string>; body: string } }> = [];
    const globalFetch = vi.fn(async (input: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => {
      fetchCalls.push({ input, init });
      const body = JSON.parse(init.body) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.[0]?.content ?? "";
      if (!prompt.includes("EVIDENCE_JSON_START")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: "step",
                      selected_step: "ask_opening_1",
                      content: "Real review setup question?",
                      args: { question: "Real review setup question?" }
                    })
                  }
                }
              ]
            };
          }
        };
      }
      const raw = prompt.slice(prompt.indexOf("EVIDENCE_JSON_START") + "EVIDENCE_JSON_START".length, prompt.indexOf("EVIDENCE_JSON_END")).trim();
      const first = JSON.parse(raw)[0].ref;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            provider_raw: "Authorization: Bearer " + secret,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Real review generated.",
                    dimensions: [{ name: "项目深度", conclusion: "Used the real review adapter.", evidence_refs: [first] }],
                    key_moments: [{ title: "Real adapter", description: "Review used OpenAI-compatible transport.", evidence_ref: first }],
                    recommendations: [{ text: "Keep evidence anchored.", evidence_refs: [first] }],
                    evidence_refs: [first],
                    uncertainty_notes: ["Generated in local real smoke mode."]
                  })
                }
              }
            ]
          };
        }
      };
    });
    vi.stubGlobal("fetch", globalFetch);
    const context = createProductApiContext({ database });
    const app = buildApp({ context, logger: false });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "review-real-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "review-real-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "review-real-start" } });
    const sessionId = started.json().session.id;
    await app.inject({ method: "POST", url: "/api/model-configs", payload: { provider: "openai-compatible", base_url: "https://provider.test/v1", model: "gpt-review-smoke", display_name: "Review smoke model", api_key: secret, idempotency_key: "review-real-model" } });
    const opening = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "review-real-ai" } });
    await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/end", payload: { expected_state_version: opening.json().session.view.state_version, idempotency_key: "review-real-end" } });

    const review = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/reviews", payload: { idempotency_key: "review-real-create" } });

    expect(review.statusCode).toBe(201);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.input).toBe("https://provider.test/v1/chat/completions");
    expect(fetchCalls[1]?.init.headers.authorization).toBe("Bearer " + secret);
    expect(review.json().review).toMatchObject({
      status: "succeeded",
      summary: "Real review generated.",
      review_adapter_kind: "openai-compatible"
    });
    assertNoSecurityLeak(review.json(), [secret, "Authorization: Bearer " + secret]);
    expect(JSON.stringify(review.json())).not.toMatch(/EVIDENCE_JSON_START|provider_raw|raw_prompt|request_headers/i);
  });

  it("saves failed review reports and retries them against current evidence", async () => {
    let calls = 0;
    let allowRetrySuccess = false;
    const database = createDatabase();
    const context = createProductApiContext({
      database,
      createReviewAdapter: () => ({
        async complete({ prompt }) {
          calls += 1;
          const raw = prompt.slice(prompt.indexOf("EVIDENCE_JSON_START") + "EVIDENCE_JSON_START".length, prompt.indexOf("EVIDENCE_JSON_END")).trim();
          const first = JSON.parse(raw)[0].ref;
          if (!allowRetrySuccess) {
            return { content: "{}" };
          }
          return { content: JSON.stringify({
            summary: "Retry succeeded.",
            dimensions: [{ name: "项目深度", conclusion: "Retry used fresh evidence.", evidence_refs: [first] }],
            key_moments: [{ title: "Retry", description: "Retry regenerated the report.", evidence_ref: first }],
            recommendations: [{ text: "Keep evidence anchored.", evidence_refs: [first] }],
            evidence_refs: [first],
            uncertainty_notes: ["Generated by retry path."]
          }) };
        }
      })
    });
    const app = buildApp({ context, logger: false });
    const draft = await app.inject({ method: "POST", url: "/api/drafts/from-template", payload: { template_id: "job_interview", params: {}, idempotency_key: "retry-draft" } });
    const confirmed = await app.inject({ method: "POST", url: "/api/drafts/" + draft.json().draft.id + "/confirm", payload: { idempotency_key: "retry-confirm" } });
    const started = await app.inject({ method: "POST", url: "/api/scenes/" + confirmed.json().scene.id + "/sessions", payload: { idempotency_key: "retry-start" } });
    const sessionId = started.json().session.id;
    const opening = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/ai-turn", payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "retry-ai" } });
    await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/end", payload: { expected_state_version: opening.json().session.view.state_version, idempotency_key: "retry-end" } });

    const failed = await app.inject({ method: "POST", url: "/api/sessions/" + sessionId + "/reviews", payload: { idempotency_key: "retry-create" } });
    expect(failed.statusCode).toBe(202);
    expect(failed.json().review).toMatchObject({ status: "failed", error_message: "review_schema_invalid" });
    expect(reviewReportCount(database)).toBe(1);

    allowRetrySuccess = true;
    const retried = await app.inject({ method: "POST", url: "/api/reviews/" + failed.json().review.id + "/retry", payload: { idempotency_key: "retry-once" } });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().review).toMatchObject({ id: failed.json().review.id, status: "succeeded", summary: "Retry succeeded." });
    expect(reviewReportCount(database)).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("forks from a visible transcript event into a child session tree without mutating the parent", async () => {
    const { app, database, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "fork-ai" }
    });
    const forkPoint = opening.json().session.view.visible_transcript[0];

    const forked = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/forks`,
      payload: {
        fork_point_event_id: forkPoint.event_id,
        include_selected_event: true,
        branch_label: "从开场问题分支",
        idempotency_key: "fork-visible-ai-question"
      }
    });

    expect(forked.statusCode).toBe(201);
    const body = forked.json();
    expect(body.session.id).not.toBe(sessionId);
    expect(body.session.view.visible_transcript).toEqual([
      expect.objectContaining({
        event_id: `${body.session.id}:1:StepCommitted`,
        actor_kind: "ai",
        text: forkPoint.text
      })
    ]);
    expect(body.branch).toMatchObject({
      session_id: body.session.id,
      parent_session_id: sessionId,
      label: "从开场问题分支",
      rounds: 1,
      is_current: true
    });
    expect(body.tree).toMatchObject({
      root_session_id: sessionId,
      current_session_id: body.session.id
    });
    expect(body.tree.nodes[0].children[0]).toMatchObject({ session_id: body.session.id });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json().session.view.visible_transcript[0].event_id).toBe(forkPoint.event_id);

    const branchRow = database.sqlite.prepare("select * from session_branches where session_id = ?").get(body.session.id) as {
      forked_from_event_id: string;
      forked_from_sequence: number;
      forked_from_state_version: number;
      fork_boundary_sequence: number;
      fork_boundary_state_version: number;
      include_selected_event: number;
    };
    expect(branchRow).toMatchObject({
      forked_from_event_id: forkPoint.event_id,
      forked_from_sequence: forkPoint.sequence,
      forked_from_state_version: 0,
      fork_boundary_sequence: forkPoint.sequence,
      fork_boundary_state_version: 1,
      include_selected_event: 1
    });
  });

  it("withdraws a user input by creating a new branch before that input", async () => {
    const { app, database, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "withdraw-ai" }
    });
    const answered = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/input`,
      payload: {
        input: "这条回答需要撤回。",
        expected_state_version: opening.json().session.view.state_version,
        idempotency_key: "withdraw-answer"
      }
    });
    const userEvent = answered.json().session.view.visible_transcript.find((entry: { actor_kind: string }) => entry.actor_kind === "user");

    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/withdraw`,
      payload: {
        user_event_id: userEvent.event_id,
        branch_label: "撤回后重写",
        idempotency_key: "withdraw-visible-user-input"
      }
    });

    expect(withdrawn.statusCode).toBe(201);
    const body = withdrawn.json();
    expect(body.withdrawn_input).toEqual({ text: "这条回答需要撤回。", event_id: userEvent.event_id });
    expect(body.session.view.visible_transcript.map((entry: { text: string }) => entry.text)).not.toContain("这条回答需要撤回。");
    expect(body.session.status).toBe("running");
    expect(body.branch.rounds).toBe(1);

    const branchRow = database.sqlite.prepare("select * from session_branches where session_id = ?").get(body.session.id) as {
      forked_from_event_id: string;
      forked_from_sequence: number;
      fork_boundary_sequence: number;
      fork_boundary_state_version: number;
      include_selected_event: number;
    };
    expect(branchRow).toMatchObject({
      forked_from_event_id: userEvent.event_id,
      forked_from_sequence: userEvent.sequence,
      fork_boundary_sequence: userEvent.sequence - 1,
      fork_boundary_state_version: opening.json().session.view.state_version,
      include_selected_event: 0
    });
  });

  it("replays fork and withdraw idempotency without creating duplicate branches or events", async () => {
    const { app, database, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "idempotency-ai" }
    });
    const aiEvent = opening.json().session.view.visible_transcript[0];
    const firstFork = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/forks`,
      payload: { fork_point_event_id: aiEvent.event_id, idempotency_key: "same-fork-key" }
    });
    const replayedFork = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/forks`,
      payload: { fork_point_event_id: aiEvent.event_id, idempotency_key: "same-fork-key" }
    });
    expect(replayedFork.statusCode).toBe(201);
    expect(replayedFork.json()).toEqual(firstFork.json());

    const answered = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/input`,
      payload: {
        input: "撤回用例回答。",
        expected_state_version: opening.json().session.view.state_version,
        idempotency_key: "idempotency-answer"
      }
    });
    const userEvent = answered.json().session.view.visible_transcript.find((entry: { actor_kind: string }) => entry.actor_kind === "user");
    const firstWithdraw = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/withdraw`,
      payload: { user_event_id: userEvent.event_id, idempotency_key: "same-withdraw-key" }
    });
    const replayedWithdraw = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/withdraw`,
      payload: { user_event_id: userEvent.event_id, idempotency_key: "same-withdraw-key" }
    });
    expect(replayedWithdraw.statusCode).toBe(201);
    expect(replayedWithdraw.json()).toEqual(firstWithdraw.json());
    expect(database.sqlite.prepare("select count(*) as count from session_branches").get()).toEqual({ count: 3 });
    expect(database.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({ count: 3 });
  });

  it("rejects fork and withdraw requests for internal, system, AI or other-session events", async () => {
    const first = await createDraftSceneAndSession();
    const second = await createDraftSceneAndSession();
    const events = await first.context.runtime.listEvents(first.sessionId);
    const internalEvent = events[0];
    if (internalEvent === undefined) {
      throw new Error("expected started session to have an internal event");
    }
    const internalEventId = internalEvent.id;

    const internalFork = await first.app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/forks`,
      payload: { fork_point_event_id: internalEventId, idempotency_key: "fork-internal" }
    });
    expect(internalFork.statusCode).toBe(400);
    expect(internalFork.json().error.message).toContain("无法从该位置创建分支");

    const paused = await first.app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/pause`,
      payload: { expected_state_version: 0, idempotency_key: "fork-system-pause" }
    });
    const systemEventId = paused.json().session.view.visible_transcript.find((entry: { actor_kind: string }) => entry.actor_kind === "system").event_id;
    const systemFork = await first.app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/forks`,
      payload: { fork_point_event_id: systemEventId, idempotency_key: "fork-system-event" }
    });
    expect(systemFork.statusCode).toBe(400);
    expect(systemFork.json().error.message).toContain("无法从该位置创建分支");

    const opening = await second.app.inject({
      method: "POST",
      url: `/api/sessions/${second.sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "withdraw-ai-reject" }
    });
    const aiEventId = opening.json().session.view.visible_transcript[0].event_id;
    const withdrawn = await second.app.inject({
      method: "POST",
      url: `/api/sessions/${second.sessionId}/withdraw`,
      payload: { user_event_id: aiEventId, idempotency_key: "withdraw-ai-event" }
    });
    expect(withdrawn.statusCode).toBe(400);
    expect(withdrawn.json().error.message).toContain("只能撤回自己的回答");

    const otherSessionFork = await first.app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/forks`,
      payload: { fork_point_event_id: aiEventId, idempotency_key: "fork-other-session" }
    });
    expect(otherSessionFork.statusCode).toBe(400);
    expect(otherSessionFork.json().error.message).toContain("无法从该位置创建分支");
  });

  it("creates root branch rows atomically for started and repractice sessions", async () => {
    const { app, sessionId } = await createDraftSceneAndSession();
    const tree = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/branch-tree` });

    expect(tree.statusCode).toBe(200);
    expect(tree.json().tree.nodes).toEqual([
      expect.objectContaining({
        session_id: sessionId,
        label: "主线",
        parent_session_id: null
      })
    ]);

    const ended = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/end`,
      payload: { expected_state_version: 0, idempotency_key: "root-row-end" }
    });
    expect(ended.statusCode).toBe(200);
    const review = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/reviews`,
      payload: { idempotency_key: "root-row-review" }
    });
    const repractice = await app.inject({
      method: "POST",
      url: `/api/reviews/${review.json().review.id}/repractice`,
      payload: { idempotency_key: "root-row-repractice" }
    });
    const repracticeTree = await app.inject({
      method: "GET",
      url: `/api/sessions/${repractice.json().session.id}/branch-tree`
    });

    expect(repracticeTree.statusCode).toBe(200);
    expect(repracticeTree.json().tree.nodes[0]).toMatchObject({
      session_id: repractice.json().session.id,
      label: "主线",
      parent_session_id: null
    });
  });

  it("builds branch tree rounds from non-system visible transcript entries", async () => {
    const { app, sessionId } = await createDraftSceneAndSession();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pause`,
      payload: { expected_state_version: 0, idempotency_key: "branch-tree-pause" }
    });
    const tree = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/branch-tree` });

    expect(tree.statusCode).toBe(200);
    expect(tree.json().tree.nodes[0]).toMatchObject({
      session_id: sessionId,
      rounds: 0
    });
  });

  it("child branch reviews cite child event ids instead of parent event ids", async () => {
    const { app, sessionId } = await createDraftSceneAndSession();
    const opening = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/ai-turn`,
      payload: { actor_id: "ai_backend_interviewer", expected_state_version: 0, idempotency_key: "child-review-ai" }
    });
    const forked = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/forks`,
      payload: {
        fork_point_event_id: opening.json().session.view.visible_transcript[0].event_id,
        include_selected_event: true,
        idempotency_key: "child-review-fork"
      }
    });
    const childSessionId = forked.json().session.id;
    const childAnswer = await app.inject({
      method: "POST",
      url: `/api/sessions/${childSessionId}/input`,
      payload: {
        input: "这是子分支回答。",
        expected_state_version: forked.json().session.view.state_version,
        idempotency_key: "child-review-answer"
      }
    });
    const ended = await app.inject({
      method: "POST",
      url: `/api/sessions/${childSessionId}/end`,
      payload: {
        expected_state_version: childAnswer.json().session.view.state_version,
        idempotency_key: "child-review-end"
      }
    });
    expect(ended.statusCode).toBe(200);

    const review = await app.inject({
      method: "POST",
      url: `/api/sessions/${childSessionId}/reviews`,
      payload: { idempotency_key: "child-branch-reviews" }
    });

    expect(review.statusCode).toBe(201);
    const serialized = JSON.stringify(review.json().review);
    expect(serialized).toContain(`${childSessionId}:`);
    expect(serialized).not.toContain(`${sessionId}:`);
    expect(review.json().review.evidence_refs.every((ref: { session_id: string; event_id: string }) =>
      ref.session_id === childSessionId && ref.event_id.startsWith(`${childSessionId}:`)
    )).toBe(true);
  });

  it("does not allow review when the current session status is running after a historical end event", () => {
    expect(
      isEndedForReview(
        {
          session_id: "session_resumed",
          scenario_id: "scenario_interview",
          status: "running",
          state_version: 0,
          state: {},
          allowed_steps: [],
          visible_transcript: [],
          current_stage_label: "等待下一步",
          current_actor_name: null,
          next_user_action_label: "演练状态同步中，请刷新或稍后重试。"
        },
        [
          {
            id: "event_end",
            session_id: "session_resumed",
            sequence: 1,
            state_version_before: 0,
            state_version_after: 0,
            created_at: "runtime-sequence-1",
            type: "RuntimeCommandCommitted",
            payload: { command: "end_session", args: { action: "end_session" } }
          },
          {
            id: "event_resume",
            session_id: "session_resumed",
            sequence: 2,
            state_version_before: 0,
            state_version_after: 0,
            created_at: "runtime-sequence-2",
            type: "RuntimeCommandCommitted",
            payload: { command: "resume_session", args: { action: "resume_session" } }
          }
        ]
      )
    ).toBe(false);
  });

});
