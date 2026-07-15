import type { JsonObject, JsonValue } from "@personalflow/contracts";

import { findBuiltInTemplate, type BuiltInTemplateDefinition } from "./templates";

export interface PreviewValue {
  value: string;
  is_default: boolean;
}

export interface PreviewListItem {
  label: string;
  value: string;
  is_default: boolean;
}

export interface TemplatePreview {
  title: PreviewValue;
  goal: PreviewValue;
  user_role: PreviewValue;
  ai_role: PreviewValue;
  flow: PreviewListItem[];
  materials: PreviewListItem[];
  review_method: PreviewValue;
  estimated_duration: PreviewValue;
  pressure_level: PreviewValue;
  ready_summary: PreviewValue;
  notes: PreviewListItem[];
}

const defaultConfirmationMetadata = {
  estimated_duration: "约 15 分钟（默认估计）",
  pressure_level: "标准压力：会有追问，适合日常练习。（默认估计）",
  ready_summary: "场景已完成基础检查，使用默认设置可以开始演练。",
  notes: [
    "可以用自然语言回答，系统会根据你的回答继续追问。",
    "建议提前准备相关材料；真实模型模式可能受网络、额度或配置影响。"
  ]
} as const;

const stringifyPreviewValue = (value: JsonValue | undefined): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
};

const estimateDuration = (
  metadata: BuiltInTemplateDefinition["preview_metadata"],
  params: JsonObject,
  explicitParamKeys: ReadonlySet<string>
): PreviewValue => {
  if (metadata.estimated_duration !== undefined) {
    return { value: metadata.estimated_duration, is_default: false };
  }
  const maxTurns = params.max_turns;
  if (typeof maxTurns === "number" && Number.isFinite(maxTurns)) {
    return {
      value: `约 ${Math.max(15, Math.round(maxTurns * 2.25))} 分钟`,
      is_default: !explicitParamKeys.has("max_turns")
    };
  }
  return {
    value: defaultConfirmationMetadata.estimated_duration,
    is_default: true
  };
};

const containsCjk = (value: string): boolean => /[\u3400-\u9fff]/.test(value);

const joinGoalCopy = (prefix: string, value: string, suffix: string | undefined): string => {
  const parts = [prefix, value, suffix ?? ""].map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  return parts.every(containsCjk) ? parts.join("") : parts.join(" ");
};

export const buildPreview = (
  template: BuiltInTemplateDefinition,
  params: JsonObject,
  explicitParamKeys: ReadonlySet<string>
): TemplatePreview => {
  const metadata = template.preview_metadata;
  const goalValue = joinGoalCopy(metadata.goal_prefix, stringifyPreviewValue(params[metadata.goal_param]), metadata.goal_suffix);
  const anyExplicit = (keys: readonly string[]) => keys.some((key) => explicitParamKeys.has(key));

  return {
    title: { value: template.title, is_default: false },
    goal: { value: goalValue.trim(), is_default: !explicitParamKeys.has(metadata.goal_param) },
    user_role: { value: metadata.user_role, is_default: true },
    ai_role: { value: metadata.ai_role, is_default: true },
    flow: metadata.flow.map((value, index) => ({
      label: "流程 " + String(index + 1),
      value,
      is_default: true
    })),
    materials: metadata.materials.map((material) => ({
      label: material.label,
      value: stringifyPreviewValue(params[material.param]),
      is_default: !explicitParamKeys.has(material.param)
    })),
    review_method: {
      value: metadata.review_method,
      is_default: !anyExplicit(metadata.materials.map((material) => material.param))
    },
    estimated_duration: estimateDuration(metadata, params, explicitParamKeys),
    pressure_level: {
      value: metadata.pressure_level ?? defaultConfirmationMetadata.pressure_level,
      is_default: metadata.pressure_level === undefined
    },
    ready_summary: {
      value: metadata.ready_summary ?? defaultConfirmationMetadata.ready_summary,
      is_default: metadata.ready_summary === undefined
    },
    notes: (metadata.notes ?? defaultConfirmationMetadata.notes).map((value, index) => ({
      label: "提醒 " + String(index + 1),
      value,
      is_default: metadata.notes === undefined
    }))
  };
};

export const previewTemplate = (templateId: string, params: JsonObject): TemplatePreview => {
  const template = findBuiltInTemplate(templateId);
  if (template === null) {
    throw new Error("Unknown template: " + templateId);
  }
  const merged = { ...template.default_params, ...params };
  return buildPreview(template, merged, new Set(Object.keys(params)));
};
