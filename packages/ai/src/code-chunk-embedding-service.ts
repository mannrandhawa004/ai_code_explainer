import type { CodeChunk } from "@codebase-explainer/repository";

import {
  EmbeddingGenerator,
  createOpenAIEmbeddingGeneratorFromEnv,
  type EmbeddingGenerationOptions,
  type EmbeddingGenerationUsage,
} from "./embedding-generator.js";
import {
  formatCodeChunkForEmbedding,
  type CodeChunkEmbeddingTextOptions,
} from "./embedding-text.js";

export type CodeChunkEmbeddingOptions = EmbeddingGenerationOptions &
  CodeChunkEmbeddingTextOptions;

export type EmbeddedCodeChunk = {
  chunk: CodeChunk;
  embedding: number[];
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingTokenCount: number;
  embeddingInputHash: string;
};

export type CodeChunkEmbeddingResult = {
  items: EmbeddedCodeChunk[];
  model: string;
  dimensions: number;
  usage: EmbeddingGenerationUsage;
};

export class CodeChunkEmbeddingService {
  constructor(private readonly generator: EmbeddingGenerator) {}

  async embedChunks(
    chunks: readonly CodeChunk[],
    options: CodeChunkEmbeddingOptions = {},
  ): Promise<CodeChunkEmbeddingResult> {
    const generated = await this.generator.generate(
      chunks.map((chunk) => ({
        id: chunk.id,
        text: formatCodeChunkForEmbedding(chunk, {
          ...(options.repositoryLabel === undefined
            ? {}
            : { repositoryLabel: options.repositoryLabel }),
        }),
      })),
      {
        ...(options.endUserId === undefined
          ? {}
          : { endUserId: options.endUserId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    return {
      items: generated.embeddings.map((embedding, index) => ({
        chunk: chunks[index]!,
        embedding: embedding.vector,
        embeddingModel: embedding.model,
        embeddingDimensions: embedding.dimensions,
        embeddingTokenCount: embedding.tokenCount,
        embeddingInputHash: embedding.inputHash,
      })),
      model: generated.model,
      dimensions: generated.dimensions,
      usage: generated.usage,
    };
  }
}

export function createOpenAICodeChunkEmbeddingServiceFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): CodeChunkEmbeddingService {
  return new CodeChunkEmbeddingService(
    createOpenAIEmbeddingGeneratorFromEnv(environment),
  );
}
