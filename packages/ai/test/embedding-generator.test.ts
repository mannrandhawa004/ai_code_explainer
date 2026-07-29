import { describe, expect, it } from "vitest";

import {
  Cl100kEmbeddingTokenCounter,
  EmbeddingGenerationError,
  EmbeddingGenerator,
  createOpenAIEmbeddingGeneratorFromEnv,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderRequestOptions,
  type EmbeddingProviderResponse,
  type EmbeddingTokenCounter,
} from "../src/index.js";

class CharacterTokenCounter implements EmbeddingTokenCounter {
  count(text: string): number {
    return text.length;
  }
}

class RecordingProvider implements EmbeddingProvider {
  readonly requests: EmbeddingProviderRequest[] = [];
  activeRequests = 0;
  maxActiveRequests = 0;

  constructor(
    private readonly dimensions: number,
    private readonly delayMs = 0,
  ) {}

  async createEmbeddings(
    request: EmbeddingProviderRequest,
    _options?: EmbeddingProviderRequestOptions,
  ): Promise<EmbeddingProviderResponse> {
    this.requests.push(request);
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(
      this.maxActiveRequests,
      this.activeRequests,
    );

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    this.activeRequests -= 1;
    const promptTokens = request.input.reduce(
      (total, input) => total + input.length,
      0,
    );

    return {
      data: request.input
        .map((input, index) => ({
          embedding: [input.length, ...Array(this.dimensions - 1).fill(index)],
          index,
        }))
        .reverse(),
      model: request.model,
      usage: {
        promptTokens,
        totalTokens: promptTokens,
      },
    };
  }
}

function createGenerator(
  provider: EmbeddingProvider,
  overrides: ConstructorParameters<typeof EmbeddingGenerator>[2] = {},
): EmbeddingGenerator {
  return new EmbeddingGenerator(provider, new CharacterTokenCounter(), {
    dimensions: 3,
    batchSize: 2,
    requestConcurrency: 2,
    maxInputTokens: 100,
    maxRequestTokens: 100,
    ...overrides,
  });
}

describe("EmbeddingGenerator", () => {
  it("returns immediately for empty input without calling the provider", async () => {
    const provider = new RecordingProvider(3);
    const result = await createGenerator(provider).generate([]);

    expect(result.embeddings).toEqual([]);
    expect(result.usage).toEqual({
      promptTokens: 0,
      totalTokens: 0,
      requests: 0,
      uniqueInputs: 0,
    });
    expect(provider.requests).toEqual([]);
  });

  it("batches requests and restores input order from indexed responses", async () => {
    const provider = new RecordingProvider(3);
    const generator = createGenerator(provider);
    const result = await generator.generate(
      ["a", "bb", "ccc", "dddd", "eeeee"].map((text, index) => ({
        id: `input-${index}`,
        text,
      })),
      { endUserId: "anonymous-session-1" },
    );

    expect(provider.requests.map((request) => request.input)).toEqual([
      ["a", "bb"],
      ["ccc", "dddd"],
      ["eeeee"],
    ]);
    expect(provider.requests.every((request) => request.user === "anonymous-session-1")).toBe(
      true,
    );
    expect(result.embeddings.map((embedding) => embedding.id)).toEqual([
      "input-0",
      "input-1",
      "input-2",
      "input-3",
      "input-4",
    ]);
    expect(result.embeddings.map((embedding) => embedding.vector[0])).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(result.usage.requests).toBe(3);
    expect(result.usage.uniqueInputs).toBe(5);
  });

  it("splits batches at the aggregate request-token budget", async () => {
    const provider = new RecordingProvider(3);
    const generator = createGenerator(provider, {
      batchSize: 10,
      maxInputTokens: 10,
      maxRequestTokens: 10,
    });

    await generator.generate([
      { id: "one", text: "123456" },
      { id: "two", text: "1234" },
      { id: "three", text: "12345" },
    ]);

    expect(provider.requests.map((request) => request.input)).toEqual([
      ["123456", "1234"],
      ["12345"],
    ]);
  });

  it("deduplicates identical text while returning one vector per input", async () => {
    const provider = new RecordingProvider(3);
    const result = await createGenerator(provider).generate([
      { id: "first", text: "same source" },
      { id: "second", text: "same source" },
    ]);

    expect(provider.requests[0]?.input).toEqual(["same source"]);
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]?.vector).toEqual(result.embeddings[1]?.vector);
    expect(result.embeddings[0]?.vector).not.toBe(result.embeddings[1]?.vector);
    expect(result.usage.uniqueInputs).toBe(1);
  });

  it("bounds concurrent provider requests", async () => {
    const provider = new RecordingProvider(3, 10);
    const generator = createGenerator(provider, {
      batchSize: 1,
      requestConcurrency: 2,
    });

    await generator.generate(
      Array.from({ length: 6 }, (_, index) => ({
        id: `input-${index}`,
        text: `text-${index}`,
      })),
    );

    expect(provider.maxActiveRequests).toBe(2);
  });

  it("rejects duplicate IDs, empty text, and oversized inputs", async () => {
    const generator = createGenerator(new RecordingProvider(3), {
      maxInputTokens: 5,
      maxRequestTokens: 5,
    });

    await expect(
      generator.generate([
        { id: "same", text: "one" },
        { id: "same", text: "two" },
      ]),
    ).rejects.toMatchObject({ code: "DUPLICATE_INPUT_ID" });
    await expect(
      generator.generate([{ id: "empty", text: "  " }]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      generator.generate([{ id: "large", text: "123456" }]),
    ).rejects.toMatchObject({
      code: "INPUT_TOKEN_LIMIT_EXCEEDED",
      inputId: "large",
    });
  });

  it("validates official provider ceilings in configuration", () => {
    const provider = new RecordingProvider(3);

    expect(
      () =>
        new EmbeddingGenerator(provider, new CharacterTokenCounter(), {
          batchSize: 2_049,
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(
      () =>
        new EmbeddingGenerator(provider, new CharacterTokenCounter(), {
          maxRequestTokens: 300_001,
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it.each([
    {
      name: "wrong response count",
      response: {
        data: [],
        model: "text-embedding-3-small",
        usage: { promptTokens: 1, totalTokens: 1 },
      },
      code: "RESPONSE_COUNT_MISMATCH",
    },
    {
      name: "invalid response index",
      response: {
        data: [{ embedding: [1, 2, 3], index: 4 }],
        model: "text-embedding-3-small",
        usage: { promptTokens: 1, totalTokens: 1 },
      },
      code: "RESPONSE_INDEX_INVALID",
    },
    {
      name: "non-finite vector",
      response: {
        data: [{ embedding: [1, Number.NaN, 3], index: 0 }],
        model: "text-embedding-3-small",
        usage: { promptTokens: 1, totalTokens: 1 },
      },
      code: "INVALID_VECTOR",
    },
    {
      name: "wrong dimensions",
      response: {
        data: [{ embedding: [1, 2], index: 0 }],
        model: "text-embedding-3-small",
        usage: { promptTokens: 1, totalTokens: 1 },
      },
      code: "DIMENSION_MISMATCH",
    },
  ])("rejects a provider response with $name", async ({ response, code }) => {
    const provider: EmbeddingProvider = {
      createEmbeddings: async () => response,
    };

    await expect(
      createGenerator(provider).generate([{ id: "input", text: "x" }]),
    ).rejects.toMatchObject({ code });
  });

  it("wraps provider failures without exposing input text", async () => {
    const provider: EmbeddingProvider = {
      createEmbeddings: async () => {
        throw new Error("provider internals");
      },
    };

    await expect(
      createGenerator(provider).generate([
        { id: "input", text: "private repository source" },
      ]),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Embedding provider request failed",
    });
  });

  it("honors cancellation before making requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new RecordingProvider(3);

    await expect(
      createGenerator(provider).generate([{ id: "input", text: "source" }], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_ABORTED" });
    expect(provider.requests).toEqual([]);
  });
});

describe("embedding runtime configuration", () => {
  it("uses the cl100k tokenizer for embedding inputs", () => {
    const counter = new Cl100kEmbeddingTokenCounter();

    expect(counter.count("hello")).toBe(1);
    expect(counter.count("export const value = 1;")).toBeGreaterThan(1);
  });

  it("requires a key and validates numeric environment variables", () => {
    expect(() => createOpenAIEmbeddingGeneratorFromEnv({})).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
    expect(() =>
      createOpenAIEmbeddingGeneratorFromEnv({
        OPENAI_API_KEY: "test-key",
        EMBEDDING_BATCH_SIZE: "zero",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(
      createOpenAIEmbeddingGeneratorFromEnv({
        OPENAI_API_KEY: "test-key",
        OPENAI_EMBEDDING_DIMENSIONS: "256",
        EMBEDDING_BATCH_SIZE: "75",
      }),
    ).toBeInstanceOf(EmbeddingGenerator);
  });

  it("uses a typed embedding generation error", () => {
    expect(
      new EmbeddingGenerationError("INVALID_INPUT", "invalid"),
    ).toBeInstanceOf(Error);
  });
});
