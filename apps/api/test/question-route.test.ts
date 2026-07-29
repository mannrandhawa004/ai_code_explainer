import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositoryQuestionError,
  type RepositoryQuestionServiceContract,
} from "../src/services/repository-question.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";

const result = {
  repositoryId,
  conversationId: "cccccccccccccccccccccccc",
  userMessageId: "dddddddddddddddddddddddd",
  assistantMessageId: "eeeeeeeeeeeeeeeeeeeeeeee",
  answer: "Authentication is handled by middleware. [src/auth.ts:L1-L3]",
  sources: [
    {
      filePath: "src/auth.ts",
      startLine: 1,
      endLine: 3,
      symbolName: "authenticate",
    },
  ],
  category: "semantic" as const,
  branch: "main",
  commitSha: "abc123",
  retrievedChunks: 3,
  embeddingModel: "text-embedding-3-small",
  model: "gpt-5.6-sol",
  providerResponseId: "response-1",
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 120,
  },
  latencyMs: 250,
};

function createTestApp(service: RepositoryQuestionServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositoryQuestionService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("POST /api/repositories/:id/chat", () => {
  it("fails closed when no server-authenticated identity exists", async () => {
    const service = { ask: vi.fn().mockResolvedValue(result) };
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositoryQuestionService: service,
    });

    const response = await request(app)
      .post(`/api/repositories/${repositoryId}/chat`)
      .set("x-user-id", userId)
      .send({ question: "How does authentication work?" })
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.ask).not.toHaveBeenCalled();
  });

  it("validates input before invoking the question service", async () => {
    const service = { ask: vi.fn().mockResolvedValue(result) };
    const app = createTestApp(service);

    const response = await request(app)
      .post(`/api/repositories/${repositoryId}/chat`)
      .send({ question: "", unexpected: true })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_QUESTION_REQUEST");
    expect(response.body.error.details).toEqual(expect.any(Array));
    expect(service.ask).not.toHaveBeenCalled();
  });

  it("returns a grounded persisted answer contract", async () => {
    const service = { ask: vi.fn().mockResolvedValue(result) };
    const app = createTestApp(service);

    const response = await request(app)
      .post(`/api/repositories/${repositoryId}/chat`)
      .send({
        question: "How does authentication work?",
        conversationId: "cccccccccccccccccccccccc",
      })
      .expect(200);

    expect(response.body).toEqual({ data: result });
    expect(service.ask).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
      question: "How does authentication work?",
      conversationId: "cccccccccccccccccccccccc",
      signal: expect.any(AbortSignal),
    });
  });

  it("maps repository access failures without exposing dependency details", async () => {
    const service = {
      ask: vi.fn().mockRejectedValue(
        new RepositoryQuestionError(
          "REPOSITORY_NOT_FOUND",
          "Repository was not found",
          { cause: new Error("database detail") },
        ),
      ),
    };
    const app = createTestApp(service);

    const response = await request(app)
      .post(`/api/repositories/${repositoryId}/chat`)
      .send({ question: "How does authentication work?" })
      .expect(404);

    expect(response.body.error).toMatchObject({
      code: "REPOSITORY_NOT_FOUND",
      message: "Repository was not found",
    });
    expect(JSON.stringify(response.body)).not.toContain("database detail");
  });
});
