import { describe, expect, it, vi } from "vitest";

import {
  AIProviderError,
  OllamaAnswerProvider,
  OllamaEmbeddingProvider,
  classifyAIProviderError,
  resolveAIProvider,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Ollama providers", () => {
  it("maps local batch embeddings into the shared provider contract", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({
        model: "qwen3-embedding:0.6b",
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
        prompt_eval_count: 12,
      }),
    ) as unknown as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ fetchImplementation });

    await expect(
      provider.createEmbeddings({
        model: "qwen3-embedding:0.6b",
        input: ["first", "second"],
        dimensions: 3,
        encodingFormat: "float",
      }),
    ).resolves.toEqual({
      data: [
        { embedding: [0.1, 0.2, 0.3], index: 0 },
        { embedding: [0.4, 0.5, 0.6], index: 1 },
      ],
      model: "qwen3-embedding:0.6b",
      usage: { promptTokens: 12, totalTokens: 12 },
    });

    const request = JSON.parse(
      String(vi.mocked(fetchImplementation).mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      model: "qwen3-embedding:0.6b",
      input: ["first", "second"],
      dimensions: 3,
      truncate: false,
    });
  });

  it("requests schema-constrained local chat and returns token usage", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({
        model: "qwen2.5-coder:0.5b",
        message: {
          role: "assistant",
          content: '{"segments":[{"text":"Ready","sourceIds":["S1"]}]}',
        },
        done: true,
        prompt_eval_count: 40,
        eval_count: 10,
      }),
    ) as unknown as typeof fetch;
    const provider = new OllamaAnswerProvider({ fetchImplementation });
    const outputSchema = {
      type: "object",
      properties: { segments: { type: "array" } },
    };

    const result = await provider.createAnswer({
      model: "qwen2.5-coder:0.5b",
      instructions: "Use only the supplied source.",
      input: "Explain this code.",
      maxOutputTokens: 500,
      safetyIdentifier: "hashed-user",
      outputSchema,
    });

    expect(result).toMatchObject({
      outputText:
        '{"segments":[{"text":"Ready","sourceIds":["S1"]}]}',
      model: "qwen2.5-coder:0.5b",
      status: "completed",
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        reasoningTokens: 0,
        totalTokens: 50,
      },
    });
    expect(result.responseId).toMatch(/^ollama-/u);

    const request = JSON.parse(
      String(vi.mocked(fetchImplementation).mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      model: "qwen2.5-coder:0.5b",
      format: outputSchema,
      stream: false,
      options: { temperature: 0, num_ctx: 4_096, num_predict: 500 },
    });
  });

  it("marks a missing local model as a permanent actionable failure", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ error: "model not found" }, 404),
    ) as unknown as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ fetchImplementation });

    const error = await provider
      .createEmbeddings({
        model: "missing-model",
        input: ["source"],
        dimensions: 3,
        encodingFormat: "float",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AIProviderError);
    expect(classifyAIProviderError(error)).toMatchObject({
      provider: "ollama",
      code: "MODEL_NOT_FOUND",
      retryable: false,
      statusCode: 404,
    });
    expect((error as Error).message).toContain("ollama pull missing-model");
  });

  it("selects providers explicitly and rejects unknown values", () => {
    expect(resolveAIProvider({})).toBe("google");
    expect(resolveAIProvider({ AI_PROVIDER: "OLLAMA" })).toBe("ollama");
    expect(() => resolveAIProvider({ AI_PROVIDER: "free-cloud" })).toThrow(
      "AI_PROVIDER must be google, openai, or ollama",
    );
  });
});
