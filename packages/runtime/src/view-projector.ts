import { SessionViewSchema } from "@personalflow/contracts";
import type { JsonObject, JsonValue, NormalizedScenarioV1, RuntimeEvent, SessionStatus, SessionView, StepContractV2, VisibleTranscriptEntry } from "@personalflow/contracts";

import { cloneJson } from "./state";
import { resolveAllowedSteps } from "./scheduler";
import { resolveActiveStage } from "./stage";

export interface ProjectViewInput {
  readonly sessionId: string;
  readonly scenario: NormalizedScenarioV1;
  readonly status: SessionStatus;
  readonly stateVersion: number;
  readonly state: JsonObject;
  readonly events: readonly RuntimeEvent[];
}

const privateArgNameFragments = ["hash", "prompt", "context", "debug", "request", "provider", "raw", "api_key", "secret"];

const isVisibleArgKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return !privateArgNameFragments.some((fragment) => normalized.includes(fragment));
};

const visibleArgText = (args: JsonObject): string => {
  const visibleEntries = Object.entries(args).filter(([key]) => isVisibleArgKey(key));
  const firstString = visibleEntries.find(([, value]) => typeof value === "string");
  if (firstString !== undefined && typeof firstString[1] === "string") {
    return firstString[1];
  }
  const visibleObject = Object.fromEntries(visibleEntries) as Record<string, JsonValue>;
  return JSON.stringify(visibleObject);
};

const actorName = (scenario: NormalizedScenarioV1, actorId: string): string =>
  scenario.roles.find((actor) => actor.id === actorId)?.display_name ?? actorId;

const productActorName = (scenario: NormalizedScenarioV1, actorId: string): string | null =>
  scenario.roles.find((actor) => actor.id === actorId)?.display_name ?? null;

const actorKind = (scenario: NormalizedScenarioV1, actorId: string) => {
  const actor = scenario.roles.find((current) => current.id === actorId);
  if (actor === undefined) {
    throw new Error(`Unknown actor: ${actorId}`);
  }
  return actor.kind;
};

const runtimeCommandText = (event: Extract<RuntimeEvent, { type: "RuntimeCommandCommitted" }>): string | null => {
  if (event.payload.command === "pause_session") {
    return "Session 已暂停。";
  }
  if (event.payload.command === "resume_session") {
    return "Session 已继续。";
  }
  if (event.payload.command === "end_session") {
    return "Session 已结束。";
  }
  return null;
};

const projectVisibleTranscript = (scenario: NormalizedScenarioV1, events: readonly RuntimeEvent[]): VisibleTranscriptEntry[] =>
  events.flatMap((event): VisibleTranscriptEntry[] => {
    if (event.type === "StepCommitted") {
      return [
        {
          id: `${event.id}:visible`,
          event_id: event.id,
          sequence: event.sequence,
          actor_id: event.payload.actor_id,
          actor_kind: actorKind(scenario, event.payload.actor_id),
          actor_name: actorName(scenario, event.payload.actor_id),
          text: visibleArgText(event.payload.args)
        }
      ];
    }
    if (event.type === "RuntimeCommandCommitted") {
      const text = runtimeCommandText(event);
      return text === null
        ? []
        : [
            {
              id: `${event.id}:visible`,
              event_id: event.id,
              sequence: event.sequence,
              actor_id: "system",
              actor_kind: "system",
              actor_name: "系统",
              text
            }
          ];
    }
    return [];
  });

const projectAllowedSteps = (input: Pick<ProjectViewInput, "scenario" | "state" | "events" | "status">) =>
  input.status === "running"
    ? resolveAllowedSteps({
        scenario: input.scenario,
        state: input.state,
        events: input.events
      }).map((step) => ({
        id: step.id,
        actor_id: step.actor_id,
        actor_kind: actorKind(input.scenario, step.actor_id),
        args_schema: step.args_schema,
        args_ref_paths: step.args_ref_paths,
        review_tags: step.review_tags
      }))
    : [];

const projectVisibleToolResults = (scenario: NormalizedScenarioV1, events: readonly RuntimeEvent[]) =>
  events.flatMap((event) => {
    if (event.type !== "ToolCallCommitted") {
      return [];
    }
    return [{
      sequence: event.sequence,
      actor_name: actorName(scenario, event.payload.actor_id),
      tool_id: event.payload.tool_id,
      summary: event.payload.result.summary,
      source_ref: event.payload.result.source_ref,
      trust_level: event.payload.result.trust_level
    }];
  });

const statusStageLabels: Record<SessionStatus, string> = {
  running: "演练进行中",
  paused: "演练已暂停",
  completed: "演练已完成",
  ended: "演练已结束",
  failed: "演练失败",
  blocked: "运行时已阻断"
};

const latestRuntimeBlocked = (events: readonly RuntimeEvent[]) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "RuntimeBlockedCommitted") {
      return event;
    }
  }
  return undefined;
};

const blockedMessage = (reason: Extract<RuntimeEvent, { type: "RuntimeBlockedCommitted" }>["payload"]["reason"]): string => {
  if (reason === "no_active_stage") {
    return "No active stage matched current state. 当前状态没有匹配的活动阶段，演练已阻断。";
  }
  if (reason === "no_allowed_step") {
    return "No allowed step is available for the active stage. 当前阶段没有可执行步骤，演练已阻断。";
  }
  return "Runtime limit exceeded. 运行时上限已触发，演练已阻断。";
};

const deriveBlockedSummary = (events: readonly RuntimeEvent[]) => {
  const blocked = latestRuntimeBlocked(events);
  if (blocked === undefined) {
    return undefined;
  }
  return {
    reason: blocked.payload.reason,
    message: blockedMessage(blocked.payload.reason),
    ...(blocked.payload.stage_id === undefined ? {} : { stage_id: blocked.payload.stage_id })
  };
};

const isHumanStep = (scenario: NormalizedScenarioV1, step: StepContractV2): boolean =>
  scenario.roles.find((actor) => actor.id === step.actor_id)?.kind === "user";

const selectCurrentStep = (scenario: NormalizedScenarioV1, allowedSteps: readonly StepContractV2[]): StepContractV2 | null =>
  allowedSteps.find((step) => isHumanStep(scenario, step)) ?? allowedSteps[0] ?? null;

const deriveStageLabel = (
  status: SessionStatus,
  scenario: NormalizedScenarioV1,
  state: JsonObject,
  events: readonly RuntimeEvent[],
  currentStep: StepContractV2 | null
): string => {
  if (status !== "running") {
    return statusStageLabels[status];
  }

  const activeStage = resolveActiveStage({ scenario, state, events });
  if (activeStage.ok) {
    return activeStage.stage.title;
  }

  return currentStep === null ? "等待下一步" : statusStageLabels.running;
};

const deriveCurrentStage = (
  status: SessionStatus,
  scenario: NormalizedScenarioV1,
  state: JsonObject,
  events: readonly RuntimeEvent[]
) => {
  if (status !== "running") {
    return undefined;
  }
  const activeStage = resolveActiveStage({ scenario, state, events });
  return activeStage.ok
    ? { id: activeStage.stage.id, title: activeStage.stage.title, goal: activeStage.stage.goal }
    : undefined;
};

const deriveNextUserActionLabel = (
  status: SessionStatus,
  scenario: NormalizedScenarioV1,
  currentStep: StepContractV2 | null,
  failureSummary: ReturnType<typeof deriveFailureSummary>
): string => {
  if (failureSummary !== undefined) {
    return "AI 本轮失败，可重试当前 AI 回合或刷新演练。";
  }
  if (status === "paused") {
    return "演练已暂停，可点击继续恢复。";
  }
  if (status === "completed") {
    return "演练已完成，可查看复盘。";
  }
  if (status === "ended") {
    return "演练已结束，可查看复盘。";
  }
  if (status === "failed") {
    return "演练失败，请刷新或稍后重试。";
  }
  if (status === "blocked") {
    return "运行时已阻断，请查看阻断原因。";
  }
  if (currentStep === null) {
    return "演练状态同步中，请刷新或稍后重试。";
  }
  if (isHumanStep(scenario, currentStep)) {
    return "请在输入框回应当前问题或提示。";
  }
  const name = productActorName(scenario, currentStep.actor_id) ?? "AI";
  return `等待${name}继续提问，可点击让 AI 提问。`;
};

const deriveFailureSummary = (events: readonly RuntimeEvent[]) => {
  let lastCommittedIndex = -1;
  events.forEach((event, index) => {
    if (event.type === "StepCommitted" || event.type === "RuntimeCommandCommitted") {
      lastCommittedIndex = index;
    }
  });
  const recentFailures = events.slice(lastCommittedIndex + 1).filter((event) => event.type === "StepAttemptFailed");
  const latestFailure = recentFailures.at(-1);
  if (latestFailure?.type !== "StepAttemptFailed" || latestFailure.payload.step_id !== "model_output") {
    return undefined;
  }
  return {
    message: "AI 本轮没有成功生成可用提问，已保留当前演练进度。",
    failed_attempts: recentFailures.length,
    can_retry: true,
    action_label: "重试当前 AI 回合"
  };
};

const projectProductSummary = (input: Pick<ProjectViewInput, "scenario" | "state" | "events" | "status">) => {
  const blockedSummary = deriveBlockedSummary(input.events);
  const status: SessionStatus = blockedSummary === undefined || input.status === "ended" ? input.status : "blocked";
  const allowedSteps = status === "running"
    ? resolveAllowedSteps({
        scenario: input.scenario,
        state: input.state,
        events: input.events
      })
    : [];
  const currentStep = status === "running" ? selectCurrentStep(input.scenario, allowedSteps) : null;
  const failureSummary = status === "running" ? deriveFailureSummary(input.events) : undefined;

  return {
    current_stage_label: deriveStageLabel(status, input.scenario, input.state, input.events, currentStep),
    ...(deriveCurrentStage(status, input.scenario, input.state, input.events) === undefined ? {} : { current_stage: deriveCurrentStage(status, input.scenario, input.state, input.events) }),
    current_actor_name: currentStep === null ? null : productActorName(input.scenario, currentStep.actor_id),
    next_user_action_label: deriveNextUserActionLabel(status, input.scenario, currentStep, failureSummary),
    ...(failureSummary === undefined ? {} : { failure_summary: failureSummary }),
    ...(blockedSummary === undefined || status !== "blocked" ? {} : { blocked_summary: blockedSummary })
  };
};

export const projectSessionView = ({
  sessionId,
  scenario,
  status,
  stateVersion,
  state,
  events
}: ProjectViewInput): SessionView => {
  const blockedSummary = deriveBlockedSummary(events);
  const effectiveStatus: SessionStatus = blockedSummary === undefined || status === "ended" ? status : "blocked";
  const view = {
    session_id: sessionId,
    scenario_id: scenario.id,
    status: effectiveStatus,
    state_version: stateVersion,
    state: cloneJson(state),
    allowed_steps: projectAllowedSteps({ scenario, state, events, status: effectiveStatus }),
    visible_transcript: projectVisibleTranscript(scenario, events),
    visible_tool_results: projectVisibleToolResults(scenario, events),
    ...projectProductSummary({ scenario, state, events, status: effectiveStatus })
  };

  return SessionViewSchema.parse(view);
};
