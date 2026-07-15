import { describe, expect, it } from "vitest";

import {
  builtInTemplates,
  buildDraftFromTemplate,
  checkScenario,
  confirmDraft,
  exportScene,
  exportSceneForInternalUse,
  exportSceneForUser,
  hashNormalizedScenario,
  importScene,
  previewTemplate,
  TemplateBuildError
} from "./index";

describe("template draft preview and confirmation", () => {
  it("marks default-filled preview fields without marking explicit params as default", () => {
    const defaultDraft = buildDraftFromTemplate("job_interview", {});
    const customDraft = buildDraftFromTemplate("job_interview", {
        target_role: "平台工程师",
        company_stage: "增长期团队",
        interview_focus: "故障复盘主导能力",
      max_turns: 22
    });

    expect(defaultDraft.preview.goal.is_default).toBe(true);
    expect(defaultDraft.preview.user_role.is_default).toBe(true);
    expect(defaultDraft.preview.ai_role.is_default).toBe(true);
    expect(defaultDraft.preview.flow.some((item) => item.is_default)).toBe(true);
    expect(defaultDraft.preview.materials.some((item) => item.is_default)).toBe(true);
    expect(defaultDraft.preview.review_method.is_default).toBe(true);

      expect(customDraft.preview.goal).toEqual({ value: "准备平台工程师面试", is_default: false });
    expect(customDraft.preview.materials).toContainEqual({
      label: "面试关注点",
        value: "故障复盘主导能力",
      is_default: false
    });
  });

  it("adds start decision metadata for every built-in template preview", () => {
    for (const template of builtInTemplates) {
      const draft = buildDraftFromTemplate(template.id, {});

      expect(draft.preview.estimated_duration.value).toMatch(/分钟/);
      expect(draft.preview.pressure_level.value).toMatch(/轻量|标准|高压/);
      expect(draft.preview.ready_summary.value).toMatch(/可以开始|检查/);
      expect(draft.preview.notes.length).toBeGreaterThan(0);
      expect(draft.preview.notes.map((item) => item.value).join("\n")).toMatch(/自然语言|材料|节奏|模型/);
      expect(draft.preview.pressure_level.value).not.toMatch(/^(low|medium|high|high_pressure)$/);
      expect(JSON.stringify(draft.preview)).not.toMatch(/can_start|model_config_id|normalized_hash|scenario_id|step_id|state_version/);
      expect(draft.semantic_preview.quality.status).toBe("ready");
      expect(draft.semantic_preview.roles.length).toBeGreaterThan(0);
      expect(draft.semantic_preview.stages.length).toBeGreaterThan(0);
      expect(draft.semantic_preview.review_dimensions.length).toBeGreaterThan(0);
      expect(draft.body.semantic_preview).toEqual(draft.semantic_preview);
      expect(JSON.stringify(draft.semantic_preview)).not.toMatch(
        /\$\.|user_candidate|user_employee|user_presenter|ai_|stage_\d|step_id|actor_id|state_path|raw prompt|RuntimeEvent/i
      );
    }
  });

  it("rejects unknown templates, missing required params, invalid types and extra params", () => {
    expect(() => buildDraftFromTemplate("unknown", {})).toThrow(TemplateBuildError);
    expect(() => buildDraftFromTemplate("job_interview", { target_role: 123 })).toThrow(TemplateBuildError);
    expect(() => buildDraftFromTemplate("job_interview", { unexpected: "nope" })).toThrow(TemplateBuildError);
    expect(() =>
      buildDraftFromTemplate("job_interview", {
          target_role: "后端工程师",
          company_stage: "增长期团队",
        interview_focus: "ownership",
        max_turns: 0
      })
    ).toThrow(TemplateBuildError);
  });

  it("supports public preview generation without exposing the normalized scenario", () => {
    const preview = previewTemplate("promotion_review", {});

    expect(preview.title.value).toBe("后端转正答辩");
    expect(preview.goal.value).toContain("准备");
    expect(JSON.stringify(preview)).not.toContain("state_schema");
    expect(JSON.stringify(preview)).not.toContain("terminal_rules");
  });

  it("confirms a draft with deep-cloned scenario and stable normalized hash", () => {
    const draft = buildDraftFromTemplate("thesis_defense", {});
    const confirmed = confirmDraft(draft);
    const originalTitle = confirmed.scenario.title;
    const originalHash = confirmed.normalized_hash;

    draft.params.topic = "mutated topic";
    draft.preview.title.value = "mutated preview";
    draft.scenario.title = "mutated scenario";
    draft.scenario.resources.project_context = { summary: "mutated resource" };

    expect(confirmed.id).toBe("confirmed_thesis_defense");
    expect(confirmed.source_template_id).toBe("thesis_defense");
    expect(confirmed.scenario.title).toBe(originalTitle);
    expect(confirmed.normalized_hash).toBe(originalHash);
    expect(confirmed.normalized_hash).toBe(hashNormalizedScenario(confirmed.scenario));
  });

  it("returns product check status and user-readable issues for ready, warning and blocked scenarios", () => {
    const readyDraft = buildDraftFromTemplate("job_interview", {});
    const blockedEvidenceScenario = {
      ...readyDraft.scenario,
      review_rubric: {
        ...readyDraft.scenario.review_rubric,
        dimensions: readyDraft.scenario.review_rubric.dimensions.map((dimension) => ({
          ...dimension,
          evidence_tags: ["missing_review_tag"]
        }))
      }
    };
    const blockedScenario = {
      ...readyDraft.scenario,
      roles: readyDraft.scenario.roles.filter((actor) => actor.kind !== "user")
    };

    expect(checkScenario(readyDraft.scenario)).toEqual({ status: "ready", ok: true, issues: [] });

    const blockedEvidence = checkScenario(blockedEvidenceScenario);
    expect(blockedEvidence.status).toBe("blocked");
    expect(blockedEvidence.ok).toBe(false);
    expect(blockedEvidence.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "blocked",
        title: expect.any(String),
        message: expect.stringMatching(/复盘|证据/),
        suggestion: expect.any(String)
      })
    ]));

    const blocked = checkScenario(blockedScenario);
    expect(blocked.status).toBe("blocked");
    expect(blocked.ok).toBe(false);
    expect(blocked.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "blocked",
        title: expect.any(String),
        message: expect.stringMatching(/用户|扮演|角色/),
        suggestion: expect.any(String)
      })
    ]));
    expect(JSON.stringify(blocked)).not.toMatch(/ZodError|stack|schema path|steps\\.|actor_id|step_id/);
  });

  it("blocks scenarios when guard expressions read unknown state paths", () => {
    const readyDraft = buildDraftFromTemplate("job_interview", {});
    const scenarioWithUnknownGuardState = {
      ...readyDraft.scenario,
      steps: readyDraft.scenario.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              preconditions: [
                ...step.preconditions,
                { op: "eq" as const, path: "$.state.not_declared_in_schema", value: true }
              ]
            }
          : step
      )
    };

    const result = checkScenario(scenarioWithUnknownGuardState);

    expect(result.status).toBe("blocked");
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "blocked",
        title: "状态引用不完整",
        message: expect.stringMatching(/状态|流程判断/)
      })
    ]));
  });

  it("roundtrips confirmed scenes through export and import with stable hash", () => {
    const confirmed = confirmDraft(buildDraftFromTemplate("promotion_review", {}));
    const exported = exportSceneForInternalUse(confirmed);
    const imported = importScene(exported);
    const reExported = exportSceneForInternalUse(imported);

    expect(exported.schema_version).toBe("personalflow.scene.export.v1");
    expect(exported.scene.scenario_package.runtime_ir).toEqual(confirmed.scenario);
    expect(exported.scene.scenario_package.authoring_metadata).toMatchObject({
      source_template_id: confirmed.source_template_id
    });
    expect(imported.normalized_hash).toBe(confirmed.normalized_hash);
    expect(reExported.normalized_hash).toBe(exported.normalized_hash);
    expect(JSON.stringify(exported)).not.toContain("api" + "_key");
    expect(JSON.stringify(exported)).not.toContain("author" + "ization");
  });

  it("redacts AI hidden materials from public scene exports while keeping imports valid", () => {
    const confirmed = confirmDraft(buildDraftFromTemplate("b2b_sales_discovery", {}));
    const exported = exportSceneForUser(confirmed);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain("客户不会主动说出的信息");
    expect(serialized).not.toContain("愿意进入下一步的条件");
    expect(serialized).toContain("AI 角色材料不随普通场景导出公开");
    expect(exported.normalized_hash).toBe(hashNormalizedScenario(exported.scene.scenario_package.runtime_ir));
    expect(importScene(exported).normalized_hash).toBe(exported.normalized_hash);
  });

  it("rejects tampered imports when the normalized hash no longer matches", () => {
    const confirmed = confirmDraft(buildDraftFromTemplate("job_interview", {}));
    const exported = exportScene(confirmed);
    const tampered = {
      ...exported,
      scene: {
        ...exported.scene,
        scenario_package: {
          ...exported.scene.scenario_package,
          runtime_ir: {
            ...exported.scene.scenario_package.runtime_ir,
            title: "tampered title"
          }
        }
      }
    };

    expect(() => importScene(tampered)).toThrow(/normalized_hash mismatch/);
  });
});
