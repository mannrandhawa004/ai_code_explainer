import { randomBytes } from "node:crypto";

import { UserModel } from "@codebase-explainer/database";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { App, Octokit } from "octokit";

import {
  getGitHubAuthenticationConfiguration,
  type GitHubAuthenticationConfiguration,
} from "../config/env.js";
import { TokenCipher } from "./token-cipher.js";

const sessionIssuer = "ai-codebase-explainer-api";
const sessionAudience = "ai-codebase-explainer-web";
const refreshWindowMs = 5 * 60 * 1_000;
const objectIdPattern = /^[0-9a-f]{24}$/u;

export type AuthenticatedGitHubUser = {
  id: string;
  githubId: string;
  username: string;
  avatarUrl: string;
  email?: string;
};

export type GitHubAuthorizationRequest = {
  state: string;
  url: string;
};

export type GitHubAuthenticationResult = {
  sessionToken: string;
  user: AuthenticatedGitHubUser;
};

export class GitHubAuthenticationError extends Error {
  override readonly name = "GitHubAuthenticationError";

  constructor(
    readonly code:
      | "AUTHENTICATION_FAILED"
      | "AUTHENTICATION_EXPIRED"
      | "USER_NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubAuthServiceContract {
  createAuthorizationRequest(): GitHubAuthorizationRequest;
  completeAuthorization(code: string): Promise<GitHubAuthenticationResult>;
  verifySession(sessionToken: string): string;
  getCurrentUser(userId: string): Promise<AuthenticatedGitHubUser>;
}

export type GitHubUserClient = InstanceType<typeof Octokit>;

function toPublicUser(user: {
  _id: { toString(): string };
  githubId: string;
  username: string;
  avatarUrl: string;
  email?: string | null;
}): AuthenticatedGitHubUser {
  return {
    id: user._id.toString(),
    githubId: user.githubId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    ...(user.email ? { email: user.email } : {}),
  };
}

function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function hasRefreshToken(authentication: unknown): authentication is {
  token: string;
  expiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
} {
  if (typeof authentication !== "object" || authentication === null) {
    return false;
  }
  const candidate = authentication as Record<string, unknown>;
  return (
    typeof candidate.token === "string" &&
    typeof candidate.expiresAt === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.refreshTokenExpiresAt === "string"
  );
}

export class GitHubAuthService implements GitHubAuthServiceContract {
  private readonly app: App;
  private readonly cipher: TokenCipher;

  constructor(private readonly configuration: GitHubAuthenticationConfiguration) {
    this.app = new App({
      appId: configuration.appId,
      privateKey: configuration.privateKey,
      oauth: {
        clientId: configuration.clientId,
        clientSecret: configuration.clientSecret,
        allowSignup: true,
      },
    });
    this.cipher = new TokenCipher(configuration.encryptionKey);
  }

  createAuthorizationRequest(): GitHubAuthorizationRequest {
    const state = randomBytes(32).toString("base64url");
    const { url } = this.app.oauth.getWebFlowAuthorizationUrl({
      state,
      redirectUrl: this.configuration.callbackUrl,
    });
    return { state, url };
  }

  async completeAuthorization(code: string): Promise<GitHubAuthenticationResult> {
    try {
      const { authentication } = await this.app.oauth.createToken({
        code,
        redirectUrl: this.configuration.callbackUrl,
      });
      const userClient = new Octokit({ auth: authentication.token });
      const { data: githubUser } = await userClient.rest.users.getAuthenticated();
      const tokenFields = this.encryptedTokenFields(authentication);

      const user = await UserModel.findOneAndUpdate(
        { githubId: githubUser.id.toString() },
        {
          $set: {
            username: githubUser.login,
            avatarUrl: githubUser.avatar_url,
            ...(githubUser.email ? { email: githubUser.email } : {}),
            ...tokenFields.set,
          },
          ...(Object.keys(tokenFields.unset).length === 0
            ? {}
            : { $unset: tokenFields.unset }),
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      ).exec();

      if (!user) {
        throw new Error("User upsert returned no document");
      }

      return {
        sessionToken: this.createSession(user._id.toString()),
        user: toPublicUser(user),
      };
    } catch (cause) {
      if (cause instanceof GitHubAuthenticationError) {
        throw cause;
      }
      throw new GitHubAuthenticationError(
        "AUTHENTICATION_FAILED",
        "GitHub authentication could not be completed",
        { cause },
      );
    }
  }

  verifySession(sessionToken: string): string {
    try {
      const payload = jwt.verify(sessionToken, this.configuration.sessionSecret, {
        algorithms: ["HS256"],
        issuer: sessionIssuer,
        audience: sessionAudience,
      }) as JwtPayload;
      if (typeof payload.sub !== "string" || !objectIdPattern.test(payload.sub)) {
        throw new Error("Session subject is invalid");
      }
      return payload.sub;
    } catch (cause) {
      throw new GitHubAuthenticationError(
        "AUTHENTICATION_EXPIRED",
        "The authentication session is invalid or expired",
        { cause },
      );
    }
  }

  async getCurrentUser(userId: string): Promise<AuthenticatedGitHubUser> {
    if (!objectIdPattern.test(userId)) {
      throw new GitHubAuthenticationError("USER_NOT_FOUND", "User was not found");
    }
    const user = await UserModel.findById(userId).exec();
    if (!user) {
      throw new GitHubAuthenticationError("USER_NOT_FOUND", "User was not found");
    }
    return toPublicUser(user);
  }

  async getUserClient(userId: string): Promise<GitHubUserClient> {
    if (!objectIdPattern.test(userId)) {
      throw new GitHubAuthenticationError("USER_NOT_FOUND", "User was not found");
    }
    const user = await UserModel.findById(userId)
      .select(
        "+githubAccessTokenEncrypted +githubAccessTokenExpiresAt " +
          "+githubRefreshTokenEncrypted +githubRefreshTokenExpiresAt",
      )
      .exec();
    if (!user?.githubAccessTokenEncrypted) {
      throw new GitHubAuthenticationError(
        "AUTHENTICATION_EXPIRED",
        "GitHub authorization is required",
      );
    }

    let accessToken = this.cipher.decrypt(user.githubAccessTokenEncrypted);
    const shouldRefresh =
      user.githubAccessTokenExpiresAt !== undefined &&
      user.githubAccessTokenExpiresAt.getTime() <= Date.now() + refreshWindowMs;

    if (shouldRefresh) {
      if (
        !user.githubRefreshTokenEncrypted ||
        !user.githubRefreshTokenExpiresAt ||
        user.githubRefreshTokenExpiresAt.getTime() <= Date.now()
      ) {
        throw new GitHubAuthenticationError(
          "AUTHENTICATION_EXPIRED",
          "GitHub authorization has expired; sign in again",
        );
      }

      try {
        const refreshToken = this.cipher.decrypt(user.githubRefreshTokenEncrypted);
        const refreshed = await this.app.oauth.refreshToken({ refreshToken });
        const fields = this.encryptedTokenFields(refreshed.authentication);
        await UserModel.updateOne(
          { _id: user._id },
          {
            $set: fields.set,
            ...(Object.keys(fields.unset).length === 0
              ? {}
              : { $unset: fields.unset }),
          },
        ).exec();
        accessToken = refreshed.authentication.token;
      } catch (cause) {
        throw new GitHubAuthenticationError(
          "AUTHENTICATION_EXPIRED",
          "GitHub authorization has expired; sign in again",
          { cause },
        );
      }
    }

    return new Octokit({ auth: accessToken });
  }

  private createSession(userId: string): string {
    return jwt.sign({}, this.configuration.sessionSecret, {
      algorithm: "HS256",
      subject: userId,
      issuer: sessionIssuer,
      audience: sessionAudience,
      expiresIn: this.configuration.sessionTtlSeconds,
    });
  }

  private encryptedTokenFields(authentication: {
    token: string;
    expiresAt?: string;
    refreshToken?: string;
    refreshTokenExpiresAt?: string;
  }): {
    set: Record<string, unknown>;
    unset: Record<string, 1>;
  } {
    const set: Record<string, unknown> = {
      githubAccessTokenEncrypted: this.cipher.encrypt(authentication.token),
    };
    const unset: Record<string, 1> = {};
    const expiresAt = optionalDate(authentication.expiresAt);
    if (expiresAt) {
      set.githubAccessTokenExpiresAt = expiresAt;
    } else {
      unset.githubAccessTokenExpiresAt = 1;
    }

    if (hasRefreshToken(authentication)) {
      set.githubRefreshTokenEncrypted = this.cipher.encrypt(
        authentication.refreshToken,
      );
      set.githubRefreshTokenExpiresAt = new Date(
        authentication.refreshTokenExpiresAt,
      );
    } else {
      unset.githubRefreshTokenEncrypted = 1;
      unset.githubRefreshTokenExpiresAt = 1;
    }
    return { set, unset };
  }
}

let defaultService: GitHubAuthService | undefined;

export function getDefaultGitHubAuthService(): GitHubAuthService {
  if (defaultService) {
    return defaultService;
  }
  const configuration = getGitHubAuthenticationConfiguration();
  if (!configuration) {
    throw new Error("GitHub authentication is not configured");
  }
  defaultService = new GitHubAuthService(configuration);
  return defaultService;
}
