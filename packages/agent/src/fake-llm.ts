import type { LLMAdapter, LLMRequest, LLMResponse } from "./types";

export type FakeLLMScriptItem =
  | { readonly content: string; readonly response_id?: string; readonly model?: string }
  | { readonly throws: Error };

export interface FakeLLMAdapter extends LLMAdapter {
  calls(): readonly LLMRequest[];
}

export const createFakeLLM = (script: readonly FakeLLMScriptItem[]): FakeLLMAdapter => {
  let cursor = 0;
  const calls: LLMRequest[] = [];

  return {
    async complete(request: LLMRequest): Promise<LLMResponse> {
      calls.push(request);
      const item = script[cursor];
      cursor += 1;
      if (item === undefined) {
        throw new Error("Fake LLM script exhausted.");
      }
      if ("throws" in item) {
        throw item.throws;
      }
      return {
        content: item.content,
        response_id: item.response_id ?? "fake-response-" + String(cursor - 1),
        model: item.model ?? "fake-llm"
      };
    },
    calls(): readonly LLMRequest[] {
      return [...calls];
    }
  };
};
