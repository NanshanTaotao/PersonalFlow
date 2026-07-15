import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { checkScenario, type ScenarioCheckResult } from "./validator";

export interface ScenarioSemanticPreview {
  readonly title: string;
  readonly roles: readonly { readonly title: string; readonly kind: string; readonly goal: string }[];
  readonly stages: readonly { readonly title: string; readonly goal: string; readonly roles: readonly string[]; readonly tools: readonly string[] }[];
  readonly visibility: readonly { readonly subject: string; readonly target: string; readonly access: string }[];
  readonly review_dimensions: readonly { readonly title: string; readonly evidence_requirement: string }[];
  readonly quality: ScenarioCheckResult;
}

const pathSummary = (path: string): string => {
  const readableLabels: Record<string, string> = {
    turn_count: "轮次进度",
    slot_index: "轮次进度",
    current_stage: "当前阶段",
    interview_stage: "当前阶段",
    panel_stage: "当前阶段",
    promotion_stage: "当前阶段",
    slot: "轮次进度",
    awaiting_response: "等待回应状态",
    awaiting_answer: "等待回应状态",
    awaiting_story: "等待回应状态",
    response_count: "回应次数",
    story_count: "回应次数",
    complete: "完成状态",
    closing_complete: "完成状态",
    synthesis_complete: "完成状态",
    growth_plan_complete: "完成状态",
    user_visible_material: "用户可见材料",
    ai_hidden_material: "AI 角色材料",
    gate1: "场景验收摘要",
    complex_config: "场景配置摘要",
    interview_context: "场景背景摘要",
    project_context: "项目背景摘要",
    promotion_context: "晋升背景摘要",
    debate_context: "辩论背景摘要",
    sales_context: "销售背景摘要",
    user_materials: "用户材料摘要"
  };
  const segment = path.split(".").at(-1);
  if (segment === undefined || segment === "") {
    return "未命名对象";
  }
  const mapped = readableLabels[segment];
  if (mapped !== undefined) {
    return mapped;
  }
  if (path.startsWith("$.state.")) {
    return "演练状态摘要";
  }
  if (path.startsWith("$.resources.")) {
    return "材料摘要";
  }
  return "可见信息摘要";
};

const accessLabel = (access: "full" | "summary" | "redacted"): string => {
  if (access === "full") {
    return "完整可见";
  }
  if (access === "summary") {
    return "摘要可见";
  }
  return "隐藏";
};

const uniqueNames = (ids: Iterable<string>, names: ReadonlyMap<string, string>): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(names.get(id) ?? id);
  }
  return result;
};

export const buildScenarioSemanticPreview = (scenario: NormalizedScenarioV1): ScenarioSemanticPreview => {
  const roleNames = new Map(scenario.roles.map((role) => [role.id, role.display_name]));
  const stageNames = new Map(scenario.stages.map((stage) => [stage.id, stage.title]));
  const toolNames = new Map(scenario.tool_policy.tools.map((tool) => [tool.id, tool.description]));
  return {
    title: scenario.title,
    roles: scenario.roles.map((role) => ({
      title: role.display_name,
      kind: role.kind,
      goal: role.goal
    })),
    stages: scenario.stages.map((stage) => ({
      title: stage.title,
      goal: stage.goal,
      roles: uniqueNames(
        [
          ...scenario.steps.filter((step) => step.stage_id === stage.id).map((step) => step.actor_id),
          ...scenario.tool_policy.grants.filter((grant) => grant.stage_id === stage.id).map((grant) => grant.role_id),
          ...scenario.visibility_policy.rules
            .filter((rule) => rule.subject.stage_ids === undefined || rule.subject.stage_ids.includes(stage.id))
            .flatMap((rule) => rule.subject.role_ids ?? [])
        ],
        roleNames
      ),
      tools: uniqueNames(
        scenario.tool_policy.grants.filter((grant) => grant.stage_id === stage.id).map((grant) => grant.tool_id),
        toolNames
      )
    })),
    visibility: scenario.visibility_policy.rules.map((rule) => {
      const roles = (rule.subject.role_ids ?? []).map((roleId) => roleNames.get(roleId) ?? "未知角色");
      const stages = (rule.subject.stage_ids ?? []).map((stageId) => stageNames.get(stageId) ?? "未知阶段");
      return {
        subject: `${roles.length > 0 ? roles.join("、") : "全部角色"} / ${stages.length > 0 ? stages.join("、") : "全部阶段"}`,
        target: `${rule.target.kind === "resource" ? "材料" : "演练状态"}：${pathSummary(rule.target.path)}`,
        access: accessLabel(rule.access)
      };
    }),
    review_dimensions: scenario.review_rubric.dimensions.map((dimension) => ({
      title: dimension.title,
      evidence_requirement: dimension.evidence_requirement
    })),
    quality: checkScenario(scenario)
  };
};
