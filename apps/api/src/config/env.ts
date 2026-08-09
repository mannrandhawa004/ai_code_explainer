import "dotenv/config";

import { z } from "zod";

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
  GOOGLE_CHAT_MODEL: z.string().trim().min(1).default("gemini-2.5-flash-lite"),
  GOOGLE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
  GOOGLE_ANSWER_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_000),
  GOOGLE_MAX_CONTEXT_CHARACTERS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  GOOGLE_MAX_HISTORY_CHARACTERS: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
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
  INDEXING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(1),
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
  GITHUB_APP_ID: optionalTrimmedString,
  GITHUB_CLIENT_ID: optionalTrimmedString,
  GITHUB_CLIENT_SECRET: optionalTrimmedString,
  GITHUB_PRIVATE_KEY: optionalTrimmedString.transform((value) =>
    value?.replaceAll("\\n", "\n"),
  ),
  GITHUB_WEBHOOK_SECRET: optionalTrimmedString,
  GITHUB_WEBHOOK_BODY_LIMIT: z.string().trim().min(1).default("5mb"),
  GITHUB_WEBHOOK_ENQUEUE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(8_000)
    .default(5_000),
  GITHUB_CALLBACK_URL: z
    .url()
    .default("http://localhost:5000/api/auth/github/callback"),
  JWT_SECRET: optionalTrimmedString,
  JWT_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(30 * 24 * 60 * 60)
    .default(7 * 24 * 60 * 60),
  COOKIE_NAME: z.string().trim().min(1).max(100).default("codebase_explainer_session"),
  OAUTH_STATE_COOKIE_NAME: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default("codebase_explainer_oauth_state"),
  OAUTH_STATE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(15 * 60)
    .default(10 * 60),
  ENCRYPTION_KEY: optionalTrimmedString,
});

export type ApiEnvironment = z.infer<typeof envSchema>;

export function parseApiEnvironment(
  environment: NodeJS.ProcessEnv,
): ApiEnvironment {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`Invalid API environment:\n${z.prettifyError(result.error)}`);
  }

  const parsed = result.data;
  const selectedEmbeddingDimensions =
    parsed.AI_PROVIDER === "google"
      ? parsed.GOOGLE_EMBEDDING_DIMENSIONS
      : parsed.AI_PROVIDER === "ollama"
        ? parsed.OLLAMA_EMBEDDING_DIMENSIONS
        : parsed.OPENAI_EMBEDDING_DIMENSIONS;
  if (parsed.QDRANT_VECTOR_SIZE !== selectedEmbeddingDimensions) {
    throw new Error(
      `QDRANT_VECTOR_SIZE (${parsed.QDRANT_VECTOR_SIZE}) must match ${parsed.AI_PROVIDER} embedding dimensions (${selectedEmbeddingDimensions})`,
    );
  }
  const githubRequiredValues = [
    parsed.GITHUB_APP_ID,
    parsed.GITHUB_CLIENT_ID,
    parsed.GITHUB_CLIENT_SECRET,
    parsed.GITHUB_PRIVATE_KEY,
    parsed.JWT_SECRET,
    parsed.ENCRYPTION_KEY,
  ];
  const configuredGitHubValues = githubRequiredValues.filter(Boolean).length;

  if (
    configuredGitHubValues !== 0 &&
    configuredGitHubValues !== githubRequiredValues.length
  ) {
    throw new Error(
      "GitHub authentication requires GITHUB_APP_ID, GITHUB_CLIENT_ID, " +
        "GITHUB_CLIENT_SECRET, GITHUB_PRIVATE_KEY, JWT_SECRET, and ENCRYPTION_KEY",
    );
  }

  if (configuredGitHubValues === githubRequiredValues.length) {
    if (!/^\d+$/u.test(parsed.GITHUB_APP_ID as string)) {
      throw new Error("GITHUB_APP_ID must contain only digits");
    }
    if ((parsed.JWT_SECRET?.length ?? 0) < 32) {
      throw new Error("JWT_SECRET must contain at least 32 characters");
    }
    const encryptionKey = Buffer.from(
      parsed.ENCRYPTION_KEY as string,
      "base64",
    );
    if (
      encryptionKey.length !== 32 ||
      encryptionKey.toString("base64") !== parsed.ENCRYPTION_KEY
    ) {
      throw new Error("ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
  }

  if (
    parsed.GITHUB_WEBHOOK_SECRET !== undefined &&
    parsed.GITHUB_WEBHOOK_SECRET.length < 32
  ) {
    throw new Error("GITHUB_WEBHOOK_SECRET must contain at least 32 characters");
  }

  if (parsed.NODE_ENV === "production") {
    if (!parsed.REDIS_URL.startsWith("rediss://")) {
      throw new Error("REDIS_URL must use TLS (rediss://) in production");
    }
    if (!usesSecureMongoTransport(parsed.MONGODB_URI)) {
      throw new Error("MONGODB_URI must use TLS in production");
    }
    if (!parsed.QDRANT_URL.startsWith("https://")) {
      throw new Error("QDRANT_URL must use HTTPS in production");
    }
    if (!parsed.QDRANT_API_KEY) {
      throw new Error("QDRANT_API_KEY must be configured in production");
    }
    if (parsed.AI_PROVIDER === "openai" && !parsed.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY must be configured in production");
    }
    if (
      parsed.AI_PROVIDER === "google" &&
      !parsed.GOOGLE_API_KEY &&
      !parsed.GEMINI_API_KEY
    ) {
      throw new Error(
        "GOOGLE_API_KEY or GEMINI_API_KEY must be configured in production",
      );
    }
    if (configuredGitHubValues !== githubRequiredValues.length) {
      throw new Error("GitHub authentication must be configured in production");
    }
    if (!parsed.FRONTEND_URL.startsWith("https://")) {
      throw new Error("FRONTEND_URL must use HTTPS in production");
    }
    if (!parsed.GITHUB_CALLBACK_URL.startsWith("https://")) {
      throw new Error("GITHUB_CALLBACK_URL must use HTTPS in production");
    }
    if (!parsed.GITHUB_WEBHOOK_SECRET) {
      throw new Error("GITHUB_WEBHOOK_SECRET must be configured in production");
    }
  }

  return parsed;
}

export const env = parseApiEnvironment(process.env);
const configuredGitHubValues = [
  env.GITHUB_APP_ID,
  env.GITHUB_CLIENT_ID,
  env.GITHUB_CLIENT_SECRET,
  env.GITHUB_PRIVATE_KEY,
  env.JWT_SECRET,
  env.ENCRYPTION_KEY,
].filter(Boolean).length;

export type GitHubAuthenticationConfiguration = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  callbackUrl: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  sessionCookieName: string;
  oauthStateCookieName: string;
  oauthStateTtlSeconds: number;
  encryptionKey: string;
  secureCookies: boolean;
  frontendUrl: string;
};

export function getGitHubAuthenticationConfiguration():
  | GitHubAuthenticationConfiguration
  | undefined {
  if (configuredGitHubValues === 0) {
    return undefined;
  }

  return {
    appId: env.GITHUB_APP_ID as string,
    clientId: env.GITHUB_CLIENT_ID as string,
    clientSecret: env.GITHUB_CLIENT_SECRET as string,
    privateKey: env.GITHUB_PRIVATE_KEY as string,
    callbackUrl: env.GITHUB_CALLBACK_URL,
    sessionSecret: env.JWT_SECRET as string,
    sessionTtlSeconds: env.JWT_EXPIRES_IN_SECONDS,
    sessionCookieName: env.COOKIE_NAME,
    oauthStateCookieName: env.OAUTH_STATE_COOKIE_NAME,
    oauthStateTtlSeconds: env.OAUTH_STATE_TTL_SECONDS,
    encryptionKey: env.ENCRYPTION_KEY as string,
    secureCookies: env.NODE_ENV === "production",
    frontendUrl: env.FRONTEND_URL,
  };
}

export type GitHubWebhookConfiguration = {
  secret: string;
  bodyLimit: string;
  enqueueTimeoutMs: number;
};

export function getGitHubWebhookConfiguration():
  | GitHubWebhookConfiguration
  | undefined {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return undefined;
  }
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    bodyLimit: env.GITHUB_WEBHOOK_BODY_LIMIT,
    enqueueTimeoutMs: env.GITHUB_WEBHOOK_ENQUEUE_TIMEOUT_MS,
  };
}
