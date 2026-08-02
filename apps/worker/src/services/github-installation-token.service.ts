import { App } from "octokit";

export type InstallationRepositoryTokenRequest = {
  installationId: number;
  repositoryId: number;
};

export interface InstallationTokenProviderContract {
  createRepositoryToken(
    input: InstallationRepositoryTokenRequest,
  ): Promise<string>;
}

export class InstallationTokenError extends Error {
  override readonly name = "InstallationTokenError";

  constructor(
    readonly code: "ACCESS_DENIED" | "GITHUB_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  return typeof error.status === "number" ? error.status : undefined;
}

export class GitHubInstallationTokenProvider
  implements InstallationTokenProviderContract
{
  private readonly app: App;

  constructor(appId: string, privateKey: string) {
    this.app = new App({ appId, privateKey });
  }

  async createRepositoryToken(
    input: InstallationRepositoryTokenRequest,
  ): Promise<string> {
    if (
      !Number.isSafeInteger(input.installationId) ||
      input.installationId <= 0 ||
      !Number.isSafeInteger(input.repositoryId) ||
      input.repositoryId <= 0
    ) {
      throw new InstallationTokenError(
        "ACCESS_DENIED",
        "Private repository access could not be verified",
      );
    }

    try {
      const response = await this.app.octokit.request(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: input.installationId,
          repository_ids: [input.repositoryId],
          permissions: { contents: "read" },
        },
      );
      if (!response.data.token) {
        throw new Error("GitHub returned no installation token");
      }
      return response.data.token;
    } catch (cause) {
      const status = statusOf(cause);
      if (status === 401 || status === 403 || status === 404) {
        throw new InstallationTokenError(
          "ACCESS_DENIED",
          "Private repository access could not be verified",
          { cause },
        );
      }
      throw new InstallationTokenError(
        "GITHUB_UNAVAILABLE",
        "GitHub is temporarily unavailable",
        { cause },
      );
    }
  }
}
