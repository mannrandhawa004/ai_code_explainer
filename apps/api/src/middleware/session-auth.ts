import type { RequestHandler } from "express";

import { env, getGitHubAuthenticationConfiguration } from "../config/env.js";
import {
  getDefaultGitHubAuthService,
  type GitHubAuthServiceContract,
} from "../services/github-auth.service.js";

export type CreateSessionAuthOptions = {
  service?: GitHubAuthServiceContract;
  cookieName?: string;
};

export function createSessionAuthMiddleware(
  options: CreateSessionAuthOptions = {},
): RequestHandler {
  return (request, response, next) => {
    const configuration = getGitHubAuthenticationConfiguration();
    const cookieName =
      options.cookieName ?? configuration?.sessionCookieName ?? env.COOKIE_NAME;
    const sessionToken: unknown = cookieName
      ? (request.cookies as Record<string, unknown> | undefined)?.[cookieName]
      : undefined;

    if (typeof sessionToken !== "string") {
      next();
      return;
    }

    try {
      const service = options.service ?? getDefaultGitHubAuthService();
      response.locals.authenticatedUserId = service.verifySession(sessionToken);
    } catch {
      response.clearCookie(cookieName as string, { path: "/" });
    }
    next();
  };
}
