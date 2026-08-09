import { CodeChunkEmbeddingService } from "./code-chunk-embedding-service.js";
import {
  createOpenAIEmbeddingGeneratorFromEnv,
  type EmbeddingGenerator,
} from "./embedding-generator.js";
import {
  createOllamaEmbeddingGeneratorFromEnv,
  createOllamaRepositoryAnswerGeneratorFromEnv,
} from "./ollama-provider.js";
import {
  createGoogleEmbeddingGeneratorFromEnv,
  createGoogleRepositoryAnswerGeneratorFromEnv,
  type GoogleEmbeddingPurpose,
} from "./google-provider.js";
import { AIProviderError, type AIProviderName } from "./provider-error.js";
import { QuestionEmbeddingService } from "./question-embedding-service.js";
import {
  createOpenAIRepositoryAnswerGeneratorFromEnv,
  type RepositoryAnswerGenerator,
} from "./repository-answer-generator.js";

export const defaultAIProvider: AIProviderName = "google";

export function resolveAIProvider(
  environment: NodeJS.ProcessEnv = process.env,
): AIProviderName {
  const value = environment.AI_PROVIDER?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return defaultAIProvider;
  }
  if (value === "google" || value === "openai" || value === "ollama") {
    return value;
  }
  throw new AIProviderError(
    "google",
    "INVALID_CONFIGURATION",
    "AI_PROVIDER must be google, openai, or ollama",
    false,
  );
}

export function createEmbeddingGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  purpose: GoogleEmbeddingPurpose = "document",
): EmbeddingGenerator {
  const provider = resolveAIProvider(environment);
  if (provider === "google") {
    return createGoogleEmbeddingGeneratorFromEnv(environment, purpose);
  }
  return provider === "ollama"
    ? createOllamaEmbeddingGeneratorFromEnv(environment)
    : createOpenAIEmbeddingGeneratorFromEnv(environment);
}

export function createCodeChunkEmbeddingServiceFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): CodeChunkEmbeddingService {
  return new CodeChunkEmbeddingService(
    createEmbeddingGeneratorFromEnv(environment, "document"),
  );
}

export function createQuestionEmbeddingServiceFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): QuestionEmbeddingService {
  return new QuestionEmbeddingService(
    createEmbeddingGeneratorFromEnv(environment, "query"),
  );
}

export function createRepositoryAnswerGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryAnswerGenerator {
  const provider = resolveAIProvider(environment);
  if (provider === "google") {
    return createGoogleRepositoryAnswerGeneratorFromEnv(environment);
  }
  return provider === "ollama"
    ? createOllamaRepositoryAnswerGeneratorFromEnv(environment)
    : createOpenAIRepositoryAnswerGeneratorFromEnv(environment);
}
