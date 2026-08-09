import { describe, expect, it, vi } from "vitest";

import {
  AIProviderError,
  GoogleAnswerProvider,
  GoogleEmbeddingProvider,
  classifyAIProviderError,
  resolveAIProvider,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Google AI providers", () => {
  it("maps code-document batch embeddings into the shared contract", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({
        embeddings: [
          { values: [0.1, 0.2, 0.3] },
          { values: [0.4, 0.5, 0.6] },
        ],
      }),
    ) as unknown as typeof fetch;
    const provider = new GoogleEmbeddingProvider({
      apiKey: "test-google-key",
      purpose: "document",
      fetchImplementation,
    });

    const result = await provider.createEmbeddings({
      model: "gemini-embedding-2",
      input: ["const first = true;", "const second = true;"],
      dimensions: 3,
      encodingFormat: "float",
    });

    expect(result.data).toEqual([
      { embedding: [0.1, 0.2, 0.3], index: 0 },
      { embedding: [0.4, 0.5, 0.6], index: 1 },
    ]);
    expect(result.model).toBe("gemini-embedding-2");
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBe(result.usage.promptTokens);

    const [url, options] = vi.mocked(fetchImplementation).mock.calls[0] ?? [];
    expect(String(url)).toMatch(
      /\/models\/gemini-embedding-2:batchEmbedContents$/u,
    );
    expect(new Headers(options?.headers).get("x-goog-api-key")).toBe(
      "test-google-key",
    );
    expect(String(url)).not.toContain("test-google-key");
    const body = JSON.parse(String(options?.body)) as {
      requests: Array<Record<string, unknown>>;
    };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({
      model: "models/gemini-embedding-2",
      content: {
        parts: [
          { text: "title: repository code | text: const first = true;" },
        ],
      },
      outputDimensionality: 3,
    });
  });

  it("uses the code-retrieval query format for question embeddings", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ embeddings: [{ values: [0.1, 0.2] }] }),
    ) as unknown as typeof fetch;
    const provider = new GoogleEmbeddingProvider({
      apiKey: "test-google-key",
      purpose: "query",
      fetchImplementation,
    });

    await provider.createEmbeddings({
      model: "gemini-embedding-2",
      input: ["Where is authentication handled?"],
      dimensions: 2,
      encodingFormat: "float",
    });

    const body = JSON.parse(
      String(vi.mocked(fetchImplementation).mock.calls[0]?.[1]?.body),
    ) as { requests: Array<{ content: { parts: Array<{ text: string }> } }> };
    expect(body.requests[0]?.content.parts[0]?.text).toBe(
      "task: code retrieval | query: Where is authentication handled?",
    );
  });

  it("requests schema-constrained Gemini chat and maps token usage", async () => {
    const outputText =
      '{"segments":[{"text":"Ready","sourceIds":["S1"]}]}';
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: outputText }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 40,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 2,
          totalTokenCount: 52,
        },
        modelVersion: "gemini-2.5-flash-lite",
        responseId: "google-response-1",
      }),
    ) as unknown as typeof fetch;
    const provider = new GoogleAnswerProvider({
      apiKey: "test-google-key",
      fetchImplementation,
    });
    const outputSchema = {
      type: "object",
      properties: { segments: { type: "array" } },
    };

    await expect(
      provider.createAnswer({
        model: "gemini-2.5-flash-lite",
        instructions: "Use only supplied source.",
        input: "Explain this code.",
        maxOutputTokens: 500,
        safetyIdentifier: "hashed-user",
        outputSchema,
      }),
    ).resolves.toEqual({
      responseId: "google-response-1",
      outputText,
      model: "gemini-2.5-flash-lite",
      status: "completed",
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        reasoningTokens: 2,
        totalTokens: 52,
      },
    });

    const body = JSON.parse(
      String(vi.mocked(fetchImplementation).mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      system_instruction: {
        parts: [{ text: "Use only supplied source." }],
      },
      contents: [
        { role: "user", parts: [{ text: "Explain this code." }] },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 500,
        responseMimeType: "application/json",
        responseJsonSchema: outputSchema,
      },
    });
  });

  it.each([
    {
      status: 400,
      body: { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } },
      code: "AUTHENTICATION_FAILED",
      retryable: false,
    },
    {
      status: 404,
      body: { error: { message: "Model not found", status: "NOT_FOUND" } },
      code: "MODEL_NOT_FOUND",
      retryable: false,
    },
    {
      status: 429,
      body: { error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
      code: "RATE_LIMITED",
      retryable: true,
    },
  ])(
    "classifies Google HTTP $status errors",
    async ({ status, body, code, retryable }) => {
      const fetchImplementation = vi.fn(async () =>
        jsonResponse(body, status),
      ) as unknown as typeof fetch;
      const provider = new GoogleEmbeddingProvider({
        apiKey: "test-google-key",
        fetchImplementation,
      });

      const error = await provider
        .createEmbeddings({
          model: "gemini-embedding-2",
          input: ["source"],
          dimensions: 3,
          encodingFormat: "float",
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(AIProviderError);
      expect(classifyAIProviderError(error)).toMatchObject({
        provider: "google",
        code,
        retryable,
        statusCode: status,
      });
    },
  );

  it("selects Google by default and rejects unknown provider names", () => {
    expect(resolveAIProvider({})).toBe("google");
    expect(resolveAIProvider({ AI_PROVIDER: "GOOGLE" })).toBe("google");
    expect(() => resolveAIProvider({ AI_PROVIDER: "free-cloud" })).toThrow(
      "AI_PROVIDER must be google, openai, or ollama",
    );
  });
});
