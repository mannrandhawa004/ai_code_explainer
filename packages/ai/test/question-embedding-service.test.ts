import { describe, expect, it } from "vitest";

import {
  EmbeddingGenerator,
  QuestionEmbeddingService,
  maximumRepositoryQuestionCharacters,
  type EmbeddingProvider,
  type EmbeddingTokenCounter,
} from "../src/index.js";

describe("QuestionEmbeddingService", () => {
  it("normalizes and embeds one question with provider attribution", async () => {
    let receivedInput = "";
    let receivedUser = "";
    const provider: EmbeddingProvider = {
      createEmbeddings: async (request) => {
        receivedInput = request.input[0] ?? "";
        receivedUser = request.user ?? "";
        return {
          data: [{ embedding: [0.2, 0.4], index: 0 }],
          model: request.model,
          usage: { promptTokens: 8, totalTokens: 8 },
        };
      },
    };
    const tokenCounter: EmbeddingTokenCounter = { count: () => 8 };
    const service = new QuestionEmbeddingService(
      new EmbeddingGenerator(provider, tokenCounter, {
        dimensions: 2,
        maxInputTokens: 100,
        maxRequestTokens: 100,
      }),
    );

    const result = await service.embed("  How does authentication work?  ", {
      endUserId: "user-1",
    });

    expect(receivedInput).toBe("How does authentication work?");
    expect(receivedUser).toBe("user-1");
    expect(result).toMatchObject({
      vector: [0.2, 0.4],
      model: "text-embedding-3-small",
      dimensions: 2,
      tokenCount: 8,
      usage: { promptTokens: 8, totalTokens: 8, requests: 1 },
    });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects empty, unsafe, and oversized questions before provider I/O", async () => {
    let called = false;
    const service = new QuestionEmbeddingService(
      new EmbeddingGenerator(
        {
          createEmbeddings: async () => {
            called = true;
            throw new Error("should not run");
          },
        },
        { count: () => 1 },
        { dimensions: 2 },
      ),
    );

    await expect(service.embed("   ")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(service.embed("unsafe\0question")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      service.embed("x".repeat(maximumRepositoryQuestionCharacters + 1)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(called).toBe(false);
  });
});
