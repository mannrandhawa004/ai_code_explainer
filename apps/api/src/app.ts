import { randomUUID } from "node:crypto";

import cookieParser from "cookie-parser";
import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

import { env } from "./config/env.js";
import { logger as defaultLogger } from "./config/logger.js";
import { AppError } from "./errors/app-error.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { createSessionAuthMiddleware } from "./middleware/session-auth.js";
import { createApiRouter } from "./routes/index.js";
import type { AuthenticatedUserIdResolver } from "./routes/question.routes.js";
import type { GitHubAuthServiceContract } from "./services/github-auth.service.js";
import type { GitHubRepositoryServiceContract } from "./services/github-repository.service.js";
import type { RepositoryQuestionServiceContract } from "./services/repository-question.service.js";
import type { RepositoryImportServiceContract } from "./services/repository-import.service.js";

export type CreateAppOptions = {
  logger?: Logger;
  disableRateLimit?: boolean;
  repositoryQuestionService?: RepositoryQuestionServiceContract;
  repositoryImportService?: RepositoryImportServiceContract;
  githubAuthService?: GitHubAuthServiceContract;
  githubRepositoryService?: GitHubRepositoryServiceContract;
  resolveAuthenticatedUserId?: AuthenticatedUserIdResolver;
};

const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (origin === undefined || origin === env.FRONTEND_URL) {
      callback(null, true);
      return;
    }

    callback(new AppError(403, "CORS_ORIGIN_DENIED", "This origin is not allowed"));
  },
};

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const appLogger = options.logger ?? defaultLogger;

  app.disable("x-powered-by");

  if (env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(
    pinoHttp({
      logger: appLogger,
      genReqId(request, response) {
        const incomingId = request.headers["x-request-id"];
        const requestId =
          typeof incomingId === "string" ? incomingId : randomUUID();
        response.setHeader("x-request-id", requestId);
        return requestId;
      },
      autoLogging: {
        ignore: (request) => request.url === "/api/health",
      },
    }),
  );
  app.use(helmet());
  app.use(cors(corsOptions));

  if (!options.disableRateLimit) {
    app.use(
      rateLimit({
        windowMs: env.API_RATE_LIMIT_WINDOW_MS,
        limit: env.API_RATE_LIMIT_MAX,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skip: (request) => request.path === "/api/health",
        handler(_request, response) {
          response.status(429).json({
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message: "Too many requests; please try again later",
            },
          });
        },
      }),
    );
  }

  app.use(express.json({ limit: env.API_JSON_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.API_JSON_LIMIT }));
  app.use(cookieParser());
  app.use(
    createSessionAuthMiddleware(
      options.githubAuthService === undefined
        ? {}
        : { service: options.githubAuthService },
    ),
  );

  app.use(
    "/api",
    createApiRouter({
      auth: {
        ...(options.githubAuthService === undefined
          ? {}
          : { service: options.githubAuthService }),
        ...(options.resolveAuthenticatedUserId === undefined
          ? {}
          : {
              resolveAuthenticatedUserId:
                options.resolveAuthenticatedUserId,
            }),
      },
      github: {
        ...(options.githubRepositoryService === undefined
          ? {}
          : { service: options.githubRepositoryService }),
        ...(options.repositoryImportService === undefined
          ? {}
          : { repositoryImportService: options.repositoryImportService }),
        ...(options.resolveAuthenticatedUserId === undefined
          ? {}
          : {
              resolveAuthenticatedUserId:
                options.resolveAuthenticatedUserId,
            }),
      },
      question: {
        ...(options.repositoryQuestionService === undefined
          ? {}
          : { service: options.repositoryQuestionService }),
        ...(options.resolveAuthenticatedUserId === undefined
          ? {}
          : {
              resolveAuthenticatedUserId:
                options.resolveAuthenticatedUserId,
            }),
      },
      repository: {
        ...(options.repositoryImportService === undefined
          ? {}
          : { service: options.repositoryImportService }),
        ...(options.resolveAuthenticatedUserId === undefined
          ? {}
          : {
              resolveAuthenticatedUserId:
                options.resolveAuthenticatedUserId,
            }),
      },
    }),
  );
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
