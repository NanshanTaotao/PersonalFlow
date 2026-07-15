import type { JsonObject, JsonSchemaValue, JsonValue, NormalizedScenarioV1, RoleContractV3, RuntimeEvent, StepContractV3 } from "@personalflow/contracts";

import { hashStableValue } from "./hash";
import { findActor } from "./scheduler";
import { resolveActiveStage } from "./stage";
import { projectVisibility, type VisibleEventSummary } from "./visibility";

export interface VisibleMaterial {
  readonly path: string;
  readonly value: JsonValue;
}

export interface VisibleAllowedStep {
  readonly id: string;
  readonly actor_id: string;
  readonly prompt: string;
  readonly argument_requirements: {
    readonly args_schema: JsonSchemaValue;
    readonly args_ref_paths: readonly string[];
  };
}

export interface VisibleContextBundle {
  readonly actor_id: string;
  readonly actor: RoleContractV3;
  readonly active_stage?: {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
  };
  readonly current_progress: {
    readonly state: JsonObject;
    readonly state_version?: number;
  };
  readonly visible_history: readonly VisibleEventSummary[];
  readonly visible_materials: readonly VisibleMaterial[];
  readonly allowed_steps: readonly VisibleAllowedStep[];
  readonly source_refs: readonly string[];
  readonly visibility_hash: string;
  readonly context_hash: string;
}

export interface BuildVisibleContextBundleInput {
  readonly actorId: string;
  readonly scenario: NormalizedScenarioV1;
  readonly state: JsonObject;
  readonly events: readonly RuntimeEvent[];
  readonly allowedSteps: readonly StepContractV3[];
  readonly stateVersion?: number;
}

const materialValueAtPath = (source: JsonObject, path: string): JsonValue | undefined => {
  if (path === "$.resources") {
    return source;
  }
  if (!path.startsWith("$.resources.")) {
    return undefined;
  }

  const segments = path.slice("$.resources.".length).split(".");
  let current: JsonValue | undefined = source;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

const buildVisibleMaterials = (
  resources: JsonObject,
  paths: readonly string[]
): { readonly materials: readonly VisibleMaterial[]; readonly refs: readonly string[] } => {
  const materials: VisibleMaterial[] = [];
  let refs: string[] = [];

  for (const path of paths) {
    const value = materialValueAtPath(resources, path);
    if (value === undefined) {
      continue;
    }
    materials.push({ path, value });
    refs = [...refs, path];
  }

  return { materials, refs };
};

const toVisibleAllowedStep = (step: StepContractV3): VisibleAllowedStep => ({
  id: step.id,
  actor_id: step.actor_id,
  prompt: step.prompt,
  argument_requirements: {
    args_schema: step.args_schema,
    args_ref_paths: step.args_ref_paths
  }
});

export const buildVisibleContextBundle = ({
  actorId,
  scenario,
  state,
  events,
  allowedSteps,
  stateVersion
}: BuildVisibleContextBundleInput): VisibleContextBundle => {
  const actor = findActor(scenario, actorId);
  if (actor === null) {
    throw new Error(`Unknown actor: ${actorId}`);
  }

  const activeStage = resolveActiveStage({ scenario, state, events });
  const visibility = projectVisibility({ actorId, scenario, state, events });
  const visibleMaterials = buildVisibleMaterials(visibility.resources, visibility.resource_paths);
  const bundleWithoutHash = {
    actor_id: actorId,
    actor,
    ...(activeStage.ok
      ? {
          active_stage: {
            id: activeStage.stage.id,
            title: activeStage.stage.title,
            goal: activeStage.stage.goal
          }
        }
      : {}),
    current_progress: {
      state: visibility.state,
      ...(stateVersion === undefined ? {} : { state_version: stateVersion })
    },
    visible_history: visibility.events,
    visible_materials: visibleMaterials.materials,
    allowed_steps: allowedSteps.map((step) => toVisibleAllowedStep(step)),
    source_refs: [...visibility.source_refs, ...visibleMaterials.refs],
    visibility_hash: visibility.visibility_hash
  };

  return {
    ...bundleWithoutHash,
    context_hash: hashStableValue(bundleWithoutHash)
  };
};
