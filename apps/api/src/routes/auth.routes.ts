import { timingSafeEqual } from "node:crypto";

import { Router, type CookieOptions, type Response } from "express";
import { z } from "zod";

import {
  env,
  getGitHubAuthenticationConfiguration,
} from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import {
  GitHubAuthenticationError,
  getDefaultGitHubAuthService,
  type GitHubAuthServiceContract,
} from "../services/github-auth.service.js";
import type { AuthenticatedUserIdResolver } from "./question.routes.js";

const objectIdPattern = /^[0-9a-f]{24}$/u;
const callbackQuerySchema = z.object({
  code: z.string().trim().min(1).max(1_024),
  state: z.string().trim().min(20).max(1_024),
});

export type CreateAuthRouterOptions = {
  service?: GitHubAuthServiceContract;
  getService?: () => GitHubAuthServiceContract;
  resolveAuthenticatedUserId?: AuthenticatedUserIdResolver;
};

function sameState(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function defaultAuthenticatedUserIdResolver(
  _request: unknown,
  response: Response,
): string | undefined {
  const value: unknown = response.locals.authenticatedUserId;
  return typeof value === "string" ? value : undefined;
}

function toAppError(error: GitHubAuthenticationError): AppError {
  switch (error.code) {
    case "AUTHENTICATION_EXPIRED":
      return new AppError(401, error.code, error.message);
    case "USER_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "AUTHENTICATION_FAILED":
      return new AppError(502, error.code, error.message);
  }
}

export function createAuthRouter(options: CreateAuthRouterOptions = {}): Router {
  const router = Router();
  const configuration = getGitHubAuthenticationConfiguration();
  const getService =
    options.getService ??
    (options.service
      ? () => options.service as GitHubAuthServiceContract
      : getDefaultGitHubAuthService);
  const resolveAuthenticatedUserId =
    options.resolveAuthenticatedUserId ?? defaultAuthenticatedUserIdResolver;

  const service = (): GitHubAuthServiceContract => {
    try {
      return getService();
    } catch (cause) {
      throw new AppError(
        503,
        "GITHUB_AUTHENTICATION_UNAVAILABLE",
        "GitHub authentication is not configured",
        cause instanceof Error ? { reason: cause.message } : undefined,
      );
    }
  };

  const cookieOptions = (maxAge: number, path = "/"): CookieOptions => ({
    httpOnly: true,
    secure: configuration?.secureCookies ?? env.NODE_ENV === "production",
    sameSite: "lax",
    path,
    maxAge,
  });

  router.get("/auth/github", (_request, response) => {
    const authRequest = service().createAuthorizationRequest();
    const cookieName =
      configuration?.oauthStateCookieName ?? "codebase_explainer_oauth_state";
    const maxAge =
      (configuration?.oauthStateTtlSeconds ?? env.OAUTH_STATE_TTL_SECONDS) * 1_000;
    response.cookie(
      cookieName,
      authRequest.state,
      cookieOptions(maxAge, "/api/auth/github/callback"),
    );
    response.redirect(302, authRequest.url);
  });

  router.get("/auth/github/callback", async (request, response) => {
    const query = callbackQuerySchema.safeParse(request.query);
    const stateCookieName =
      configuration?.oauthStateCookieName ?? "codebase_explainer_oauth_state";
    const expectedState: unknown = (
      request.cookies as Record<string, unknown> | undefined
    )?.[stateCookieName];
    response.clearCookie(stateCookieName, {
      ...cookieOptions(0, "/api/auth/github/callback"),
      maxAge: undefined,
    });

    if (
      !query.success ||
      typeof expectedState !== "string" ||
      !sameState(expectedState, query.data.state)
    ) {
      throw new AppError(
        400,
        "INVALID_OAUTH_CALLBACK",
        "The GitHub authentication callback is invalid or expired",
      );
    }

    try {
      const result = await service().completeAuthorization(query.data.code);
      const sessionCookieName =
        configuration?.sessionCookieName ?? env.COOKIE_NAME;
      const sessionTtl =
        (configuration?.sessionTtlSeconds ?? env.JWT_EXPIRES_IN_SECONDS) * 1_000;
      response.cookie(
        sessionCookieName,
        result.sessionToken,
        cookieOptions(sessionTtl),
      );
      response.redirect(
        302,
        new URL("/repositories", configuration?.frontendUrl ?? env.FRONTEND_URL)
          .toString(),
      );
    } catch (error) {
      if (error instanceof GitHubAuthenticationError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  router.post("/auth/logout", (_request, response) => {
    response.clearCookie(
      configuration?.sessionCookieName ?? env.COOKIE_NAME,
      cookieOptions(0),
    );
    response.status(204).send();
  });

  router.get("/auth/me", async (request, response) => {
    const userId = await resolveAuthenticatedUserId(request, response);
    if (!userId || !objectIdPattern.test(userId)) {
      throw new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
    }
    try {
      response.status(200).json({ data: await service().getCurrentUser(userId) });
    } catch (error) {
      if (error instanceof GitHubAuthenticationError) {
        throw toAppError(error);
      }
      throw error;
    }
  });

  return router;
}
