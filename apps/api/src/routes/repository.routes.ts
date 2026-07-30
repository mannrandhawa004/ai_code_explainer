import { Router, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositoryImportError,
  getDefaultRepositoryImportService,
  type RepositoryImportServiceContract,
} from "../services/repository-import.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/u;
const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});
const importBodySchema = z
  .object({
    repositoryUrl: z.string().trim().url().max(2_048),
    branch: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type CreateRepositoryRouterOptions = {
  service?: RepositoryImportServiceContract;
  getService?: () => RepositoryImportServiceContract;
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

function toAppError(error: RepositoryImportError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
    case "INDEXING_JOB_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "PRIVATE_REPOSITORY_UNSUPPORTED":
    case "INDEXING_ALREADY_FINISHED":
      return new AppError(409, error.code, error.message);
    case "INDEXING_QUEUE_UNAVAILABLE":
    case "PERSISTENCE_FAILED":
      return new AppError(503, error.code, error.message);
  }
}

export function createRepositoryRouter(
  options: CreateRepositoryRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositoryImportServiceContract
      : getDefaultRepositoryImportService);

  const requireUser = async (
    request: Parameters<AuthenticatedUserIdResolver>[0],
    response: Parameters<AuthenticatedUserIdResolver>[1],
  ): Promise<string> => {
    const userId = await resolveAuthenticatedUserId(request, response);
    if (!userId || !objectIdPattern.test(userId)) {
      throw new AppError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
      );
    }
    return userId;
  };

  const service = (): RepositoryImportServiceContract => {
    try {
      return getService();
    } catch (error) {
      throw new AppError(
        503,
        "INDEXING_SERVICE_UNAVAILABLE",
        "Repository indexing is not configured",
        error instanceof Error ? { reason: error.message } : undefined,
      );
    }
  };

  router.post("/repositories/import", async (request, response) => {
    const userId = await requireUser(request, response);
    const body = importBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError(
        400,
        "INVALID_REPOSITORY_IMPORT",
        "The repository import request is invalid",
        validationDetails(body.error),
      );
    }

    try {
      const result = await service().importPublic({
        authenticatedUserId: userId,
        repositoryUrl: body.data.repositoryUrl,
        ...(body.data.branch === undefined ? {} : { branch: body.data.branch }),
      });
      response.status(202).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryImportError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.post("/repositories/:id/index", async (request, response) => {
    const userId = await requireUser(request, response);
    const params = repositoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(
        400,
        "INVALID_REPOSITORY_ID",
        "Repository ID is invalid",
        validationDetails(params.error),
      );
    }

    try {
      const result = await service().enqueueExisting(userId, params.data.id);
      response.status(202).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryImportError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.get("/repositories/:id/status", async (request, response) => {
    const userId = await requireUser(request, response);
    const params = repositoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(
        400,
        "INVALID_REPOSITORY_ID",
        "Repository ID is invalid",
        validationDetails(params.error),
      );
    }

    try {
      const result = await service().getStatus(userId, params.data.id);
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryImportError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.post("/repositories/:id/index/cancel", async (request, response) => {
    const userId = await requireUser(request, response);
    const params = repositoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(
        400,
        "INVALID_REPOSITORY_ID",
        "Repository ID is invalid",
        validationDetails(params.error),
      );
    }

    try {
      const result = await service().cancel(userId, params.data.id);
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryImportError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  return router;
}
