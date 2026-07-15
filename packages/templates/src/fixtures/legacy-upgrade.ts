import type { GuardExprV1, JsonObject, NormalizedScenarioV1, StepContractV3 } from "@personalflow/contracts";

interface LegacyActor {
  readonly id: string;
  readonly kind: "user" | "ai" | "system";
  readonly display_name: string;
  readonly description?: string;
}

interface LegacyScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly actors: readonly LegacyActor[];
  readonly resources: JsonObject;
  readonly constants: JsonObject;
  readonly state_schema: NormalizedScenarioV1["state_schema"];
  readonly initial_state: JsonObject;
  readonly steps: readonly Omit<StepContractV3, "stage_id">[];
  readonly step_order: readonly string[];
  readonly max_steps?: number;
  readonly terminal_rules: NormalizedScenarioV1["terminal_rules"];
  readonly context_profile?: {
    readonly visible_state_paths: readonly string[];
    readonly visible_resource_paths: readonly string[];
    readonly event_window?: number;
  };
}

const allReviewTags = (steps: readonly Omit<StepContractV3, "stage_id">[]): string[] => {
  const tags = Array.from(new Set(steps.flatMap((step) => step.review_tags)));
  return tags.length > 0 ? tags : ["scenario_evidence"];
};

const orderedStepIds = (legacy: LegacyScenario): string[] => {
  const stepIds = new Set(legacy.steps.map((step) => step.id));
  const ordered = legacy.step_order.filter((stepId) => stepIds.has(stepId));
  return [...ordered, ...legacy.steps.map((step) => step.id).filter((stepId) => !ordered.includes(stepId))];
};

const initialStageGuard = (initialState: JsonObject): GuardExprV1 => {
  const firstStateKey = Object.keys(initialState)[0];
  return firstStateKey === undefined
    ? { op: "exists", path: "$.events.count" }
    : { op: "exists", path: `$.state.${firstStateKey}` };
};

export const legacyScenarioToV2 = (legacy: LegacyScenario): NormalizedScenarioV1 => {
  const stageId = "main";
  const roleIds = legacy.actors.map((actor) => actor.id);
  const evidenceTags = allReviewTags(legacy.steps);
  const stepOrder = orderedStepIds(legacy);
  const maxSteps = legacy.max_steps ?? Math.max(legacy.steps.length * 2, 1);

  return {
    schema_version: "3",
    id: legacy.id,
    title: legacy.title,
    description: legacy.description,
    domain: "template",
    version: "3.0.0",
    roles: legacy.actors.map((actor) => ({
      id: actor.id,
      kind: actor.kind,
      display_name: actor.display_name,
      identity: actor.description ?? actor.display_name,
      goal: actor.description ?? actor.display_name,
      behavior_style: "scenario-guided"
    })),
    stages: [
      {
        id: stageId,
        title: "主流程",
        goal: legacy.description,
        order: 1,
        enter_when: initialStageGuard(legacy.initial_state),
        exit_when: { op: "exists", path: "$.events.never" }
      }
    ],
    resources: legacy.resources,
    constants: legacy.constants,
    state_schema: legacy.state_schema,
    initial_state: legacy.initial_state,
    steps: legacy.steps.map((step) => ({ ...step, stage_id: stageId })),
    step_order: stepOrder,
    runtime_limits: {
      max_committed_steps: maxSteps,
      max_stage_committed_steps: maxSteps,
      max_events: Math.max(maxSteps * 4, 10),
      max_failed_attempts: 6,
      max_tool_calls: 4
    },
    visibility_policy: {
      default: "deny",
      rules: [
        ...(legacy.context_profile?.visible_state_paths ?? []).map((path) => ({
          id: `visible_${path.replace(/[^a-z0-9]+/gi, "_")}`,
          subject: { role_ids: roleIds, stage_ids: [stageId] },
          target: { kind: "state" as const, path },
          access: "full" as const
        })),
        ...(legacy.context_profile?.visible_resource_paths ?? []).map((path) => ({
          id: `visible_${path.replace(/[^a-z0-9]+/gi, "_")}`,
          subject: { role_ids: roleIds, stage_ids: [stageId] },
          target: { kind: "resource" as const, path },
          access: "full" as const
        }))
      ]
    },
    tool_policy: { tools: [], grants: [] },
    terminal_rules: legacy.terminal_rules,
    review_rubric: {
      dimensions: [
        {
          id: "scenario_evidence",
          title: "场景证据",
          description: "基于演练中已提交的可见证据进行评价。",
          evidence_tags: evidenceTags,
          evidence_requirement: "optional",
          output_guidance: "仅引用已提交事件中的可见证据。"
        }
      ]
    }
  };
};
