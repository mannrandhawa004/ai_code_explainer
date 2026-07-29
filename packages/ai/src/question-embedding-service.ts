import { createHash } from "node:crypto";

import {
  EmbeddingGenerationError,
  EmbeddingGenerator,
  createOpenAIEmbeddingGeneratorFromEnv,
  type EmbeddingGenerationOptions,
  type EmbeddingGenerationUsage,
} from "./embedding-generator.js";

export const maximumRepositoryQuestionCharacters = 4_000;

export type QuestionEmbedding = {
  vector: number[];
  model: string;
  dimensions: number;
  tokenCount: number;
  inputHash: string;
  usage: EmbeddingGenerationUsage;
};

export class QuestionEmbeddingService {
  constructor(private readonly generator: EmbeddingGenerator) {}

  async embed(
    question: string,
    options: EmbeddingGenerationOptions = {},
  ): Promise<QuestionEmbedding> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || normalizedQuestion.includes("\0")) {
      throw new EmbeddingGenerationError(
        "INVALID_INPUT",
        "Question must be a non-empty string without null bytes",
      );
    }
    if (normalizedQuestion.length > maximumRepositoryQuestionCharacters) {
      throw new EmbeddingGenerationError(
        "INVALID_INPUT",
        `Question cannot exceed ${maximumRepositoryQuestionCharacters} characters`,
      );
    }

    const questionId = createHash("sha256")
      .update(normalizedQuestion, "utf8")
      .digest("hex");
    const result = await this.generator.generate(
      [{ id: questionId, text: normalizedQuestion }],
      options,
    );
    const embedding = result.embeddings[0];

    if (!embedding) {
      throw new EmbeddingGenerationError(
        "RESPONSE_COUNT_MISMATCH",
        "Embedding provider did not return a question vector",
        questionId,
      );
    }

    return {
      vector: embedding.vector,
      model: embedding.model,
      dimensions: embedding.dimensions,
      tokenCount: embedding.tokenCount,
      inputHash: embedding.inputHash,
      usage: result.usage,
    };
  }
}

export function createOpenAIQuestionEmbeddingServiceFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): QuestionEmbeddingService {
  return new QuestionEmbeddingService(
    createOpenAIEmbeddingGeneratorFromEnv(environment),
  );
}
