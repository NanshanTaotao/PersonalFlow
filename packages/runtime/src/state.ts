import type { JsonObject, JsonSchemaValue, JsonValue } from "@personalflow/contracts";

import { RuntimeValidationError } from "./errors";

export type RuntimeState = JsonObject;

const pathSegments = (path: string, expectedRoot: string): string[] => {
  const prefix = `$.${expectedRoot}`;
  if (path !== prefix && !path.startsWith(`${prefix}.`)) {
    throw new RuntimeValidationError(`Path must start with ${prefix}.`);
  }
  return path === prefix ? [] : path.slice(prefix.length + 1).split(".");
};

export const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const readPath = (root: JsonObject, path: string): JsonValue | undefined => {
  if (!path.startsWith("$.")) {
    throw new RuntimeValidationError("JSON path must start with $.");
  }

  const segments = path.slice(2).split(".");
  let current: JsonValue | undefined = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

export const writeStatePath = (state: RuntimeState, path: string, value: JsonValue): RuntimeState => {
  const next = cloneJson(state);
  const segments = pathSegments(path, "state");
  if (segments.length === 0) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RuntimeValidationError("Root state must be an object.");
    }
    return cloneJson(value);
  }

  let current: JsonObject = next;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      const created: JsonObject = {};
      current[segment] = created;
      current = created;
    } else {
      current = child;
    }
  }

  const target = segments.at(-1);
  if (target === undefined) {
    throw new RuntimeValidationError("State path is empty.");
  }
  current[target] = cloneJson(value);
  return next;
};

export const removeStatePath = (state: RuntimeState, path: string): RuntimeState => {
  const next = cloneJson(state);
  const segments = pathSegments(path, "state");
  const target = segments.at(-1);
  if (target === undefined) {
    return {};
  }

  let current: JsonValue = next;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return next;
    }
    current = current[segment] as JsonValue;
  }

  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    delete current[target];
  }
  return next;
};

export const isDeclaredStatePath = (stateSchema: JsonSchemaValue, path: string): boolean => {
  const segments = pathSegments(path, "state");
  if (segments.length === 0) {
    return true;
  }
  if (stateSchema === true || stateSchema === false) {
    return stateSchema;
  }

  let schema: JsonSchemaValue | undefined = stateSchema;
  for (const segment of segments) {
    if (schema === true) {
      return true;
    }
    if (schema === false || schema === undefined || typeof schema === "boolean") {
      return false;
    }
    const properties: Record<string, JsonSchemaValue> = schema.properties ?? {};
    schema = properties[segment];
  }

  return schema !== undefined && schema !== false;
};

export const jsonEqual = (left: JsonValue, right: JsonValue): boolean => JSON.stringify(left) === JSON.stringify(right);
