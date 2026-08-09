import { APIConnectionTimeoutError, APIError } from "openai";

export type AIProviderName = "google" | "openai" | "ollama";

export type AIProviderErrorCode =
  | "INVALID_CONFIGURATION"
  | "AUTHENTICATION_FAILED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_NOT_FOUND"
  | "REQUEST_REJECTED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_RESPONSE";

export type AIProviderFailure = {
  provider: AIProviderName;
  code: AIProviderErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
};

export class AIProviderError extends Error {
  override readonly name = "AIProviderError";

  constructor(
    readonly provider: AIProviderName,
    readonly code: AIProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const quotaCodes = new Set([
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "insufficient_quota",
  "quota_exceeded",
]);
const authenticationCodes = new Set([
  "authentication_error",
  "invalid_api_key",
  "permission_denied",
]);
const modelCodes = new Set(["model_not_found"]);
const rateLimitCodes = new Set(["rate_limit_exceeded"]);

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function errorCause(value: unknown): unknown {
  return typeof value === "object" && value !== null && "cause" in value
    ? value.cause
    : undefined;
}

function structuralProviderFailure(
  error: unknown,
): AIProviderFailure | undefined {
  if (!(error instanceof APIError)) {
    return undefined;
  }

  const details = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  const code = safeString(details.code);
  const type = safeString(details.type);
  const statusCode =
    safeStatus(details.statusCode) ?? safeStatus(details.status);

  if (statusCode === undefined && !code && !type) {
    return {
      provider: "openai",
      code:
        error instanceof APIConnectionTimeoutError ? "TIMEOUT" : "UNAVAILABLE",
      message:
        error instanceof APIConnectionTimeoutError
          ? "The AI provider request timed out."
          : "The AI provider is temporarily unavailable.",
      retryable: true,
    };
  }

  if ((code && quotaCodes.has(code)) || (type && quotaCodes.has(type))) {
    return {
      provider: "openai",
      code: "QUOTA_EXHAUSTED",
      message:
        "The hosted AI provider has no available credits or quota. Configure Google Gemini's free tier, or update the provider account.",
      retryable: false,
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  if (
    (code && authenticationCodes.has(code)) ||
    (type && authenticationCodes.has(type)) ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return {
      provider: "openai",
      code: "AUTHENTICATION_FAILED",
      message:
        "AI provider authentication failed. Check the configured credentials.",
      retryable: false,
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  if (
    (code && modelCodes.has(code)) ||
    (type && modelCodes.has(type)) ||
    statusCode === 404
  ) {
    return {
      provider: "openai",
      code: "MODEL_NOT_FOUND",
      message:
        "The configured AI model is unavailable. Select an installed or accessible model.",
      retryable: false,
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  if (
    (code && rateLimitCodes.has(code)) ||
    (type && rateLimitCodes.has(type)) ||
    statusCode === 429
  ) {
    return {
      provider: "openai",
      code: "RATE_LIMITED",
      message: "The AI provider is temporarily rate limited.",
      retryable: true,
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  if (statusCode === 408 || statusCode === 425 || (statusCode ?? 0) >= 500) {
    return {
      provider: "openai",
      code: statusCode === 408 ? "TIMEOUT" : "UNAVAILABLE",
      message: "The AI provider is temporarily unavailable.",
      retryable: true,
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }

  if (statusCode !== undefined && statusCode >= 400) {
    return {
      provider: "openai",
      code: "REQUEST_REJECTED",
      message:
        "The AI provider rejected the request. Check the selected model and embedding dimensions.",
      retryable: false,
      statusCode,
    };
  }

  return undefined;
}

export function classifyAIProviderError(
  error: unknown,
): AIProviderFailure | undefined {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);

    if (current instanceof AIProviderError) {
      return {
        provider: current.provider,
        code: current.code,
        message: current.message,
        retryable: current.retryable,
        ...(current.statusCode === undefined
          ? {}
          : { statusCode: current.statusCode }),
      };
    }

    const classified = structuralProviderFailure(current);
    if (classified !== undefined) {
      return classified;
    }
    current = errorCause(current);
  }

  return undefined;
}
