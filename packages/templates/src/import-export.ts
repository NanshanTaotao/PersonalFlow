import {
  JsonObjectSchema,
  NormalizedScenarioV1Schema,
  ScenarioPackageV1Schema,
  type JsonObject,
  type NormalizedScenarioV1,
  type ScenarioPackageV1
} from "@personalflow/contracts";

import type { ConfirmedScene } from "./builder";
import { hashNormalizedScenario } from "./hash";
import { validateScenario } from "./validator";

export const sceneExportSchemaVersion = "personalflow.scene.export.v1";
const hiddenMaterialExportPlaceholder = "[已隐藏：AI 角色材料不随普通场景导出公开。导入后请重新补充私密评审材料。]";

export interface ExportedScene {
  readonly schema_version: typeof sceneExportSchemaVersion;
  readonly scene: {
    readonly id: string;
    readonly scenario_package: ScenarioPackageV1;
    readonly normalized_hash: string;
  };
  readonly normalized_hash: string;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sourceTemplateIdFromPackage = (scenarioPackage: ScenarioPackageV1): string => {
  const sourceTemplateId = scenarioPackage.authoring_metadata?.source_template_id;
  return typeof sourceTemplateId === "string" && sourceTemplateId.length > 0 ? sourceTemplateId : "imported";
};

const buildExportPayload = (
  confirmedScene: ConfirmedScene,
  scenario: NormalizedScenarioV1,
  normalizedHash: string
): ExportedScene => ({
  schema_version: sceneExportSchemaVersion,
  scene: {
    id: confirmedScene.id,
    scenario_package: {
      runtime_ir: scenario,
      authoring_metadata: {
        source_template_id: confirmedScene.source_template_id
      }
    },
    normalized_hash: normalizedHash
  },
  normalized_hash: normalizedHash
});

export const exportSceneForInternalUse = (confirmedScene: ConfirmedScene): ExportedScene => {
  const scenario = NormalizedScenarioV1Schema.parse(cloneJson(confirmedScene.scenario));
  const normalizedHash = hashNormalizedScenario(scenario);
  if (normalizedHash !== confirmedScene.normalized_hash) {
    throw new Error("confirmed scene normalized_hash mismatch");
  }

  return buildExportPayload(confirmedScene, scenario, normalizedHash);
};

export const redactScenarioForPublicExport = (scenario: NormalizedScenarioV1): NormalizedScenarioV1 => {
  const redacted = NormalizedScenarioV1Schema.parse(cloneJson(scenario));
  const userRoleIds = new Set(redacted.roles.filter((role) => role.kind === "user").map((role) => role.id));
  const userCanSeeResource = (path: string): boolean =>
    redacted.visibility_policy.rules.some((rule) => {
      if (rule.target.kind !== "resource" || rule.target.path !== path || rule.access === "redacted") {
        return false;
      }
      const roleIds = rule.subject.role_ids;
      return roleIds === undefined || roleIds.some((roleId) => userRoleIds.has(roleId));
    });

  for (const key of Object.keys(redacted.resources)) {
    const path = `$.resources.${key}`;
    if (!userCanSeeResource(path)) {
      redacted.resources[key] = hiddenMaterialExportPlaceholder;
    }
  }
  return redacted;
};

export const exportSceneForUser = (confirmedScene: ConfirmedScene): ExportedScene => {
  const original = NormalizedScenarioV1Schema.parse(cloneJson(confirmedScene.scenario));
  const originalHash = hashNormalizedScenario(original);
  if (originalHash !== confirmedScene.normalized_hash) {
    throw new Error("confirmed scene normalized_hash mismatch");
  }
  const redacted = redactScenarioForPublicExport(original);
  return buildExportPayload(confirmedScene, redacted, hashNormalizedScenario(redacted));
};

export const exportScene = exportSceneForUser;

const parseExportObject = (exportJson: unknown): JsonObject => JsonObjectSchema.parse(exportJson);

export const importScene = (exportJson: unknown): ConfirmedScene => {
  const payload = parseExportObject(exportJson);
  if (payload.schema_version !== sceneExportSchemaVersion) {
    throw new Error("Unsupported scene export schema_version.");
  }
  if (!isRecord(payload.scene)) {
    throw new Error("Scene export payload is missing scene metadata.");
  }

  const scene = payload.scene;
  if (typeof scene.id !== "string") {
    throw new Error("Scene export payload has invalid scene metadata.");
  }
  if (typeof scene.normalized_hash !== "string" || typeof payload.normalized_hash !== "string") {
    throw new Error("Scene export payload is missing normalized_hash.");
  }

  const scenarioPackage = ScenarioPackageV1Schema.parse(scene.scenario_package);
  const scenario = NormalizedScenarioV1Schema.parse(scenarioPackage.runtime_ir);
  const validation = validateScenario(scenario);
  if (!validation.ok) {
    throw new Error("Imported scenario is invalid: " + validation.errors[0]?.code);
  }

  const recomputedHash = hashNormalizedScenario(scenario);
  if (recomputedHash !== scene.normalized_hash || recomputedHash !== payload.normalized_hash) {
    throw new Error("normalized_hash mismatch");
  }

  return {
    id: scene.id,
    source_template_id: sourceTemplateIdFromPackage(scenarioPackage),
    scenario: cloneJson(scenario),
    normalized_hash: recomputedHash
  };
};
