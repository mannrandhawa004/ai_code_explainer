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

export const env = result.data;
