import express, { Router } from "express";

import {
  env,
  getGitHubWebhookConfiguration,
} from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import {
  GitHubWebhookError,
  getDefaultGitHubWebhookService,
  type GitHubWebhookServiceContract,
} from "../services/github-webhook.service.js";

export type CreateGitHubWebhookRouterOptions = {
  service?: GitHubWebhookServiceContract;
  getService?: () => GitHubWebhookServiceContract;
  bodyLimit?: string;
};

function requiredHeader(
  value: string | string[] | undefined,
  headerName: string,
): string {
  if (typeof value !== "string") {
    throw new AppError(
      400,
      "INVALID_WEBHOOK_HEADERS",
      `The ${headerName} header is required`,
    );
  }
  return value;
}

function toAppError(error: GitHubWebhookError): AppError {
  switch (error.code) {
    case "INVALID_WEBHOOK_HEADERS":
    case "INVALID_WEBHOOK_PAYLOAD":
      return new AppError(400, error.code, error.message);
    case "INVALID_WEBHOOK_SIGNATURE":
      return new AppError(401, error.code, error.message);
    case "DELIVERY_CONFLICT":
      return new AppError(409, error.code, error.message);
    case "WEBHOOK_QUEUE_UNAVAILABLE":
      return new AppError(503, error.code, error.message);
  }
}

export function createGitHubWebhookRouter(
  options: CreateGitHubWebhookRouterOptions = {},
): Router {
  const router = Router();
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as GitHubWebhookServiceContract
      : getDefaultGitHubWebhookService);
  const bodyLimit =
    options.bodyLimit ??
    getGitHubWebhookConfiguration()?.bodyLimit ??
    env.GITHUB_WEBHOOK_BODY_LIMIT;

  const service = (): GitHubWebhookServiceContract => {
    try {
      return getService();
    } catch (cause) {
      throw new AppError(
        503,
        "GITHUB_WEBHOOK_UNAVAILABLE",
        "GitHub webhooks are not configured",
        cause instanceof Error ? { reason: cause.message } : undefined,
      );
    }
  };

  router.post(
    "/github/webhook",
    express.raw({ type: "application/json", limit: bodyLimit }),
    async (request, response) => {
      if (!Buffer.isBuffer(request.body)) {
        throw new AppError(
          415,
          "INVALID_WEBHOOK_CONTENT_TYPE",
          "GitHub webhooks must use application/json",
        );
      }

      try {
        const receipt = await service().receive({
          deliveryId: requiredHeader(
            request.headers["x-github-delivery"],
            "X-GitHub-Delivery",
          ),
          eventName: requiredHeader(
            request.headers["x-github-event"],
            "X-GitHub-Event",
          ),
          signature: requiredHeader(
            request.headers["x-hub-signature-256"],
            "X-Hub-Signature-256",
          ),
          rawBody: request.body,
        });
        response.status(202).json({ data: receipt });
      } catch (error) {
        if (error instanceof GitHubWebhookError) {
          throw toAppError(error);
        }
        throw error;
      }
    },
  );

  return router;
}
