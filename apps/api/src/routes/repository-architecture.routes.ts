import { Router, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositoryArchitectureError,
  getDefaultRepositoryArchitectureService,
  type RepositoryArchitectureServiceContract,
} from "../services/repository-architecture.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});
const architectureQuerySchema = z.object({}).strict();

export type CreateRepositoryArchitectureRouterOptions = {
  service?: RepositoryArchitectureServiceContract;
  getService?: () => RepositoryArchitectureServiceContract;
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

function toAppError(error: RepositoryArchitectureError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "REPOSITORY_NOT_READY":
      return new AppError(409, error.code, error.message);
    case "ARCHITECTURE_TOO_LARGE":
      return new AppError(413, error.code, error.message);
    case "ARCHITECTURE_DATA_UNAVAILABLE":
      return new AppError(503, error.code, error.message);
    case "ARCHITECTURE_DATA_INVALID":
      return new AppError(500, error.code, error.message);
  }
}

export function createRepositoryArchitectureRouter(
  options: CreateRepositoryArchitectureRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositoryArchitectureServiceContract
      : getDefaultRepositoryArchitectureService);

  router.get("/repositories/:id/architecture", async (request, response) => {
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
    const query = architectureQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      const issues = [
        ...(params.success ? [] : validationDetails(params.error)),
        ...(query.success ? [] : validationDetails(query.error)),
      ];
      throw new AppError(
        400,
        "INVALID_ARCHITECTURE_REQUEST",
        "The repository architecture request is invalid",
        issues,
      );
    }

    let service: RepositoryArchitectureServiceContract;
    try {
      service = getService();
    } catch (error) {
      throw new AppError(
        503,
        "ARCHITECTURE_SERVICE_UNAVAILABLE",
        "Repository architecture analysis is not configured",
        error instanceof Error ? { reason: error.message } : undefined,
      );
    }

    try {
      const result = await service.getArchitecture({
        authenticatedUserId,
        repositoryId: params.data.id,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryArchitectureError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  return router;
}
