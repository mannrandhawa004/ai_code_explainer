import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositoryDependencyExplorationError,
  defaultDependencyExplorationDepth,
  defaultRelatedFileSuggestionLimit,
  getDefaultRepositoryDependencyExplorationService,
  maximumDependencyExplorationDepth,
  maximumRelatedFileSuggestionLimit,
  type RepositoryDependencyExplorationServiceContract,
} from "../services/repository-dependency-exploration.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});
const filePathSchema = z.string().trim().min(1).max(1_024);
const dependencyQuerySchema = z
  .object({
    file: filePathSchema,
    direction: z.enum(["imports", "imported-by", "both"]).default("both"),
    depth: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumDependencyExplorationDepth)
      .default(defaultDependencyExplorationDepth),
  })
  .strict();
const relatedFilesQuerySchema = z
  .object({
    file: filePathSchema,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumRelatedFileSuggestionLimit)
      .default(defaultRelatedFileSuggestionLimit),
  })
  .strict();

export type CreateRepositoryDependencyExplorationRouterOptions = {
  service?: RepositoryDependencyExplorationServiceContract;
  getService?: () => RepositoryDependencyExplorationServiceContract;
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

function toAppError(error: RepositoryDependencyExplorationError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
    case "FILE_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "REPOSITORY_NOT_READY":
      return new AppError(409, error.code, error.message);
    case "DEPENDENCY_TOO_LARGE":
      return new AppError(413, error.code, error.message);
    case "DEPENDENCY_DATA_UNAVAILABLE":
      return new AppError(503, error.code, error.message);
    case "DEPENDENCY_DATA_INVALID":
      return new AppError(500, error.code, error.message);
  }
}

function parseRequest(input: {
  params: unknown;
  query: unknown;
  querySchema: typeof dependencyQuerySchema | typeof relatedFilesQuerySchema;
}):
  | {
      params: z.infer<typeof repositoryParamsSchema>;
      query: Record<string, unknown>;
    }
  | { error: AppError } {
  const params = repositoryParamsSchema.safeParse(input.params);
  const query = input.querySchema.safeParse(input.query);
  if (!params.success || !query.success) {
    const issues = [
      ...(params.success ? [] : validationDetails(params.error)),
      ...(query.success ? [] : validationDetails(query.error)),
    ];
    return {
      error: new AppError(
        400,
        "INVALID_DEPENDENCY_EXPLORATION_REQUEST",
        "The repository dependency exploration request is invalid",
        issues,
      ),
    };
  }
  return { params: params.data, query: query.data };
}

export function createRepositoryDependencyExplorationRouter(
  options: CreateRepositoryDependencyExplorationRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositoryDependencyExplorationServiceContract
      : getDefaultRepositoryDependencyExplorationService);

  async function authenticatedUserId(
    request: Request,
    response: Response,
  ): Promise<string> {
    const value = await resolveAuthenticatedUserId(request, response);
    if (!value || !objectIdPattern.test(value)) {
      throw new AppError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
      );
    }
    return value;
  }

  function service(): RepositoryDependencyExplorationServiceContract {
    try {
      return getService();
    } catch (error) {
      throw new AppError(
        503,
        "DEPENDENCY_EXPLORATION_SERVICE_UNAVAILABLE",
        "Repository dependency exploration is not configured",
        error instanceof Error ? { reason: error.message } : undefined,
      );
    }
  }

  router.get("/repositories/:id/dependencies", async (request, response) => {
    const userId = await authenticatedUserId(request, response);
    const parsed = parseRequest({
      params: request.params,
      query: request.query,
      querySchema: dependencyQuerySchema,
    });
    if ("error" in parsed) {
      throw parsed.error;
    }
    const query = parsed.query as z.infer<typeof dependencyQuerySchema>;
    try {
      const result = await service().exploreDependencies({
        authenticatedUserId: userId,
        repositoryId: parsed.params.id,
        filePath: query.file,
        direction: query.direction,
        depth: query.depth,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryDependencyExplorationError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.get("/repositories/:id/related-files", async (request, response) => {
    const userId = await authenticatedUserId(request, response);
    const parsed = parseRequest({
      params: request.params,
      query: request.query,
      querySchema: relatedFilesQuerySchema,
    });
    if ("error" in parsed) {
      throw parsed.error;
    }
    const query = parsed.query as z.infer<typeof relatedFilesQuerySchema>;
    try {
      const result = await service().suggestRelatedFiles({
        authenticatedUserId: userId,
        repositoryId: parsed.params.id,
        filePath: query.file,
        limit: query.limit,
      });
      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryDependencyExplorationError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  return router;
}
