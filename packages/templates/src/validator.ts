import {
  NormalizedScenarioV1Schema,
  type GuardExprV1,
  type JsonSchemaValue,
  type NormalizedScenarioV1,
  type RoleContractV3
} from "@personalflow/contracts";

export type ScenarioValidationErrorCode =
  | "invalid_schema"
  | "missing_step_order"
  | "step_order_duplicate"
  | "step_order_unknown_step"
  | "step_order_incomplete"
  | "runtime_limits_invalid"
  | "missing_terminal_rules"
  | "missing_user_actor"
  | "missing_ai_actor"
  | "missing_visibility_policy"
  | "unknown_stage_reference"
  | "unknown_tool_reference"
  | "stage_without_steps"
  | "initial_stage_unreachable"
  | "initial_step_unreachable"
  | "review_evidence_tag_not_observable"
  | "visibility_rule_not_stage_scoped"
  | "unknown_step_reference"
  | "unknown_actor_reference"
  | "state_effect_path_outside_schema"
  | "invisible_resource_reference"
  | "unknown_state_reference";

export interface ScenarioValidationError {
  code: ScenarioValidationErrorCode;
  message: string;
  path?: string | undefined;
  diagnostics?: string[] | undefined;
}

export interface ScenarioValidationResult {
  ok: boolean;
  errors: ScenarioValidationError[];
}

export type ScenarioCheckStatus = "ready" | "warning" | "blocked";
export type ScenarioCheckIssueSeverity = "warning" | "blocked";

export interface ScenarioCheckIssue {
  readonly severity: ScenarioCheckIssueSeverity;
  readonly title: string;
  readonly message: string;
  readonly suggestion: string;
}

export interface ScenarioCheckResult {
  readonly status: ScenarioCheckStatus;
  readonly ok: boolean;
  readonly issues: ScenarioCheckIssue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const issueDiagnostic = (issue: { path: readonly PropertyKey[]; message: string }): string => {
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
  return `${path}: ${issue.message}`;
};

const addMissingStructureErrors = (scenario: unknown, errors: ScenarioValidationError[]) => {
  if (!isRecord(scenario)) {
    return;
  }

  if (!Array.isArray(scenario.step_order) || scenario.step_order.length === 0) {
    errors.push({
      code: "missing_step_order",
      message: "RuntimeIR v3 scenario must define a non-empty step_order.",
      path: "step_order"
    });
  }

  addRuntimeLimitsErrors(scenario.runtime_limits, errors);

  if (!Array.isArray(scenario.terminal_rules) || scenario.terminal_rules.length === 0) {
    errors.push({
      code: "missing_terminal_rules",
      message: "Scenario must define at least one terminal rule."
    });
  }

  if (scenario.visibility_policy === undefined) {
    errors.push({
      code: "missing_visibility_policy",
      message: "Scenario must define a visibility policy."
    });
  }

  const roles = Array.isArray(scenario.roles) ? scenario.roles : [];
  if (!roles.some((actor) => isRecord(actor) && actor.kind === "user")) {
    errors.push({
      code: "missing_user_actor",
      message: "Scenario must define at least one user actor."
    });
  }

  if (!roles.some((actor) => isRecord(actor) && actor.kind === "ai")) {
    errors.push({
      code: "missing_ai_actor",
      message: "Scenario must define at least one AI actor."
    });
  }
};

const runtimeLimitFields = [
  "max_committed_steps",
  "max_stage_committed_steps",
  "max_events",
  "max_failed_attempts",
  "max_tool_calls"
] as const;

const addRuntimeLimitsErrors = (runtimeLimits: unknown, errors: ScenarioValidationError[]): void => {
  if (!isRecord(runtimeLimits)) {
    errors.push({
      code: "runtime_limits_invalid",
      message: "RuntimeIR v3 scenario must define effective runtime_limits.",
      path: "runtime_limits"
    });
    return;
  }

  for (const field of runtimeLimitFields) {
    const value = runtimeLimits[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push({
        code: "runtime_limits_invalid",
        message: `Runtime limit '${field}' must be a positive integer.`,
        path: `runtime_limits.${field}`
      });
    }
  }
};

const objectPropertyKeys = (schema: JsonSchemaValue): Set<string> => {
  if (typeof schema === "boolean" || schema.type !== "object") {
    return new Set();
  }
  return new Set(Object.keys(schema.properties ?? {}));
};

const topLevelStateKey = (path: string): string | null => {
  const prefix = "$.state.";
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  const key = rest.split(/[.[\]]/, 1)[0];
  return key === "" || key === undefined ? null : key;
};

const topLevelResourceKey = (path: string): string | null => {
  const prefix = "$.resources.";
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  const key = rest.split(/[.[\]]/, 1)[0];
  return key === "" || key === undefined ? null : key;
};

const collectGuardReadPaths = (guard: GuardExprV1): string[] => {
  switch (guard.op) {
    case "and":
    case "or":
      return guard.all.flatMap(collectGuardReadPaths);
    case "not":
      return collectGuardReadPaths(guard.expr);
    case "exists":
      return [guard.path];
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
      return "value_from" in guard ? [guard.path, guard.value_from] : [guard.path];
    default:
      return [];
  }
};

const readPathSegments = (value: unknown, segments: string[]): unknown =>
  segments.reduce<unknown>((current, segment) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[segment];
  }, value);

interface InitialGuardContext {
  readonly state: NormalizedScenarioV1["initial_state"];
  readonly constants: NormalizedScenarioV1["constants"];
  readonly actor: RoleContractV3;
  readonly args: Record<string, never>;
  readonly events: readonly unknown[];
}

const initialGuardRoot = (context: InitialGuardContext): Record<string, unknown> => ({
  state: context.state,
  constants: context.constants,
  actor: context.actor,
  args: context.args,
  events: { count: context.events.length }
});

const readRuntimePath = (path: string, context: InitialGuardContext): unknown => {
  if (!path.startsWith("$.")) {
    return undefined;
  }

  return readPathSegments(initialGuardRoot(context), path.slice(2).split("."));
};

const compareGuardValues = (op: GuardExprV1["op"], left: unknown, right: unknown): boolean => {
  switch (op) {
    case "eq":
      return Object.is(left, right);
    case "neq":
      return !Object.is(left, right);
    case "gt":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "gte":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "lt":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "lte":
      return typeof left === "number" && typeof right === "number" && left <= right;
    case "contains":
      return (
        (Array.isArray(left) && left.some((item) => Object.is(item, right))) ||
        (typeof left === "string" && typeof right === "string" && left.includes(right))
      );
    default:
      return false;
  }
};

const evaluateGuard = (guard: GuardExprV1, context: InitialGuardContext): boolean => {
  switch (guard.op) {
    case "and":
      return guard.all.every((item) => evaluateGuard(item, context));
    case "or":
      return guard.all.some((item) => evaluateGuard(item, context));
    case "not":
      return !evaluateGuard(guard.expr, context);
    case "exists":
      return readRuntimePath(guard.path, context) !== undefined;
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains": {
      const left = readRuntimePath(guard.path, context);
      const right = "value_from" in guard ? readRuntimePath(guard.value_from, context) : guard.value;
      return compareGuardValues(guard.op, left, right);
    }
    default:
      return false;
  }
};

const initialGuardContext = (scenario: NormalizedScenarioV1, actor: RoleContractV3): InitialGuardContext => ({
  state: scenario.initial_state,
  constants: scenario.constants,
  actor,
  args: {},
  events: []
});

const stepPreconditionsSatisfied = (scenario: NormalizedScenarioV1, step: NormalizedScenarioV1["steps"][number]): boolean => {
  const actor = scenario.roles.find((role) => role.id === step.actor_id);
  if (actor === undefined) {
    return false;
  }
  const context = initialGuardContext(scenario, actor);
  return step.preconditions.every((guard) => evaluateGuard(guard, context));
};

const addUnknownGuardStateReferenceErrors = (
  guard: GuardExprV1,
  stateKeys: ReadonlySet<string>,
  path: string,
  errors: ScenarioValidationError[]
): void => {
  for (const readPath of collectGuardReadPaths(guard)) {
    const stateKey = topLevelStateKey(readPath);
    if (stateKey !== null && !stateKeys.has(stateKey)) {
      errors.push({
        code: "unknown_state_reference",
        message: `Guard references unknown state path '${readPath}'.`,
        path
      });
    }
  }
};

const addCrossReferenceErrors = (scenario: NormalizedScenarioV1, errors: ScenarioValidationError[]) => {
  const stepIds = new Set(scenario.steps.map((step) => step.id));
  const actorIds = new Set(scenario.roles.map((actor) => actor.id));
  const stageIds = new Set(scenario.stages.map((stage) => stage.id));
  const toolIds = new Set(scenario.tool_policy.tools.map((tool) => tool.id));
  const observableReviewTags = new Set(scenario.steps.flatMap((step) => step.review_tags));
  const stateKeys = objectPropertyKeys(scenario.state_schema);
  const resourceKeys = new Set(Object.keys(scenario.resources));
  const visibleStatePaths = new Set(
    scenario.visibility_policy.rules.filter((rule) => rule.target.kind === "state").map((rule) => rule.target.path)
  );
  const visibleResourcePaths = new Set(
    scenario.visibility_policy.rules.filter((rule) => rule.target.kind === "resource").map((rule) => rule.target.path)
  );

  const stepOrderIds = new Set<string>();
  for (const stepId of scenario.step_order) {
    if (stepOrderIds.has(stepId)) {
      errors.push({
        code: "step_order_duplicate",
        message: `Step order contains duplicate step '${stepId}'.`,
        path: "step_order"
      });
    }
    stepOrderIds.add(stepId);

    if (!stepIds.has(stepId)) {
      errors.push({
        code: "step_order_unknown_step",
        message: `Step order references unknown step '${stepId}'.`,
        path: "step_order"
      });
    }
  }

  for (const step of scenario.steps) {
    if (!stepOrderIds.has(step.id)) {
      errors.push({
        code: "step_order_incomplete",
        message: `Step order does not include step '${step.id}'.`,
        path: "step_order"
      });
    }
  }

  for (const stage of scenario.stages) {
    if (!scenario.steps.some((step) => step.stage_id === stage.id)) {
      errors.push({
        code: "stage_without_steps",
        message: `Stage '${stage.id}' has no owned steps.`,
        path: `stages.${stage.id}`
      });
    }

    addUnknownGuardStateReferenceErrors(stage.enter_when, stateKeys, `stages.${stage.id}.enter_when`, errors);
    addUnknownGuardStateReferenceErrors(stage.exit_when, stateKeys, `stages.${stage.id}.exit_when`, errors);
  }

  for (const rule of scenario.visibility_policy.rules) {
    for (const roleId of rule.subject.role_ids ?? []) {
      if (!actorIds.has(roleId)) {
        errors.push({
          code: "unknown_actor_reference",
          message: `Visibility rule '${rule.id}' references unknown role '${roleId}'.`,
          path: `visibility_policy.rules.${rule.id}.subject.role_ids`
        });
      }
    }

    if (rule.subject.stage_ids === undefined) {
      errors.push({
        code: "visibility_rule_not_stage_scoped",
        message: `Visibility rule '${rule.id}' must be scoped to at least one stage.`,
        path: `visibility_policy.rules.${rule.id}.subject.stage_ids`
      });
    }

    for (const stageId of rule.subject.stage_ids ?? []) {
      if (!stageIds.has(stageId)) {
        errors.push({
          code: "unknown_stage_reference",
          message: `Visibility rule '${rule.id}' references unknown stage '${stageId}'.`,
          path: `visibility_policy.rules.${rule.id}.subject.stage_ids`
        });
      }
    }
  }

  for (const statePath of visibleStatePaths) {
    const key = topLevelStateKey(statePath);
    if (key === null || !stateKeys.has(key)) {
      errors.push({
        code: "unknown_state_reference",
        message: `Context profile references unknown state path '${statePath}'.`,
        path: "visibility_policy.rules"
      });
    }
  }

  for (const resourcePath of visibleResourcePaths) {
    const key = topLevelResourceKey(resourcePath);
    if (key === null || !resourceKeys.has(key)) {
      errors.push({
        code: "invisible_resource_reference",
        message: `Context profile references unknown resource path '${resourcePath}'.`,
        path: "visibility_policy.rules"
      });
    }
  }

  for (const step of scenario.steps) {
    if (!stageIds.has(step.stage_id)) {
      errors.push({
        code: "unknown_stage_reference",
        message: `Step '${step.id}' references unknown stage '${step.stage_id}'.`,
        path: `steps.${step.id}.stage_id`
      });
    }
    if (!actorIds.has(step.actor_id)) {
      errors.push({
        code: "unknown_actor_reference",
        message: `Step '${step.id}' references unknown actor '${step.actor_id}'.`,
        path: `steps.${step.id}.actor_id`
      });
    }

    for (let index = 0; index < step.state_effects.length; index += 1) {
      const effect = step.state_effects[index];
      if (effect === undefined) {
        continue;
      }
      const stateKey = topLevelStateKey(effect.target_path);
      if (stateKey === null || !stateKeys.has(stateKey)) {
        errors.push({
          code: "state_effect_path_outside_schema",
          message: `Step '${step.id}' writes outside state_schema properties.`,
          path: `steps.${step.id}.state_effects.${String(index)}.target_path`
        });
      }
    }

    step.preconditions.forEach((guard, index) => {
      addUnknownGuardStateReferenceErrors(guard, stateKeys, `steps.${step.id}.preconditions.${String(index)}`, errors);
    });

    if (step.accept_when !== undefined) {
      addUnknownGuardStateReferenceErrors(step.accept_when, stateKeys, `steps.${step.id}.accept_when`, errors);
    }

    for (const refPath of step.args_ref_paths) {
      const stateKey = topLevelStateKey(refPath);
      if (stateKey !== null && (!stateKeys.has(stateKey) || !visibleStatePaths.has(refPath))) {
        errors.push({
          code: "unknown_state_reference",
          message: `Step '${step.id}' references non-visible state path '${refPath}'.`,
          path: `steps.${step.id}.args_ref_paths`
        });
      }

      const resourceKey = topLevelResourceKey(refPath);
      if (resourceKey !== null && (!resourceKeys.has(resourceKey) || !visibleResourcePaths.has(refPath))) {
        errors.push({
          code: "invisible_resource_reference",
          message: `Step '${step.id}' references non-visible resource path '${refPath}'.`,
          path: `steps.${step.id}.args_ref_paths`
        });
      }
    }
  }

  scenario.terminal_rules.forEach((rule) => {
    addUnknownGuardStateReferenceErrors(rule.when, stateKeys, `terminal_rules.${rule.id}.when`, errors);
  });

  for (const grant of scenario.tool_policy.grants) {
    if (!actorIds.has(grant.role_id) || !stageIds.has(grant.stage_id) || !toolIds.has(grant.tool_id)) {
      errors.push({
        code: "unknown_tool_reference",
        message: "Tool grant references an unknown role, stage, or tool.",
        path: "tool_policy.grants"
      });
    }
  }

  const firstActor = scenario.roles[0];
  const initialActiveStages = firstActor === undefined
    ? []
    : scenario.stages.filter((stage) => {
        const context = initialGuardContext(scenario, firstActor);
        return evaluateGuard(stage.enter_when, context) && !evaluateGuard(stage.exit_when, context);
      });
  if (initialActiveStages.length === 0) {
    errors.push({
      code: "initial_stage_unreachable",
      message: "Initial state does not activate any RuntimeIR v3 stage.",
      path: "initial_state"
    });
  } else if (
    !initialActiveStages.some((stage) =>
      scenario.steps.some((step) => step.stage_id === stage.id && stepPreconditionsSatisfied(scenario, step))
    )
  ) {
    errors.push({
      code: "initial_step_unreachable",
      message: "Initial active stage has no step with satisfied preconditions.",
      path: "initial_state"
    });
  }

  for (const dimension of scenario.review_rubric.dimensions) {
    if (!dimension.evidence_tags.some((tag) => observableReviewTags.has(tag))) {
      errors.push({
        code: "review_evidence_tag_not_observable",
        message: `Review dimension '${dimension.id}' does not map to observable step review tags.`,
        path: "review_rubric.dimensions"
      });
    }
  }
};

export const validateScenario = (scenario: unknown): ScenarioValidationResult => {
  const errors: ScenarioValidationError[] = [];
  addMissingStructureErrors(scenario, errors);

  const parsed = NormalizedScenarioV1Schema.safeParse(scenario);
  if (!parsed.success) {
    errors.push({
      code: "invalid_schema",
      message: "Scenario does not satisfy NormalizedScenarioV1Schema.",
      diagnostics: parsed.error.issues.map(issueDiagnostic)
    });

    return { ok: false, errors };
  }

  addCrossReferenceErrors(parsed.data, errors);
  return { ok: errors.length === 0, errors };
};

const blockedIssueByCode: Record<ScenarioValidationErrorCode, Omit<ScenarioCheckIssue, "severity">> = {
  invalid_schema: {
    title: "草稿内容不完整",
    message: "这个场景草稿的结构损坏或缺少必要内容，暂时无法开始演练。",
    suggestion: "请返回模板参数页重新创建草稿，或重新导入一份完整的场景文件。"
  },
  missing_step_order: {
    title: "缺少流程安排",
    message: "这个场景没有声明步骤顺序，系统无法稳定决定候选步骤的展示顺序。",
    suggestion: "请重新创建草稿，确保模板包含完整的 step_order。"
  },
  step_order_duplicate: {
    title: "流程顺序重复",
    message: "这个场景的步骤顺序中存在重复步骤，运行时无法得到唯一排序。",
    suggestion: "请去除重复步骤，并确保每个步骤只在 step_order 中出现一次。"
  },
  step_order_unknown_step: {
    title: "流程引用不完整",
    message: "这个场景的步骤顺序指向了不存在的步骤，运行时无法可靠推进。",
    suggestion: "请修复 step_order 中的步骤引用。"
  },
  step_order_incomplete: {
    title: "流程顺序不完整",
    message: "这个场景还有步骤没有出现在步骤顺序中，运行时无法稳定排序。",
    suggestion: "请确保每个步骤都被 step_order 覆盖。"
  },
  runtime_limits_invalid: {
    title: "运行上限无效",
    message: "这个场景缺少完整有效的运行上限，运行时无法安全控制执行边界。",
    suggestion: "请补齐 runtime_limits，并确保每个上限都是正整数。"
  },
  missing_terminal_rules: {
    title: "缺少结束条件",
    message: "这个场景没有结束条件，演练开始后可能无法判断何时完成。",
    suggestion: "请重新创建草稿，确保模板包含明确的结束规则。"
  },
  missing_user_actor: {
    title: "缺少用户角色",
    message: "这个场景没有可扮演的用户角色，因此不能开始互动演练。",
    suggestion: "请返回模板参数页重新创建草稿，选择包含用户角色的模板。"
  },
  missing_ai_actor: {
    title: "缺少 AI 角色",
    message: "这个场景没有可执行的 AI 角色，系统无法发起或继续演练。",
    suggestion: "请重新创建草稿，确保模板包含至少一个 AI 评审或提问角色。"
  },
  missing_visibility_policy: {
    title: "缺少上下文配置",
    message: "这个场景缺少上下文配置，AI 无法获得演练所需的材料和状态。",
    suggestion: "请重新创建草稿，确保模板包含完整的上下文设置。"
  },
  unknown_stage_reference: {
    title: "阶段引用不完整",
    message: "这个场景中有流程步骤指向了不存在的阶段，运行时无法执行该步骤。",
    suggestion: "请重新创建草稿，或修复导入文件中的阶段配置。"
  },
  unknown_tool_reference: {
    title: "工具授权引用不完整",
    message: "这个场景中有工具授权指向了不存在的角色、阶段或工具。",
    suggestion: "请重新创建草稿，或修复导入文件中的工具权限配置。"
  },
  stage_without_steps: {
    title: "阶段缺少步骤",
    message: "这个场景中有阶段没有任何归属步骤，进入该阶段后无法继续执行。",
    suggestion: "请为每个阶段至少配置一个步骤，或移除空阶段。"
  },
  initial_stage_unreachable: {
    title: "初始阶段不可达",
    message: "这个场景的初始状态无法激活任何阶段，因此演练无法开始。",
    suggestion: "请调整 initial_state 或阶段进入条件，让初始状态命中一个阶段。"
  },
  initial_step_unreachable: {
    title: "初始步骤不可达",
    message: "这个场景的初始阶段下没有满足前置条件的步骤，因此演练无法开始。",
    suggestion: "请调整 initial_state 或步骤前置条件，让初始阶段至少有一个可执行步骤。"
  },
  review_evidence_tag_not_observable: {
    title: "复盘证据不可观察",
    message: "这个场景的复盘维度无法映射到演练中的可观察证据。",
    suggestion: "请调整复盘维度或步骤证据标签后再确认场景。"
  },
  visibility_rule_not_stage_scoped: {
    title: "可见性规则缺少阶段约束",
    message: "这个场景的可见性规则没有绑定具体阶段，可能导致材料或状态在错误阶段暴露。",
    suggestion: "请为每条可见性规则补充适用阶段后再确认场景。"
  },
  unknown_step_reference: {
    title: "流程引用不完整",
    message: "这个场景的流程安排指向了不存在的步骤，运行时无法可靠推进。",
    suggestion: "请重新创建草稿，或修复导入文件中的流程配置。"
  },
  unknown_actor_reference: {
    title: "角色引用不完整",
    message: "这个场景中有流程步骤指向了不存在的角色，运行时无法执行该步骤。",
    suggestion: "请重新创建草稿，或修复导入文件中的角色配置。"
  },
  state_effect_path_outside_schema: {
    title: "状态更新配置异常",
    message: "这个场景会写入未定义的演练状态，可能导致流程判断失效。",
    suggestion: "请重新创建草稿，或修复导入文件中的状态更新配置。"
  },
  invisible_resource_reference: {
    title: "材料引用不完整",
    message: "这个场景引用了不可用的材料，AI 可能无法获得必要上下文。",
    suggestion: "请重新创建草稿，或修复导入文件中的材料配置。"
  },
  unknown_state_reference: {
    title: "状态引用不完整",
    message: "这个场景引用了不可用的演练状态，流程判断可能无法运行。",
    suggestion: "请重新创建草稿，或修复导入文件中的状态配置。"
  }
};

const productIssueFromValidationError = (error: ScenarioValidationError): ScenarioCheckIssue => ({
  severity: "blocked",
  ...blockedIssueByCode[error.code]
});

const addWarningIssues = (scenario: NormalizedScenarioV1, issues: ScenarioCheckIssue[]): void => {
  const reviewSignalCount = scenario.steps.reduce((count, step) => count + step.review_tags.length, 0);
  if (reviewSignalCount === 0) {
    issues.push({
      severity: "warning",
      title: "复盘信息不足",
      message: "这个场景可以开始，但复盘信号偏少，结束后的总结可能不够具体。",
      suggestion: "可以先继续演练；如果希望复盘更稳定，建议补充更明确的评价维度或材料。"
    });
  }
};

export const checkScenario = (scenario: unknown): ScenarioCheckResult => {
  const validation = validateScenario(scenario);
  const issues = validation.errors.map(productIssueFromValidationError);
  if (issues.some((issue) => issue.severity === "blocked")) {
    return { status: "blocked", ok: false, issues };
  }

  const parsed = NormalizedScenarioV1Schema.parse(scenario);
  addWarningIssues(parsed, issues);
  if (issues.length > 0) {
    return { status: "warning", ok: true, issues };
  }
  return { status: "ready", ok: true, issues: [] };
};
