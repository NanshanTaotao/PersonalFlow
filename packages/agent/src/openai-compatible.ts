import type { LLMAdapter, LLMRequest, LLMResponse } from "./types";

type FetchLike = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export interface OpenAICompatibleAdapterOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export class OpenAICompatibleProviderError extends Error {
  readonly code: "provider_auth_error" | "provider_retryable_error" | "provider_error";
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number) {
    super("OpenAI-compatible provider request failed with status " + String(status) + ".");
    this.status = status;
    this.retryable = status === 408 || status === 429 || status >= 500;
    this.code = status === 401 || status === 403
      ? "provider_auth_error"
      : this.retryable
        ? "provider_retryable_error"
        : "provider_error";
  }
}

export class OpenAICompatibleProviderTransportError extends Error {
  readonly code = "provider_transport_error";
  readonly retryable = true;

  constructor() {
    super("OpenAI-compatible provider request failed before receiving a valid response.");
    this.name = "OpenAICompatibleProviderTransportError";
  }
}

export class OpenAICompatibleProviderTimeoutError extends Error {
  readonly code = "provider_timeout";
  readonly retryable = true;

  constructor() {
    super("OpenAI-compatible provider request timed out.");
    this.name = "OpenAICompatibleProviderTimeoutError";
  }
}

export class OpenAICompatibleProviderResponseError extends Error {
  readonly code = "provider_response_error";
  readonly retryable = false;

  constructor() {
    super("OpenAI-compatible provider response could not be parsed.");
    this.name = "OpenAICompatibleProviderResponseError";
  }
}

export class OpenAICompatibleTransportError extends Error {
  readonly code = "transport_required";

  constructor() {
    super("OpenAI-compatible adapter requires an explicit fetch transport.");
    this.name = "OpenAICompatibleTransportError";
  }
}

const pickContent = (value: unknown): string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return "";
  }
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
  const content = first?.message?.content ?? first?.text;
  return typeof content === "string" ? content : "";
};

export const createOpenAICompatibleAdapter = ({
  endpoint,
  model,
  apiKey,
  fetch: fetchImpl,
  timeoutMs = 30000
}: OpenAICompatibleAdapterOptions): LLMAdapter => ({
  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (fetchImpl === undefined) {
      throw new OpenAICompatibleTransportError();
    }
    let response: Awaited<ReturnType<FetchLike>>;
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    const timeout = controller === undefined || timeoutMs <= 0
      ? undefined
      : setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: request.prompt }],
          response_format: { type: "json_object" },
          metadata: {
            prompt_hash: request.prompt_hash,
            actor_id: request.actor_id,
            context_hash: request.metadata.context_hash,
            visibility_hash: request.metadata.visibility_hash
          }
        }),
        ...(controller === undefined ? {} : { signal: controller.signal })
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenAICompatibleProviderTimeoutError();
      }
      throw new OpenAICompatibleProviderTransportError();
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    if (!response.ok) {
      await response.text?.().catch(() => "");
      throw new OpenAICompatibleProviderError(response.status);
    }

    let payload: unknown;
    try {
      payload = response.json === undefined ? {} : await response.json();
    } catch {
      throw new OpenAICompatibleProviderResponseError();
    }
    return { content: pickContent(payload), model };
  }
});
