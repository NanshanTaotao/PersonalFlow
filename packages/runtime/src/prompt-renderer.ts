import type { VisibleContextBundle } from "./context";
import { hashStableValue } from "./hash";
import { buildPromptBlocks, type PromptBlock } from "./prompt-blocks";

export interface PromptDebugBlock {
  readonly name: PromptBlock["name"];
  readonly hash: string;
  readonly source_refs: readonly string[];
}

export interface PromptDebugMetadata {
  readonly prompt_hash: string;
  readonly visibility_hash: string;
  readonly context_hash: string;
  readonly blocks: readonly PromptDebugBlock[];
}

export interface RenderedPrompt {
  readonly text: string;
  readonly blocks: readonly PromptBlock[];
  readonly prompt_hash: string;
  readonly debug: PromptDebugMetadata;
}

export const renderPrompt = (bundle: VisibleContextBundle): RenderedPrompt => {
  const blocks = buildPromptBlocks(bundle);
  const text = blocks.map((block) => block.text).join("\n\n");
  const promptHash = hashStableValue({
    blocks: blocks.map((block) => ({
      name: block.name,
      hash: block.hash
    }))
  });

  return {
    text,
    blocks,
    prompt_hash: promptHash,
    debug: {
      prompt_hash: promptHash,
      visibility_hash: bundle.visibility_hash,
      context_hash: bundle.context_hash,
      blocks: blocks.map((block) => ({
        name: block.name,
        hash: block.hash,
        source_refs: block.source_refs
      }))
    }
  };
};
