import { createHash } from "node:crypto";

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";

import {
  CreateSessionForkRequestSchema,
  GetBranchTreeResponseSchema,
  JsonObjectSchema,
  NormalizedScenarioV1Schema,
  WithdrawUserInputRequestSchema
} from "@personalflow/contracts";
import type { JsonObject, NormalizedScenarioV1, SessionView } from "@personalflow/contracts";
import { parseAgentOutput, type LLMAdapter, type LLMRequest } from "@personalflow/agent";
import type { MaterialRecord, ModelConfigForModelCall, StorageDatabase } from "@personalflow/storage";
import { materialContextText, materialSummary } from "@personalflow/storage";
import {
  builtInTemplates,
  buildDraftFromComplexConfig,
  buildDraftFromTemplate,
  buildScenarioSemanticPreview,
  checkScenario,
  confirmDraft,
  exportSceneForUser,
  importScene,
  hashNormalizedScenario,
  type ConfirmedScene,
  type TemplateDraft
} from "@personalflow/templates";

import { createProductApiContext, replayOrRun, type IdempotencyStore, type ProductApiContext } from "./context";
import { ProductApiError, scenarioError, serializeApiError, toApiError, validationError } from "./errors";
import { registerReviewRoutes } from "./routes/reviews";
import { productSessionDto } from "./session-dto";
import { createSessionFork, getBranchTree, startSessionWithRootBranch, withdrawUserInput } from "./session-forks";

export interface BuildAppOptions {
  readonly database?: StorageDatabase;
  readonly idempotency?: IdempotencyStore;
  readonly logger?: boolean | FastifyBaseLogger;
  readonly context?: ProductApiContext;
}

const bodyWithIdempotency = z.object({ idempotency_key: z.string().min(1).optional() }).strict();
const fromTemplateBody = bodyWithIdempotency.extend({
  template_id: z.string().min(1),
  params: JsonObjectSchema.default({})
}).strict();
const complexConfigBody = bodyWithIdempotency.extend({
  title: z.string().min(1),
  goal: z.string().min(1),
  user_role: z.string().min(1),
  ai_roles: z.array(z.object({
    name: z.string().min(1),
    focus: z.string().min(1)
  }).strict()).min(2),
  stages: z.array(z.object({
    name: z.string().min(1),
    rounds: z.number().int().min(1).max(5),
    follow_up_strategy: z.string().min(1)
  }).strict()).min(2),
  termination: z.string().min(1)
}).strict();
const confirmBody = bodyWithIdempotency;
const startSessionBody = bodyWithIdempotency;
const inputBody = bodyWithIdempotency.extend({
  input: z.string().min(1),
  expected_state_version: z.number().int().nonnegative()
}).strict();
const aiTurnBody = bodyWithIdempotency.extend({
  actor_id: z.string().min(1),
  expected_state_version: z.number().int().nonnegative(),
  model_config_id: z.string().min(1).optional()
}).strict();
const commandBody = bodyWithIdempotency.extend({
  expected_state_version: z.number().int().nonnegative()
}).strict();
const modelConfigBody = bodyWithIdempotency.extend({
  provider: z.string().min(1),
  base_url: z.string().min(1),
  model: z.string().min(1),
  display_name: z.string().min(1),
  api_key: z.string().min(1)
}).strict();
const modelConfigUpdateBody = bodyWithIdempotency.extend({
  provider: z.string().min(1).optional(),
  base_url: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  api_key: z.string().min(1).optional()
}).strict();
const idempotentOnlyBody = bodyWithIdempotency;
const deleteModelConfigBody = bodyWithIdempotency.extend({ reason: z.string().min(1).optional() }).strict();
const importSceneBody = bodyWithIdempotency.extend({ export_json: z.unknown() }).strict();
const recentQuery = z.object({ limit: z.coerce.number().int().positive().optional() }).strict();
const materialBody = bodyWithIdempotency.extend({
  title: z.string().min(1),
  text: z.string().min(1),
  source: z.string().min(1).optional()
}).strict();
const materialVisibilityAccessBody = z.enum(["full", "summary", "hidden"]);
const materialVisibilityEntryBody = z.object({
  role_id: z.string().min(1),
  stage_id: z.string().min(1).optional(),
  access: materialVisibilityAccessBody
}).strict();
const materialVisibilityInputBody = z.object({
  mode: z.enum(["all_stages", "per_stage"]),
  entries: z.array(materialVisibilityEntryBody).min(1)
}).strict();
const libraryAttachMaterialBody = bodyWithIdempotency.extend({
  kind: z.literal("library"),
  material_id: z.string().min(1),
  visibility: materialVisibilityInputBody.optional()
}).strict();
const legacyAttachMaterialBody = bodyWithIdempotency.extend({
  material_id: z.string().min(1),
  visibility: materialVisibilityInputBody.optional()
}).strict();
const temporaryTextAttachMaterialBody = bodyWithIdempotency.extend({
  kind: z.literal("temporary_text"),
  title: z.string().min(1),
  text: z.string().min(1),
  visibility: materialVisibilityInputBody.optional()
}).strict();
const attachMaterialBody = z.union([libraryAttachMaterialBody, legacyAttachMaterialBody, temporaryTextAttachMaterialBody]);
const updateMaterialVisibilityBody = bodyWithIdempotency.extend({
  source_ref: z.string().min(1),
  visibility: materialVisibilityInputBody
}).strict();
const deleteSceneBody = bodyWithIdempotency.extend({ confirm: z.boolean() }).strict();
const renameSceneBody = bodyWithIdempotency.extend({ title: z.string().min(1) }).strict();

const parseParams = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => schema.parse(value);
type AttachMaterialBody = z.infer<typeof attachMaterialBody>;
type MaterialVisibilityInput = z.infer<typeof materialVisibilityInputBody>;

const parseAttachMaterialBody = (value: unknown): AttachMaterialBody => {
  const parsed = attachMaterialBody.safeParse(value);
  if (!parsed.success) {
    throw validationError(
      "请提供材料 ID，或填写临时材料标题和正文。",
      parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code }))
    );
  }
  return parsed.data;
};

const templateSummary = (template: (typeof builtInTemplates)[number]) => ({
  id: template.id,
  title: template.title,
  description: template.description
});

const templateDetail = (template: (typeof builtInTemplates)[number]) => ({
  id: template.id,
  title: template.title,
  description: template.description,
  param_schema: template.param_schema,
  default_params: template.default_params,
  preview_metadata: template.preview_metadata
});

const draftFromRecord = (record: { readonly id: string; readonly template_id: string | null; readonly body: JsonObject }): TemplateDraft => {
  const body = record.body as Record<string, unknown>;
  const scenario = NormalizedScenarioV1Schema.parse(body.scenario);
  return {
    id: record.id,
    template_id: typeof body.template_id === "string" ? body.template_id : record.template_id ?? "unknown",
    params: JsonObjectSchema.parse(body.params ?? {}),
    preview: body.preview as TemplateDraft["preview"],
    semantic_preview: (body.semantic_preview as TemplateDraft["semantic_preview"] | undefined) ?? buildScenarioSemanticPreview(scenario),
    scenario,
    body: record.body
  };
};

const sourceTemplateId = (scenario: NormalizedScenarioV1): string => {
  if (scenario.id.includes("complex_config")) {
    return "complex_config";
  }
  if (scenario.id.includes("thesis")) {
    return "thesis_defense";
  }
  if (scenario.id.includes("promotion")) {
    return "promotion_review";
  }
  return "job_interview";
};

const draftDto = (draft: { readonly id: string; readonly template_id: string | null; readonly body: JsonObject; readonly created_at: string; readonly updated_at: string }) => {
  const body = draft.body as Record<string, unknown>;
  const scenario = NormalizedScenarioV1Schema.safeParse(body.scenario);
  const semanticPreview = (body.semantic_preview as TemplateDraft["semantic_preview"] | undefined) ??
    (scenario.success ? buildScenarioSemanticPreview(scenario.data) : undefined);
  const rawPreview = body.preview !== null && typeof body.preview === "object" && !Array.isArray(body.preview)
    ? (body.preview as Record<string, unknown>)
    : body.preview;
  const decoratedPreview = rawPreview !== null && typeof rawPreview === "object" && !Array.isArray(rawPreview) && scenario.success
    ? attachVisibilityToPreview(rawPreview as Record<string, unknown>, scenario.data)
    : rawPreview;
  const preview = decoratedPreview !== null && typeof decoratedPreview === "object" && !Array.isArray(decoratedPreview)
    ? { ...decoratedPreview, ...(semanticPreview === undefined ? {} : { quality: semanticPreview.quality }) }
    : body.preview;
  return {
    id: draft.id,
    template_id: typeof body.template_id === "string" ? body.template_id : draft.template_id,
    preview,
    ...(semanticPreview === undefined ? {} : { semantic_preview: semanticPreview }),
    ...(scenario.success
      ? {
          visibility_options: {
            roles: scenario.data.roles.map((role) => ({
              id: role.id,
              display_name: role.display_name,
              kind: role.kind
            })),
            stages: scenario.data.stages.map((stage) => ({
              id: stage.id,
              title: stage.title
            }))
          }
        }
      : {}),
    created_at: draft.created_at,
    updated_at: draft.updated_at
  };
};

const sensitiveTextPattern = /authorization|bearer|api.?key|sk-[a-z0-9_-]+|secret|token|password|provider raw|raw prompt/gi;

const redactText = (value: string): string =>
  value.replace(sensitiveTextPattern, "[已隐藏]");

type AttachedMaterialSourceType = "library_text" | "temporary_text" | "future_file";
type MaterialVisibilityAccess = "full" | "summary" | "hidden";
interface AttachedMaterialInput {
  readonly source_ref: string;
  readonly source_type: AttachedMaterialSourceType;
  readonly title: string;
  readonly source_label: string;
  readonly summary: string;
  readonly context_text: string;
}

interface MaterialVisibilityEntry {
  readonly role_id: string;
  readonly stage_id?: string;
  readonly access: MaterialVisibilityAccess;
}

interface MaterialVisibilityConfig {
  readonly source_ref: string;
  readonly material_key: string;
  readonly mode: "all_stages" | "per_stage";
  readonly entries: readonly MaterialVisibilityEntry[];
}

const materialVisibilityRulePrefix = "user_material_visibility_";
const legacyUserMaterialsPath = "$.resources.user_materials";

const materialKeyForSourceRef = (sourceRef: string): string =>
  `um_${createHash("sha256").update(sourceRef).digest("hex").slice(0, 16)}`;

const materialResourcePath = (materialKey: string): string =>
  `$.resources.user_materials_by_ref.${materialKey}`;

const normalizeAttachedMaterialText = (value: string): string =>
  redactText(value).replace(/\s+/g, " ").trim();

const normalizeAttachedMaterialTitle = (value: string): string =>
  value.trim();

const attachedMaterialSourceRef = (value: unknown): string | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const sourceRef = (value as Record<string, unknown>).source_ref;
  return typeof sourceRef === "string" ? sourceRef : null;
};

const appendAttachedMaterialOnce = <T>(items: readonly T[], material: AttachedMaterialInput, build: () => T): readonly T[] =>
  items.some((item) => attachedMaterialSourceRef(item) === material.source_ref) ? items : [...items, build()];

const safeAttachedMaterial = (material: AttachedMaterialInput) => ({
  title: material.title,
  source_ref: material.source_ref,
  source_type: material.source_type,
  source_label: material.source_label,
  summary: material.summary,
  context_text: material.context_text
});

const attachedMaterialFromValue = (value: unknown): AttachedMaterialInput | null => {
  if (!isRecord(value)) {
    return null;
  }
  const sourceType = parseVisibleMaterialSourceType(value.source_type);
  if (
    typeof value.source_ref !== "string" ||
    sourceType === undefined ||
    typeof value.title !== "string" ||
    typeof value.source_label !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.context_text !== "string"
  ) {
    return null;
  }
  return {
    source_ref: value.source_ref,
    source_type: sourceType,
    title: value.title,
    source_label: value.source_label,
    summary: value.summary,
    context_text: value.context_text
  };
};

const rawVisibilityConfigToInput = (value: unknown): MaterialVisibilityInput | null => {
  if (!isRecord(value) || (value.mode !== "all_stages" && value.mode !== "per_stage") || !Array.isArray(value.entries)) {
    return null;
  }
  const entries = value.entries.flatMap((entry): MaterialVisibilityInput["entries"] => {
    if (!isRecord(entry) || typeof entry.role_id !== "string" || !materialVisibilityAccessBody.safeParse(entry.access).success) {
      return [];
    }
    return [{
      role_id: entry.role_id,
      ...(typeof entry.stage_id === "string" ? { stage_id: entry.stage_id } : {}),
      access: entry.access as MaterialVisibilityAccess
    }];
  });
  return entries.length === 0 ? null : { mode: value.mode, entries };
};

const currentVisibilityInputForMaterial = (
  resources: Record<string, unknown>,
  material: AttachedMaterialInput
): MaterialVisibilityInput | null => {
  if (!isRecord(resources.user_material_visibility)) {
    return null;
  }
  const materialKey = materialKeyForSourceRef(material.source_ref);
  const direct = rawVisibilityConfigToInput(resources.user_material_visibility[materialKey]);
  if (direct !== null) {
    return direct;
  }
  for (const value of Object.values(resources.user_material_visibility)) {
    if (isRecord(value) && value.source_ref === material.source_ref) {
      return rawVisibilityConfigToInput(value);
    }
  }
  return null;
};

const normalizeMaterialVisibilityConfig = (
  scenario: NormalizedScenarioV1,
  material: AttachedMaterialInput,
  input: MaterialVisibilityInput | null
): MaterialVisibilityConfig => {
  const materialKey = materialKeyForSourceRef(material.source_ref);
  const visibility: MaterialVisibilityInput = input ?? {
    mode: "all_stages" as const,
    entries: scenario.roles.map((role) => ({ role_id: role.id, access: "full" as const }))
  };
  const roleIds = scenario.roles.map((role) => role.id);
  const roleIdSet = new Set(roleIds);
  const stageIds = scenario.stages.map((stage) => stage.id);
  const stageIdSet = new Set(stageIds);

  if (visibility.mode === "all_stages") {
    const accessByRole = new Map<string, MaterialVisibilityAccess>(roleIds.map((roleId) => [roleId, "full"]));
    const seen = new Set<string>();
    for (const entry of visibility.entries) {
      if (entry.stage_id !== undefined) {
        throw validationError("全部阶段统一配置不能包含阶段。");
      }
      if (!roleIdSet.has(entry.role_id)) {
        throw validationError("材料可见性包含未知角色，请刷新页面后重试。");
      }
      if (seen.has(entry.role_id)) {
        throw validationError("同一角色不能重复配置材料可见性。");
      }
      seen.add(entry.role_id);
      accessByRole.set(entry.role_id, entry.access);
    }
    return {
      source_ref: material.source_ref,
      material_key: materialKey,
      mode: "all_stages",
      entries: roleIds.map((roleId) => ({ role_id: roleId, access: accessByRole.get(roleId) ?? "full" }))
    };
  }

  const accessByRoleAndStage = new Map<string, MaterialVisibilityAccess>();
  for (const stageId of stageIds) {
    for (const roleId of roleIds) {
      accessByRoleAndStage.set(`${stageId}\n${roleId}`, "full");
    }
  }
  const seen = new Set<string>();
  for (const entry of visibility.entries) {
    if (entry.stage_id === undefined) {
      throw validationError("按阶段配置必须包含阶段。");
    }
    if (!roleIdSet.has(entry.role_id)) {
      throw validationError("材料可见性包含未知角色，请刷新页面后重试。");
    }
    if (!stageIdSet.has(entry.stage_id)) {
      throw validationError("材料可见性包含未知阶段，请刷新页面后重试。");
    }
    const key = `${entry.stage_id}\n${entry.role_id}`;
    if (seen.has(key)) {
      throw validationError("同一角色和阶段不能重复配置材料可见性。");
    }
    seen.add(key);
    accessByRoleAndStage.set(key, entry.access);
  }
  return {
    source_ref: material.source_ref,
    material_key: materialKey,
    mode: "per_stage",
    entries: stageIds.flatMap((stageId) =>
      roleIds.map((roleId) => ({
        role_id: roleId,
        stage_id: stageId,
        access: accessByRoleAndStage.get(`${stageId}\n${roleId}`) ?? "full"
      }))
    )
  };
};

const visibilitySummaryLabel = (config: MaterialVisibilityConfig): string => {
  if (config.mode === "per_stage") {
    return "按阶段自定义";
  }
  const counts = config.entries.reduce<Record<MaterialVisibilityAccess, number>>(
    (result, entry) => ({ ...result, [entry.access]: result[entry.access] + 1 }),
    { full: 0, summary: 0, hidden: 0 }
  );
  if (counts.full === config.entries.length) {
    return "全部角色全文可见";
  }
  if (counts.summary === config.entries.length) {
    return "全部角色摘要可见";
  }
  if (counts.hidden === config.entries.length) {
    return "全部角色不可见";
  }
  return "自定义可见性";
};

const previewVisibility = (config: MaterialVisibilityConfig) => ({
  source_ref: config.source_ref,
  material_key: config.material_key,
  mode: config.mode,
  summary_label: visibilitySummaryLabel(config),
  entries: config.entries
});

const buildMaterialVisibilityRules = (
  scenario: NormalizedScenarioV1,
  config: MaterialVisibilityConfig
): NormalizedScenarioV1["visibility_policy"]["rules"] => {
  const target = { kind: "resource" as const, path: materialResourcePath(config.material_key) };
  if (config.mode === "all_stages") {
    return (["full", "summary"] as const).flatMap((access): NormalizedScenarioV1["visibility_policy"]["rules"] => {
      const roleIds = config.entries.filter((entry) => entry.access === access).map((entry) => entry.role_id);
      if (roleIds.length === 0) {
        return [];
      }
      return [{
        id: `${materialVisibilityRulePrefix}${config.material_key}_${access}_all_stages`,
        subject: { role_ids: roleIds, stage_ids: scenario.stages.map((stage) => stage.id) },
        target,
        access
      }];
    });
  }

  return scenario.stages.flatMap((stage) =>
    (["full", "summary"] as const).flatMap((access): NormalizedScenarioV1["visibility_policy"]["rules"] => {
      const roleIds = config.entries
        .filter((entry) => entry.stage_id === stage.id && entry.access === access)
        .map((entry) => entry.role_id);
      if (roleIds.length === 0) {
        return [];
      }
      return [{
        id: `${materialVisibilityRulePrefix}${config.material_key}_${stage.id}_${access}`,
        subject: { role_ids: roleIds, stage_ids: [stage.id] },
        target,
        access
      }];
    })
  );
};

const isGeneratedMaterialVisibilityRule = (rule: NormalizedScenarioV1["visibility_policy"]["rules"][number]): boolean =>
  rule.id.startsWith(materialVisibilityRulePrefix) ||
  (rule.id === "user_materials_visible" && rule.target.kind === "resource" && rule.target.path === legacyUserMaterialsPath);

const attachVisibilityToPreview = (preview: Record<string, unknown>, scenario: NormalizedScenarioV1): Record<string, unknown> => {
  if (!Array.isArray(preview.attached_materials) || !isRecord(scenario.resources.user_material_visibility)) {
    return preview;
  }
  const visibilityConfigs = new Map<string, MaterialVisibilityConfig>();
  for (const value of Object.values(scenario.resources.user_material_visibility)) {
    if (
      isRecord(value) &&
      typeof value.source_ref === "string" &&
      typeof value.material_key === "string" &&
      (value.mode === "all_stages" || value.mode === "per_stage") &&
      Array.isArray(value.entries)
    ) {
      const input = rawVisibilityConfigToInput(value);
      if (input !== null) {
        const material = attachedMaterialFromValue((scenario.resources.user_materials_by_ref as Record<string, unknown> | undefined)?.[value.material_key]);
        if (material !== null) {
          const config = normalizeMaterialVisibilityConfig(scenario, material, input);
          visibilityConfigs.set(config.source_ref, config);
        }
      }
    }
  }
  return {
    ...preview,
    attached_materials: preview.attached_materials.map((item) => {
      if (!isRecord(item) || typeof item.source_ref !== "string") {
        return item;
      }
      const config = visibilityConfigs.get(item.source_ref);
      return config === undefined ? item : { ...item, visibility: previewVisibility(config) };
    })
  };
};

const attachedMaterialsFromResources = (resources: Record<string, unknown>): readonly AttachedMaterialInput[] => {
  const currentMaterials = Array.isArray(resources.user_materials) ? resources.user_materials : [];
  return currentMaterials.flatMap((value): AttachedMaterialInput[] => {
    const material = attachedMaterialFromValue(value);
    return material === null ? [] : [material];
  });
};

const rebuildScenarioMaterialVisibility = ({
  scenario,
  materials,
  visibilityOverride
}: {
  readonly scenario: NormalizedScenarioV1;
  readonly materials: readonly AttachedMaterialInput[];
  readonly visibilityOverride?: {
    readonly source_ref: string;
    readonly visibility: MaterialVisibilityInput;
  };
}): NormalizedScenarioV1 => {
  const currentResources = scenario.resources as Record<string, unknown>;
  const materialsByRef = Object.fromEntries(
    materials.map((material) => [materialKeyForSourceRef(material.source_ref), safeAttachedMaterial(material)])
  );
  const visibilityConfigs = Object.fromEntries(
    materials.map((material) => {
      const visibilityInput = visibilityOverride?.source_ref === material.source_ref
        ? visibilityOverride.visibility
        : currentVisibilityInputForMaterial(currentResources, material);
      const config = normalizeMaterialVisibilityConfig(scenario, material, visibilityInput);
      return [config.material_key, config];
    })
  );
  const baseRules = scenario.visibility_policy.rules.filter((rule) => !isGeneratedMaterialVisibilityRule(rule));
  const materialRules = Object.values(visibilityConfigs).flatMap((config) => buildMaterialVisibilityRules(scenario, config));

  return NormalizedScenarioV1Schema.parse({
    ...scenario,
    resources: {
      ...scenario.resources,
      user_materials: materials.map((material) => safeAttachedMaterial(material)),
      user_materials_by_ref: materialsByRef,
      user_material_visibility: visibilityConfigs
    },
    visibility_policy: {
      ...scenario.visibility_policy,
      rules: [...baseRules, ...materialRules]
    }
  });
};

const previewWithAttachedMaterial = (
  body: Record<string, unknown>,
  scenario: NormalizedScenarioV1,
  material?: AttachedMaterialInput
): Record<string, unknown> => {
  const preview = (body.preview !== null && typeof body.preview === "object" && !Array.isArray(body.preview) ? body.preview : {}) as Record<string, unknown>;
  const previewAttachedMaterials = Array.isArray(preview.attached_materials) ? preview.attached_materials : [];
  const nextPreviewAttachedMaterials = material === undefined
    ? previewAttachedMaterials
    : appendAttachedMaterialOnce(previewAttachedMaterials, material, () => ({
        label: material.title,
        source_label: material.source_label,
        source_ref: material.source_ref,
        source_type: material.source_type,
        value: material.summary,
        is_default: false
      }));
  return attachVisibilityToPreview({
    ...preview,
    attached_materials: nextPreviewAttachedMaterials
  }, scenario);
};

const attachedMaterialFromLibrary = (material: MaterialRecord): AttachedMaterialInput => {
  const summary = materialSummary(material);
  return {
    source_ref: `material:${material.id}`,
    source_type: "library_text",
    title: summary.title,
    source_label: summary.source_label,
    summary: summary.summary,
    context_text: materialContextText(material)
  };
};

const attachedMaterialFromTemporaryText = (title: string, text: string): AttachedMaterialInput => {
  const normalizedTitle = normalizeAttachedMaterialTitle(title);
  const contextText = normalizeAttachedMaterialText(text);
  if (normalizedTitle.length === 0 || contextText.length === 0) {
    throw validationError("临时材料标题和正文不能为空。");
  }
  return {
    source_ref: `temporary_text:${createHash("sha256").update(`${normalizedTitle}\n${contextText}`).digest("hex").slice(0, 16)}`,
    source_type: "temporary_text",
    title: normalizedTitle,
    source_label: "临时文本",
    summary: `已添加 ${contextText.length} 字临时材料，可用于演练上下文。`,
    context_text: contextText
  };
};

const attachMaterialToDraftBody = (
  draft: { readonly body: JsonObject },
  material: AttachedMaterialInput,
  visibility?: MaterialVisibilityInput
): JsonObject => {
  const body = JSON.parse(JSON.stringify(draft.body)) as Record<string, unknown>;
  const scenario = NormalizedScenarioV1Schema.parse(body.scenario);
  const currentResources = scenario.resources as Record<string, unknown>;
  const currentMaterials = attachedMaterialsFromResources(currentResources);
  const nextMaterials = currentMaterials.some((item) => item.source_ref === material.source_ref)
    ? currentMaterials
    : [...currentMaterials, material];
  const nextScenario = rebuildScenarioMaterialVisibility({
    scenario,
    materials: nextMaterials,
    ...(visibility === undefined ? {} : { visibilityOverride: { source_ref: material.source_ref, visibility } })
  });
  return JsonObjectSchema.parse({
    ...body,
    preview: previewWithAttachedMaterial(body, nextScenario, material),
    semantic_preview: buildScenarioSemanticPreview(nextScenario),
    scenario: nextScenario
  });
};

const updateMaterialVisibilityDraftBody = (
  draft: { readonly body: JsonObject },
  sourceRef: string,
  visibility: MaterialVisibilityInput
): JsonObject => {
  const body = JSON.parse(JSON.stringify(draft.body)) as Record<string, unknown>;
  const scenario = NormalizedScenarioV1Schema.parse(body.scenario);
  const currentResources = scenario.resources as Record<string, unknown>;
  const materials = attachedMaterialsFromResources(currentResources);
  if (!materials.some((material) => material.source_ref === sourceRef)) {
    throw scenarioError("找不到这份已附加材料，请重新引用后再配置可见性。", 404);
  }
  const nextScenario = rebuildScenarioMaterialVisibility({
    scenario,
    materials,
    visibilityOverride: { source_ref: sourceRef, visibility }
  });
  return JsonObjectSchema.parse({
    ...body,
    preview: previewWithAttachedMaterial(body, nextScenario),
    semantic_preview: buildScenarioSemanticPreview(nextScenario),
    scenario: nextScenario
  });
};

const draftScenarioCheck = (draft: { readonly body: JsonObject }) => {
  const body = draft.body as Record<string, unknown>;
  return checkScenario(body.scenario);
};

const sceneImportError = (error: unknown): ProductApiError => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("normalized_hash mismatch")) {
    return scenarioError("场景文件校验失败，请重新导出后再导入。", 400);
  }
  if (message.includes("Unsupported scene export schema_version")) {
    return scenarioError("场景文件版本不受支持，请使用当前版本重新导出。", 400);
  }
  if (message.includes("missing") || message.includes("invalid scene metadata")) {
    return scenarioError("场景文件结构不完整，请检查后重试。", 400);
  }
  if (message.includes("Imported scenario is invalid")) {
    return scenarioError("场景文件内容不可用，请修复后再导入。", 400);
  }
  return scenarioError("场景文件无法导入，请检查文件内容后重试。", 400);
};

const confirmedDto = (scene: { readonly id: string; readonly draft_id: string | null; readonly scenario: NormalizedScenarioV1; readonly created_at: string }) => ({
  id: scene.id,
  draft_id: scene.draft_id,
  source_template_id: sourceTemplateId(scene.scenario),
  title: scene.scenario.title,
  normalized_hash: hashNormalizedScenario(scene.scenario),
  created_at: scene.created_at
});

const sessionStatusLabels: Record<SessionView["status"], string> = {
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  ended: "已结束",
  failed: "演练失败",
  blocked: "运行时已阻断"
};

const reviewStatusLabels = {
  pending: "复盘生成中",
  succeeded: "复盘已生成",
  failed: "复盘生成失败"
} as const;

const safeSessionHistoryDto = async (context: ProductApiContext, sessionId: string) => {
  const view = await context.runtime.getView(sessionId);
  const scenario = await context.runtime.getScenario(sessionId);
  const events = await context.runtime.listEvents(sessionId);
  const scene = await context.repositories.confirmedScenes.getByScenarioId(scenario.id);
  const reviews = await context.repositories.reviewReports.listBySession(sessionId);
  const title = scene?.scenario.title ?? scenario.title;
  const firstEventAt = events[0]?.created_at ?? "";
  const lastEventAt = events[events.length - 1]?.created_at ?? firstEventAt;
  const dialogEventIds = new Set(events.filter((event) => event.type === "StepCommitted").map((event) => event.id));
  const transcript = view.visible_transcript.filter((entry) => dialogEventIds.has(entry.event_id));
  return {
    title,
    status: view.status,
    status_label: sessionStatusLabels[view.status],
    created_at: firstEventAt,
    updated_at: lastEventAt,
    rounds: transcript.length,
    model_summary: {
      label: context.modelMode === "real" ? "真实模型" : "Fake LLM",
      mode: context.modelMode
    },
    scene: {
      title,
      archived: scene?.deleted_at !== null && scene?.deleted_at !== undefined
    },
    transcript: transcript.map((entry, index) => ({
      sequence: index + 1,
      speaker: entry.actor_name,
      text: entry.text
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      title: `${title}复盘`,
      status: review.status,
      status_label: reviewStatusLabels[review.status]
    }))
  };
};

const recentReviewSummaries = async (context: ProductApiContext, limit: number) => {
  const reviews = await context.repositories.reviewReports.listRecent(limit);
  return Promise.all(reviews.map(async (review) => {
    try {
      const scenario = await context.runtime.getScenario(review.session_id);
      return { ...review, title: `${scenario.title}复盘` };
    } catch {
      return review;
    }
  }));
};

const defaultModelConfig = {
  id: "default",
  provider: "fake",
  base_url: "local",
  model: "fake-llm",
  api_key: ""
};

const missingRealModelConfigError = () =>
  new ProductApiError("model_error", 400, "当前为真实模型模式，但还没有可用模型配置，请到设置页保存 OpenAI 兼容配置。");

const connectionTestArgsSchema = {
  type: "object",
  properties: { ok: { type: "string" } },
  required: ["ok"],
  additionalProperties: false
} satisfies LLMRequest["allowed_steps"][number]["args_schema"];

const connectionTestPrompt = (): string => [
  "You are validating that this model can follow the PersonalFlow AgentAction protocol.",
  "Return exactly one JSON object. Do not wrap it in markdown, do not return an array, and do not add any extra top-level fields.",
  "The only valid step AgentAction shape is:",
  "{\"kind\":\"step\",\"selected_step\":\"connection_test\",\"content\":\"连接测试通过。\",\"args\":{\"ok\":\"yes\"}}",
  "Required top-level keys: \"kind\", \"selected_step\", \"content\", \"args\".",
  "Forbidden alternatives: step_id, selectedStep, action, tool_name, markdown fences, or any field outside the required top-level keys.",
  "Allowed step: connection_test.",
  `Allowed args JSON Schema: ${JSON.stringify(connectionTestArgsSchema)}`
].join("\n");

const adapterRequest = (model: string): LLMRequest => ({
  prompt: connectionTestPrompt(),
  prompt_hash: "connection-test",
  actor_id: "connection_tester",
  allowed_steps: [
    {
      id: "connection_test",
      actor_id: "connection_tester",
      args_schema: connectionTestArgsSchema,
      args_ref_paths: []
    }
  ],
  metadata: { context_hash: "connection-test", visibility_hash: "connection-test", block_hashes: [], source_refs: [model] }
});

const connectionTestFailureMessage = {
  auth: "认证失败，请检查 API Key 或模型服务权限。",
  provider: "模型服务暂时不可用，请稍后重试。",
  response: "连接可用但模型返回内容不是可解析 JSON，请检查模型输出能力。",
  protocol: "连接可用但模型未按演练协议输出，请检查模型能力或提示配置。"
} as const;

const classifyConnectionError = (error: unknown) => {
  if (error !== null && typeof error === "object") {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "provider_auth_error") {
      return { auth_valid: false, json_parseable: false, message: connectionTestFailureMessage.auth };
    }
    if (code === "provider_response_error") {
      return { auth_valid: true, json_parseable: false, message: connectionTestFailureMessage.response };
    }
    if (code === "provider_retryable_error" || code === "provider_timeout" || code === "provider_transport_error") {
      return { auth_valid: true, json_parseable: false, message: connectionTestFailureMessage.provider };
    }
  }
  return { auth_valid: true, json_parseable: false, message: connectionTestFailureMessage.provider };
};

interface VisibleHistoryObservability {
  readonly event_id: string;
  readonly sequence: number;
  readonly actor_id?: string;
  readonly step_id?: string;
  readonly text_summary: string;
}

interface VisibleMaterialEntryObservability {
  readonly title: string;
  readonly source_label: string;
  readonly summary: string;
  readonly source_type?: AttachedMaterialSourceType;
  readonly source_ref?: string;
}

interface VisibleMaterialObservability {
  readonly path: string;
  readonly value: readonly VisibleMaterialEntryObservability[];
}

const sensitiveSummaryPattern = /api.?key|authorization|bearer|credential|full prompt|password|provider raw|raw[_ -]?prompt|secret|sk-[a-z0-9_-]+|token/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseVisibleMaterialSourceType = (value: unknown): AttachedMaterialSourceType | undefined => {
  if (value === "library_text" || value === "temporary_text" || value === "future_file") {
    return value;
  }
  return undefined;
};

const inferVisibleMaterialSourceType = (value: Record<string, unknown>): AttachedMaterialSourceType | undefined => {
  const explicit = parseVisibleMaterialSourceType(value.source_type);
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof value.source_ref === "string") {
    if (value.source_ref.startsWith("material:")) {
      return "library_text";
    }
    if (value.source_ref.startsWith("temporary_text:")) {
      return "temporary_text";
    }
  }
  if (value.source_label === "临时文本") {
    return "temporary_text";
  }
  if (value.source_label === "手动粘贴") {
    return "library_text";
  }
  return undefined;
};

const parseVisibleMaterialEntry = (value: unknown): VisibleMaterialEntryObservability | null => {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.summary !== "string" || typeof value.source_label !== "string") {
    return null;
  }
  const sourceType = inferVisibleMaterialSourceType(value);
  const sourceRef = typeof value.source_ref === "string" ? value.source_ref : undefined;
  const combined = `${value.title}\n${value.summary}\n${value.source_label}\n${sourceType ?? ""}\n${sourceRef ?? ""}`;
  if (sensitiveSummaryPattern.test(combined)) {
    return null;
  }
  return {
    title: value.title,
    source_label: value.source_label,
    summary: value.summary,
    ...(sourceType === undefined ? {} : { source_type: sourceType }),
    ...(sourceRef === undefined ? {} : { source_ref: sourceRef })
  };
};

const extractVisibleHistoryObservability = (request: LLMRequest): readonly VisibleHistoryObservability[] => {
  const marker = "[visible_history]\n";
  const start = request.prompt.indexOf(marker);
  if (start < 0) {
    return [];
  }
  const valueStart = start + marker.length;
  const nextBlock = request.prompt.indexOf("\n\n[", valueStart);
  const raw = request.prompt.slice(valueStart, nextBlock < 0 ? undefined : nextBlock);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item): VisibleHistoryObservability[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.sequence !== "number" || typeof item.text_summary !== "string") {
      return [];
    }
    if (sensitiveSummaryPattern.test(item.text_summary)) {
      return [];
    }
    return [{
      event_id: item.id,
      sequence: item.sequence,
      ...(typeof item.actor_id === "string" ? { actor_id: item.actor_id } : {}),
      ...(typeof item.step_id === "string" ? { step_id: item.step_id } : {}),
      text_summary: item.text_summary
    }];
  });
};

const extractVisibleMaterialObservability = (request: LLMRequest): readonly VisibleMaterialObservability[] => {
  const marker = "[visible_materials]\n";
  const start = request.prompt.indexOf(marker);
  if (start < 0) {
    return [];
  }
  const valueStart = start + marker.length;
  const nextBlock = request.prompt.indexOf("\n\n[", valueStart);
  const raw = request.prompt.slice(valueStart, nextBlock < 0 ? undefined : nextBlock);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item): VisibleMaterialObservability[] => {
    if (!isRecord(item) || typeof item.path !== "string") {
      return [];
    }
    if (Array.isArray(item.value)) {
      const entries = item.value.flatMap((value): VisibleMaterialEntryObservability[] => {
        const entry = parseVisibleMaterialEntry(value);
        return entry === null ? [] : [entry];
      });
      return entries.length === 0 ? [] : [{ path: item.path, value: entries }];
    }
    const entry = parseVisibleMaterialEntry(item.value);
    return entry === null ? [] : [{ path: item.path, value: [entry] }];
  });
};

const observeVisibleHistory = (
  adapter: LLMAdapter,
  onRequest: (visibleHistory: readonly VisibleHistoryObservability[]) => void
): LLMAdapter => ({
  async complete(request) {
    onRequest(extractVisibleHistoryObservability(request));
    return adapter.complete(request);
  }
});

const registerRoutes = (app: FastifyInstance, context: ProductApiContext): void => {
  app.get("/health", async () => ({ status: "ok", service: "personalflow-api" }));

  app.get("/api/recent", async (request) => {
    const { limit = 10 } = parseParams(recentQuery, request.query);
    const sessions = await context.runtimeStore.listRecentSessions(limit);
    return {
      drafts: await context.repositories.sceneDrafts.listRecent(limit),
      scenes: await context.repositories.confirmedScenes.listRecent(limit),
      sessions: sessions.map((session) => ({
        ...session,
        status_label: sessionStatusLabels[session.status]
      })),
      reviews: await recentReviewSummaries(context, limit)
    };
  });

  app.get("/api/materials", async (request) => {
    const { limit = 10 } = parseParams(recentQuery, request.query);
    return { materials: await context.repositories.materials.listRecent(limit) };
  });

  app.post("/api/materials", async (request, reply) => {
    const body = parseParams(materialBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, body, async () => {
      const created = await context.repositories.materials.create({
        id: context.createId("material"),
        source: body.source ?? "manual",
        title: body.title,
        content: { text: redactText(body.text) },
        created_at: context.now()
      });
      return { statusCode: 201, body: { material: materialSummary(created) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/api/templates", async () => ({ templates: builtInTemplates.map(templateSummary) }));

  app.get("/api/templates/:templateId", async (request) => {
    const { templateId } = parseParams(z.object({ templateId: z.string().min(1) }).strict(), request.params);
    const template = builtInTemplates.find((item) => item.id === templateId);
    if (template === undefined) {
      throw scenarioError("Template does not exist.", 404);
    }
    return { template: templateDetail(template) };
  });

  app.post("/api/drafts/from-template", async (request, reply) => {
    const body = parseParams(fromTemplateBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, body, async () => {
      const built = buildDraftFromTemplate(body.template_id, body.params);
      const now = context.now();
      const created = await context.repositories.sceneDrafts.create({
        id: context.createId("draft"),
        template_id: built.template_id,
        body: JSON.parse(JSON.stringify(built.body)) as JsonObject,
        created_at: now,
        updated_at: now
      });
      return { statusCode: 201, body: { draft: draftDto(created) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/drafts/from-complex-config", async (request, reply) => {
    const body = parseParams(complexConfigBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, body, async () => {
      const built = buildDraftFromComplexConfig(body);
      const now = context.now();
      const created = await context.repositories.sceneDrafts.create({
        id: context.createId("draft"),
        template_id: built.template_id,
        body: JSON.parse(JSON.stringify(built.body)) as JsonObject,
        created_at: now,
        updated_at: now
      });
      return { statusCode: 201, body: { draft: draftDto(created) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/api/drafts/:draftId", async (request) => {
    const { draftId } = parseParams(z.object({ draftId: z.string().min(1) }).strict(), request.params);
    const draft = await context.repositories.sceneDrafts.get(draftId);
    if (draft === null) {
      throw scenarioError("找不到这个草稿，请重新创建或返回首页。", 404);
    }
    return { draft: draftDto(draft) };
  });

  app.post("/api/drafts/:draftId/check", async (request) => {
    parseParams(idempotentOnlyBody, request.body ?? {});
    const { draftId } = parseParams(z.object({ draftId: z.string().min(1) }).strict(), request.params);
    const draft = await context.repositories.sceneDrafts.get(draftId);
    if (draft === null) {
      throw scenarioError("找不到这个草稿，请重新创建或返回首页。", 404);
    }
    return { ...draftScenarioCheck(draft), draft: draftDto(draft) };
  });

  app.post("/api/drafts/:draftId/materials", async (request, reply) => {
    const { draftId } = parseParams(z.object({ draftId: z.string().min(1) }).strict(), request.params);
    const body = parseAttachMaterialBody(request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { draftId, body }, async () => {
      const draft = await context.repositories.sceneDrafts.get(draftId);
      if (draft === null) {
        throw scenarioError("找不到这个草稿，请重新创建或返回首页。", 404);
      }
      const material = "kind" in body && body.kind === "temporary_text"
        ? attachedMaterialFromTemporaryText(body.title, body.text)
        : await (async () => {
            const libraryMaterial = await context.repositories.materials.get(body.material_id);
            if (libraryMaterial === null) {
              throw scenarioError("找不到这条材料，请返回材料页重新添加。", 404);
            }
            return attachedMaterialFromLibrary(libraryMaterial);
          })();
      const updated = await context.repositories.sceneDrafts.update(draftId, {
        body: attachMaterialToDraftBody(draft, material, body.visibility),
        updated_at: context.now()
      });
      return { statusCode: 200, body: { draft: draftDto(updated) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.patch("/api/drafts/:draftId/materials/visibility", async (request, reply) => {
    const { draftId } = parseParams(z.object({ draftId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(updateMaterialVisibilityBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { draftId, body, method: "updateMaterialVisibility" }, async () => {
      const draft = await context.repositories.sceneDrafts.get(draftId);
      if (draft === null) {
        throw scenarioError("找不到这个草稿，请重新创建或返回首页。", 404);
      }
      const updated = await context.repositories.sceneDrafts.update(draftId, {
        body: updateMaterialVisibilityDraftBody(draft, body.source_ref, body.visibility),
        updated_at: context.now()
      });
      return { statusCode: 200, body: { draft: draftDto(updated) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/drafts/:draftId/confirm", async (request, reply) => {
    const { draftId } = parseParams(z.object({ draftId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(confirmBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { draftId, body }, async () => {
      const draft = await context.repositories.sceneDrafts.get(draftId);
      if (draft === null) {
        throw scenarioError("找不到这个草稿，请重新创建或返回首页。", 404);
      }
      const check = draftScenarioCheck(draft);
      if (!check.ok) {
        throw new ProductApiError("scenario_quality_blocked", 400, "这个草稿需要修复后才能开始演练。", {
          status: check.status,
          issues: check.issues
        });
      }
      const confirmed = confirmDraft(draftFromRecord(draft));
      const created = await context.repositories.confirmedScenes.create({
        id: context.createId("scene"),
        draft_id: draft.id,
        scenario: confirmed.scenario,
        created_at: context.now()
      });
      return { statusCode: 201, body: { scene: confirmedDto(created) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/scenes/:sceneId/sessions", async (request, reply) => {
    const { sceneId } = parseParams(z.object({ sceneId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(startSessionBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sceneId, body }, async () => {
      const scene = await context.repositories.confirmedScenes.get(sceneId);
      if (scene === null) {
        throw scenarioError("Scene does not exist.", 404);
      }
      if (scene.deleted_at !== null) {
        throw scenarioError("这个场景已归档，不能开始新的演练；历史演练和复盘仍可查看。", 400);
      }
      const view = await startSessionWithRootBranch(context, scene.scenario);
      return { statusCode: 201, body: { session: await productSessionDto(context, view) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/api/sessions/:sessionId", async (request) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    return { session: await productSessionDto(context, await context.runtime.getView(sessionId)) };
  });

  app.get("/api/sessions/:sessionId/branch-tree", async (request) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    return GetBranchTreeResponseSchema.parse({ tree: await getBranchTree(context, sessionId) });
  });

  app.get("/api/sessions/:sessionId/history", async (request) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    return { history: await safeSessionHistoryDto(context, sessionId) };
  });

  app.post("/api/sessions/:sessionId/forks", async (request, reply) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(CreateSessionForkRequestSchema, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sessionId, body, method: "fork" }, async () => {
      const response = await createSessionFork(context, sessionId, body);
      return { statusCode: 201, body: response };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/sessions/:sessionId/withdraw", async (request, reply) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(WithdrawUserInputRequestSchema, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sessionId, body, method: "withdraw" }, async () => {
      const response = await withdrawUserInput(context, sessionId, body);
      return { statusCode: 201, body: response };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/sessions/:sessionId/input", async (request, reply) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(inputBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, { sessionId, body }, async () => {
      const view = await context.runtime.submitUserInput({
        sessionId,
        input: body.input,
        expectedStateVersion: body.expected_state_version
      });
      return { statusCode: 200, body: { session: await productSessionDto(context, view) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/sessions/:sessionId/ai-turn", async (request, reply) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(aiTurnBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, { sessionId, body }, async () => {
      let selectedConfig: ModelConfigForModelCall = defaultModelConfig;
      if (context.modelMode === "real") {
        const config = body.model_config_id === undefined
          ? await context.repositories.modelConfigs.getDefaultForModelCall()
          : await context.repositories.modelConfigs.getForModelCall(body.model_config_id);
        if (config === null || config.provider !== "openai-compatible") {
          throw missingRealModelConfigError();
        }
        selectedConfig = config;
      }
      let visibleHistory: readonly VisibleHistoryObservability[] = [];
      let visibleMaterials: readonly VisibleMaterialObservability[] = [];
      const adapter = observeVisibleHistory(context.createModelAdapter(selectedConfig), (observedVisibleHistory) => {
        visibleHistory = observedVisibleHistory;
      });
      const materialAwareAdapter: LLMAdapter = {
        async complete(request) {
          visibleMaterials = extractVisibleMaterialObservability(request);
          return adapter.complete(request);
        }
      };
      const view = await context.runtime.runAiTurn({
        sessionId,
        actorId: body.actor_id,
        expectedStateVersion: body.expected_state_version,
        adapter: materialAwareAdapter
      });
      return {
        statusCode: 200,
        body: {
          session: await productSessionDto(context, view),
          ai_turn_observability: {
            ...context.describeModelRoute(selectedConfig),
            visible_history: visibleHistory,
            ...(visibleMaterials.length === 0 ? {} : { visible_materials: visibleMaterials })
          }
        }
      };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  const commandRoute = (method: "pauseSession" | "resumeSession" | "endSession") => async (request: unknown, reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }) => {
    const req = request as { params: unknown; body: unknown };
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), req.params);
    const body = parseParams(commandBody, req.body);
    const result = await replayOrRun(context, body.idempotency_key, { sessionId, body, method }, async () => {
      const view = await context.runtime[method]({ sessionId, expectedStateVersion: body.expected_state_version });
      return { statusCode: 200, body: { session: await productSessionDto(context, view) } };
    });
    return reply.code(result.statusCode).send(result.body);
  };
  app.post("/api/sessions/:sessionId/pause", commandRoute("pauseSession"));
  app.post("/api/sessions/:sessionId/resume", commandRoute("resumeSession"));
  app.post("/api/sessions/:sessionId/end", commandRoute("endSession"));

  app.get("/api/model-configs", async () => {
    const [modelConfigs, defaultModelConfig] = await Promise.all([
      context.repositories.modelConfigs.listSafe(),
      context.repositories.modelConfigs.getDefaultSafe()
    ]);
    return { model_configs: modelConfigs, default_model_config_id: defaultModelConfig?.id ?? null };
  });
  app.post("/api/model-configs", async (request, reply) => {
    const body = parseParams(modelConfigBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, body, async () => {
      const now = context.now();
      const modelConfig = await context.repositories.modelConfigs.create({ id: context.createId("model"), provider: body.provider, base_url: body.base_url, model: body.model, display_name: body.display_name, api_key: body.api_key, created_at: now, updated_at: now });
      return { statusCode: 201, body: { model_config: modelConfig } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
  app.patch("/api/model-configs/:modelConfigId/default", async (request, reply) => {
    const { modelConfigId } = parseParams(z.object({ modelConfigId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(idempotentOnlyBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { modelConfigId, body, method: "setDefaultModelConfig" }, async () => {
      const modelConfig = await context.repositories.modelConfigs.setDefault(modelConfigId);
      return { statusCode: 200, body: { model_config: modelConfig, default_model_config_id: modelConfig.id } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
  app.get("/api/model-configs/:modelConfigId", async (request) => {
    const { modelConfigId } = parseParams(z.object({ modelConfigId: z.string().min(1) }).strict(), request.params);
    const modelConfig = await context.repositories.modelConfigs.getSafe(modelConfigId);
    if (modelConfig === null) {
      throw scenarioError("Model config does not exist.", 404);
    }
    return { model_config: modelConfig };
  });
  app.patch("/api/model-configs/:modelConfigId", async (request, reply) => {
    const { modelConfigId } = parseParams(z.object({ modelConfigId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(modelConfigUpdateBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, { modelConfigId, body, method: "patchModelConfig" }, async () => {
      const update = Object.fromEntries(Object.entries(body).filter(([key, value]) => key !== "idempotency_key" && value !== undefined));
      return { statusCode: 200, body: { model_config: await context.repositories.modelConfigs.update(modelConfigId, { ...update, updated_at: context.now() }) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
  app.delete("/api/model-configs/:modelConfigId", async (request, reply) => {
    const { modelConfigId } = parseParams(z.object({ modelConfigId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(deleteModelConfigBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { modelConfigId, body, method: "deleteModelConfig" }, async () => {
      await context.repositories.modelConfigs.delete(modelConfigId);
      return { statusCode: 200, body: { deleted: true } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/scenes/:sceneId/copy", async (request, reply) => {
    const { sceneId } = parseParams(z.object({ sceneId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(idempotentOnlyBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sceneId, body, method: "copyScene" }, async () => {
      const now = context.now();
      const draft = await context.repositories.confirmedScenes.copyToDraft({
        source_scene_id: sceneId,
        draft_id: context.createId("draft"),
        created_at: now,
        updated_at: now
      });
      return { statusCode: 201, body: { draft: draftDto(draft) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.delete("/api/scenes/:sceneId", async (request, reply) => {
    const { sceneId } = parseParams(z.object({ sceneId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(deleteSceneBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sceneId, body, method: "deleteScene" }, async () => {
      if (!body.confirm) {
        throw scenarioError("删除场景前需要确认。", 400);
      }
      await context.repositories.confirmedScenes.softDelete(sceneId, context.now());
      return { statusCode: 200, body: { deleted: true, message: "场景已从默认列表移除，历史演练和复盘仍可查看。" } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
  app.patch("/api/scenes/:sceneId", async (request, reply) => {
    const { sceneId } = parseParams(z.object({ sceneId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(renameSceneBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sceneId, body, method: "renameScene" }, async () => {
      const renamed = await context.repositories.confirmedScenes.rename(sceneId, { title: body.title });
      return { statusCode: 200, body: { scene: confirmedDto(renamed) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
  app.get("/api/scenes/archive", async () => ({
    scenes: await context.repositories.confirmedScenes.listArchive()
  }));
  app.post("/api/model-configs/:modelConfigId/test", async (request, reply) => {
    const { modelConfigId } = parseParams(z.object({ modelConfigId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(idempotentOnlyBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { modelConfigId, body }, async () => {
      const config = await context.repositories.modelConfigs.getForModelCall(modelConfigId);
      if (config === null) {
        throw scenarioError("Model config does not exist.", 404);
      }
      const base = { provider: config.provider, base_url: config.base_url, model: config.model };
      let responseContent = "";
      try {
        const response = await context.createModelAdapter(config).complete(adapterRequest(config.model));
        responseContent = response.content;
      } catch (error) {
        return {
          statusCode: 200,
          body: {
            ok: false,
            ...base,
            provider_reachable: true,
            protocol_valid: false,
            ...classifyConnectionError(error)
          }
        };
      }
      const parsed = parseAgentOutput(responseContent);
      if (!parsed.ok || parsed.action.kind !== "step" || parsed.action.selected_step !== "connection_test") {
        return {
          statusCode: 200,
          body: {
            ok: false,
            ...base,
            provider_reachable: true,
            auth_valid: true,
            json_parseable: true,
            protocol_valid: false,
            message: connectionTestFailureMessage.protocol
          }
        };
      }
      return {
        statusCode: 200,
        body: {
          ok: true,
          ...base,
          provider_reachable: true,
          auth_valid: true,
          json_parseable: true,
          protocol_valid: true,
          message: "连接测试通过：认证、JSON 解析和演练协议均可用。"
        }
      };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/scenes/import", async (request, reply) => {
    const body = parseParams(importSceneBody, request.body);
    const result = await replayOrRun(context, body.idempotency_key, body, async () => {
      let imported: ConfirmedScene;
      try {
        imported = importScene(body.export_json);
      } catch (error) {
        throw sceneImportError(error);
      }
      const created = await context.repositories.confirmedScenes.create({ id: context.createId("scene"), draft_id: null, scenario: imported.scenario, created_at: context.now() });
      return { statusCode: 201, body: { scene: confirmedDto(created) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
  app.get("/api/scenes/:sceneId/export", async (request) => {
    const { sceneId } = parseParams(z.object({ sceneId: z.string().min(1) }).strict(), request.params);
    const scene = await context.repositories.confirmedScenes.get(sceneId);
    if (scene === null) {
      throw scenarioError("Scene does not exist.", 404);
    }
    const confirmed: ConfirmedScene = { id: scene.id, source_template_id: sourceTemplateId(scene.scenario), scenario: scene.scenario, normalized_hash: hashNormalizedScenario(scene.scenario) };
    return { export_json: exportSceneForUser(confirmed) };
  });

  registerReviewRoutes(app, context);
};

export function buildApp(options: BuildAppOptions = {}) {
  const context = options.context ?? createProductApiContext(options);
  const app = Fastify({ logger: options.logger ?? true });
  app.setErrorHandler((error, _request, reply) => {
    const apiError = toApiError(error);
    reply.code(apiError.statusCode).send(serializeApiError(apiError));
  });
  app.setNotFoundHandler((_request, reply) => {
    const apiError = new ProductApiError("scenario_error", 404, "Route does not exist.");
    reply.code(404).send(serializeApiError(apiError));
  });
  registerRoutes(app, context);
  return app;
}
