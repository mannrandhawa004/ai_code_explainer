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
  QDRANT_COLLECTION: z.string().min(1).default("code_chunks"),
  QDRANT_VECTOR_SIZE: z.coerce.number().int().positive().default(1_536),
  QDRANT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  INDEXING_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
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

  if (
    result.data.NODE_ENV === "production" &&
    !result.data.REDIS_URL.startsWith("rediss://")
  ) {
    throw new Error("REDIS_URL must use TLS (rediss://) in production");
  }

  const configuredGitHubValues = [
    result.data.GITHUB_APP_ID,
    result.data.GITHUB_PRIVATE_KEY,
  ].filter(Boolean).length;
  if (configuredGitHubValues === 1) {
    throw new Error(
      "Private repository indexing requires GITHUB_APP_ID and GITHUB_PRIVATE_KEY",
    );
  }
  if (result.data.NODE_ENV === "production" && configuredGitHubValues !== 2) {
    throw new Error(
      "Private repository indexing must be configured in production",
    );
  }

  return result.data;
}

export const env = parseWorkerEnvironment(process.env);
