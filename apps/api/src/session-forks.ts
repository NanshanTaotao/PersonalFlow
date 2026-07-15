import {
  BranchTreeResponseSchema,
  type BranchTreeNode,
  type BranchTreeResponse,
  type CreateSessionForkRequest,
  type CreateSessionForkResponse,
  type NormalizedScenarioV1,
  type RuntimeEvent,
  type SessionBranchRecord,
  type SessionView,
  type WithdrawUserInputRequest,
  type WithdrawUserInputResponse
} from "@personalflow/contracts";
import { projectForkedSessionView } from "@personalflow/runtime";

import type { ProductApiContext } from "./context";
import { scenarioError } from "./errors";
import { productSessionDto } from "./session-dto";

const eventIdForChild = (sessionId: string, event: RuntimeEvent): string =>
  `${sessionId}:${event.sequence}:${event.type}`;

const cloneEventForSession = (event: RuntimeEvent, sessionId: string): RuntimeEvent => ({
  ...event,
  id: eventIdForChild(sessionId, event),
  session_id: sessionId
});

const actorKind = (scenario: NormalizedScenarioV1, actorId: string): "user" | "ai" | "system" | null =>
  scenario.roles.find((role) => role.id === actorId)?.kind ?? null;

const visibleEventIds = (view: SessionView): Set<string> =>
  new Set(view.visible_transcript.map((entry) => entry.event_id));

const roundsForView = (view: SessionView): number =>
  view.visible_transcript.filter((entry) => entry.actor_kind !== "system").length;

const firstEventCreatedAt = (events: readonly RuntimeEvent[], fallback: string): string =>
  events[0]?.created_at ?? fallback;

const childByParent = (branches: readonly SessionBranchRecord[]): Map<string | null, SessionBranchRecord[]> => {
  const map = new Map<string | null, SessionBranchRecord[]>();
  for (const branch of branches) {
    const current = map.get(branch.parent_session_id) ?? [];
    current.push(branch);
    map.set(branch.parent_session_id, current);
  }
  return map;
};

const treeNode = (
  branch: SessionBranchRecord,
  grouped: Map<string | null, SessionBranchRecord[]>,
  sessionViews: ReadonlyMap<string, SessionView>,
  latestReviews: ReadonlyMap<string, BranchTreeNode["latest_review"]>,
  currentSessionId: string
): BranchTreeNode => {
  const view = sessionViews.get(branch.session_id);
  if (view === undefined) {
    throw scenarioError("分支记录不完整，请刷新后重试。", 500);
  }
  const latestReview = latestReviews.get(branch.session_id);
  const children = (grouped.get(branch.session_id) ?? []).map((child) =>
    treeNode(child, grouped, sessionViews, latestReviews, currentSessionId)
  );
  return {
    session_id: branch.session_id,
    parent_session_id: branch.parent_session_id,
    label: branch.branch_label,
    ...(branch.forked_from_sequence === null ? {} : { forked_from_sequence: branch.forked_from_sequence }),
    status: view.status,
    rounds: roundsForView(view),
    created_at: branch.created_at,
    is_current: branch.session_id === currentSessionId,
    has_review: latestReview !== undefined,
    ...(latestReview === undefined ? {} : { latest_review: latestReview }),
    children
  };
};

const buildBranchTreeResponse = (input: {
  readonly rootSessionId: string;
  readonly currentSessionId: string;
  readonly branches: readonly SessionBranchRecord[];
  readonly sessionViews: ReadonlyMap<string, SessionView>;
  readonly latestReviews: ReadonlyMap<string, BranchTreeNode["latest_review"]>;
}): BranchTreeResponse => {
  const grouped = childByParent(input.branches);
  const roots = grouped.get(null) ?? [];
  const nodes = roots.map((branch) =>
    treeNode(branch, grouped, input.sessionViews, input.latestReviews, input.currentSessionId)
  );
  return BranchTreeResponseSchema.parse({
    root_session_id: input.rootSessionId,
    current_session_id: input.currentSessionId,
    nodes
  });
};

const flattenBranchNodes = (nodes: readonly BranchTreeNode[]): BranchTreeNode[] =>
  nodes.flatMap((node) => [node, ...flattenBranchNodes(node.children)]);

const latestReviewsForBranches = async (
  context: ProductApiContext,
  branches: readonly SessionBranchRecord[]
): Promise<Map<string, BranchTreeNode["latest_review"]>> => {
  const latestReviews = new Map<string, BranchTreeNode["latest_review"]>();
  for (const branch of branches) {
    const latestReview = (await context.repositories.reviewReports.listBySession(branch.session_id))[0];
    if (latestReview !== undefined) {
      latestReviews.set(branch.session_id, {
        id: latestReview.id,
        title: latestReview.title,
        status: latestReview.status
      });
    }
  }
  return latestReviews;
};

export const getBranchTree = async (context: ProductApiContext, sessionId: string): Promise<BranchTreeResponse> =>
  context.productStore.transaction(async (stores) => {
    const branch = await stores.branches.get(sessionId);
    const session = await stores.runtime.sessions.get(sessionId);
    if (session === null) {
      throw scenarioError("找不到这次练习，请返回首页重新打开。", 404);
    }
    const events = await stores.runtime.events.listBySession(sessionId);
    const currentBranch = branch ?? await stores.branches.ensureRoot({
      session_id: sessionId,
      branch_label: "主线",
      created_at: firstEventCreatedAt(events, context.now())
    });
    const branches = await stores.branches.listByRootSession(currentBranch.root_session_id);
    const sessionViews = new Map<string, SessionView>();
    for (const item of branches) {
      const record = await stores.runtime.sessions.get(item.session_id);
      if (record?.view !== undefined) {
        sessionViews.set(item.session_id, record.view);
      }
    }
    return buildBranchTreeResponse({
      rootSessionId: currentBranch.root_session_id,
      currentSessionId: sessionId,
      branches,
      sessionViews,
      latestReviews: await latestReviewsForBranches(context, branches)
    });
  });

interface ForkCreationInput {
  readonly parentSessionId: string;
  readonly forkPointEventId: string;
  readonly includeSelectedEvent: boolean;
  readonly mode: "manual_fork" | "withdraw_user_input" | "edit_answer";
  readonly branchLabel: string;
  readonly requireUserEvent: boolean;
}

const resolveForkPoint = (
  scenario: NormalizedScenarioV1,
  view: SessionView,
  events: readonly RuntimeEvent[],
  eventId: string,
  requireUserEvent: boolean
): {
  readonly forkEvent: Extract<RuntimeEvent, { type: "StepCommitted" }>;
  readonly visibleEntry: SessionView["visible_transcript"][number];
} => {
  const event = events.find((item) => item.id === eventId);
  if (event === undefined || event.session_id !== view.session_id) {
    throw scenarioError("无法从该位置创建分支，请刷新后重试。", 400);
  }
  if (event.type !== "StepCommitted" || !visibleEventIds(view).has(event.id)) {
    throw scenarioError("无法从该位置创建分支，请刷新后重试。", 400);
  }
  const visibleEntry = view.visible_transcript.find((entry) => entry.event_id === event.id);
  if (visibleEntry === undefined) {
    throw scenarioError("无法从该位置创建分支，请刷新后重试。", 400);
  }
  if (requireUserEvent && actorKind(scenario, event.payload.actor_id) !== "user") {
    throw scenarioError("只能撤回自己的回答。", 400);
  }
  return { forkEvent: event, visibleEntry };
};

const createFork = async (
  context: ProductApiContext,
  input: ForkCreationInput
): Promise<{
  readonly response: CreateSessionForkResponse;
  readonly resolvedVisibleText: string;
}> => {
  const childSessionId = context.createId("session");
  const now = context.now();
  return context.productStore.transaction(async (stores) => {
    const parent = await stores.runtime.sessions.get(input.parentSessionId);
    if (parent?.scenario === undefined || parent.view === undefined) {
      throw scenarioError("找不到这次练习，请返回首页重新打开。", 404);
    }
    const parentEvents = await stores.runtime.events.listBySession(input.parentSessionId);
    const { forkEvent, visibleEntry } = resolveForkPoint(
      parent.scenario,
      parent.view,
      parentEvents,
      input.forkPointEventId,
      input.requireUserEvent
    );
    const boundarySequence = input.includeSelectedEvent ? forkEvent.sequence : forkEvent.sequence - 1;
    const prefix = parentEvents.filter((event) => event.sequence <= boundarySequence);
    const boundaryEvent = prefix.at(-1);
    const childEvents = prefix.map((event) => cloneEventForSession(event, childSessionId));
    const childView = projectForkedSessionView({
      sessionId: childSessionId,
      scenario: parent.scenario,
      events: childEvents
    });
    if (input.mode === "withdraw_user_input" && childView.status !== "running") {
      throw scenarioError("该回答之前的状态无法继续演练，不能撤回到这里。", 400);
    }

    await stores.runtime.sessions.create({
      session_id: childSessionId,
      scenario_id: parent.scenario_id,
      status: childView.status,
      state_version: childView.state_version,
      scenario: parent.scenario,
      view: childView
    });
    for (const event of childEvents) {
      await stores.runtime.events.append(event);
    }
    const parentBranch = (await stores.branches.get(input.parentSessionId)) ??
      await stores.branches.ensureRoot({
        session_id: input.parentSessionId,
        branch_label: "主线",
        created_at: firstEventCreatedAt(parentEvents, now)
      });
    await stores.branches.create({
      session_id: childSessionId,
      root_session_id: parentBranch.root_session_id,
      parent_session_id: input.parentSessionId,
      forked_from_event_id: forkEvent.id,
      forked_from_sequence: forkEvent.sequence,
      forked_from_state_version: forkEvent.state_version_before,
      fork_boundary_sequence: boundaryEvent?.sequence ?? null,
      fork_boundary_state_version: boundaryEvent?.state_version_after ?? null,
      include_selected_event: input.includeSelectedEvent,
      fork_mode: input.mode,
      branch_label: input.branchLabel,
      created_at: now
    });
    const branches = await stores.branches.listByRootSession(parentBranch.root_session_id);
    const sessionViews = new Map<string, SessionView>();
    for (const branch of branches) {
      const record = branch.session_id === childSessionId
        ? { view: childView }
        : await stores.runtime.sessions.get(branch.session_id);
      if (record?.view !== undefined) {
        sessionViews.set(branch.session_id, record.view);
      }
    }
    const tree = buildBranchTreeResponse({
      rootSessionId: parentBranch.root_session_id,
      currentSessionId: childSessionId,
      branches,
      sessionViews,
      latestReviews: await latestReviewsForBranches(context, branches)
    });
    const branchNode = flattenBranchNodes(tree.nodes).find((node) => node.session_id === childSessionId);
    if (branchNode === undefined) {
      throw scenarioError("分支创建失败，请重试。", 500);
    }
    return {
      response: {
        session: await productSessionDto(context, childView, { scenario: parent.scenario, events: childEvents }),
        branch: branchNode,
        tree
      },
      resolvedVisibleText: visibleEntry.text
    };
  });
};

export const createSessionFork = async (
  context: ProductApiContext,
  sessionId: string,
  body: CreateSessionForkRequest
): Promise<CreateSessionForkResponse> =>
  (await createFork(context, {
    parentSessionId: sessionId,
    forkPointEventId: body.fork_point_event_id,
    includeSelectedEvent: body.include_selected_event,
    mode: body.mode,
    branchLabel: body.branch_label ?? "从这里分支",
    requireUserEvent: false
  })).response;

export const withdrawUserInput = async (
  context: ProductApiContext,
  sessionId: string,
  body: WithdrawUserInputRequest
): Promise<WithdrawUserInputResponse> => {
  const forked = await createFork(context, {
    parentSessionId: sessionId,
    forkPointEventId: body.user_event_id,
    includeSelectedEvent: false,
    mode: "withdraw_user_input",
    branchLabel: body.branch_label ?? "撤回后重写",
    requireUserEvent: true
  });
  return {
    ...forked.response,
    withdrawn_input: {
      text: forked.resolvedVisibleText,
      event_id: body.user_event_id
    }
  };
};

export const startSessionWithRootBranch = async (
  context: ProductApiContext,
  scenario: NormalizedScenarioV1,
  branchLabel = "主线"
): Promise<SessionView> =>
  context.productStore.transaction(async (stores) => {
    const sessionId = context.createId("session");
    const view = await context.runtime.startSessionInStores(stores.runtime, {
      sessionId,
      scenario
    });
    const events = await stores.runtime.events.listBySession(sessionId);
    await stores.branches.ensureRoot({
      session_id: sessionId,
      branch_label: branchLabel,
      created_at: firstEventCreatedAt(events, context.now())
    });
    return view;
  });
