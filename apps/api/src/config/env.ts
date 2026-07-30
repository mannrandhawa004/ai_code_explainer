import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(5_000),
  FRONTEND_URL: z.url().default("http://localhost:3000"),
  MONGODB_URI: z
    .string()
    .min(1)
    .default("mongodb://localhost:27017/codebase_explainer"),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
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
    .default(5_000),
  REDIS_URL: z
    .url()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      { message: "REDIS_URL must use the redis or rediss protocol" },
    )
    .default("redis://localhost:6379"),
  QUESTION_SEARCH_LIMIT: z.coerce.number().int().min(1).max(50).default(15),
  QUESTION_SCORE_THRESHOLD: z.preprocess(
    (value) =>
      typeof value === "string" && !value.trim() ? undefined : value,
    z.coerce.number().finite().optional(),
  ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  API_JSON_LIMIT: z.string().min(1).default("1mb"),
  API_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1_000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  throw new Error(`Invalid API environment:\n${z.prettifyError(result.error)}`);
}

if (
  result.data.NODE_ENV === "production" &&
  !result.data.REDIS_URL.startsWith("rediss://")
) {
  throw new Error("REDIS_URL must use TLS (rediss://) in production");
}

export const env = result.data;
