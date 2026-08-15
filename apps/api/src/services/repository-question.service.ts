import {
  ConversationModel,
  MessageModel,
  RepositoryModel,
} from "@codebase-explainer/database";
import {
  classifyRepositoryQuestion,
  createQuestionEmbeddingServiceFromEnv,
  createRepositoryAnswerGeneratorFromEnv,
  extractExactSymbolName,
  type AnswerTokenUsage,
  type QuestionEmbedding,
  type RepositoryAnswerCitation,
  type RepositoryAnswerResult,
  type RepositoryAnswerSource,
  type RepositoryConversationMessage,
  type RepositoryQuestionCategory,
} from "@codebase-explainer/ai";
import {
  QdrantCodeChunkSearch,
  type CodeChunkSearchResult,
} from "@codebase-explainer/vector-store";

import { env } from "../config/env.js";
import { vectorStoreConfig } from "../config/vector-store.js";
import {
  getDefaultApiMetrics,
  type ApiAiOperation,
  type ApiDependency,
  type ApiMetricsObserver,
} from "../observability/api-metrics.js";

export const repositoryQuestionNoContextAnswer =
  "I could not find enough relevant evidence in the indexed repository to answer that question.";

export type RepositoryQuestionInput = {
  authenticatedUserId: string;
  repositoryId: string;
  question: string;
  conversationId?: string;
  signal?: AbortSignal;
};

export type RepositoryQuestionResult = {
  repositoryId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  answer: string;
  sources: RepositoryAnswerCitation[];
  category: RepositoryQuestionCategory;
  branch: string;
  commitSha: string;
  retrievedChunks: number;
  embeddingModel: string;
  model?: string;
  providerResponseId?: string;
  usage: AnswerTokenUsage;
  latencyMs: number;
};

export interface RepositoryQuestionServiceContract {
  ask(input: RepositoryQuestionInput): Promise<RepositoryQuestionResult>;
}

export type RepositoryQuestionRecord = {
  id: string;
  userId: string;
  fullName: string;
  selectedBranch: string;
  status: string;
  lastIndexedCommit?: string;
};

export type LoadedConversation = {
  id: string;
  history: RepositoryConversationMessage[];
};

export type PersistQuestionExchangeInput = {
  conversationId?: string;
  authenticatedUserId: string;
  repositoryId: string;
  branch: string;
  question: string;
  answer: string;
  sources: readonly RepositoryAnswerCitation[];
  model?: string;
  providerResponseId?: string;
  usage: AnswerTokenUsage;
  latencyMs: number;
};

export type PersistQuestionExchangeResult = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
};

export interface RepositoryQuestionRepositoryGateway {
  findOwnedRepository(
    repositoryId: string,
    authenticatedUserId: string,
  ): Promise<RepositoryQuestionRecord | null>;
}

export interface RepositoryQuestionConversationGateway {
  loadOwnedConversation(input: {
    conversationId: string;
    authenticatedUserId: string;
    repositoryId: string;
    branch: string;
  }): Promise<LoadedConversation | null>;
  persistExchange(
    input: PersistQuestionExchangeInput,
  ): Promise<PersistQuestionExchangeResult>;
}

export interface RepositoryQuestionEmbedder {
  embed(
    question: string,
    options?: { endUserId?: string; signal?: AbortSignal },
  ): Promise<QuestionEmbedding>;
}

export interface RepositoryQuestionRetriever {
  search(input: {
    vector: readonly number[];
    userId: string;
    repositoryId: string;
    branch: string;
    commitSha: string;
    limit?: number;
    scoreThreshold?: number;
    signal?: AbortSignal;
  }): Promise<CodeChunkSearchResult[]>;
  searchExactSymbol(input: {
    symbolName: string;
    userId: string;
    repositoryId: string;
    branch: string;
    commitSha: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<CodeChunkSearchResult[]>;
}

export interface RepositoryQuestionAnswerer {
  generate(input: {
    userId: string;
    repositoryName: string;
    branch: string;
    commitSha: string;
    question: string;
    category: RepositoryQuestionCategory;
    sources: readonly RepositoryAnswerSource[];
    history?: readonly RepositoryConversationMessage[];
    signal?: AbortSignal;
  }): Promise<RepositoryAnswerResult>;
}

export type RepositoryQuestionServiceDependencies = {
  repositories: RepositoryQuestionRepositoryGateway;
  conversations: RepositoryQuestionConversationGateway;
  embedder: RepositoryQuestionEmbedder;
  retriever: RepositoryQuestionRetriever;
  answerer: RepositoryQuestionAnswerer;
  searchLimit?: number;
  scoreThreshold?: number;
  now?: () => number;
  metrics?: ApiMetricsObserver;
};

export type RepositoryQuestionErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_ACCESS_FAILED"
  | "REPOSITORY_NOT_READY"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_ACCESS_FAILED"
  | "EMBEDDING_FAILED"
  | "RETRIEVAL_FAILED"
  | "ANSWER_GENERATION_FAILED"
  | "PERSISTENCE_FAILED"
  | "QUESTION_ABORTED";

export class RepositoryQuestionError extends Error {
  override readonly name = "RepositoryQuestionError";

  constructor(
    readonly code: RepositoryQuestionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepositoryQuestionError(
      "QUESTION_ABORTED",
      "The repository question request was cancelled",
      { cause: signal.reason },
    );
  }
}

function toAnswerSource(result: CodeChunkSearchResult): RepositoryAnswerSource {
  return {
    id: result.id,
    score: result.score,
    filePath: result.filePath,
    language: result.language,
    ...(result.symbolType === undefined
      ? {}
      : { symbolType: result.symbolType }),
    ...(result.symbolName === undefined
      ? {}
      : { symbolName: result.symbolName }),
    startLine: result.startLine,
    endLine: result.endLine,
    content: result.content,
  };
}

function mergeRetrievedChunks(
  exactMatches: readonly CodeChunkSearchResult[],
  semanticMatches: readonly CodeChunkSearchResult[],
  limit: number | undefined,
): CodeChunkSearchResult[] {
  const merged = new Map<string, CodeChunkSearchResult>();
  for (const chunk of exactMatches) {
    merged.set(chunk.id, { ...chunk, score: 1 });
  }
  for (const chunk of semanticMatches) {
    if (!merged.has(chunk.id)) {
      merged.set(chunk.id, chunk);
    }
  }
  const results = [...merged.values()];
  return limit === undefined ? results : results.slice(0, limit);
}

const emptyAnswerUsage: AnswerTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export class RepositoryQuestionService
  implements RepositoryQuestionServiceContract
{
  private readonly now: () => number;

  constructor(private readonly dependencies: RepositoryQuestionServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async ask(input: RepositoryQuestionInput): Promise<RepositoryQuestionResult> {
    const question = input.question.trim();
    if (!question || question.includes("\0")) {
      throw new RepositoryQuestionError(
        "INVALID_REQUEST",
        "Question must be a non-empty string without null bytes",
      );
    }
    assertNotAborted(input.signal);
    const startedAt = this.now();

    let repository: RepositoryQuestionRecord | null;
    try {
      repository = await this.observeDependency(
        "mongodb",
        "repository_lookup",
        () =>
          this.dependencies.repositories.findOwnedRepository(
            input.repositoryId,
            input.authenticatedUserId,
          ),
      );
    } catch (error) {
      throw new RepositoryQuestionError(
        "REPOSITORY_ACCESS_FAILED",
        "The repository could not be accessed",
        { cause: error },
      );
    }
    if (!repository) {
      throw new RepositoryQuestionError(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found",
      );
    }
    if (repository.status !== "ready" || !repository.lastIndexedCommit) {
      throw new RepositoryQuestionError(
        "REPOSITORY_NOT_READY",
        "Repository indexing is not complete",
      );
    }
    const indexedCommit = repository.lastIndexedCommit;

    let loadedConversation: LoadedConversation | undefined;
    if (input.conversationId !== undefined) {
      try {
        loadedConversation =
          (await this.observeDependency(
            "mongodb",
            "conversation_load",
            () =>
              this.dependencies.conversations.loadOwnedConversation({
                conversationId: input.conversationId as string,
                authenticatedUserId: input.authenticatedUserId,
                repositoryId: repository.id,
                branch: repository.selectedBranch,
              }),
          )) ?? undefined;
      } catch (error) {
        throw new RepositoryQuestionError(
          "CONVERSATION_ACCESS_FAILED",
          "The conversation could not be accessed",
          { cause: error },
        );
      }
      if (!loadedConversation) {
        throw new RepositoryQuestionError(
          "CONVERSATION_NOT_FOUND",
          "Conversation was not found",
        );
      }
    }

    const category = classifyRepositoryQuestion(question);
    let embedding: QuestionEmbedding;
    try {
      embedding = await this.observeAi(
        "embedding",
        () =>
          this.dependencies.embedder.embed(question, {
            endUserId: input.authenticatedUserId,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
        (result) => ({
          embeddingRequests: result.usage.requests,
          embeddingTokens: result.usage.totalTokens,
        }),
      );
    } catch (error) {
      assertNotAborted(input.signal);
      throw new RepositoryQuestionError(
        "EMBEDDING_FAILED",
        "The repository question could not be embedded",
        { cause: error },
      );
    }

    let chunks: CodeChunkSearchResult[];
    try {
      const repositoryScope = {
        userId: repository.userId,
        repositoryId: repository.id,
        branch: repository.selectedBranch,
        commitSha: indexedCommit,
        ...(this.dependencies.searchLimit === undefined
          ? {}
          : { limit: this.dependencies.searchLimit }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };
      chunks = await this.observeDependency("qdrant", "retrieval", async () => {
        const semanticSearch = this.dependencies.retriever.search({
          vector: embedding.vector,
          ...repositoryScope,
          ...(this.dependencies.scoreThreshold === undefined
            ? {}
            : { scoreThreshold: this.dependencies.scoreThreshold }),
        });
        const exactSymbolName =
          category === "exact_symbol"
            ? extractExactSymbolName(question)
            : undefined;
        if (exactSymbolName === undefined) {
          return semanticSearch;
        }
        const [semanticMatches, exactMatches] = await Promise.all([
          semanticSearch,
          this.dependencies.retriever.searchExactSymbol({
            symbolName: exactSymbolName,
            ...repositoryScope,
          }),
        ]);
        return mergeRetrievedChunks(
          exactMatches,
          semanticMatches,
          this.dependencies.searchLimit,
        );
      });
    } catch (error) {
      assertNotAborted(input.signal);
      throw new RepositoryQuestionError(
        "RETRIEVAL_FAILED",
        "Relevant repository context could not be retrieved",
        { cause: error },
      );
    }

    let answer = repositoryQuestionNoContextAnswer;
    let sources: RepositoryAnswerCitation[] = [];
    let model: string | undefined;
    let providerResponseId: string | undefined;
    let usage = emptyAnswerUsage;

    if (chunks.length > 0) {
      try {
        const generated = await this.observeAi(
          "generation",
          () =>
            this.dependencies.answerer.generate({
              userId: repository.userId,
              repositoryName: repository.fullName,
              branch: repository.selectedBranch,
              commitSha: indexedCommit,
              question,
              category,
              sources: chunks.map(toAnswerSource),
              ...(loadedConversation === undefined
                ? {}
                : { history: loadedConversation.history }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            }),
          (result) => ({ answerUsage: result.usage }),
        );
        answer = generated.answer;
        sources = generated.sources;
        model = generated.model;
        providerResponseId = generated.responseId;
        usage = generated.usage;
      } catch (error) {
        assertNotAborted(input.signal);
        throw new RepositoryQuestionError(
          "ANSWER_GENERATION_FAILED",
          "A grounded repository answer could not be generated",
          { cause: error },
        );
      }
    }

    assertNotAborted(input.signal);
    const latencyMs = Math.max(0, this.now() - startedAt);
    let persisted: PersistQuestionExchangeResult;
    try {
      persisted = await this.observeDependency(
        "mongodb",
        "conversation_persist",
        () =>
          this.dependencies.conversations.persistExchange({
            ...(loadedConversation === undefined
              ? {}
              : { conversationId: loadedConversation.id }),
            authenticatedUserId: input.authenticatedUserId,
            repositoryId: repository.id,
            branch: repository.selectedBranch,
            question,
            answer,
            sources,
            ...(model === undefined ? {} : { model }),
            ...(providerResponseId === undefined
              ? {}
              : { providerResponseId }),
            usage,
            latencyMs,
          }),
      );
    } catch (error) {
      throw new RepositoryQuestionError(
        "PERSISTENCE_FAILED",
        "The repository conversation could not be saved",
        { cause: error },
      );
    }

    return {
      repositoryId: repository.id,
      conversationId: persisted.conversationId,
      userMessageId: persisted.userMessageId,
      assistantMessageId: persisted.assistantMessageId,
      answer,
      sources,
      category,
      branch: repository.selectedBranch,
      commitSha: indexedCommit,
      retrievedChunks: chunks.length,
      embeddingModel: embedding.model,
      ...(model === undefined ? {} : { model }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
      usage,
      latencyMs,
    };
  }

  private async observeDependency<Result>(
    dependency: ApiDependency,
    operation: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    if (this.dependencies.metrics === undefined) {
      return action();
    }
    const startedAt = performance.now();
    try {
      const result = await action();
      this.reportMetric(() =>
        this.dependencies.metrics?.observeDependency({
          dependency,
          operation,
          outcome: "success",
          durationSeconds: (performance.now() - startedAt) / 1_000,
        }),
      );
      return result;
    } catch (error) {
      this.reportMetric(() =>
        this.dependencies.metrics?.observeDependency({
          dependency,
          operation,
          outcome: "failure",
          durationSeconds: (performance.now() - startedAt) / 1_000,
        }),
      );
      throw error;
    }
  }

  private async observeAi<Result>(
    operation: ApiAiOperation,
    action: () => Promise<Result>,
    usage: (result: Result) =>
      | {
          embeddingRequests?: number;
          embeddingTokens?: number;
          answerUsage?: AnswerTokenUsage;
        }
      | undefined,
  ): Promise<Result> {
    if (this.dependencies.metrics === undefined) {
      return action();
    }
    const startedAt = performance.now();
    try {
      const result = await action();
      this.reportMetric(() =>
        this.dependencies.metrics?.observeAi({
          operation,
          outcome: "success",
          durationSeconds: (performance.now() - startedAt) / 1_000,
          ...usage(result),
        }),
      );
      return result;
    } catch (error) {
      this.reportMetric(() =>
        this.dependencies.metrics?.observeAi({
          operation,
          outcome: "failure",
          durationSeconds: (performance.now() - startedAt) / 1_000,
        }),
      );
      throw error;
    }
  }

  private reportMetric(report: () => void): void {
    try {
      report();
    } catch {
      // Observability must never break the user-facing request path.
    }
  }
}

export class MongooseRepositoryQuestionGateway
  implements RepositoryQuestionRepositoryGateway
{
  async findOwnedRepository(
    repositoryId: string,
    authenticatedUserId: string,
  ): Promise<RepositoryQuestionRecord | null> {
    const repository = await RepositoryModel.findOne({
      _id: repositoryId,
      userId: authenticatedUserId,
    }).exec();
    if (!repository) {
      return null;
    }

    return {
      id: repository.id,
      userId: repository.userId.toString(),
      fullName: repository.fullName,
      selectedBranch: repository.selectedBranch,
      status: repository.status,
      ...(repository.lastIndexedCommit === undefined
        ? {}
        : { lastIndexedCommit: repository.lastIndexedCommit }),
    };
  }
}

export class MongooseRepositoryQuestionConversationGateway
  implements RepositoryQuestionConversationGateway
{
  async loadOwnedConversation(input: {
    conversationId: string;
    authenticatedUserId: string;
    repositoryId: string;
    branch: string;
  }): Promise<LoadedConversation | null> {
    const conversation = await ConversationModel.findOne({
      _id: input.conversationId,
      userId: input.authenticatedUserId,
      repositoryId: input.repositoryId,
      branch: input.branch,
    }).exec();
    if (!conversation) {
      return null;
    }

    const recentMessages = await MessageModel.find({
      conversationId: conversation._id,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();

    return {
      id: conversation.id,
      history: recentMessages.reverse().map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
  }

  async persistExchange(
    input: PersistQuestionExchangeInput,
  ): Promise<PersistQuestionExchangeResult> {
    let conversationId = input.conversationId;
    let createdConversationId: string | undefined;

    if (conversationId === undefined) {
      const conversation = await ConversationModel.create({
        userId: input.authenticatedUserId,
        repositoryId: input.repositoryId,
        title: input.question.slice(0, 200),
        branch: input.branch,
      });
      conversationId = conversation.id;
      createdConversationId = conversation.id;
    } else {
      const exists = await ConversationModel.exists({
        _id: conversationId,
        userId: input.authenticatedUserId,
        repositoryId: input.repositoryId,
        branch: input.branch,
      });
      if (!exists) {
        throw new Error("Conversation no longer exists");
      }
    }

    try {
      const messages = await MessageModel.insertMany([
        {
          conversationId,
          role: "user",
          content: input.question,
          sources: [],
        },
        {
          conversationId,
          role: "assistant",
          content: input.answer,
          sources: input.sources,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.providerResponseId === undefined
            ? {}
            : { providerResponseId: input.providerResponseId }),
          tokenUsage: input.usage,
          latencyMs: input.latencyMs,
        },
      ]);
      await ConversationModel.updateOne(
        { _id: conversationId },
        { $set: { updatedAt: new Date() } },
      ).exec();

      return {
        conversationId,
        userMessageId: messages[0]!.id,
        assistantMessageId: messages[1]!.id,
      };
    } catch (error) {
      if (createdConversationId !== undefined) {
        await ConversationModel.deleteOne({
          _id: createdConversationId,
        }).catch(() => undefined);
      }
      throw error;
    }
  }
}

let defaultRepositoryQuestionService:
  | RepositoryQuestionService
  | undefined;

export function getDefaultRepositoryQuestionService(): RepositoryQuestionService {
  defaultRepositoryQuestionService ??= new RepositoryQuestionService({
    repositories: new MongooseRepositoryQuestionGateway(),
    conversations: new MongooseRepositoryQuestionConversationGateway(),
    embedder: createQuestionEmbeddingServiceFromEnv(process.env),
    retriever: new QdrantCodeChunkSearch(vectorStoreConfig),
    answerer: createRepositoryAnswerGeneratorFromEnv(process.env),
    metrics: getDefaultApiMetrics(),
    searchLimit: env.QUESTION_SEARCH_LIMIT,
    ...(env.QUESTION_SCORE_THRESHOLD === undefined
      ? {}
      : { scoreThreshold: env.QUESTION_SCORE_THRESHOLD }),
  });
  return defaultRepositoryQuestionService;
}
