import { Router, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositorySymbolGraphError,
  getDefaultRepositorySymbolGraphService,
  type RepositorySymbolGraphServiceContract,
} from "../services/repository-symbol-graph.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});
const symbolQuerySchema = z
  .object({
    symbol: z.string().trim().min(1).max(255),
  })
  .strict();

export type CreateRepositorySymbolGraphRouterOptions = {
  service?: RepositorySymbolGraphServiceContract;
  getService?: () => RepositorySymbolGraphServiceContract;
  resolveAuthenticatedUserId?: AuthenticatedUserIdResolver;
};

function defaultAuthenticatedUserIdResolver(
  _request: unknown,
  response: Response,
): string | undefined {
  const value: unknown = response.locals.authenticatedUserId;
  return typeof value === "string" ? value : undefined;
}

function validationDetails(error: z.ZodError): Array<{
  path: string;
  message: string;
}> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function toAppError(error: RepositorySymbolGraphError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
    case "SYMBOL_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "REPOSITORY_NOT_READY":
      return new AppError(409, error.code, error.message);
    case "SYMBOL_GRAPH_TOO_LARGE":
      return new AppError(413, error.code, error.message);
    case "REPOSITORY_ACCESS_FAILED":
    case "SYMBOL_DATA_UNAVAILABLE":
      return new AppError(503, error.code, error.message);
    case "SYMBOL_DATA_INVALID":
      return new AppError(500, error.code, error.message);
  }
}

export function createRepositorySymbolGraphRouter(
  options: CreateRepositorySymbolGraphRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositorySymbolGraphServiceContract
      : getDefaultRepositorySymbolGraphService);

  const requireUser = async (
    request: Parameters<AuthenticatedUserIdResolver>[0],
    response: Parameters<AuthenticatedUserIdResolver>[1],
  ): Promise<string> => {
    const authenticatedUserId = await resolveAuthenticatedUserId(
      request,
      response,
    );
    if (!authenticatedUserId || !objectIdPattern.test(authenticatedUserId)) {
      throw new AppError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
      );
    }
    return authenticatedUserId;
  };

  const parseRepositoryId = (params: unknown): string => {
    const parsed = repositoryParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new AppError(
        400,
        "INVALID_SYMBOL_GRAPH_REQUEST",
        "The repository symbol graph request is invalid",
        validationDetails(parsed.error),
      );
    }
    return parsed.data.id;
  };

  const service = (): RepositorySymbolGraphServiceContract => {
    try {
      return getService();
    } catch (error) {
      throw new AppError(
        503,
        "SYMBOL_GRAPH_SERVICE_UNAVAILABLE",
        "Repository symbol graph is not configured",
        error instanceof Error ? { reason: error.message } : undefined,
      );
    }
  };

  router.get("/repositories/:id/symbol-graph", async (request, response) => {
    const authenticatedUserId = await requireUser(request, response);
    const repositoryId = parseRepositoryId(request.params);
    try {
      const result = await service().getGraph({
        authenticatedUserId,
        repositoryId,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositorySymbolGraphError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.get(
    "/repositories/:id/symbol-references",
    async (request, response) => {
      const authenticatedUserId = await requireUser(request, response);
      const repositoryId = parseRepositoryId(request.params);
      const query = symbolQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new AppError(
          400,
          "INVALID_SYMBOL_REFERENCE_REQUEST",
          "The repository symbol reference request is invalid",
          validationDetails(query.error),
        );
      }
      try {
        const result = await service().findReferences({
          authenticatedUserId,
          repositoryId,
          symbol: query.data.symbol,
        });
        response.status(200).json({ data: result });
      } catch (error) {
        if (error instanceof RepositorySymbolGraphError) {
          throw toAppError(error);
        }
        throw error;
      }
    },
  );

  return router;
}
