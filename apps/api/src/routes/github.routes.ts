import { Router, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  GitHubRepositoryAccessError,
  getDefaultGitHubRepositoryService,
  type GitHubRepositoryServiceContract,
} from "../services/github-repository.service.js";
import {
  RepositoryImportError,
  getDefaultRepositoryImportService,
  type RepositoryImportServiceContract,
} from "../services/repository-import.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";
import { repositoryImportErrorToAppError } from "./repository.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/u;
const ownerPattern = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/u;
const installationIdSchema = z.coerce.number().int().positive().safe();
const repositoryParamsSchema = z.object({
  owner: z.string().regex(ownerPattern),
  repository: z
    .string()
    .regex(repositoryPattern)
    .refine((value) => value !== "." && value !== ".."),
});
const listRepositoriesQuerySchema = z.object({
  installationId: installationIdSchema.optional(),
});
const branchQuerySchema = z.object({
  installationId: installationIdSchema,
});
const importBodySchema = z
  .object({
    installationId: z.number().int().positive().safe(),
    branch: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type CreateGitHubRouterOptions = {
  service?: GitHubRepositoryServiceContract;
  getService?: () => GitHubRepositoryServiceContract;
  repositoryImportService?: RepositoryImportServiceContract;
  getRepositoryImportService?: () => RepositoryImportServiceContract;
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

function toAppError(error: GitHubRepositoryAccessError): AppError {
  switch (error.code) {
    case "AUTHORIZATION_REQUIRED":
      return new AppError(401, error.code, error.message);
    case "INSTALLATION_REQUIRED":
      return new AppError(400, error.code, error.message);
    case "INSTALLATION_NOT_FOUND":
    case "REPOSITORY_NOT_FOUND":
    case "BRANCH_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "GITHUB_UNAVAILABLE":
      return new AppError(502, error.code, error.message);
  }
}

export function createGitHubRouter(
  options: CreateGitHubRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as GitHubRepositoryServiceContract
      : getDefaultGitHubRepositoryService);
  const getImportService =
    options.getRepositoryImportService ??
    (options.repositoryImportService
      ? () => options.repositoryImportService as RepositoryImportServiceContract
      : getDefaultRepositoryImportService);

  const requireUser = async (
    request: Parameters<AuthenticatedUserIdResolver>[0],
    response: Parameters<AuthenticatedUserIdResolver>[1],
  ): Promise<string> => {
    const userId = await resolveAuthenticatedUserId(request, response);
    if (!userId || !objectIdPattern.test(userId)) {
      throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
    }
    return userId;
  };

  const service = (): GitHubRepositoryServiceContract => {
    try {
      return getService();
    } catch (cause) {
      throw new AppError(
        503,
        "GITHUB_INTEGRATION_UNAVAILABLE",
        "GitHub integration is not configured",
        cause instanceof Error ? { reason: cause.message } : undefined,
      );
    }
  };

  const importService = (): RepositoryImportServiceContract => {
    try {
      return getImportService();
    } catch (cause) {
      throw new AppError(
        503,
        "INDEXING_SERVICE_UNAVAILABLE",
        "Repository indexing is not configured",
        cause instanceof Error ? { reason: cause.message } : undefined,
      );
    }
  };

  router.get("/github/installations", async (request, response) => {
    const userId = await requireUser(request, response);
    try {
      response.status(200).json({ data: await service().listInstallations(userId) });
    } catch (error) {
      if (error instanceof GitHubRepositoryAccessError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.get("/github/repositories", async (request, response) => {
    const userId = await requireUser(request, response);
    const query = listRepositoriesQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new AppError(
        400,
        "INVALID_GITHUB_QUERY",
        "The GitHub repository query is invalid",
        validationDetails(query.error),
      );
    }
    try {
      response.status(200).json({
        data: await service().listRepositories(
          userId,
          query.data.installationId,
        ),
      });
    } catch (error) {
      if (error instanceof GitHubRepositoryAccessError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.get(
    "/github/repositories/:owner/:repository/branches",
    async (request, response) => {
      const userId = await requireUser(request, response);
      const params = repositoryParamsSchema.safeParse(request.params);
      const query = branchQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        throw new AppError(
          400,
          "INVALID_GITHUB_REPOSITORY",
          "The GitHub repository request is invalid",
          [
            ...(params.success ? [] : validationDetails(params.error)),
            ...(query.success ? [] : validationDetails(query.error)),
          ],
        );
      }
      try {
        response.status(200).json({
          data: await service().listBranches({
            userId,
            installationId: query.data.installationId,
            owner: params.data.owner,
            repository: params.data.repository,
          }),
        });
      } catch (error) {
        if (error instanceof GitHubRepositoryAccessError) {
          throw toAppError(error);
        }
        throw error;
      }
    },
  );

  router.post(
    "/github/repositories/:owner/:repository/import",
    async (request, response) => {
      const userId = await requireUser(request, response);
      const params = repositoryParamsSchema.safeParse(request.params);
      const body = importBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new AppError(
          400,
          "INVALID_GITHUB_IMPORT",
          "The GitHub repository import request is invalid",
          [
            ...(params.success ? [] : validationDetails(params.error)),
            ...(body.success ? [] : validationDetails(body.error)),
          ],
        );
      }

      try {
        const result = await importService().importGitHub({
          authenticatedUserId: userId,
          installationId: body.data.installationId,
          owner: params.data.owner,
          repository: params.data.repository,
          ...(body.data.branch === undefined ? {} : { branch: body.data.branch }),
        });
        response.status(202).json({ data: result });
      } catch (error) {
        if (error instanceof RepositoryImportError) {
          throw repositoryImportErrorToAppError(error);
        }
        throw error;
      }
    },
  );

  return router;
}
