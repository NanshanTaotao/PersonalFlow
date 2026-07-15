import { describe, expect, it } from "vitest";

import { NormalizedScenarioV1Schema, type NormalizedScenarioV1 } from "@personalflow/contracts";

import { hashNormalizedScenario, jobInterviewSmokeFixture, validateScenario } from "./index";

const cloneScenario = (scenario: NormalizedScenarioV1): NormalizedScenarioV1 =>
  structuredClone(scenario) as NormalizedScenarioV1;

const validationCodes = (scenario: unknown) => validateScenario(scenario).errors.map((error) => error.code);

describe("job interview smoke fixture", () => {
  it("is a minimal normalized scenario that the runtime can consume", () => {
    const parsed = NormalizedScenarioV1Schema.parse(jobInterviewSmokeFixture);

    expect(parsed.schema_version).toBe("3");
    expect(parsed.roles.map((role) => ({ id: role.id, kind: role.kind, display_name: role.display_name }))).toEqual([
      { id: "user_candidate", kind: "user", display_name: "Candidate" },
      { id: "ai_interviewer", kind: "ai", display_name: "Interviewer" }
    ]);
    expect(parsed.steps.map((step) => step.id)).toEqual(["answer_question", "ask_question"]);
    expect(parsed.steps.map((step) => step.stage_id)).toEqual(["main", "main"]);
    expect(parsed.steps.map((step) => step.actor_id)).toEqual(["user_candidate", "ai_interviewer"]);
    expect(parsed.initial_state).toEqual({ turn_count: 0 });
    expect(parsed.constants).toMatchObject({ max_turns: 2 });
    expect(parsed.step_order).toEqual(["ask_question", "answer_question"]);
    expect(parsed.runtime_limits).toMatchObject({
      max_committed_steps: expect.any(Number),
      max_stage_committed_steps: expect.any(Number)
    });
    expect(parsed.terminal_rules).toContainEqual({
      id: "terminal_max_turns",
      when: { op: "gte", path: "$.state.turn_count", value_from: "$.constants.max_turns" },
      status: "completed",
      reason: "Reached max_turns."
    });
    expect(parsed.visibility_policy).toMatchObject({ default: "deny" });
    expect(parsed.visibility_policy.rules.map((rule) => rule.target.path)).toEqual(
      expect.arrayContaining(["$.state.turn_count", "$.resources.interview_context"])
    );
  });

  it("passes blocking structural validation", () => {
    expect(validateScenario(jobInterviewSmokeFixture)).toEqual({ ok: true, errors: [] });
  });

  it("reports missing required runtime structure without throwing", () => {
    expect(validationCodes({ ...cloneScenario(jobInterviewSmokeFixture), step_order: [] })).toContain(
      "missing_step_order"
    );
    expect(validationCodes({ ...cloneScenario(jobInterviewSmokeFixture), terminal_rules: [] })).toContain(
      "missing_terminal_rules"
    );
    expect(validationCodes({ ...cloneScenario(jobInterviewSmokeFixture), roles: [] })).toEqual(
      expect.arrayContaining(["missing_user_actor", "missing_ai_actor"])
    );
    expect(
      validationCodes({
        ...cloneScenario(jobInterviewSmokeFixture),
        visibility_policy: undefined
      })
    ).toContain("missing_visibility_policy");
  });

  it("reports cross-reference errors for step_order steps and step actors", () => {
    const unknownStep = cloneScenario(jobInterviewSmokeFixture);
    unknownStep.step_order = ["ask_question", "missing_step"];

    const unknownActor = cloneScenario(jobInterviewSmokeFixture);

    expect(validationCodes(unknownStep)).toContain("step_order_unknown_step");
    const firstStep = unknownActor.steps[0];
    if (firstStep === undefined) {
      throw new Error("jobInterviewSmokeFixture must define at least one step");
    }
    unknownActor.steps[0] = { ...firstStep, actor_id: "missing_actor" };

    expect(validationCodes(unknownActor)).toContain("unknown_actor_reference");
  });

  it("reports visibility policy references that are not stage-aware", () => {
    const unknownVisibilityRole = cloneScenario(jobInterviewSmokeFixture);
    const firstRoleRule = unknownVisibilityRole.visibility_policy.rules[0];
    if (firstRoleRule === undefined) {
      throw new Error("jobInterviewSmokeFixture must define at least one visibility rule");
    }
    unknownVisibilityRole.visibility_policy.rules[0] = {
      ...firstRoleRule,
      subject: { ...firstRoleRule.subject, role_ids: ["missing_role"] }
    };

    const unknownVisibilityStage = cloneScenario(jobInterviewSmokeFixture);
    const firstStageRule = unknownVisibilityStage.visibility_policy.rules[0];
    if (firstStageRule === undefined) {
      throw new Error("jobInterviewSmokeFixture must define at least one visibility rule");
    }
    unknownVisibilityStage.visibility_policy.rules[0] = {
      ...firstStageRule,
      subject: { ...firstStageRule.subject, stage_ids: ["missing_stage"] }
    };

    const unscopedVisibility = cloneScenario(jobInterviewSmokeFixture);
    const firstUnscopedRule = unscopedVisibility.visibility_policy.rules[0];
    if (firstUnscopedRule === undefined) {
      throw new Error("jobInterviewSmokeFixture must define at least one visibility rule");
    }
    unscopedVisibility.visibility_policy.rules[0] = {
      ...firstUnscopedRule,
      subject: { role_ids: firstUnscopedRule.subject.role_ids ?? ["user_candidate"] }
    };

    expect(validationCodes(unknownVisibilityRole)).toContain("unknown_actor_reference");
    expect(validationCodes(unknownVisibilityStage)).toContain("unknown_stage_reference");
    expect(validationCodes(unscopedVisibility)).toContain("visibility_rule_not_stage_scoped");
  });

  it("reports schema errors with zod diagnostics", () => {
    const result = validateScenario({ ...cloneScenario(jobInterviewSmokeFixture), schema_version: "1" });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_schema",
          diagnostics: expect.arrayContaining([expect.stringContaining("schema_version")])
        })
      ])
    );
  });

  it("hashes normalized scenario content deterministically", () => {
    const scenario = cloneScenario(jobInterviewSmokeFixture);
    const reordered = {
      visibility_policy: scenario.visibility_policy,
      review_rubric: scenario.review_rubric,
      tool_policy: scenario.tool_policy,
      terminal_rules: scenario.terminal_rules,
      runtime_limits: scenario.runtime_limits,
      step_order: scenario.step_order,
      steps: scenario.steps,
      initial_state: scenario.initial_state,
      state_schema: scenario.state_schema,
      constants: scenario.constants,
      resources: scenario.resources,
      stages: scenario.stages,
      roles: scenario.roles,
      version: scenario.version,
      domain: scenario.domain,
      description: scenario.description,
      title: scenario.title,
      id: scenario.id,
      schema_version: scenario.schema_version
    };
    const changed = cloneScenario(jobInterviewSmokeFixture);
    changed.constants = { ...changed.constants, max_turns: 3 };

    expect(hashNormalizedScenario(jobInterviewSmokeFixture)).toBe(hashNormalizedScenario(jobInterviewSmokeFixture));
    expect(hashNormalizedScenario(reordered)).toBe(hashNormalizedScenario(jobInterviewSmokeFixture));
    expect(hashNormalizedScenario(changed)).not.toBe(hashNormalizedScenario(jobInterviewSmokeFixture));
  });
});
