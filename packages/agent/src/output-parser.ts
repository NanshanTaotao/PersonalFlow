import type { JsonObject, JsonValue } from "@personalflow/contracts";

import type { AgentAction, ParseAgentOutputResult } from "./types";

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);

const hasAmbiguousObjectBoundary = (text: string): boolean => /}\s*{/.test(text);

const requireExactFields = (value: JsonObject, allowedFields: ReadonlySet<string>): ParseAgentOutputResult | null => {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      return { ok: false, error: { code: "unexpected_field", field } };
    }
  }

  for (const field of allowedFields) {
    if (!(field in value)) {
      return { ok: false, error: { code: "missing_field", field } };
    }
  }
  return null;
};

export const parseAgentOutput = (output: string): ParseAgentOutputResult => {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "empty_output" } };
  }
  if (hasAmbiguousObjectBoundary(trimmed)) {
    return { ok: false, error: { code: "ambiguous_output" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { ok: false, error: { code: "invalid_json" } };
  }

  if (!isJsonObject(parsed)) {
    return { ok: false, error: { code: "not_object" } };
  }

  if (!("kind" in parsed)) {
    return { ok: false, error: { code: "missing_field", field: "kind" } };
  }
  if (parsed.kind !== "step" && parsed.kind !== "tool_request") {
    return { ok: false, error: { code: "invalid_field", field: "kind" } };
  }

  if (parsed.kind === "step") {
    const fieldError = requireExactFields(parsed, new Set(["kind", "selected_step", "content", "args"]));
    if (fieldError !== null) {
      return fieldError;
    }
    if (typeof parsed.selected_step !== "string" || parsed.selected_step.trim().length === 0) {
      return { ok: false, error: { code: "invalid_field", field: "selected_step" } };
    }
    if (typeof parsed.content !== "string") {
      return { ok: false, error: { code: "invalid_field", field: "content" } };
    }
    if (!isJsonObject(parsed.args)) {
      return { ok: false, error: { code: "invalid_field", field: "args" } };
    }

    const action: AgentAction = {
      kind: "step",
      selected_step: parsed.selected_step,
      content: parsed.content,
      args: parsed.args
    };
    return { ok: true, action };
  }

  const fieldError = requireExactFields(parsed, new Set(["kind", "selected_tool", "reason", "args"]));
  if (fieldError !== null) {
    return fieldError;
  }
  if (typeof parsed.selected_tool !== "string" || parsed.selected_tool.trim().length === 0) {
    return { ok: false, error: { code: "invalid_field", field: "selected_tool" } };
  }
  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
    return { ok: false, error: { code: "invalid_field", field: "reason" } };
  }
  if (!isJsonObject(parsed.args)) {
    return { ok: false, error: { code: "invalid_field", field: "args" } };
  }

  const action: AgentAction = {
    kind: "tool_request",
    selected_tool: parsed.selected_tool,
    reason: parsed.reason,
    args: parsed.args
  };
  return { ok: true, action };
};
