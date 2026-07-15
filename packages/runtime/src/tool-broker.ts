import type { JsonObject, NormalizedScenarioV1 } from "@personalflow/contracts";

export interface RuntimeToolResult {
  readonly summary: string;
  readonly source_ref: string;
  readonly doc_version_hash: string;
  readonly chunk_id: string;
  readonly visibility_label: string;
  readonly trust_level: "high" | "medium" | "low";
}

export interface RuntimeToolAdapter {
  readonly id: string;
  execute(input: { readonly args: JsonObject; readonly scenario: NormalizedScenarioV1 }): Promise<RuntimeToolResult>;
}

export const createMockRagToolAdapter = (): RuntimeToolAdapter => ({
  id: "mock_rag_query",
  async execute(input) {
    const query = typeof input.args.query === "string" ? input.args.query : "unknown";
    return {
      summary: "Mock RAG result for: " + query,
      source_ref: "mock_rag:chunk-1",
      doc_version_hash: "mock-doc-v1",
      chunk_id: "chunk-1",
      visibility_label: "participant",
      trust_level: "medium"
    };
  }
});

export const defaultRuntimeToolAdapters = (): RuntimeToolAdapter[] => [createMockRagToolAdapter()];

