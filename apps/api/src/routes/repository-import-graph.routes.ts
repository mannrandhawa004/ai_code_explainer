import { Router, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositoryImportGraphError,
  getDefaultRepositoryImportGraphService,
  type RepositoryImportGraphServiceContract,
} from "../services/repository-import-graph.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});

export type CreateRepositoryImportGraphRouterOptions = {
  service?: RepositoryImportGraphServiceContract;
  getService?: () => RepositoryImportGraphServiceContract;
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

function toAppError(error: RepositoryImportGraphError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "REPOSITORY_NOT_READY":
      return new AppError(409, error.code, error.message);
    case "GRAPH_TOO_LARGE":
      return new AppError(413, error.code, error.message);
    case "REPOSITORY_ACCESS_FAILED":
    case "GRAPH_DATA_UNAVAILABLE":
      return new AppError(503, error.code, error.message);
    case "GRAPH_DATA_INVALID":
      return new AppError(500, error.code, error.message);
  }
}

export function createRepositoryImportGraphRouter(
  options: CreateRepositoryImportGraphRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositoryImportGraphServiceContract
      : getDefaultRepositoryImportGraphService);

  router.get("/repositories/:id/import-graph", async (request, response) => {
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

    const params = repositoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(
        400,
        "INVALID_IMPORT_GRAPH_REQUEST",
        "The repository import graph request is invalid",
        validationDetails(params.error),
      );
    }

    let service: RepositoryImportGraphServiceContract;
    try {
      service = getService();
    } catch (error) {
      throw new AppError(
        503,
        "IMPORT_GRAPH_SERVICE_UNAVAILABLE",
        "Repository import graph is not configured",
        error instanceof Error ? { reason: error.message } : undefined,
      );
    }

    try {
      const result = await service.getGraph({
        authenticatedUserId,
        repositoryId: params.data.id,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryImportGraphError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  return router;
}
