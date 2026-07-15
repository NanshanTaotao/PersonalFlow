import path from "node:path";

import { createId, type JsonObject } from "@personalflow/contracts";
import { createOpenAICompatibleAdapter, type LLMAdapter, type LLMRequest, type LLMResponse } from "@personalflow/agent";
import { CommitService, RuntimeKernel } from "@personalflow/runtime";
import type { ReviewModelAdapter } from "@personalflow/review";
import {
  createDatabase,
  createProductStore,
  createRepositories,
  createRuntimeStore,
  type ModelConfigForModelCall,
  type SqliteProductStore,
  type SqliteRuntimeStore,
  type StorageDatabase,
  type StorageRepositories
} from "@personalflow/storage";
import { builtInTemplates } from "@personalflow/templates";

import { conflictError } from "./errors";

type OpenAICompatibleFetch = NonNullable<Parameters<typeof createOpenAICompatibleAdapter>[0]["fetch"]>;

export interface IdempotencyRecord {
  readonly payloadHash: string;
  readonly statusCode: number;
  readonly body: unknown;
}

export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined;
  put(key: string, record: IdempotencyRecord): void;
}

export interface ProductApiContext {
  readonly database: StorageDatabase;
  readonly repositories: StorageRepositories;
  readonly runtimeStore: SqliteRuntimeStore;
  readonly productStore: SqliteProductStore;
  readonly runtime: RuntimeKernel;
  readonly idempotency: IdempotencyStore;
  readonly modelMode: ModelMode;
  readonly createModelAdapter: (config: ModelConfigForModelCall) => LLMAdapter;
  readonly describeModelRoute: (config: ModelConfigForModelCall) => ModelRouteObservability;
  readonly createReviewAdapter: () => Promise<ReviewAdapterRoute>;
  readonly now: () => string;
  readonly createId: (prefix: string) => string;
}

export interface ModelRouteObservability {
  readonly adapter_kind: string;
  readonly model_config_id: string;
  readonly provider: string;
  readonly model: string;
}

export interface ReviewAdapterRoute {
  readonly adapter: ReviewModelAdapter;
  readonly kind: string;
}

export type ModelMode = "fake" | "real";

export interface BuildContextOptions {
  readonly database?: StorageDatabase;
  readonly idempotency?: IdempotencyStore;
  readonly createModelAdapter?: (config: ModelConfigForModelCall) => LLMAdapter;
  readonly describeModelRoute?: (config: ModelConfigForModelCall) => ModelRouteObservability;
  readonly createReviewAdapter?: () => ReviewModelAdapter | Promise<ReviewModelAdapter>;
  readonly reviewAdapterKind?: string;
  readonly enableOpenAICompatibleAdapter?: boolean;
  readonly openAICompatibleFetch?: OpenAICompatibleFetch;
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
}

const localEncryptionKey = (): Uint8Array => {
  const raw = process.env.PERSONALFLOW_LOCAL_ENCRYPTION_KEY;
  if (raw !== undefined && raw.length >= 32) {
    return new TextEncoder().encode(raw).slice(0, 32);
  }
  return new Uint8Array(32).fill(1);
};

const defaultSqlitePath = (): string =>
  path.resolve(process.cwd(), ".personalflow", "personalflow.sqlite");

const configuredSqlitePath = (): string => {
  const explicitPath = process.env.PERSONALFLOW_SQLITE_PATH;
  return explicitPath === undefined || explicitPath.trim() === "" ? defaultSqlitePath() : explicitPath;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>).sort().map((key) => JSON.stringify(key) + ":" + stableStringify((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
};

export const hashIdempotencyPayload = (value: unknown): string => stableStringify(value);

export class DefaultIdempotencyStore implements IdempotencyStore {
  private readonly records: Record<string, IdempotencyRecord> = Object.create(null) as Record<string, IdempotencyRecord>;

  get(key: string): IdempotencyRecord | undefined {
    return this.records[key];
  }

  put(key: string, record: IdempotencyRecord): void {
    this.records[key] = record;
  }
}

const firstStringField = (request: LLMRequest): string => {
  const step = request.allowed_steps[0];
  const schema = typeof step?.args_schema === "object" && step.args_schema !== null ? step.args_schema : undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const properties = schema?.properties ?? {};
  const match = required.find((key) => {
    const property = properties[key];
    return typeof property === "object" && property !== null && property.type === "string";
  });
  return match ?? "content";
};


interface PromptReviewEvidence {
  readonly ref: { readonly session_id: string; readonly event_id: string; readonly sequence: number; readonly step_id: string; readonly actor_id: string };
  readonly actor_kind?: string;
  readonly review_tags?: readonly string[];
}

interface PromptReviewRubricDimension {
  readonly id: string;
  readonly title: string;
  readonly evidence_tags: readonly string[];
}

const extractReviewEvidenceFromPrompt = (prompt: string): PromptReviewEvidence[] => {
  const start = "EVIDENCE_JSON_START";
  const end = "EVIDENCE_JSON_END";
  const startIndex = prompt.indexOf(start);
  const endIndex = prompt.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return [];
  }
  const raw = prompt.slice(startIndex + start.length, endIndex).trim();
  const parsed = JSON.parse(raw) as PromptReviewEvidence[];
  return parsed;
};

const extractReviewRubricFromPrompt = (prompt: string): PromptReviewRubricDimension[] => {
  const start = "RUBRIC_JSON_START";
  const end = "RUBRIC_JSON_END";
  const startIndex = prompt.indexOf(start);
  const endIndex = prompt.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return [];
  }
  const raw = prompt.slice(startIndex + start.length, endIndex).trim();
  const parsed = JSON.parse(raw) as Array<{ id?: unknown; title?: unknown; evidence_tags?: unknown }>;
  return parsed.flatMap((dimension) => {
    const id = typeof dimension.id === "string" ? dimension.id : undefined;
    const title = typeof dimension.title === "string" ? dimension.title : id;
    if (id === undefined || title === undefined) {
      return [];
    }
    return [{
      id,
      title,
      evidence_tags: Array.isArray(dimension.evidence_tags)
        ? dimension.evidence_tags.filter((tag): tag is string => typeof tag === "string")
        : []
    }];
  });
};

const promptEvidenceRefsForTags = (
  evidence: readonly PromptReviewEvidence[],
  tags: readonly string[]
): Array<PromptReviewEvidence["ref"]> => {
  const acceptedTags = new Set(tags);
  const matching = evidence.filter((item) => item.review_tags?.some((tag) => acceptedTags.has(tag)) === true);
  const userMatching = matching.filter((item) => item.actor_kind === "user");
  return (userMatching.length > 0 ? userMatching : matching).map((item) => item.ref);
};

const createDeterministicReviewAdapter = (): ReviewModelAdapter => ({
  async complete({ prompt }) {
    const evidence = extractReviewEvidenceFromPrompt(prompt);
    const rubric = extractReviewRubricFromPrompt(prompt);
    const preferredEvidence = evidence.find((item) => item.actor_kind === "user") ?? evidence[0];
    const first = preferredEvidence?.ref;
    if (first === undefined) {
      return { content: "{}" };
    }
    return {
      content: JSON.stringify({
        summary: "Evidence-based review generated from committed events.",
        dimensions: (rubric.length > 0 ? rubric : [{ id: "scenario_evidence", title: "scenario_evidence", evidence_tags: [] }]).map((dimension) => ({
          name: dimension.id,
          conclusion: "The session has reviewable committed evidence.",
          evidence_refs: promptEvidenceRefsForTags(evidence, dimension.evidence_tags).length > 0
            ? promptEvidenceRefsForTags(evidence, dimension.evidence_tags)
            : [first]
        })),
        key_moments: [{ title: "Committed step", description: "A committed step was used as the review anchor.", evidence_ref: first }],
        recommendations: [{ text: "Add more concrete outcome details in the next practice run.", evidence_refs: [first] }],
        evidence_refs: [first],
        uncertainty_notes: ["Only committed runtime evidence was available to the review engine."]
      })
    };
  }
});

const createDeterministicAdapter = (config: ModelConfigForModelCall): LLMAdapter => ({
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const step = request.allowed_steps[0];
    if (step === undefined) {
      return { content: "{}", model: config.model };
    }
    const field = firstStringField(request);
    const text = "Simulated AI response.";
    return {
      content: JSON.stringify({
        kind: "step",
        selected_step: step.id,
        content: text,
        args: { [field]: text } satisfies JsonObject
      }),
      model: config.model
    };
  }
});

const createOpenAICompatibleReviewAdapter = (
  config: ModelConfigForModelCall,
  fetchImpl: OpenAICompatibleFetch | undefined
): ReviewModelAdapter => {
  const adapter = createOpenAICompatibleAdapter({
    endpoint: chatCompletionsEndpoint(config.base_url),
    model: config.model,
    apiKey: config.api_key,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl })
  });
  return {
    async complete({ prompt }) {
      const response = await adapter.complete({
        prompt,
        prompt_hash: "review-prompt",
        actor_id: "reviewer",
        allowed_steps: [],
        metadata: {
          context_hash: "review",
          visibility_hash: "review",
          block_hashes: [],
          source_refs: [config.id]
        }
      });
      return { content: response.content };
    }
  };
};

export const resolveModelMode = (env: Partial<Record<"PERSONALFLOW_MODEL_MODE" | "PERSONALFLOW_REAL_LLM_SMOKE", string>> = process.env): ModelMode => {
  const explicitMode = env.PERSONALFLOW_MODEL_MODE;
  if (explicitMode !== undefined) {
    if (explicitMode === "real") {
      return "real";
    }
    if (explicitMode === "fake") {
      return "fake";
    }
    return "fake";
  }
  const legacyValue = env.PERSONALFLOW_REAL_LLM_SMOKE;
  return legacyValue === "1" || legacyValue === "true" ? "real" : "fake";
};

const chatCompletionsEndpoint = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : trimmed + "/chat/completions";
};

export const createProductApiContext = (options: BuildContextOptions = {}): ProductApiContext => {
  const database = options.database ?? createDatabase({ path: configuredSqlitePath(), encryptionKey: localEncryptionKey() });
  const repositories = createRepositories(database);
  const runtimeStore = createRuntimeStore(database);
  const productStore = createProductStore(database);
  const now = options.now ?? (() => new Date().toISOString());
  const runtime = new RuntimeKernel({ store: runtimeStore, commitService: new CommitService({ now }) });
  void builtInTemplates;
  const modelMode: ModelMode = options.enableOpenAICompatibleAdapter === undefined
    ? resolveModelMode()
    : options.enableOpenAICompatibleAdapter
      ? "real"
      : "fake";
  const shouldUseGlobalFetch =
    options.openAICompatibleFetch === undefined &&
    options.enableOpenAICompatibleAdapter === undefined &&
    modelMode === "real" &&
    typeof globalThis.fetch === "function";
  const openAICompatibleFetch: OpenAICompatibleFetch | undefined =
    options.openAICompatibleFetch ??
    (shouldUseGlobalFetch ? (async (input, init) => globalThis.fetch(input, init)) : undefined);
  return {
    database,
    repositories,
    runtimeStore,
    productStore,
    runtime,
    idempotency: options.idempotency ?? new DefaultIdempotencyStore(),
    modelMode,
    createModelAdapter: options.createModelAdapter ?? ((config) => {
      if (modelMode === "real" && config.provider === "openai-compatible") {
        return createOpenAICompatibleAdapter({
          endpoint: chatCompletionsEndpoint(config.base_url),
          model: config.model,
          apiKey: config.api_key,
          ...(openAICompatibleFetch === undefined ? {} : { fetch: openAICompatibleFetch })
        });
      }
      return createDeterministicAdapter(config);
    }),
    describeModelRoute: options.describeModelRoute ?? ((config) => ({
      adapter_kind: modelMode === "real" && config.provider === "openai-compatible" ? "openai-compatible" : "fake",
      model_config_id: config.id,
      provider: config.provider,
      model: config.model
    })),
    createReviewAdapter: async () => {
      if (options.createReviewAdapter !== undefined) {
        return { adapter: await options.createReviewAdapter(), kind: options.reviewAdapterKind ?? "mock" };
      }
      if (modelMode === "real") {
        const config = await repositories.modelConfigs.getDefaultForModelCall();
        if (config !== null && config.provider === "openai-compatible") {
          return { adapter: createOpenAICompatibleReviewAdapter(config, openAICompatibleFetch), kind: "openai-compatible" };
        }
      }
      return { adapter: createDeterministicReviewAdapter(), kind: "fake" };
    },
    now,
    createId: options.createId ?? createId
  };
};

export const replayOrRun = async <T>(
  context: ProductApiContext,
  idempotencyKey: string | undefined,
  payload: unknown,
  run: () => Promise<{ readonly statusCode: number; readonly body: T }>
): Promise<{ readonly statusCode: number; readonly body: T }> => {
  if (idempotencyKey === undefined) {
    return run();
  }
  const payloadHash = hashIdempotencyPayload(payload);
  const existing = context.idempotency.get(idempotencyKey);
  if (existing !== undefined) {
    if (existing.payloadHash !== payloadHash) {
      throw conflictError("Idempotency key was already used with a different payload.");
    }
    return { statusCode: existing.statusCode, body: existing.body as T };
  }
  const result = await run();
  context.idempotency.put(idempotencyKey, { payloadHash, statusCode: result.statusCode, body: result.body });
  return result;
};
