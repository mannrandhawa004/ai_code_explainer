import { describe, expect, it, vi } from "vitest";

import {
  RepositoryQuestionError,
  RepositoryQuestionService,
  repositoryQuestionNoContextAnswer,
  type RepositoryQuestionConversationGateway,
  type RepositoryQuestionRepositoryGateway,
  type RepositoryQuestionServiceDependencies,
} from "../src/services/repository-question.service.js";

const repository = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  fullName: "owner/repository",
  selectedBranch: "main",
  status: "ready",
  lastIndexedCommit: "abc123",
};

const embedding = {
  vector: [0.1, 0.2, 0.3, 0.4],
  model: "text-embedding-3-small",
  dimensions: 4,
  tokenCount: 8,
  inputHash: "a".repeat(64),
  usage: {
    promptTokens: 8,
    totalTokens: 8,
    requests: 1,
    uniqueInputs: 1,
  },
};

const chunk = {
  id: "11111111-1111-8111-8111-111111111111",
  score: 0.9,
  userId: repository.userId,
  repositoryId: repository.id,
  branch: "main",
  commitSha: "abc123",
  filePath: "src/auth.ts",
  language: "typescript",
  symbolType: "function",
  symbolName: "authenticate",
  startLine: 1,
  endLine: 3,
  chunkIndex: 0,
  contentHash: "b".repeat(64),
  content: "export function authenticate() {}",
};

const answerUsage = {
  inputTokens: 100,
  outputTokens: 25,
  reasoningTokens: 10,
  totalTokens: 125,
};

const answerSources = [
  {
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName,
  },
];

function createDependencies(
  overrides: Partial<RepositoryQuestionServiceDependencies> = {},
) {
  const repositories: RepositoryQuestionRepositoryGateway = {
    findOwnedRepository: vi.fn().mockResolvedValue(repository),
  };
  const conversations: RepositoryQuestionConversationGateway = {
    loadOwnedConversation: vi.fn().mockResolvedValue({
      id: "cccccccccccccccccccccccc",
      history: [{ role: "user", content: "Earlier question" }],
    }),
    persistExchange: vi.fn().mockResolvedValue({
      conversationId: "cccccccccccccccccccccccc",
      userMessageId: "dddddddddddddddddddddddd",
      assistantMessageId: "eeeeeeeeeeeeeeeeeeeeeeee",
    }),
  };
  const embedder = {
    embed: vi.fn().mockResolvedValue(embedding),
  };
  const retriever = {
    search: vi.fn().mockResolvedValue([chunk]),
    searchExactSymbol: vi.fn().mockResolvedValue([]),
  };
  const answerer = {
    generate: vi.fn().mockResolvedValue({
      answer:
        "Authentication uses the authenticate function. [src/auth.ts:L1-L3]",
      sources: answerSources,
      model: "gpt-5.6-sol",
      responseId: "response-1",
      usage: answerUsage,
    }),
  };
  const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_125);

  return {
    repositories,
    conversations,
    embedder,
    retriever,
    answerer,
    searchLimit: 15,
    now,
    ...overrides,
  } satisfies RepositoryQuestionServiceDependencies;
}

const questionInput = {
  authenticatedUserId: repository.userId,
  repositoryId: repository.id,
  question: "How does authentication work?",
  conversationId: "cccccccccccccccccccccccc",
};

describe("RepositoryQuestionService", () => {
  it("runs the owned, ready repository RAG pipeline and persists the exchange", async () => {
    const dependencies = createDependencies();
    const service = new RepositoryQuestionService(dependencies);

    await expect(service.ask(questionInput)).resolves.toEqual({
      repositoryId: repository.id,
      conversationId: "cccccccccccccccccccccccc",
      userMessageId: "dddddddddddddddddddddddd",
      assistantMessageId: "eeeeeeeeeeeeeeeeeeeeeeee",
      answer:
        "Authentication uses the authenticate function. [src/auth.ts:L1-L3]",
      sources: answerSources,
      category: "semantic",
      branch: "main",
      commitSha: "abc123",
      retrievedChunks: 1,
      embeddingModel: "text-embedding-3-small",
      model: "gpt-5.6-sol",
      providerResponseId: "response-1",
      usage: answerUsage,
      latencyMs: 125,
    });
    expect(dependencies.repositories.findOwnedRepository).toHaveBeenCalledWith(
      repository.id,
      repository.userId,
    );
    expect(dependencies.retriever.search).toHaveBeenCalledWith({
      vector: embedding.vector,
      userId: repository.userId,
      repositoryId: repository.id,
      branch: "main",
      commitSha: "abc123",
      limit: 15,
    });
    expect(dependencies.answerer.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryName: "owner/repository",
        history: [{ role: "user", content: "Earlier question" }],
        sources: [
          expect.objectContaining({
            id: chunk.id,
            filePath: "src/auth.ts",
            content: chunk.content,
          }),
        ],
      }),
    );
    expect(dependencies.conversations.persistExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedUserId: repository.userId,
        repositoryId: repository.id,
        answer:
          "Authentication uses the authenticate function. [src/auth.ts:L1-L3]",
        sources: answerSources,
        usage: answerUsage,
      }),
    );
  });

  it("checks repository ownership and readiness before provider work", async () => {
    const missingDependencies = createDependencies({
      repositories: { findOwnedRepository: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      new RepositoryQuestionService(missingDependencies).ask(questionInput),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    expect(missingDependencies.embedder.embed).not.toHaveBeenCalled();

    const pendingDependencies = createDependencies({
      repositories: {
        findOwnedRepository: vi
          .fn()
          .mockResolvedValue({ ...repository, status: "embedding" }),
      },
    });
    await expect(
      new RepositoryQuestionService(pendingDependencies).ask(questionInput),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_READY" });
    expect(pendingDependencies.embedder.embed).not.toHaveBeenCalled();
  });

  it("validates an existing conversation before provider work", async () => {
    const dependencies = createDependencies({
      conversations: {
        loadOwnedConversation: vi.fn().mockResolvedValue(null),
        persistExchange: vi.fn(),
      },
    });

    await expect(
      new RepositoryQuestionService(dependencies).ask(questionInput),
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    expect(dependencies.embedder.embed).not.toHaveBeenCalled();
  });

  it("returns a deterministic insufficient-context answer without a model call", async () => {
    const dependencies = createDependencies({
      retriever: {
        search: vi.fn().mockResolvedValue([]),
        searchExactSymbol: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new RepositoryQuestionService(dependencies);

    const result = await service.ask({
      authenticatedUserId: repository.userId,
      repositoryId: repository.id,
      question: questionInput.question,
    });

    expect(result.answer).toBe(repositoryQuestionNoContextAnswer);
    expect(result.retrievedChunks).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.model).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });
    expect(dependencies.answerer.generate).not.toHaveBeenCalled();
    expect(dependencies.conversations.persistExchange).toHaveBeenCalled();
    expect(dependencies.conversations.persistExchange).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [] }),
    );
  });

  it.each([
    [
      "EMBEDDING_FAILED",
      { embedder: { embed: vi.fn().mockRejectedValue(new Error("offline")) } },
    ],
    [
      "RETRIEVAL_FAILED",
      {
        retriever: {
          search: vi.fn().mockRejectedValue(new Error("offline")),
          searchExactSymbol: vi.fn().mockResolvedValue([]),
        },
      },
    ],
    [
      "ANSWER_GENERATION_FAILED",
      { answerer: { generate: vi.fn().mockRejectedValue(new Error("offline")) } },
    ],
    [
      "PERSISTENCE_FAILED",
      {
        conversations: {
          loadOwnedConversation: vi.fn().mockResolvedValue({
            id: "cccccccccccccccccccccccc",
            history: [],
          }),
          persistExchange: vi.fn().mockRejectedValue(new Error("offline")),
        },
      },
    ],
  ])("maps dependency failures to %s", async (code, override) => {
    const dependencies = createDependencies(
      override as Partial<RepositoryQuestionServiceDependencies>,
    );

    await expect(
      new RepositoryQuestionService(dependencies).ask(questionInput),
    ).rejects.toMatchObject({ code });
  });

  it("honors an already-aborted request", async () => {
    const dependencies = createDependencies();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new RepositoryQuestionService(dependencies).ask({
        ...questionInput,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RepositoryQuestionError);
    expect(dependencies.repositories.findOwnedRepository).not.toHaveBeenCalled();
  });

  it("prioritizes and deduplicates exact symbol matches", async () => {
    const semanticMatch = { ...chunk, score: 0.92 };
    const exactMatch = {
      ...chunk,
      score: 1,
      filePath: "src/middleware/authenticate.ts",
    };
    const dependencies = createDependencies({
      retriever: {
        search: vi.fn().mockResolvedValue([semanticMatch]),
        searchExactSymbol: vi.fn().mockResolvedValue([exactMatch]),
      },
    });

    await new RepositoryQuestionService(dependencies).ask({
      authenticatedUserId: repository.userId,
      repositoryId: repository.id,
      question: "Where is `authenticate` used?",
    });

    expect(dependencies.retriever.searchExactSymbol).toHaveBeenCalledWith({
      symbolName: "authenticate",
      userId: repository.userId,
      repositoryId: repository.id,
      branch: "main",
      commitSha: "abc123",
      limit: 15,
    });
    expect(dependencies.answerer.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "exact_symbol",
        sources: [
          expect.objectContaining({
            id: chunk.id,
            filePath: "src/middleware/authenticate.ts",
            score: 1,
          }),
        ],
      }),
    );
  });
});
