import type { ErrorRequestHandler } from "express";

import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";

export interface ApiErrorMetricsObserver {
  recordApiError(code: string, statusCode: number): void;
}

type ErrorPayload = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
};

function isInvalidJson(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    "status" in error &&
    (error as SyntaxError & { status: number }).status === 400
  );
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as Error & { status: number }).status === 413
  );
}

export function createErrorHandler(
  metrics?: ApiErrorMetricsObserver,
): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    const normalizedError = isInvalidJson(error)
      ? new AppError(400, "INVALID_JSON", "The request body contains invalid JSON")
      : isPayloadTooLarge(error)
        ? new AppError(413, "PAYLOAD_TOO_LARGE", "The request body is too large")
        : error;

    const isOperational = normalizedError instanceof AppError;
    const statusCode = isOperational ? normalizedError.statusCode : 500;
    const payload: ErrorPayload = {
      error: {
        code: isOperational ? normalizedError.code : "INTERNAL_SERVER_ERROR",
        message: isOperational
          ? normalizedError.message
          : "An unexpected error occurred",
        requestId: String(request.id),
      },
    };
    try {
      metrics?.recordApiError(payload.error.code, statusCode);
    } catch {
      // Metrics failures must not replace the normalized API error.
    }

    if (isOperational && normalizedError.details !== undefined) {
      payload.error.details = normalizedError.details;
    }

    request.log[statusCode >= 500 ? "error" : "warn"](
      {
        error: normalizedError,
        requestId: request.id,
        statusCode,
      },
      "Request failed",
    );

    if (env.NODE_ENV === "production" && statusCode >= 500) {
      delete payload.error.details;
    }

    response.status(statusCode).json(payload);
  };
}

export const errorHandler = createErrorHandler();
