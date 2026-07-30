import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RepositoryChatApiError,
  askRepositoryQuestion,
  repositoryChatErrorMessage,
} from "./repository-chat";

const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";

const result = {
  repositoryId,
  conversationId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  userMessageId: "cccccccccccccccccccccccc",
  assistantMessageId: "dddddddddddddddddddddddd",
  answer: "Authentication uses middleware. [src/auth.ts:L1-L3]",
  sources: [
    {
      filePath: "src/auth.ts",
      startLine: 1,
      endLine: 3,
      symbolName: "authenticate",
    },
  ],
  category: "semantic",
  branch: "main",
  commitSha: "abc123",
  retrievedChunks: 3,
  embeddingModel: "text-embedding-3-small",
  model: "gpt-5.6-sol",
  providerResponseId: "response-1",
  usage: {
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: 10,
    totalTokens: 125,
  },
  latencyMs: 250,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("askRepositoryQuestion", () => {
  it("sends an authenticated exact-body request and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: result }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test/");
    const controller = new AbortController();

    await expect(
      askRepositoryQuestion({
        repositoryId,
        question: "  How does authentication work?  ",
        conversationId: result.conversationId,
        signal: controller.signal,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`https://api.example.test/api/repositories/${repositoryId}/chat`),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          question: "How does authentication work?",
          conversationId: result.conversationId,
        }),
      }),
    );
  });

  it("preserves safe API error details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "REPOSITORY_NOT_READY",
              message: "Repository indexing is not complete",
              requestId: "request-1",
            },
          },
          409,
        ),
      ),
    );

    await expect(
      askRepositoryQuestion({ repositoryId, question: "Explain the app" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "REPOSITORY_NOT_READY",
      requestId: "request-1",
    });
  });

  it("rejects invalid local input and malformed success payloads", async () => {
    await expect(
      askRepositoryQuestion({ repositoryId: "invalid", question: "Question" }),
    ).rejects.toMatchObject({ code: "INVALID_REPOSITORY_ID" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { answer: "incomplete" } })),
    );
    await expect(
      askRepositoryQuestion({ repositoryId, question: "Question" }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
});

describe("repositoryChatErrorMessage", () => {
  it("maps actionable API errors and unreachable network failures", () => {
    expect(
      repositoryChatErrorMessage(
        new RepositoryChatApiError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required",
        ),
      ),
    ).toContain("Sign in");
    expect(repositoryChatErrorMessage(new TypeError("fetch failed"))).toContain(
      "could not be reached",
    );
  });
});
