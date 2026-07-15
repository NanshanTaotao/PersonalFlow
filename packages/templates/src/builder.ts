import { JsonObjectSchema, NormalizedScenarioV1Schema, type JsonObject, type JsonValue, type NormalizedScenarioV1 } from "@personalflow/contracts";

import { hashNormalizedScenario } from "./hash";
import { buildPreview, type TemplatePreview } from "./preview";
import { buildScenarioSemanticPreview, type ScenarioSemanticPreview } from "./semantic-preview";
import { findBuiltInTemplate, type BuiltInTemplateDefinition } from "./templates";
import { checkScenario } from "./validator";

export class TemplateBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateBuildError";
  }
}

export interface TemplateDraft {
  readonly id: string;
  readonly template_id: string;
  readonly params: JsonObject;
  readonly preview: TemplatePreview;
  readonly semantic_preview: ScenarioSemanticPreview;
  readonly scenario: NormalizedScenarioV1;
  readonly body: JsonObject;
}

export interface ConfirmedScene {
  readonly id: string;
  readonly source_template_id: string;
  readonly scenario: NormalizedScenarioV1;
  readonly normalized_hash: string;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const assertString = (key: string, value: JsonValue, minLength: number | undefined): string => {
  if (typeof value !== "string") {
    throw new TemplateBuildError("Template param '" + key + "' must be a string.");
  }
  if (minLength !== undefined && value.length < minLength) {
    throw new TemplateBuildError("Template param '" + key + "' is shorter than minLength.");
  }
  return value;
};

const assertInteger = (
  key: string,
  value: JsonValue,
  minimum: number | undefined,
  maximum: number | undefined
): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TemplateBuildError("Template param '" + key + "' must be an integer.");
  }
  if (minimum !== undefined && value < minimum) {
    throw new TemplateBuildError("Template param '" + key + "' is less than minimum.");
  }
  if (maximum !== undefined && value > maximum) {
    throw new TemplateBuildError("Template param '" + key + "' is greater than maximum.");
  }
  return value;
};

const mergeAndValidateParams = (template: BuiltInTemplateDefinition, params: JsonObject): JsonObject => {
  const allowedKeys = new Set(Object.keys(template.param_schema.properties));
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new TemplateBuildError("Unknown template param '" + key + "'.");
    }
  }

  const merged: Record<string, JsonValue> = { ...template.default_params, ...params };
  for (const requiredKey of template.param_schema.required) {
    if (merged[requiredKey] === undefined) {
      throw new TemplateBuildError("Missing template param '" + requiredKey + "'.");
    }
  }

  for (const [key, definition] of Object.entries(template.param_schema.properties)) {
    const value = merged[key];
    if (value === undefined) {
      continue;
    }
    if (definition.type === "string") {
      merged[key] = assertString(key, value, definition.minLength);
    } else {
      merged[key] = assertInteger(key, value, definition.minimum, definition.maximum);
    }
  }

  return JsonObjectSchema.parse(merged);
};

const buildDraftBody = (draft: Omit<TemplateDraft, "body">): JsonObject =>
  JsonObjectSchema.parse({
    template_id: draft.template_id,
    params: draft.params,
    preview: draft.preview,
    semantic_preview: draft.semantic_preview,
    scenario: draft.scenario as unknown
  });

export const buildDraftFromTemplate = (templateId: string, params: JsonObject): TemplateDraft => {
  const template = findBuiltInTemplate(templateId);
  if (template === null) {
    throw new TemplateBuildError("Unknown template '" + templateId + "'.");
  }

  const explicitParamKeys = new Set(Object.keys(params));
  const mergedParams = mergeAndValidateParams(template, params);
  const preview = buildPreview(template, mergedParams, explicitParamKeys);
  const scenario = NormalizedScenarioV1Schema.parse(template.buildScenario(mergedParams));
  const check = checkScenario(scenario);
  if (!check.ok) {
    throw new TemplateBuildError("Template generated an invalid scenario.");
  }

  const draftWithoutBody = {
    id: "draft_" + template.id,
    template_id: template.id,
    params: cloneJson(mergedParams),
    preview,
    semantic_preview: buildScenarioSemanticPreview(scenario),
    scenario: cloneJson(scenario)
  } satisfies Omit<TemplateDraft, "body">;

  return {
    ...draftWithoutBody,
    body: buildDraftBody(draftWithoutBody)
  };
};

export const confirmDraft = (draft: TemplateDraft): ConfirmedScene => {
  const scenario = NormalizedScenarioV1Schema.parse(cloneJson(draft.scenario));
  const check = checkScenario(scenario);
  if (!check.ok) {
    throw new TemplateBuildError("Cannot confirm invalid draft scenario.");
  }

  return {
    id: "confirmed_" + draft.template_id,
    source_template_id: draft.template_id,
    scenario,
    normalized_hash: hashNormalizedScenario(scenario)
  };
};
