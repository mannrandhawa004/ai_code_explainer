import {
  GitHubAuthenticationError,
  getDefaultGitHubAuthService,
  type GitHubAuthService,
  type GitHubUserClient,
} from "./github-auth.service.js";

const pageSize = 100;
const maximumPages = 10;
const maximumInstallationFanout = 20;
const ownerPattern = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/u;

export type GitHubInstallationSummary = {
  id: number;
  account: {
    id: number;
    login: string;
    avatarUrl: string;
    type: string;
  };
  repositorySelection: "all" | "selected";
  targetType: string;
};

export type GitHubRepositorySummary = {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  installationId: number;
};

export type GitHubBranchSummary = {
  name: string;
  commitSha: string;
  protected: boolean;
};

export type AuthorizeGitHubRepositoryInput = {
  userId: string;
  installationId: number;
  owner: string;
  repository: string;
  branch?: string;
};

export class GitHubRepositoryAccessError extends Error {
  override readonly name = "GitHubRepositoryAccessError";

  constructor(
    readonly code:
      | "AUTHORIZATION_REQUIRED"
      | "INSTALLATION_REQUIRED"
      | "INSTALLATION_NOT_FOUND"
      | "REPOSITORY_NOT_FOUND"
      | "BRANCH_NOT_FOUND"
      | "GITHUB_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubRepositoryServiceContract {
  listInstallations(userId: string): Promise<GitHubInstallationSummary[]>;
  listRepositories(
    userId: string,
    installationId?: number,
  ): Promise<GitHubRepositorySummary[]>;
  listBranches(
    input: Omit<AuthorizeGitHubRepositoryInput, "branch">,
  ): Promise<GitHubBranchSummary[]>;
  authorizeRepository(
    input: AuthorizeGitHubRepositoryInput,
  ): Promise<GitHubRepositorySummary>;
}

export interface GitHubRepositoryAuthorizationContract {
  authorizeRepository(
    input: AuthorizeGitHubRepositoryInput,
  ): Promise<GitHubRepositorySummary>;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  return typeof error.status === "number" ? error.status : undefined;
}

function validateInstallationId(installationId: number): void {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new GitHubRepositoryAccessError(
      "INSTALLATION_NOT_FOUND",
      "GitHub App installation was not found",
    );
  }
}

function validateRepositoryCoordinates(owner: string, repository: string): void {
  if (
    !ownerPattern.test(owner) ||
    !repositoryPattern.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    throw new GitHubRepositoryAccessError(
      "REPOSITORY_NOT_FOUND",
      "GitHub repository was not found for this installation",
    );
  }
}

function mapInstallation(installation: {
  id: number;
  account: unknown;
  repository_selection: string;
  target_type: string;
}): GitHubInstallationSummary | undefined {
  if (
    typeof installation.account !== "object" ||
    installation.account === null
  ) {
    return undefined;
  }
  const account = installation.account as Record<string, unknown>;
  const login =
    typeof account.login === "string"
      ? account.login
      : typeof account.slug === "string"
        ? account.slug
        : undefined;
  if (
    !login ||
    typeof account.id !== "number" ||
    typeof account.avatar_url !== "string"
  ) {
    return undefined;
  }
  return {
    id: installation.id,
    account: {
      id: account.id,
      login,
      avatarUrl: account.avatar_url,
      type: typeof account.type === "string" ? account.type : "Enterprise",
    },
    repositorySelection:
      installation.repository_selection === "all" ? "all" : "selected",
    targetType: installation.target_type,
  };
}

function mapRepository(
  repository: {
    id: number | bigint;
    node_id: string;
    name: string;
    full_name: string;
    private: boolean;
    html_url: string;
    default_branch: string;
    owner: { login: string } | null;
  },
  installationId: number,
): GitHubRepositorySummary | undefined {
  const repositoryId = Number(repository.id);
  if (!repository.owner || !Number.isSafeInteger(repositoryId)) {
    return undefined;
  }
  return {
    id: repositoryId,
    nodeId: repository.node_id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    htmlUrl: repository.html_url,
    defaultBranch: repository.default_branch,
    installationId,
  };
}

export class GitHubRepositoryService
  implements GitHubRepositoryServiceContract
{
  constructor(private readonly authService: Pick<GitHubAuthService, "getUserClient">) {}

  async listInstallations(userId: string): Promise<GitHubInstallationSummary[]> {
    const client = await this.userClient(userId);
    const installations: GitHubInstallationSummary[] = [];

    try {
      for (let page = 1; page <= maximumPages; page += 1) {
        const response = await client.request("GET /user/installations", {
          per_page: pageSize,
          page,
        });
        for (const installation of response.data.installations) {
          const mapped = mapInstallation(installation);
          if (mapped) {
            installations.push(mapped);
          }
        }
        if (response.data.installations.length < pageSize) {
          break;
        }
      }
      return installations;
    } catch (cause) {
      throw this.mapRequestError(cause, "INSTALLATION_NOT_FOUND");
    }
  }

  async listRepositories(
    userId: string,
    installationId?: number,
  ): Promise<GitHubRepositorySummary[]> {
    const installationIds =
      installationId === undefined
        ? (await this.listInstallations(userId)).map((item) => item.id)
        : [installationId];
    if (installationIds.length > maximumInstallationFanout) {
      throw new GitHubRepositoryAccessError(
        "INSTALLATION_REQUIRED",
        "Select a GitHub App installation before listing repositories",
      );
    }
    const client = await this.userClient(userId);
    const repositories: GitHubRepositorySummary[] = [];

    for (const id of installationIds) {
      validateInstallationId(id);
      repositories.push(...(await this.listInstallationRepositories(client, id)));
    }
    return repositories;
  }

  async listBranches(
    input: Omit<AuthorizeGitHubRepositoryInput, "branch">,
  ): Promise<GitHubBranchSummary[]> {
    await this.authorizeRepository(input);
    const client = await this.userClient(input.userId);
    const branches: GitHubBranchSummary[] = [];

    try {
      for (let page = 1; page <= maximumPages; page += 1) {
        const response = await client.request(
          "GET /repos/{owner}/{repo}/branches",
          {
            owner: input.owner,
            repo: input.repository,
            per_page: pageSize,
            page,
          },
        );
        branches.push(
          ...response.data.map((branch) => ({
            name: branch.name,
            commitSha: branch.commit.sha,
            protected: branch.protected,
          })),
        );
        if (response.data.length < pageSize) {
          break;
        }
      }
      return branches;
    } catch (cause) {
      throw this.mapRequestError(cause, "REPOSITORY_NOT_FOUND");
    }
  }

  async authorizeRepository(
    input: AuthorizeGitHubRepositoryInput,
  ): Promise<GitHubRepositorySummary> {
    validateInstallationId(input.installationId);
    validateRepositoryCoordinates(input.owner, input.repository);
    const client = await this.userClient(input.userId);
    const repositories = await this.listInstallationRepositories(
      client,
      input.installationId,
    );
    const expectedFullName = `${input.owner}/${input.repository}`.toLowerCase();
    const repository = repositories.find(
      (candidate) => candidate.fullName.toLowerCase() === expectedFullName,
    );
    if (!repository) {
      throw new GitHubRepositoryAccessError(
        "REPOSITORY_NOT_FOUND",
        "GitHub repository was not found for this installation",
      );
    }

    if (input.branch !== undefined) {
      try {
        await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
          owner: repository.owner,
          repo: repository.name,
          branch: input.branch,
        });
      } catch (cause) {
        throw this.mapRequestError(cause, "BRANCH_NOT_FOUND");
      }
    }
    return repository;
  }

  private async listInstallationRepositories(
    client: GitHubUserClient,
    installationId: number,
  ): Promise<GitHubRepositorySummary[]> {
    const repositories: GitHubRepositorySummary[] = [];
    try {
      for (let page = 1; page <= maximumPages; page += 1) {
        const response = await client.request(
          "GET /user/installations/{installation_id}/repositories",
          {
            installation_id: installationId,
            per_page: pageSize,
            page,
          },
        );
        for (const repository of response.data.repositories) {
          const mapped = mapRepository(repository, installationId);
          if (mapped) {
            repositories.push(mapped);
          }
        }
        if (response.data.repositories.length < pageSize) {
          break;
        }
      }
      return repositories;
    } catch (cause) {
      throw this.mapRequestError(cause, "INSTALLATION_NOT_FOUND");
    }
  }

  private async userClient(userId: string): Promise<GitHubUserClient> {
    try {
      return await this.authService.getUserClient(userId);
    } catch (cause) {
      if (cause instanceof GitHubAuthenticationError) {
        throw new GitHubRepositoryAccessError(
          "AUTHORIZATION_REQUIRED",
          "GitHub authorization is required",
          { cause },
        );
      }
      throw cause;
    }
  }

  private mapRequestError(
    cause: unknown,
    notFoundCode: "INSTALLATION_NOT_FOUND" | "REPOSITORY_NOT_FOUND" | "BRANCH_NOT_FOUND",
  ): GitHubRepositoryAccessError {
    const status = statusOf(cause);
    if (status === 401) {
      return new GitHubRepositoryAccessError(
        "AUTHORIZATION_REQUIRED",
        "GitHub authorization is required",
        { cause },
      );
    }
    if (status === 403 || status === 404) {
      const messages = {
        INSTALLATION_NOT_FOUND: "GitHub App installation was not found",
        REPOSITORY_NOT_FOUND:
          "GitHub repository was not found for this installation",
        BRANCH_NOT_FOUND: "GitHub branch was not found",
      } as const;
      return new GitHubRepositoryAccessError(notFoundCode, messages[notFoundCode], {
        cause,
      });
    }
    return new GitHubRepositoryAccessError(
      "GITHUB_UNAVAILABLE",
      "GitHub is temporarily unavailable",
      { cause },
    );
  }
}

let defaultService: GitHubRepositoryService | undefined;

export function getDefaultGitHubRepositoryService(): GitHubRepositoryService {
  defaultService ??= new GitHubRepositoryService(getDefaultGitHubAuthService());
  return defaultService;
}
