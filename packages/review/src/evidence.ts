import type { JsonValue, NormalizedScenarioV1, ReviewEvidenceRef, RuntimeEvent, StepContractV2 } from "@personalflow/contracts";

export interface ReviewEvidenceItem {
  readonly ref: ReviewEvidenceRef;
  readonly actor_display_name: string;
  readonly actor_kind: "user" | "ai" | "system";
  readonly review_tags: readonly string[];
  readonly args_summary: readonly string[];
}

export interface ExtractReviewEvidenceInput {
  readonly session_id: string;
  readonly scenario: NormalizedScenarioV1;
  readonly events: readonly RuntimeEvent[];
}

const sensitiveNameParts = ["secret", "token", "password", "credential", "key"];

const isSensitiveField = (field: string): boolean => sensitiveNameParts.some((part) => field.toLowerCase().includes(part));

const summarizeValue = (value: JsonValue): string => {
  if (typeof value === "string") {
    return value.length > 120 ? value.slice(0, 117) + "..." : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "array(" + String(value.length) + ")";
  }
  return "object(" + Object.keys(value).sort().join(",") + ")";
};

const summarizeArgs = (args: Record<string, JsonValue>): string[] =>
  Object.entries(args)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + (isSensitiveField(key) ? "[redacted]" : summarizeValue(value)));

const stepById = (scenario: NormalizedScenarioV1): Map<string, StepContractV2> =>
  new Map(scenario.steps.map((step) => [step.id, step]));

const rubricEvidenceTags = (scenario: NormalizedScenarioV1): Set<string> =>
  new Set(scenario.review_rubric.dimensions.flatMap((dimension) => dimension.evidence_tags));

const actorName = (scenario: NormalizedScenarioV1, actorId: string): string =>
  scenario.roles.find((actor) => actor.id === actorId)?.display_name ?? actorId;

const actorKind = (scenario: NormalizedScenarioV1, actorId: string): "user" | "ai" | "system" =>
  scenario.roles.find((actor) => actor.id === actorId)?.kind ?? "system";

export const extractReviewEvidence = ({ session_id, scenario, events }: ExtractReviewEvidenceInput): ReviewEvidenceItem[] => {
  const steps = stepById(scenario);
  const allowedTags = rubricEvidenceTags(scenario);
  return events.flatMap((event) => {
    if (event.type !== "StepCommitted" || event.session_id !== session_id) {
      return [];
    }
    const step = steps.get(event.payload.step_id);
    if (step === undefined || !step.review_tags.some((tag) => allowedTags.has(tag))) {
      return [];
    }
    return [{
      ref: {
        session_id: event.session_id,
        event_id: event.id,
        sequence: event.sequence,
        step_id: event.payload.step_id,
        actor_id: event.payload.actor_id
      },
      actor_display_name: actorName(scenario, event.payload.actor_id),
      actor_kind: actorKind(scenario, event.payload.actor_id),
      review_tags: [...step.review_tags],
      args_summary: summarizeArgs(event.payload.args)
    }];
  });
};
