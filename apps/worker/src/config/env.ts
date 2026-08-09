import "dotenv/config";

import { z } from "zod";

const redisUrlSchema = z
  .url()
  .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
    message: "REDIS_URL must use the redis or rediss protocol",
  });

const optionalTrimmedString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

function usesSecureMongoTransport(value: string): boolean {
  if (value.toLowerCase().startsWith("mongodb+srv://")) {
    return true;
  }
  if (!value.toLowerCase().startsWith("mongodb://")) {
    return false;
  }
  const query = value.split("?", 2)[1];
  if (query === undefined) {
    return false;
  }
  const parameters = new URLSearchParams(query);
  return (
    parameters.get("tls")?.toLowerCase() === "true" ||
    parameters.get("ssl")?.toLowerCase() === "true"
  );
}

const workerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  MONGODB_URI: z
    .string()
    .min(1)
    .default("mongodb://localhost:27017/codebase_explainer"),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  REDIS_URL: redisUrlSchema.default("redis://localhost:6379"),
  QDRANT_URL: z.url().default("http://localhost:6333"),
  QDRANT_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  AI_PROVIDER: z.enum(["google", "openai", "ollama"]).default("google"),
  GOOGLE_API_KEY: optionalTrimmedString,
  GEMINI_API_KEY: optionalTrimmedString,
  GOOGLE_API_BASE_URL: z
    .url()
    .default("https://generativelanguage.googleapis.com/v1beta"),
  GOOGLE_EMBEDDING_MODEL: z.string().trim().min(1).default("gemini-embedding-2"),
  GOOGLE_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(768),
  GOOGLE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
  GOOGLE_EMBEDDING_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(16),
  GOOGLE_EMBEDDING_REQUEST_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  GOOGLE_EMBEDDING_MAX_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(8_192),
  GOOGLE_EMBEDDING_MAX_REQUEST_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(65_536),
  OPENAI_API_KEY: optionalTrimmedString,
  OPENAI_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(1_536),
  OLLAMA_URL: z.url().default("http://localhost:11434"),
  OLLAMA_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(1_024),
  QDRANT_COLLECTION: z.string().min(1).default("code_chunks"),
  QDRANT_VECTOR_SIZE: z.coerce.number().int().positive().default(768),
  QDRANT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  INDEXING_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  INDEXING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(1),
  GITHUB_WEBHOOK_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1),
  MAX_REPOSITORY_FILES: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  MAX_REPOSITORY_SIZE_MB: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  MAX_FILE_SIZE_KB: z.coerce.number().int().positive().default(500),
  TEMP_REPOSITORY_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
  GITHUB_APP_ID: optionalTrimmedString,
  GITHUB_PRIVATE_KEY: optionalTrimmedString.transform((value) =>
    value?.replaceAll("\\n", "\n"),
  ),
});

export type WorkerEnvironment = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): WorkerEnvironment {
  const result = workerEnvSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(
      `Invalid worker environment:\n${z.prettifyError(result.error)}`,
    );
  }

  const configuredGitHubValues = [
    result.data.GITHUB_APP_ID,
    result.data.GITHUB_PRIVATE_KEY,
  ].filter(Boolean).length;
  const selectedEmbeddingDimensions =
    result.data.AI_PROVIDER === "google"
      ? result.data.GOOGLE_EMBEDDING_DIMENSIONS
      : result.data.AI_PROVIDER === "ollama"
        ? result.data.OLLAMA_EMBEDDING_DIMENSIONS
        : result.data.OPENAI_EMBEDDING_DIMENSIONS;
  if (result.data.QDRANT_VECTOR_SIZE !== selectedEmbeddingDimensions) {
    throw new Error(
      `QDRANT_VECTOR_SIZE (${result.data.QDRANT_VECTOR_SIZE}) must match ${result.data.AI_PROVIDER} embedding dimensions (${selectedEmbeddingDimensions})`,
    );
  }
  if (configuredGitHubValues === 1) {
    throw new Error(
      "Private repository indexing requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY",
    );
  }
  if (result.data.NODE_ENV === "production") {
    if (!result.data.REDIS_URL.startsWith("rediss://")) {
      throw new Error("REDIS_URL must use TLS (rediss://) in production");
    }
    if (!usesSecureMongoTransport(result.data.MONGODB_URI)) {
      throw new Error("MONGODB_URI must use TLS in production");
    }
    if (!result.data.QDRANT_URL.startsWith("https://")) {
      throw new Error("QDRANT_URL must use HTTPS in production");
    }
    if (!result.data.QDRANT_API_KEY) {
      throw new Error("QDRANT_API_KEY must be configured in production");
    }
    if (
      result.data.AI_PROVIDER === "openai" &&
      !result.data.OPENAI_API_KEY
    ) {
      throw new Error("OPENAI_API_KEY must be configured in production");
    }
    if (
      result.data.AI_PROVIDER === "google" &&
      !result.data.GOOGLE_API_KEY &&
      !result.data.GEMINI_API_KEY
    ) {
      throw new Error(
        "GOOGLE_API_KEY or GEMINI_API_KEY must be configured in production",
      );
    }
    if (configuredGitHubValues !== 2) {
      throw new Error(
        "Private repository indexing must be configured in production",
      );
    }
  }

  return result.data;
}

export const env = parseWorkerEnvironment(process.env);
