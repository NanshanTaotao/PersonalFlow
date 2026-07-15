import type { VisibleContextBundle } from "./context";
import { hashStableValue, stableStringify } from "./hash";

export type PromptBlockName =
  | "output_protocol"
  | "role_identity"
  | "active_stage"
  | "current_progress"
  | "visible_history"
  | "visible_materials"
  | "allowed_steps"
  | "argument_requirements";

export interface PromptBlock {
  readonly name: PromptBlockName;
  readonly text: string;
  readonly hash: string;
  readonly source_refs: readonly string[];
}

const block = (name: PromptBlockName, value: unknown, sourceRefs: readonly string[] = []): PromptBlock => ({
  name,
  text: `[${name}]\n${stableStringify(value)}`,
  hash: hashStableValue({ name, value }),
  source_refs: [...sourceRefs]
});

const referencesWithPrefix = (references: readonly string[], prefix: string): readonly string[] =>
  references.filter((reference) => reference.startsWith(prefix));

export const buildPromptBlocks = (bundle: VisibleContextBundle): readonly PromptBlock[] => [
  block("output_protocol", {
    instruction:
      "You must output one strict JSON object only. Do not wrap the JSON in Markdown, code fences, prose, or explanations. 不要输出 Markdown、代码块、解释或多余文本。Use kind=\"step\" to select an allowed step. Do not modify state, end sessions, change visibility, or commit events. Before asking a follow-up, inspect visible_history.text_summary. Do not repeat prior visible questions or restate the same angle. Advance one new dimension grounded in active_stage, visible_materials, and the user's latest answer. Do not invent facts that are not present in visible context.",
    shape: {
      kind: "step",
      selected_step: "string",
      content: "string",
      args: "object"
    },
    strict_step_example: {
      kind: "step",
      selected_step: "ask_question",
      content: "Question",
      args: {
        question: "What project did you own end to end?"
      }
    }
  }),
  block(
    "role_identity",
    {
      actor_id: bundle.actor.id,
      kind: bundle.actor.kind,
      display_name: bundle.actor.display_name,
      identity: bundle.actor.identity,
      goal: bundle.actor.goal,
      behavior_style: bundle.actor.behavior_style
    },
    [`actor:${bundle.actor.id}`]
  ),
  ...(bundle.active_stage === undefined
    ? []
    : [
        block(
          "active_stage",
          {
            ...bundle.active_stage,
            priority:
              "Role is long-term identity. Stage is current context. Step prompt has highest priority."
          },
          [`stage:${bundle.active_stage.id}`]
        )
      ]),
  block("current_progress", bundle.current_progress, referencesWithPrefix(bundle.source_refs, "$.state")),
  block(
    "visible_history",
    bundle.visible_history.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      type: event.type,
      actor_id: event.actor_id ?? null,
      step_id: event.step_id ?? null,
      text_summary: event.text_summary ?? null,
      state_version_before: event.state_version_before,
      state_version_after: event.state_version_after,
      error_code: event.error_code ?? null
    })),
    referencesWithPrefix(bundle.source_refs, "event:")
  ),
  block(
    "visible_materials",
    bundle.visible_materials.map((material) => ({
      path: material.path,
      value: material.value
    })),
    bundle.visible_materials.map((material) => material.path)
  ),
  block(
    "allowed_steps",
    bundle.allowed_steps.map((step) => ({
      id: step.id,
      actor_id: step.actor_id,
      prompt: step.prompt
    })),
    bundle.allowed_steps.map((step) => `step:${step.id}`)
  ),
  block(
    "argument_requirements",
    bundle.allowed_steps.map((step) => ({
      kind: "step",
      selected_step: step.id,
      args_schema: step.argument_requirements.args_schema,
      args_ref_paths: step.argument_requirements.args_ref_paths
    })),
    bundle.allowed_steps.map((step) => `step:${step.id}:args`)
  )
];
