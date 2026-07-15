import type { JsonObject, JsonValue, NormalizedScenarioV1, RuntimeEvent } from "@personalflow/contracts";

import { hashStableValue } from "./hash";
import { cloneJson, readPath, writeStatePath } from "./state";
import { resolveActiveStage } from "./stage";

export interface VisibleEventSummary {
  readonly id: string;
  readonly sequence: number;
  readonly type: RuntimeEvent["type"];
  readonly actor_id?: string;
  readonly step_id?: string;
  readonly text_summary?: string;
  readonly state_version_before: number;
  readonly state_version_after: number;
  readonly error_code?: string;
}

export interface VisibilityProjection {
  readonly actor_id: string;
  readonly state: JsonObject;
  readonly resources: JsonObject;
  readonly events: readonly VisibleEventSummary[];
  readonly resource_paths: readonly string[];
  readonly source_refs: readonly string[];
  readonly visibility_hash: string;
}

export interface ProjectVisibilityInput {
  readonly actorId: string;
  readonly scenario: NormalizedScenarioV1;
  readonly state: JsonObject;
  readonly events: readonly RuntimeEvent[];
}

const setProjectedPath = (target: JsonObject, rootName: "state" | "resources", path: string, value: JsonValue): JsonObject =>
  writeStatePath(target, path.replace(`$.${rootName}`, "$.state"), value);

const sensitiveArgNameFragments = [
  "apikey",
  "authorization",
  "bearer",
  "context",
  "credential",
  "debug",
  "hash",
  "key",
  "password",
  "prompt",
  "provider",
  "raw",
  "request",
  "secret",
  "token"
];
const textSummaryMaxLength = 160;
const sensitiveTextSummaryPattern = /api.?key|authorization|bearer|credential|full prompt|password|provider raw|raw[_ -]?prompt|secret|sk-[a-z0-9_-]+|token/i;

const isVisibleArgKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return !sensitiveArgNameFragments.some((fragment) => normalized.includes(fragment));
};

const isVisibleTextSummaryValue = (value: string): boolean => !sensitiveTextSummaryPattern.test(value);

const truncateTextSummary = (value: string): string =>
  value.length > textSummaryMaxLength ? value.slice(0, textSummaryMaxLength - 3) + "..." : value;

const visibleTextSummary = (args: JsonObject): string | undefined => {
  const entry = Object.entries(args).find(([key, value]) =>
    isVisibleArgKey(key) && typeof value === "string" && isVisibleTextSummaryValue(value)
  );
  return typeof entry?.[1] === "string" ? truncateTextSummary(entry[1]) : undefined;
};

type VisibleRuleProjection = {
  readonly path: string;
  readonly access: "full" | "summary" | "redacted";
};

const summarizeValue = (value: JsonValue): JsonValue => {
  if (typeof value === "string") {
    return "[summary]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeValue(item));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const title = value["title"];
    const sourceLabel = value["source_label"];
    const summary = value["summary"];
    if (typeof summary === "string") {
      return {
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof sourceLabel === "string" ? { source_label: sourceLabel } : {}),
        summary
      };
    }
    return "[summary]";
  }
  return "[summary]";
};

const projectVisibleRules = ({
  source,
  rootName,
  rules
}: {
  readonly source: JsonObject;
  readonly rootName: "state" | "resources";
  readonly rules: readonly VisibleRuleProjection[];
}): { readonly value: JsonObject; readonly refs: readonly string[] } => {
  let projected: JsonObject = {};
  let refs: string[] = [];

  for (const rule of rules) {
    const { path } = rule;
    const expectedPrefix = `$.${rootName}`;
    if (path !== expectedPrefix && !path.startsWith(`${expectedPrefix}.`)) {
      continue;
    }

    const sourceValue = readPath({ [rootName]: source }, path);
    if (sourceValue === undefined) {
      continue;
    }

    const value =
      rule.access === "redacted"
        ? "[redacted]"
        : rule.access === "summary"
          ? summarizeValue(sourceValue)
          : cloneJson(sourceValue);
    projected = setProjectedPath(projected, rootName, path, value);
    refs = [...refs, path];
  }

  return { value: projected, refs };
};

const visibleRulesFor = (
  scenario: NormalizedScenarioV1,
  actorId: string,
  rootName: "state" | "resources",
  state: JsonObject,
  events: readonly RuntimeEvent[]
): VisibleRuleProjection[] => {
  const activeStage = resolveActiveStage({ scenario, state, events });
  const activeStageId = activeStage.ok ? activeStage.stage.id : null;
  return scenario.visibility_policy.rules
    .filter((rule) => {
      if (rule.target.kind !== (rootName === "state" ? "state" : "resource")) {
        return false;
      }
      const roleMatches = rule.subject.role_ids === undefined || rule.subject.role_ids.includes(actorId);
      const stageMatches =
        rule.subject.stage_ids === undefined ||
        (activeStageId !== null && rule.subject.stage_ids.includes(activeStageId));
      return roleMatches && stageMatches;
    })
    .map((rule) => ({ path: rule.target.path, access: rule.access }));
};

const summarizeEvent = (event: RuntimeEvent): VisibleEventSummary => {
  const base = {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    state_version_before: event.state_version_before,
    state_version_after: event.state_version_after
  };

  if (event.type === "StepCommitted") {
    const textSummary = visibleTextSummary(event.payload.args);
    return {
      ...base,
      actor_id: event.payload.actor_id,
      step_id: event.payload.step_id,
      ...(textSummary === undefined ? {} : { text_summary: textSummary })
    };
  }

  if (event.type === "StepAttemptFailed") {
    return {
      ...base,
      actor_id: event.payload.actor_id,
      step_id: event.payload.step_id,
      error_code: event.payload.error_code
    };
  }

  return base;
};

export const projectVisibility = ({ actorId, scenario, state, events }: ProjectVisibilityInput): VisibilityProjection => {
  const visibleStateRules = visibleRulesFor(scenario, actorId, "state", state, events);
  const visibleResourceRules = visibleRulesFor(scenario, actorId, "resources", state, events);
  const stateProjection = projectVisibleRules({
    source: state,
    rootName: "state",
    rules: visibleStateRules
  });
  const resourceProjection = projectVisibleRules({
    source: scenario.resources,
    rootName: "resources",
    rules: visibleResourceRules
  });
  const eventWindow = events.length;
  const visibleEvents = eventWindow === 0 ? [] : events.slice(-eventWindow).map((event) => summarizeEvent(event));
  const sourceRefs = [
    ...stateProjection.refs,
    ...resourceProjection.refs,
    ...visibleEvents.map((event) => `event:${event.id}`)
  ];
  const hashInput = {
    actor_id: actorId,
    state: stateProjection.value,
    resources: resourceProjection.value,
    events: visibleEvents
  };

  return {
    actor_id: actorId,
    state: stateProjection.value,
    resources: resourceProjection.value,
    events: visibleEvents,
    resource_paths: visibleResourceRules.map((rule) => rule.path),
    source_refs: sourceRefs,
    visibility_hash: hashStableValue(hashInput)
  };
};
