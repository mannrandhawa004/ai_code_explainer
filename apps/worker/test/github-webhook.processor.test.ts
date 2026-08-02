import type { GitHubWebhookJobData } from "@codebase-explainer/shared";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWebhookProcessingError,
  GitHubWebhookProcessor,
} from "../src/jobs/github-webhook.processor.js";
import { InstallationTokenError } from "../src/services/github-installation-token.service.js";
import type { GitHubWebhookRepositoryOperationsContract } from "../src/services/github-webhook-repository.service.js";

const base = {
  deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  payloadSha256: "b".repeat(64),
  receivedAt: "2026-08-02T12:00:00.000Z",
};
const push: GitHubWebhookJobData = {
  ...base,
  kind: "push",
  installationId: 501,
  githubRepositoryId: 9001,
  owner: "owner",
  repository: "private-repository",
  fullName: "owner/private-repository",
  repositoryUrl: "https://github.com/owner/private-repository",
  private: true,
  defaultBranch: "main",
  branch: "main",
  commitSha: "a".repeat(40),
};

function createRepositories(): GitHubWebhookRepositoryOperationsContract {
  return {
    enqueuePush: vi.fn().mockResolvedValue({
      matchedRepositories: 2,
      queuedRepositories: 1,
      deduplicatedRepositories: 1,
    }),
    revokeInstallation: vi.fn().mockResolvedValue(2),
    revokeRepositories: vi.fn().mockResolvedValue(1),
  };
}

describe("GitHubWebhookProcessor", () => {
  it("revalidates installation access before queueing push reindexes", async () => {
    const repositories = createRepositories();
    const installationTokens = {
      createRepositoryToken: vi.fn().mockResolvedValue("short-lived-token"),
    };
    const processor = new GitHubWebhookProcessor(
      repositories,
      installationTokens,
    );

    await expect(processor.process(push)).resolves.toEqual({
      deliveryId: base.deliveryId,
      kind: "push",
      matchedRepositories: 2,
      queuedRepositories: 1,
      deduplicatedRepositories: 1,
      revokedRepositories: 0,
    });
    expect(installationTokens.createRepositoryToken).toHaveBeenCalledWith({
      installationId: 501,
      repositoryId: 9001,
    });
    expect(repositories.enqueuePush).toHaveBeenCalledWith(push);
  });

  it("revokes local access when GitHub denies the installation token", async () => {
    const repositories = createRepositories();
    const processor = new GitHubWebhookProcessor(repositories, {
      createRepositoryToken: vi.fn().mockRejectedValue(
        new InstallationTokenError(
          "ACCESS_DENIED",
          "Private repository access could not be verified",
        ),
      ),
    });

    await expect(processor.process(push)).resolves.toMatchObject({
      queuedRepositories: 0,
      revokedRepositories: 1,
    });
    expect(repositories.revokeRepositories).toHaveBeenCalledWith(501, [9001]);
    expect(repositories.enqueuePush).not.toHaveBeenCalled();
  });

  it("retries transient GitHub failures without exposing provider details", async () => {
    const processor = new GitHubWebhookProcessor(createRepositories(), {
      createRepositoryToken: vi.fn().mockRejectedValue(
        new InstallationTokenError(
          "GITHUB_UNAVAILABLE",
          "GitHub is temporarily unavailable",
          { cause: new Error("internal provider response") },
        ),
      ),
    });

    await expect(processor.process(push)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubWebhookProcessingError>>({
        message: "GitHub is temporarily unavailable",
        retryable: true,
      }),
    );
  });

  it("handles installation-wide and repository-specific revocation jobs", async () => {
    const repositories = createRepositories();
    const processor = new GitHubWebhookProcessor(repositories);

    await expect(
      processor.process({
        ...base,
        kind: "installation_revoked",
        installationId: 501,
      }),
    ).resolves.toMatchObject({ revokedRepositories: 2 });
    await expect(
      processor.process({
        ...base,
        kind: "repositories_revoked",
        installationId: 501,
        githubRepositoryIds: [9001, 9002],
      }),
    ).resolves.toMatchObject({ revokedRepositories: 1 });
    expect(repositories.revokeInstallation).toHaveBeenCalledWith(501);
    expect(repositories.revokeRepositories).toHaveBeenCalledWith(501, [
      9001,
      9002,
    ]);
  });

  it("fails closed when push access validation is not configured", async () => {
    const repositories = createRepositories();
    const processor = new GitHubWebhookProcessor(repositories);

    await expect(processor.process(push)).rejects.toMatchObject({
      retryable: false,
    });
    expect(repositories.enqueuePush).not.toHaveBeenCalled();
  });
});
