import type { JsonObject, JsonValue, NormalizedScenarioV1, StateEffectV1 } from "@personalflow/contracts";

import type { GuardContext } from "./guard";
import { RuntimeValidationError } from "./errors";
import { cloneJson, isDeclaredStatePath, readPath, removeStatePath, writeStatePath } from "./state";

const resolveEffectValue = (effect: StateEffectV1, context: GuardContext): JsonValue | undefined => {
  if (effect.value_from !== undefined) {
    return readPath(
      {
        state: context.state,
        constants: context.constants,
        actor: context.actor as unknown as JsonObject,
        args: context.args,
        events: { count: context.events.length }
      },
      effect.value_from
    );
  }
  return effect.value;
};

export const applyStateEffects = (
  scenario: NormalizedScenarioV1,
  state: JsonObject,
  effects: readonly StateEffectV1[],
  context: GuardContext
): JsonObject => {
  let next = cloneJson(state);

  for (const effect of effects) {
    if (!isDeclaredStatePath(scenario.state_schema, effect.target_path)) {
      throw new RuntimeValidationError("State effect target path is not declared in state_schema.");
    }

    const current = readPath({ state: next }, effect.target_path);
    const value = resolveEffectValue(effect, { ...context, state: next });

    switch (effect.op) {
      case "set":
        if (value === undefined) {
          throw new RuntimeValidationError("set effect requires a value.");
        }
        next = writeStatePath(next, effect.target_path, value);
        break;
      case "increment": {
        const amount = effect.amount ?? 1;
        const base = current === undefined ? 0 : current;
        if (typeof base !== "number") {
          throw new RuntimeValidationError("increment effect target must be a number.");
        }
        next = writeStatePath(next, effect.target_path, base + amount);
        break;
      }
      case "append": {
        if (value === undefined) {
          throw new RuntimeValidationError("append effect requires a value.");
        }
        const base = current === undefined ? [] : current;
        if (!Array.isArray(base)) {
          throw new RuntimeValidationError("append effect target must be an array.");
        }
        next = writeStatePath(next, effect.target_path, [...base, cloneJson(value)]);
        break;
      }
      case "remove": {
        if (Array.isArray(current) && value !== undefined) {
          next = writeStatePath(
            next,
            effect.target_path,
            current.filter((item) => JSON.stringify(item) !== JSON.stringify(value))
          );
        } else {
          next = removeStatePath(next, effect.target_path);
        }
        break;
      }
      case "clear": {
        if (Array.isArray(current)) {
          next = writeStatePath(next, effect.target_path, []);
        } else if (current !== null && typeof current === "object") {
          next = writeStatePath(next, effect.target_path, {});
        } else {
          next = writeStatePath(next, effect.target_path, null);
        }
        break;
      }
      default:
        throw new RuntimeValidationError("Unsupported state effect.");
    }
  }

  return next;
};
