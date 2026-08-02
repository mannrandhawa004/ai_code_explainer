import type {
  GitHubWebhookJobData,
  GitHubWebhookJobResult,
} from "@codebase-explainer/shared";

import {
  InstallationTokenError,
  type InstallationTokenProviderContract,
} from "../services/github-installation-token.service.js";
import type { GitHubWebhookRepositoryOperationsContract } from "../services/github-webhook-repository.service.js";

export class GitHubWebhookProcessingError extends Error {
  override readonly name = "GitHubWebhookProcessingError";

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubWebhookProcessorContract {
  process(data: GitHubWebhookJobData): Promise<GitHubWebhookJobResult>;
}

export class GitHubWebhookProcessor implements GitHubWebhookProcessorContract {
  constructor(
    private readonly repositories: GitHubWebhookRepositoryOperationsContract,
    private readonly installationTokens?: InstallationTokenProviderContract,
  ) {}

  async process(data: GitHubWebhookJobData): Promise<GitHubWebhookJobResult> {
    if (data.kind === "installation_revoked") {
      const revokedRepositories = await this.repositories.revokeInstallation(
        data.installationId,
      );
      return this.result(data, { revokedRepositories });
    }

    if (data.kind === "repositories_revoked") {
      const revokedRepositories = await this.repositories.revokeRepositories(
        data.installationId,
        data.githubRepositoryIds,
      );
      return this.result(data, { revokedRepositories });
    }

    if (!this.installationTokens) {
      throw new GitHubWebhookProcessingError(
        "GitHub App credentials are required to process push webhooks",
        false,
      );
    }

    try {
      await this.installationTokens.createRepositoryToken({
        installationId: data.installationId,
        repositoryId: data.githubRepositoryId,
      });
    } catch (cause) {
      if (cause instanceof InstallationTokenError) {
        if (cause.code === "ACCESS_DENIED") {
          const revokedRepositories = await this.repositories.revokeRepositories(
            data.installationId,
            [data.githubRepositoryId],
          );
          return this.result(data, { revokedRepositories });
        }
        throw new GitHubWebhookProcessingError(
          "GitHub is temporarily unavailable",
          true,
          { cause },
        );
      }
      throw cause;
    }

    try {
      const queued = await this.repositories.enqueuePush(data);
      return this.result(data, queued);
    } catch (cause) {
      throw new GitHubWebhookProcessingError(
        "GitHub webhook processing is temporarily unavailable",
        true,
        { cause },
      );
    }
  }

  private result(
    data: GitHubWebhookJobData,
    values: Partial<
      Pick<
        GitHubWebhookJobResult,
        | "matchedRepositories"
        | "queuedRepositories"
        | "deduplicatedRepositories"
        | "revokedRepositories"
      >
    >,
  ): GitHubWebhookJobResult {
    return {
      deliveryId: data.deliveryId,
      kind: data.kind,
      matchedRepositories: values.matchedRepositories ?? 0,
      queuedRepositories: values.queuedRepositories ?? 0,
      deduplicatedRepositories: values.deduplicatedRepositories ?? 0,
      revokedRepositories: values.revokedRepositories ?? 0,
    };
  }
}
