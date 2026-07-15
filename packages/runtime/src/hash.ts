import { createHash } from "node:crypto";

import type { JsonValue } from "@personalflow/contracts";

type StableJsonValue = JsonValue | undefined;

const stableNormalize = (value: unknown): StableJsonValue => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item)).filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableNormalize((value as Record<string, unknown>)[key])])
        .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
    );
  }
  return String(value);
};

export const stableStringify = (value: unknown): string => JSON.stringify(stableNormalize(value));

export const hashStableValue = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");
