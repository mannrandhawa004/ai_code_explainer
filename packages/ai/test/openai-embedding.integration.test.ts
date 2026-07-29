import { describe, expect, it } from "vitest";

import { createOpenAIEmbeddingGeneratorFromEnv } from "../src/index.js";

const runLiveTest =
  process.env.RUN_OPENAI_EMBEDDING_TESTS === "true" &&
  Boolean(process.env.OPENAI_API_KEY);
const describeWithOpenAI = runLiveTest ? describe : describe.skip;

describeWithOpenAI("OpenAI embedding integration", () => {
  it(
    "generates a finite vector using the configured embedding model",
    async () => {
      const generator = createOpenAIEmbeddingGeneratorFromEnv();
      const result = await generator.generate([
        {
          id: "live-test",
          text: "Repository: integration/test\nFile: src/index.ts\nCode:\nexport {};",
        },
      ]);

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]?.vector).toHaveLength(result.dimensions);
      expect(result.embeddings[0]?.vector.every(Number.isFinite)).toBe(true);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
    },
    90_000,
  );
});
