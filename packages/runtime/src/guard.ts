import type { GuardExprV1, JsonObject, JsonValue, RoleContractV3, RuntimeEvent } from "@personalflow/contracts";

import { RuntimeValidationError } from "./errors";
import { jsonEqual, readPath } from "./state";

export interface GuardContext {
  readonly state: JsonObject;
  readonly constants: JsonObject;
  readonly actor: RoleContractV3;
  readonly args: JsonObject;
  readonly events: readonly RuntimeEvent[];
}

const contextRoot = (context: GuardContext): JsonObject => ({
  state: context.state,
  constants: context.constants,
  actor: context.actor as unknown as JsonObject,
  args: context.args,
  events: { count: context.events.length }
});

const readGuardValue = (context: GuardContext, path: string): JsonValue | undefined => readPath(contextRoot(context), path);

const compareValues = (op: GuardExprV1["op"], left: JsonValue | undefined, right: JsonValue | undefined): boolean => {
  if (left === undefined) {
    return false;
  }

  switch (op) {
    case "eq":
      return right !== undefined && jsonEqual(left, right);
    case "neq":
      return right === undefined || !jsonEqual(left, right);
    case "gt":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "gte":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "lt":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "lte":
      return typeof left === "number" && typeof right === "number" && left <= right;
    case "contains":
      if (right === undefined) {
        return false;
      }
      if (Array.isArray(left)) {
        return left.some((item) => jsonEqual(item, right));
      }
      if (typeof left === "string" && typeof right === "string") {
        return left.includes(right);
      }
      if (left !== null && typeof left === "object" && typeof right === "string") {
        return Object.prototype.hasOwnProperty.call(left, right);
      }
      return false;
    default:
      throw new RuntimeValidationError(`Unsupported guard comparison: ${op}`);
  }
};

export const evaluateGuard = (expr: GuardExprV1, context: GuardContext): boolean => {
  switch (expr.op) {
    case "and":
      return expr.all.every((item) => evaluateGuard(item, context));
    case "or":
      return expr.all.some((item) => evaluateGuard(item, context));
    case "not":
      return !evaluateGuard(expr.expr, context);
    case "exists":
      return readGuardValue(context, expr.path) !== undefined;
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains": {
      const right = "value_from" in expr ? readGuardValue(context, expr.value_from) : expr.value;
      return compareValues(expr.op, readGuardValue(context, expr.path), right);
    }
    default:
      throw new RuntimeValidationError("Unsupported guard expression.");
  }
};

export const evaluateAllGuards = (guards: readonly GuardExprV1[], context: GuardContext): boolean =>
  guards.every((guard) => evaluateGuard(guard, context));
