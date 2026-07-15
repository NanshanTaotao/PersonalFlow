import { parseAgentOutput } from "./output-parser";
import type { AgentAttemptErrorCode, AgentAttemptSummary, AgentRetryResult, LLMAdapter, LLMRequest } from "./types";

export interface InvokeAgentWithRetryInput {
  readonly adapter: LLMAdapter;
  readonly request: LLMRequest;
  readonly maxAttempts: number;
}

const providerErrorCodes = new Set<AgentAttemptErrorCode>([
  "provider_auth_error",
  "provider_retryable_error",
  "provider_timeout",
  "provider_response_error",
  "provider_transport_error"
]);

const classifyAdapterError = (error: unknown): { readonly code: AgentAttemptErrorCode; readonly retryable: boolean } => {
  if (error !== null && typeof error === "object") {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && providerErrorCodes.has(code as AgentAttemptErrorCode)) {
      const retryable = (error as { readonly retryable?: unknown }).retryable;
      return { code: code as AgentAttemptErrorCode, retryable: retryable === true };
    }
  }
  return { code: "adapter_error", retryable: true };
};

export const invokeAgentWithRetry = async ({
  adapter,
  request,
  maxAttempts
}: InvokeAgentWithRetryInput): Promise<AgentRetryResult> => {
  const attempts: AgentAttemptSummary[] = [];
  const attemptLimit = Math.max(1, Math.trunc(maxAttempts));

  for (let index = 0; index < attemptLimit; index += 1) {
    try {
      const response = await adapter.complete(request);
      const parsed = parseAgentOutput(response.content);
      if (parsed.ok) {
        attempts.push({
          ok: true,
          ...(response.response_id === undefined ? {} : { response_id: response.response_id }),
          ...(response.model === undefined ? {} : { model: response.model })
        });
        return { ok: true, action: parsed.action, attempts };
      }
      attempts.push({ ok: false, error_code: parsed.error.code });
    } catch (error) {
      const classified = classifyAdapterError(error);
      attempts.push({ ok: false, error_code: classified.code });
      if (!classified.retryable) {
        break;
      }
    }
  }

  return { ok: false, error: { code: "model_failed" }, attempts };
};
