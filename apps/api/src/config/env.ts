import "dotenv/config";

import { z } from "zod";

const optionalTrimmedString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

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

const result = envSchema.safeParse(process.env);

if (!result.success) {
  throw new Error(`Invalid API environment:\n${z.prettifyError(result.error)}`);
}

const parsedEnvironment = result.data;

if (
  parsedEnvironment.NODE_ENV === "production" &&
  !parsedEnvironment.REDIS_URL.startsWith("rediss://")
) {
  throw new Error("REDIS_URL must use TLS (rediss://) in production");
}

const githubRequiredValues = [
  parsedEnvironment.GITHUB_APP_ID,
  parsedEnvironment.GITHUB_CLIENT_ID,
  parsedEnvironment.GITHUB_CLIENT_SECRET,
  parsedEnvironment.GITHUB_PRIVATE_KEY,
  parsedEnvironment.JWT_SECRET,
  parsedEnvironment.ENCRYPTION_KEY,
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
  if (!/^\d+$/u.test(parsedEnvironment.GITHUB_APP_ID as string)) {
    throw new Error("GITHUB_APP_ID must contain only digits");
  }
  if ((parsedEnvironment.JWT_SECRET?.length ?? 0) < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters");
  }
  const encryptionKey = Buffer.from(
    parsedEnvironment.ENCRYPTION_KEY as string,
    "base64",
  );
  if (
    encryptionKey.length !== 32 ||
    encryptionKey.toString("base64") !== parsedEnvironment.ENCRYPTION_KEY
  ) {
    throw new Error("ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
}

if (
  parsedEnvironment.GITHUB_WEBHOOK_SECRET !== undefined &&
  parsedEnvironment.GITHUB_WEBHOOK_SECRET.length < 32
) {
  throw new Error("GITHUB_WEBHOOK_SECRET must contain at least 32 characters");
}

if (parsedEnvironment.NODE_ENV === "production") {
  if (configuredGitHubValues !== githubRequiredValues.length) {
    throw new Error("GitHub authentication must be configured in production");
  }
  if (!parsedEnvironment.FRONTEND_URL.startsWith("https://")) {
    throw new Error("FRONTEND_URL must use HTTPS in production");
  }
  if (!parsedEnvironment.GITHUB_CALLBACK_URL.startsWith("https://")) {
    throw new Error("GITHUB_CALLBACK_URL must use HTTPS in production");
  }
  if (!parsedEnvironment.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET must be configured in production");
  }
}

export const env = parsedEnvironment;

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
    appId: parsedEnvironment.GITHUB_APP_ID as string,
    clientId: parsedEnvironment.GITHUB_CLIENT_ID as string,
    clientSecret: parsedEnvironment.GITHUB_CLIENT_SECRET as string,
    privateKey: parsedEnvironment.GITHUB_PRIVATE_KEY as string,
    callbackUrl: parsedEnvironment.GITHUB_CALLBACK_URL,
    sessionSecret: parsedEnvironment.JWT_SECRET as string,
    sessionTtlSeconds: parsedEnvironment.JWT_EXPIRES_IN_SECONDS,
    sessionCookieName: parsedEnvironment.COOKIE_NAME,
    oauthStateCookieName: parsedEnvironment.OAUTH_STATE_COOKIE_NAME,
    oauthStateTtlSeconds: parsedEnvironment.OAUTH_STATE_TTL_SECONDS,
    encryptionKey: parsedEnvironment.ENCRYPTION_KEY as string,
    secureCookies: parsedEnvironment.NODE_ENV === "production",
    frontendUrl: parsedEnvironment.FRONTEND_URL,
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
  if (!parsedEnvironment.GITHUB_WEBHOOK_SECRET) {
    return undefined;
  }
  return {
    secret: parsedEnvironment.GITHUB_WEBHOOK_SECRET,
    bodyLimit: parsedEnvironment.GITHUB_WEBHOOK_BODY_LIMIT,
    enqueueTimeoutMs: parsedEnvironment.GITHUB_WEBHOOK_ENQUEUE_TIMEOUT_MS,
  };
}
