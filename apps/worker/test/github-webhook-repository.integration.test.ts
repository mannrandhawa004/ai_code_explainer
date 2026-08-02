import {
  IndexingJobModel,
  RepositoryModel,
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";
import type { GitHubPushWebhookJobData } from "@codebase-explainer/shared";
import { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MongoGitHubWebhookRepositoryOperations } from "../src/services/github-webhook-repository.service.js";

const mongoTestUri = process.env.MONGODB_TEST_URI;
const describeWithMongo = mongoTestUri ? describe : describe.skip;

describeWithMongo("GitHub webhook repository operations", () => {
  const userId = new Types.ObjectId();
  const repositoryId = new Types.ObjectId();
  const suffix = repositoryId.toString();
  const githubRepositoryId = Number.parseInt(suffix.slice(0, 10), 16);
  const installationId = Number.parseInt(suffix.slice(10, 20), 16);
  const fullName = `owner/webhook-${suffix}`;
  const producer = {
    enqueue: vi.fn().mockResolvedValue({ jobId: `webhook-job-${suffix}` }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const service = new MongoGitHubWebhookRepositoryOperations(producer);

  beforeAll(async () => {
    await connectDatabase(mongoTestUri as string, {
      serverSelectionTimeoutMS: 5_000,
    });
    await RepositoryModel.create({
      _id: repositoryId,
      userId,
      githubRepositoryId,
      installationId,
      owner: "owner",
      name: `webhook-${suffix}`,
      fullName,
      private: true,
      selectedBranch: "main",
      defaultBranch: "main",
      status: "ready",
    });
  });

  afterAll(async () => {
    await IndexingJobModel.deleteMany({ repositoryId });
    await RepositoryModel.deleteOne({ _id: repositoryId });
    await disconnectDatabase();
  });

  it("queues matching branch pushes and durably revokes later access", async () => {
    const push: GitHubPushWebhookJobData = {
      kind: "push",
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      payloadSha256: "b".repeat(64),
      receivedAt: "2026-08-02T12:00:00.000Z",
      installationId,
      githubRepositoryId,
      owner: "owner",
      repository: `webhook-${suffix}`,
      fullName,
      repositoryUrl: `https://github.com/${fullName}`,
      private: true,
      defaultBranch: "main",
      branch: "main",
      commitSha: "a".repeat(40),
    };

    await expect(service.enqueuePush(push)).resolves.toEqual({
      matchedRepositories: 1,
      queuedRepositories: 1,
      deduplicatedRepositories: 0,
    });
    expect(producer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: repositoryId.toString(),
        userId: userId.toString(),
        branch: "main",
      }),
    );

    await expect(
      service.revokeInstallation(installationId),
    ).resolves.toBeGreaterThanOrEqual(1);
    const repository = await RepositoryModel.findById(repositoryId).lean().exec();
    const job = await IndexingJobModel.findOne({ repositoryId }).lean().exec();
    expect(repository).toMatchObject({
      status: "failed",
      errorMessage: "GitHub repository access was revoked",
      githubAccessRevokedAt: expect.any(Date),
    });
    expect(job).toMatchObject({ status: "cancelled" });
  });
});
