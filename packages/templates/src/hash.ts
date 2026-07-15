import { createHash } from "node:crypto";

import { NormalizedScenarioV1Schema, type JsonValue, type NormalizedScenarioV1 } from "@personalflow/contracts";

type CanonicalJsonValue = JsonValue;

const isPlainRecord = (value: unknown): value is Record<string, CanonicalJsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: CanonicalJsonValue): CanonicalJsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as CanonicalJsonValue)])
    );
  }

  return value;
};

export const hashNormalizedScenario = (scenario: NormalizedScenarioV1): string => {
  const normalized = NormalizedScenarioV1Schema.parse(scenario) as CanonicalJsonValue;
  const canonicalJson = JSON.stringify(canonicalize(normalized));

  return createHash("sha256").update(canonicalJson).digest("hex");
};
