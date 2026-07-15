import type { JsonObject, JsonSchemaValue } from "@personalflow/contracts";

export interface LLMAllowedStepSummary {
  readonly id: string;
  readonly actor_id: string;
  readonly args_schema: JsonSchemaValue;
  readonly args_ref_paths: readonly string[];
}

export interface LLMPromptBlockHash {
  readonly name: string;
  readonly hash: string;
}

export interface LLMRequest {
  readonly prompt: string;
  readonly prompt_hash: string;
  readonly actor_id: string;
  readonly allowed_steps: readonly LLMAllowedStepSummary[];
  readonly metadata: {
    readonly context_hash: string;
    readonly visibility_hash: string;
    readonly block_hashes: readonly LLMPromptBlockHash[];
    readonly source_refs: readonly string[];
  };
}

export interface LLMResponse {
  readonly content: string;
  readonly response_id?: string;
  readonly model?: string;
}

export interface LLMAdapter {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export type AgentAction =
  | { readonly kind: "step"; readonly selected_step: string; readonly content: string; readonly args: JsonObject }
  | { readonly kind: "tool_request"; readonly selected_tool: string; readonly reason: string; readonly args: JsonObject };

export type AgentOutputErrorCode =
  | "empty_output"
  | "invalid_json"
  | "ambiguous_output"
  | "not_object"
  | "missing_field"
  | "invalid_field"
  | "unexpected_field";

export interface AgentOutputError {
  readonly code: AgentOutputErrorCode;
  readonly field?: string;
}

export type ParseAgentOutputResult =
  | { readonly ok: true; readonly action: AgentAction }
  | { readonly ok: false; readonly error: AgentOutputError };

export type AgentAttemptErrorCode =
  | AgentOutputErrorCode
  | "adapter_error"
  | "provider_auth_error"
  | "provider_retryable_error"
  | "provider_timeout"
  | "provider_response_error"
  | "provider_transport_error";

export type AgentAttemptSummary =
  | { readonly ok: true; readonly response_id?: string; readonly model?: string }
  | { readonly ok: false; readonly error_code: AgentAttemptErrorCode };

export type AgentRetryResult =
  | { readonly ok: true; readonly action: AgentAction; readonly attempts: readonly AgentAttemptSummary[] }
  | {
      readonly ok: false;
      readonly error: { readonly code: "model_failed" };
      readonly attempts: readonly AgentAttemptSummary[];
    };
