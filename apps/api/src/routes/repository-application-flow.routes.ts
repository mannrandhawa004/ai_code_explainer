import { Router, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositoryApplicationFlowError,
  getDefaultRepositoryApplicationFlowService,
  type RepositoryApplicationFlowServiceContract,
} from "../services/repository-application-flow.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});
const flowQuerySchema = z
  .object({
    route: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export type CreateRepositoryApplicationFlowRouterOptions = {
  service?: RepositoryApplicationFlowServiceContract;
  getService?: () => RepositoryApplicationFlowServiceContract;
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

function toAppError(error: RepositoryApplicationFlowError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
    case "ROUTE_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "REPOSITORY_NOT_READY":
      return new AppError(409, error.code, error.message);
    case "FLOW_TOO_LARGE":
      return new AppError(413, error.code, error.message);
    case "REPOSITORY_ACCESS_FAILED":
    case "FLOW_DATA_UNAVAILABLE":
      return new AppError(503, error.code, error.message);
    case "FLOW_DATA_INVALID":
      return new AppError(500, error.code, error.message);
  }
}

export function createRepositoryApplicationFlowRouter(
  options: CreateRepositoryApplicationFlowRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositoryApplicationFlowServiceContract
      : getDefaultRepositoryApplicationFlowService);

  router.get("/repositories/:id/application-flow", async (request, response) => {
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
    const query = flowQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      const issues = [
        ...(params.success ? [] : validationDetails(params.error)),
        ...(query.success ? [] : validationDetails(query.error)),
      ];
      throw new AppError(
        400,
        "INVALID_APPLICATION_FLOW_REQUEST",
        "The repository application flow request is invalid",
        issues,
      );
    }

    let service: RepositoryApplicationFlowServiceContract;
    try {
      service = getService();
    } catch (error) {
      throw new AppError(
        503,
        "APPLICATION_FLOW_SERVICE_UNAVAILABLE",
        "Repository application flow is not configured",
        error instanceof Error ? { reason: error.message } : undefined,
      );
    }

    try {
      const result = await service.getFlow({
        authenticatedUserId,
        repositoryId: params.data.id,
        ...(query.data.route === undefined ? {} : { route: query.data.route }),
      });
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryApplicationFlowError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  return router;
}
