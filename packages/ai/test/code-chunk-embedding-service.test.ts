import type { CodeChunk } from "@codebase-explainer/repository";
import { describe, expect, it } from "vitest";

import {
  CodeChunkEmbeddingService,
  EmbeddingGenerator,
  type EmbeddingProvider,
  type EmbeddingTokenCounter,
} from "../src/index.js";

const chunk: CodeChunk = {
  id: "chunk-1",
  userId: "user-1",
  repositoryId: "repository-1",
  branch: "main",
  commitSha: "abc123",
  filePath: "src/index.ts",
  language: "typescript",
  startLine: 1,
  endLine: 1,
  chunkIndex: 0,
  content: "export {};",
  contentHash: "content-hash",
  imports: [],
  exports: [],
};

describe("CodeChunkEmbeddingService", () => {
  it("formats chunks and returns vectors beside their original metadata", async () => {
    let receivedText = "";
    const provider: EmbeddingProvider = {
      createEmbeddings: async (request) => {
        receivedText = request.input[0] ?? "";
        return {
          data: [{ embedding: [0.1, 0.2], index: 0 }],
          model: request.model,
          usage: { promptTokens: 20, totalTokens: 20 },
        };
      },
    };
    const tokenCounter: EmbeddingTokenCounter = {
      count: () => 20,
    };
    const generator = new EmbeddingGenerator(provider, tokenCounter, {
      dimensions: 2,
      maxInputTokens: 100,
      maxRequestTokens: 100,
    });
    const result = await new CodeChunkEmbeddingService(generator).embedChunks(
      [chunk],
      { repositoryLabel: "owner/repository" },
    );

    expect(receivedText).toContain("Repository: owner/repository");
    expect(receivedText).toContain("File: src/index.ts");
    expect(receivedText).toContain("Code:\nexport {};");
    expect(result.items[0]).toMatchObject({
      chunk,
      embedding: [0.1, 0.2],
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 2,
      embeddingTokenCount: 20,
    });
    expect(result.items[0]?.embeddingInputHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("handles an empty chunk list without calling the provider", async () => {
    let called = false;
    const provider: EmbeddingProvider = {
      createEmbeddings: async () => {
        called = true;
        throw new Error("should not be called");
      },
    };
    const generator = new EmbeddingGenerator(
      provider,
      { count: () => 1 },
      { dimensions: 2 },
    );

    const result = await new CodeChunkEmbeddingService(generator).embedChunks(
      [],
    );

    expect(result.items).toEqual([]);
    expect(called).toBe(false);
  });
});
