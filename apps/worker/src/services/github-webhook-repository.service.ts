import {
  IndexingJobModel,
  RepositoryModel,
  type IndexingJobStatus,
  type RepositoryStatus,
} from "@codebase-explainer/database";
import type {
  GitHubPushWebhookJobData,
  RepositoryIndexingJobData,
} from "@codebase-explainer/shared";
import { trusted, type Types } from "mongoose";

import type { RepositoryIndexingProducerContract } from "../queues/repository-indexing.producer.js";

const inProgressRepositoryStatuses = new Set<RepositoryStatus>([
  "queued",
  "cloning",
  "scanning",
  "parsing",
  "embedding",
  "indexing",
]);
const inProgressJobStatuses: IndexingJobStatus[] = [
  "waiting",
  "active",
  "delayed",
];
const revokedMessage = "GitHub repository access was revoked";

export type GitHubPushRepositoryResult = {
  matchedRepositories: number;
  queuedRepositories: number;
  deduplicatedRepositories: number;
};

export interface GitHubWebhookRepositoryOperationsContract {
  enqueuePush(
    input: GitHubPushWebhookJobData,
  ): Promise<GitHubPushRepositoryResult>;
  revokeInstallation(installationId: number): Promise<number>;
  revokeRepositories(
    installationId: number,
    githubRepositoryIds: readonly number[],
  ): Promise<number>;
}

export class MongoGitHubWebhookRepositoryOperations
  implements GitHubWebhookRepositoryOperationsContract
{
  constructor(private readonly producer: RepositoryIndexingProducerContract) {}

  async enqueuePush(
    input: GitHubPushWebhookJobData,
  ): Promise<GitHubPushRepositoryResult> {
    const repositories = await RepositoryModel.find({
      installationId: input.installationId,
      githubRepositoryId: input.githubRepositoryId,
      selectedBranch: input.branch,
    }).exec();
    const matching = repositories.filter(
      (repository) =>
        repository.fullName.toLowerCase() === input.fullName.toLowerCase(),
    );
    let queuedRepositories = 0;
    let deduplicatedRepositories = 0;

    for (const repository of matching) {
      if (inProgressRepositoryStatuses.has(repository.status)) {
        const existingJob = await IndexingJobModel.findOne({
          repositoryId: repository._id,
          status: trusted({ $in: inProgressJobStatuses }),
        })
          .sort({ createdAt: -1 })
          .lean()
          .exec();
        if (existingJob) {
          deduplicatedRepositories += 1;
          continue;
        }
      }

      repository.owner = input.owner;
      repository.name = input.repository;
      repository.fullName = input.fullName;
      repository.private = input.private;
      repository.defaultBranch = input.defaultBranch;
      repository.status = "queued";
      repository.set("githubAccessRevokedAt", undefined);
      repository.set("errorMessage", undefined);
      await repository.save();

      const data: RepositoryIndexingJobData = {
        repositoryId: repository._id.toString(),
        userId: repository.userId.toString(),
        repositoryUrl: input.repositoryUrl,
        branch: input.branch,
        requestedAt: new Date().toISOString(),
      };

      try {
        const queued = await this.producer.enqueue(data);
        await IndexingJobModel.findOneAndUpdate(
          { bullJobId: queued.jobId },
          {
            $setOnInsert: {
              repositoryId: repository._id,
              status: "waiting",
              progress: 0,
              currentStep: "queued",
            },
          },
          { upsert: true, runValidators: true },
        ).exec();
        queuedRepositories += 1;
      } catch (cause) {
        repository.status = "failed";
        repository.errorMessage = "The indexing queue is unavailable";
        await repository.save();
        throw cause;
      }
    }

    return {
      matchedRepositories: matching.length,
      queuedRepositories,
      deduplicatedRepositories,
    };
  }

  async revokeInstallation(installationId: number): Promise<number> {
    const repositories = await RepositoryModel.find({ installationId })
      .select("_id")
      .lean()
      .exec();
    return this.revokeRepositoryDocuments(
      repositories.map((repository) => repository._id),
    );
  }

  async revokeRepositories(
    installationId: number,
    githubRepositoryIds: readonly number[],
  ): Promise<number> {
    const repositories = await RepositoryModel.find({
      installationId,
      githubRepositoryId: trusted({ $in: [...githubRepositoryIds] }),
    })
      .select("_id")
      .lean()
      .exec();
    return this.revokeRepositoryDocuments(
      repositories.map((repository) => repository._id),
    );
  }

  private async revokeRepositoryDocuments(
    repositoryIds: readonly Types.ObjectId[],
  ): Promise<number> {
    if (repositoryIds.length === 0) {
      return 0;
    }
    const now = new Date();
    await RepositoryModel.updateMany(
      { _id: trusted({ $in: [...repositoryIds] }) },
      {
        $set: {
          status: "failed",
          githubAccessRevokedAt: now,
          errorMessage: revokedMessage,
        },
      },
      { runValidators: true },
    ).exec();
    await IndexingJobModel.updateMany(
      {
        repositoryId: trusted({ $in: [...repositoryIds] }),
        status: trusted({ $in: inProgressJobStatuses }),
      },
      {
        $set: {
          status: "cancelled",
          errorMessage: revokedMessage,
          completedAt: now,
        },
      },
      { runValidators: true },
    ).exec();
    return repositoryIds.length;
  }
}
