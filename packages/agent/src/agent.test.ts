import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFakeLLM,
  OpenAICompatibleProviderTimeoutError,
  createOpenAICompatibleAdapter,
  invokeAgentWithRetry,
  parseAgentOutput,
  type LLMRequest
} from "./index";

const request: LLMRequest = {
  prompt: "Prompt text",
  prompt_hash: "prompt-hash",
  actor_id: "ai_interviewer",
  allowed_steps: [
    {
      id: "ask_question",
      actor_id: "ai_interviewer",
      args_schema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false
      },
      args_ref_paths: ["$.resources.interview_context"]
    }
  ],
  metadata: {
    context_hash: "context-hash",
    visibility_hash: "visibility-hash",
    block_hashes: [{ name: "allowed_steps", hash: "block-hash" }],
    source_refs: ["step:ask_question"]
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent protocol", () => {
  it("parses one strict step AgentAction JSON object", () => {
    expect(
      parseAgentOutput(
        JSON.stringify({
          kind: "step",
          selected_step: "ask_question",
          content: "Next question",
          args: { question: "What project did you own end to end?" }
        })
      )
    ).toEqual({
      ok: true,
      action: {
        kind: "step",
        selected_step: "ask_question",
        content: "Next question",
        args: { question: "What project did you own end to end?" }
      }
    });
  });

  it("parses one strict tool request AgentAction JSON object", () => {
    expect(
      parseAgentOutput(
        JSON.stringify({
          kind: "tool_request",
          selected_tool: "mock_rag_query",
          reason: "Need visible source context before the next question.",
          args: { query: "ownership evidence" }
        })
      )
    ).toEqual({
      ok: true,
      action: {
        kind: "tool_request",
        selected_tool: "mock_rag_query",
        reason: "Need visible source context before the next question.",
        args: { query: "ownership evidence" }
      }
    });
  });

  it("rejects ambiguous, malformed, incomplete and unexpected top-level outputs with stable error codes", () => {
    expect(parseAgentOutput("")).toMatchObject({ ok: false, error: { code: "empty_output" } });
    expect(parseAgentOutput("not-json")).toMatchObject({ ok: false, error: { code: "invalid_json" } });
    expect(parseAgentOutput("```json\n{\"selected_step\":\"ask_question\",\"content\":\"Question\",\"args\":{}}\n```")).toMatchObject({
      ok: false,
      error: { code: "invalid_json" }
    });
    expect(parseAgentOutput("[]")).toMatchObject({ ok: false, error: { code: "not_object" } });
    expect(parseAgentOutput("null")).toMatchObject({ ok: false, error: { code: "not_object" } });
    expect(parseAgentOutput("{}")).toMatchObject({ ok: false, error: { code: "missing_field" } });
    expect(parseAgentOutput(JSON.stringify({ selected_step: "ask_question", content: "Question", args: {} }))).toMatchObject({
      ok: false,
      error: { code: "missing_field", field: "kind" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", step_id: "ask_question", content: "Question", args: {} }))).toMatchObject({
      ok: false,
      error: { code: "unexpected_field", field: "step_id" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", selectedStep: "ask_question", content: "Question", args: {} }))).toMatchObject({
      ok: false,
      error: { code: "unexpected_field", field: "selectedStep" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", selected_step: "ask_question", action: "submit", content: "Question", args: {} }))).toMatchObject({
      ok: false,
      error: { code: "unexpected_field", field: "action" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", selected_step: "ask_question", content: "Question", args: {}, debug: true }))).toMatchObject({
      ok: false,
      error: { code: "unexpected_field", field: "debug" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", selected_step: "   ", content: "Question", args: {} }))).toMatchObject({
      ok: false,
      error: { code: "invalid_field", field: "selected_step" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", selected_step: "ask_question", args: {} }))).toMatchObject({
      ok: false,
      error: { code: "missing_field", field: "content" }
    });
    expect(parseAgentOutput(JSON.stringify({ kind: "step", selected_step: "ask_question", content: "", args: [] }))).toMatchObject({
      ok: false,
      error: { code: "invalid_field", field: "args" }
    });
    expect(
      parseAgentOutput(JSON.stringify({ kind: "tool_request", selected_tool: "   ", reason: "Need data.", args: {} }))
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_field", field: "selected_tool" }
    });
    expect(
      parseAgentOutput(JSON.stringify({ kind: "tool_request", selected_tool: "mock_rag_query", reason: "   ", args: {} }))
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_field", field: "reason" }
    });
    expect(
      parseAgentOutput(JSON.stringify({ kind: "unknown", selected_tool: "mock_rag_query", reason: "Need data.", args: {} }))
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_field", field: "kind" }
    });
    expect(
      parseAgentOutput(
        JSON.stringify({ kind: "step", selected_step: "ask_question", content: "Question", args: {} }) +
          JSON.stringify({ kind: "step", selected_step: "ask_question", content: "Question", args: {} })
      )
    ).toMatchObject({ ok: false, error: { code: "ambiguous_output" } });
  });

  it("returns scripted Fake LLM responses deterministically", async () => {
    const adapter = createFakeLLM([
      { content: "{bad-json" },
      { throws: new Error("provider down") },
      {
        content: JSON.stringify({
          kind: "step",
          selected_step: "ask_question",
          content: "Question",
          args: { question: "Where did you reduce operational risk?" }
        })
      }
    ]);

    await expect(adapter.complete(request)).resolves.toMatchObject({ content: "{bad-json" });
    await expect(adapter.complete(request)).rejects.toThrow("provider down");
    await expect(adapter.complete(request)).resolves.toMatchObject({
      content: JSON.stringify({
        kind: "step",
        selected_step: "ask_question",
        content: "Question",
        args: { question: "Where did you reduce operational risk?" }
      })
    });
    expect(adapter.calls()).toEqual([request, request, request]);
  });

  it("retries model call and parsing only until the first valid action", async () => {
    const adapter = createFakeLLM([
      { content: "{bad-json" },
      {
        content: JSON.stringify({
          kind: "step",
          selected_step: "ask_question",
          content: "Question",
          args: { question: "Where did you reduce operational risk?" }
        })
      },
      { content: "{}" }
    ]);

    const result = await invokeAgentWithRetry({ adapter, request, maxAttempts: 3 });

    expect(result).toMatchObject({
      ok: true,
      attempts: [
        { ok: false, error_code: "invalid_json" },
        { ok: true, response_id: "fake-response-1" }
      ],
      action: {
        kind: "step",
        selected_step: "ask_question",
        args: { question: "Where did you reduce operational risk?" }
      }
    });
    expect(adapter.calls()).toHaveLength(2);
  });

  it("returns stable model failure without leaking raw provider details", async () => {
    const adapter = createFakeLLM([{ throws: new Error("Authorization: Bearer secret-key") }, { content: "{}" }]);
    const result = await invokeAgentWithRetry({ adapter, request, maxAttempts: 2 });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "model_failed" },
      attempts: [
        { ok: false, error_code: "adapter_error" },
        { ok: false, error_code: "missing_field" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(JSON.stringify(result)).not.toContain("Authorization");
  });

  it("wraps OpenAI-compatible fetch without exposing secrets in errors or responses", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Authorization: Bearer secret-key rejected"
    }));
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "secret-key",
      fetch: fetchImpl
    });

    await expect(adapter.complete(request)).rejects.toMatchObject({ code: "provider_auth_error", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, { headers: Record<string, string> }]>;
    expect(JSON.stringify(calls[0]?.[1])).toContain("Bearer secret-key");
    await adapter.complete(request).catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("secret-key");
      expect(JSON.stringify(error)).not.toContain("Authorization");
    });
  });

  it("requests JSON object output from OpenAI-compatible providers", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "step",
                selected_step: "ask_question",
                content: "Question",
                args: { question: "Where did you reduce operational risk?" }
              })
            }
          }
        ]
      })
    }));
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "secret-key",
      fetch: fetchImpl
    });

    await adapter.complete(request);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, { body: string }]>;
    expect(JSON.parse(calls[0]?.[1].body ?? "{}")).toMatchObject({
      response_format: { type: "json_object" }
    });
  });

  it("normalizes provider auth, 5xx, timeout and invalid JSON failures without leaking raw payloads", async () => {
    const secret = "dummy-secret-for-failure-matrix-only";
    const rawBody = "Authorization: Bearer " + secret + "; provider raw response body";
    const cases = [
      {
        name: "401",
        fetch: async () => ({ ok: false, status: 401, text: async () => rawBody })
      },
      {
        name: "403",
        fetch: async () => ({ ok: false, status: 403, text: async () => rawBody })
      },
      {
        name: "500",
        fetch: async () => ({ ok: false, status: 500, text: async () => rawBody })
      },
      {
        name: "502",
        fetch: async () => ({ ok: false, status: 502, text: async () => rawBody })
      },
      {
        name: "503",
        fetch: async () => ({ ok: false, status: 503, text: async () => rawBody })
      },
      {
        name: "timeout",
        fetch: async () => {
          throw new Error("timeout Authorization: Bearer " + secret);
        }
      },
      {
        name: "invalid-json",
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("invalid JSON: " + rawBody);
          }
        })
      }
    ] as const;

    for (const item of cases) {
      const adapter = createOpenAICompatibleAdapter({
        endpoint: "https://example.invalid/v1/chat/completions",
        model: "test-model",
        apiKey: secret,
        fetch: item.fetch
      });

      await adapter.complete(request).catch((error: unknown) => {
        const serialized = JSON.stringify(error) + " " + String(error);
        expect(serialized, item.name).not.toContain(secret);
        expect(serialized, item.name).not.toMatch(/Authorization|Bearer|provider raw|raw response/i);
      });
    }
  });

  it("requires an explicit mock transport before OpenAI-compatible adapter can send requests", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch touched");
    });
    vi.stubGlobal("fetch", globalFetch);
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "dummy-secret-for-security-check-only"
    });

    await expect(adapter.complete(request)).rejects.toThrow("OpenAI-compatible adapter requires an explicit fetch transport.");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("does not retry provider auth failures because changing attempts cannot fix credentials", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Authorization: Bearer dummy-secret rejected"
    }));
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "dummy-secret",
      fetch: fetchImpl
    });

    const result = await invokeAgentWithRetry({ adapter, request, maxAttempts: 3 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "model_failed" },
      attempts: [{ ok: false, error_code: "provider_auth_error" }]
    });
    expect(JSON.stringify(result)).not.toMatch(/Authorization|Bearer|dummy-secret/i);
  });

  it("retries retryable provider failures and succeeds on the first valid action", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "provider temporarily unavailable" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                kind: "step",
                selected_step: "ask_question",
                content: "Question",
                args: { question: "Where did you reduce operational risk?" }
              })
            }
          }]
        })
      });
    const adapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "dummy-secret",
      fetch: fetchImpl
    });

    const result = await invokeAgentWithRetry({ adapter, request, maxAttempts: 3 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      attempts: [
        { ok: false, error_code: "provider_retryable_error" },
        { ok: true, model: "test-model" }
      ]
    });
  });

  it("classifies provider timeout and malformed provider JSON as productized failure codes", async () => {
    const timeoutAdapter = {
      async complete() {
        throw new OpenAICompatibleProviderTimeoutError();
      }
    };
    const malformedJsonAdapter = createOpenAICompatibleAdapter({
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      apiKey: "dummy-secret",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("raw provider body with Authorization: Bearer dummy-secret");
        }
      })
    });

    await expect(invokeAgentWithRetry({ adapter: timeoutAdapter, request, maxAttempts: 1 })).resolves.toMatchObject({
      ok: false,
      attempts: [{ ok: false, error_code: "provider_timeout" }]
    });
    await expect(invokeAgentWithRetry({ adapter: malformedJsonAdapter, request, maxAttempts: 1 })).resolves.toMatchObject({
      ok: false,
      attempts: [{ ok: false, error_code: "provider_response_error" }]
    });
  });
});
