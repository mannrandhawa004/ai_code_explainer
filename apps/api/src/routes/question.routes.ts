import { maximumRepositoryQuestionCharacters } from "@codebase-explainer/ai";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { AppError } from "../errors/app-error.js";
import {
  RepositoryQuestionError,
  getDefaultRepositoryQuestionService,
  type RepositoryQuestionServiceContract,
} from "../services/repository-question.service.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;

const repositoryParamsSchema = z.object({
  id: z.string().regex(objectIdPattern, "Repository ID must be a MongoDB ObjectId"),
});

const questionBodySchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(maximumRepositoryQuestionCharacters),
    conversationId: z
      .string()
      .regex(objectIdPattern, "Conversation ID must be a MongoDB ObjectId")
      .optional(),
  })
  .strict();

export type AuthenticatedUserIdResolver = (
  request: Request,
  response: Response,
) => string | undefined | Promise<string | undefined>;

export type CreateQuestionRouterOptions = {
  service?: RepositoryQuestionServiceContract;
  getService?: () => RepositoryQuestionServiceContract;
  resolveAuthenticatedUserId?: AuthenticatedUserIdResolver;
};

function defaultAuthenticatedUserIdResolver(
  _request: Request,
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

function toAppError(error: RepositoryQuestionError): AppError {
  switch (error.code) {
    case "INVALID_REQUEST":
      return new AppError(400, error.code, error.message);
    case "REPOSITORY_NOT_FOUND":
    case "CONVERSATION_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "REPOSITORY_ACCESS_FAILED":
    case "CONVERSATION_ACCESS_FAILED":
      return new AppError(503, error.code, error.message);
    case "REPOSITORY_NOT_READY":
      return new AppError(409, error.code, error.message);
    case "EMBEDDING_FAILED":
    case "RETRIEVAL_FAILED":
    case "ANSWER_GENERATION_FAILED":
      return new AppError(502, error.code, error.message);
    case "PERSISTENCE_FAILED":
      return new AppError(503, error.code, error.message);
    case "QUESTION_ABORTED":
      return new AppError(408, error.code, error.message);
  }
}

export function createQuestionRouter(
  options: CreateQuestionRouterOptions = {},
): Router {
  const router = Router();
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as RepositoryQuestionServiceContract
      : getDefaultRepositoryQuestionService);

  router.post("/repositories/:id/chat", async (request, response) => {
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
    const body = questionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const issues = [
        ...(params.success ? [] : validationDetails(params.error)),
        ...(body.success ? [] : validationDetails(body.error)),
      ];
      throw new AppError(
        400,
        "INVALID_QUESTION_REQUEST",
        "The repository question request is invalid",
        issues,
      );
    }

    const controller = new AbortController();
    const handleAbortedRequest = () => controller.abort();
    const handleClosedResponse = () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    };
    request.once("aborted", handleAbortedRequest);
    response.once("close", handleClosedResponse);

    try {
      let service: RepositoryQuestionServiceContract;
      try {
        service = getService();
      } catch (error) {
        throw new AppError(
          503,
          "QUESTION_SERVICE_UNAVAILABLE",
          "Repository question answering is not configured",
          error instanceof Error ? { reason: error.message } : undefined,
        );
      }

      const result = await service.ask({
        authenticatedUserId,
        repositoryId: params.data.id,
        question: body.data.question,
        ...(body.data.conversationId === undefined
          ? {}
          : { conversationId: body.data.conversationId }),
        signal: controller.signal,
      });

      response.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof RepositoryQuestionError) {
        throw toAppError(error);
      }
      throw error;
    } finally {
      request.off("aborted", handleAbortedRequest);
      response.off("close", handleClosedResponse);
    }
  });

  return router;
}
