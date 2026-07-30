import {
  IndexingJobModel,
  RepositoryModel,
  type IndexingJobStatus,
  type RepositoryStatus,
} from "@codebase-explainer/database";
import {
  normalizePublicGitHubRepository,
  validateGitBranch,
} from "@codebase-explainer/repository";
import type { RepositoryIndexingJobData } from "@codebase-explainer/shared";
import { Types, trusted } from "mongoose";

import {
  getDefaultRepositoryIndexingQueue,
  type RepositoryIndexingQueueContract,
} from "../queues/repository-indexing.queue.js";

const objectIdPattern = /^[0-9a-f]{24}$/iu;
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

export type ImportPublicRepositoryInput = {
  authenticatedUserId: string;
  repositoryUrl: string;
  branch?: string;
};

export type RepositoryIndexingResult = {
  repositoryId: string;
  jobId: string;
  status: "queued";
  deduplicated: boolean;
};

export type RepositoryIndexingStatusResult = {
  repositoryId: string;
  status: RepositoryStatus;
  selectedBranch: string;
  lastIndexedCommit?: string;
  indexedAt?: string;
  errorMessage?: string;
  stats: {
    files: number;
    chunks: number;
  };
  job?: {
    id: string;
    status: IndexingJobStatus;
    progress: number;
    currentStep?: string;
    errorMessage?: string;
  };
};

export type RepositoryCancellationResult = {
  repositoryId: string;
  jobId: string;
  status: "cancelled";
};

export type RepositoryImportErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "PRIVATE_REPOSITORY_UNSUPPORTED"
  | "INDEXING_QUEUE_UNAVAILABLE"
  | "INDEXING_JOB_NOT_FOUND"
  | "INDEXING_ALREADY_FINISHED"
  | "PERSISTENCE_FAILED";

export class RepositoryImportError extends Error {
  override readonly name = "RepositoryImportError";

  constructor(
    readonly code: RepositoryImportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RepositoryImportServiceContract {
  importPublic(
    input: ImportPublicRepositoryInput,
  ): Promise<RepositoryIndexingResult>;
  enqueueExisting(
    authenticatedUserId: string,
    repositoryId: string,
  ): Promise<RepositoryIndexingResult>;
  getStatus(
    authenticatedUserId: string,
    repositoryId: string,
  ): Promise<RepositoryIndexingStatusResult>;
  cancel(
    authenticatedUserId: string,
    repositoryId: string,
  ): Promise<RepositoryCancellationResult>;
}

function toObjectId(value: string, fieldName: string): Types.ObjectId {
  if (!objectIdPattern.test(value)) {
    throw new RepositoryImportError(
      "INVALID_REQUEST",
      `${fieldName} must be a MongoDB ObjectId`,
    );
  }
  return new Types.ObjectId(value);
}

function sanitizeBranch(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }

  try {
    return validateGitBranch(branch);
  } catch (error) {
    throw new RepositoryImportError(
      "INVALID_REQUEST",
      "Git branch name is invalid",
      { cause: error },
    );
  }
}

export class RepositoryImportService implements RepositoryImportServiceContract {
  constructor(private readonly queue: RepositoryIndexingQueueContract) {}

  async importPublic(
    input: ImportPublicRepositoryInput,
  ): Promise<RepositoryIndexingResult> {
    const userId = toObjectId(input.authenticatedUserId, "Authenticated user ID");
    const branch = sanitizeBranch(input.branch);
    let normalized;

    try {
      normalized = normalizePublicGitHubRepository(input.repositoryUrl);
    } catch (error) {
      throw new RepositoryImportError(
        "INVALID_REQUEST",
        "A canonical public GitHub repository URL is required",
        { cause: error },
      );
    }

    try {
      let repository = await RepositoryModel.findOne({
        userId,
        fullName: normalized.fullName,
      }).exec();

      if (repository?.private) {
        throw new RepositoryImportError(
          "PRIVATE_REPOSITORY_UNSUPPORTED",
          "Private repositories are not supported in the public MVP",
        );
      }

      if (repository && inProgressRepositoryStatuses.has(repository.status)) {
        const existingJob = await IndexingJobModel.findOne({
          repositoryId: repository._id,
          status: trusted({ $in: inProgressJobStatuses }),
        })
          .sort({ createdAt: -1 })
          .lean()
          .exec();
        if (existingJob) {
          return {
            repositoryId: repository._id.toString(),
            jobId: existingJob.bullJobId,
            status: "queued",
            deduplicated: true,
          };
        }
      }

      if (!repository) {
        repository = await RepositoryModel.create({
          userId,
          owner: normalized.owner,
          name: normalized.name,
          fullName: normalized.fullName,
          private: false,
          selectedBranch: branch ?? "HEAD",
          defaultBranch: branch ?? "HEAD",
          status: "queued",
        });
      } else {
        repository.owner = normalized.owner;
        repository.name = normalized.name;
        repository.status = "queued";
        repository.set("errorMessage", undefined);
        if (branch !== undefined) {
          repository.selectedBranch = branch;
        }
        await repository.save();
      }

      return await this.enqueueRepository(
        repository._id.toString(),
        userId.toHexString(),
        normalized.htmlUrl,
        branch,
      );
    } catch (error) {
      if (error instanceof RepositoryImportError) {
        throw error;
      }
      throw new RepositoryImportError(
        "PERSISTENCE_FAILED",
        "The repository import could not be persisted",
        { cause: error },
      );
    }
  }

  async enqueueExisting(
    authenticatedUserId: string,
    repositoryId: string,
  ): Promise<RepositoryIndexingResult> {
    const canonicalUserId = toObjectId(
      authenticatedUserId,
      "Authenticated user ID",
    ).toHexString();
    const canonicalRepositoryId = toObjectId(
      repositoryId,
      "Repository ID",
    ).toHexString();
    const repository = await this.requireOwnedRepository(
      canonicalUserId,
      canonicalRepositoryId,
    );
    if (repository.private) {
      throw new RepositoryImportError(
        "PRIVATE_REPOSITORY_UNSUPPORTED",
        "Private repositories are not supported in the public MVP",
      );
    }

    if (inProgressRepositoryStatuses.has(repository.status)) {
      const existingJob = await IndexingJobModel.findOne({
        repositoryId: repository._id,
        status: trusted({ $in: inProgressJobStatuses }),
      })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
      if (existingJob) {
        return {
          repositoryId: canonicalRepositoryId,
          jobId: existingJob.bullJobId,
          status: "queued",
          deduplicated: true,
        };
      }
    }

    repository.status = "queued";
    repository.set("errorMessage", undefined);
    await repository.save();
    return this.enqueueRepository(
      canonicalRepositoryId,
      canonicalUserId,
      `https://github.com/${repository.fullName}`,
      repository.selectedBranch === "HEAD"
        ? undefined
        : repository.selectedBranch,
    );
  }

  async getStatus(
    authenticatedUserId: string,
    repositoryId: string,
  ): Promise<RepositoryIndexingStatusResult> {
    const canonicalRepositoryId = toObjectId(
      repositoryId,
      "Repository ID",
    ).toHexString();
    const repository = await this.requireOwnedRepository(
      authenticatedUserId,
      canonicalRepositoryId,
    );
    const job = await IndexingJobModel.findOne({ repositoryId: repository._id })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return {
      repositoryId: canonicalRepositoryId,
      status: repository.status,
      selectedBranch: repository.selectedBranch,
      ...(repository.lastIndexedCommit === undefined
        ? {}
        : { lastIndexedCommit: repository.lastIndexedCommit }),
      ...(repository.indexedAt === undefined
        ? {}
        : { indexedAt: repository.indexedAt.toISOString() }),
      ...(repository.errorMessage === undefined
        ? {}
        : { errorMessage: repository.errorMessage }),
      stats: {
        files: repository.stats.files,
        chunks: repository.stats.chunks,
      },
      ...(job
        ? {
            job: {
              id: job.bullJobId,
              status: job.status,
              progress: job.progress,
              ...(job.currentStep === undefined
                ? {}
                : { currentStep: job.currentStep }),
              ...(job.errorMessage === undefined
                ? {}
                : { errorMessage: job.errorMessage }),
            },
          }
        : {}),
    };
  }

  async cancel(
    authenticatedUserId: string,
    repositoryId: string,
  ): Promise<RepositoryCancellationResult> {
    const canonicalRepositoryId = toObjectId(
      repositoryId,
      "Repository ID",
    ).toHexString();
    const repository = await this.requireOwnedRepository(
      authenticatedUserId,
      canonicalRepositoryId,
    );
    const job = await IndexingJobModel.findOne({
      repositoryId: repository._id,
      status: trusted({ $in: inProgressJobStatuses }),
    })
      .sort({ createdAt: -1 })
      .exec();

    if (!job) {
      throw new RepositoryImportError(
        "INDEXING_JOB_NOT_FOUND",
        "No cancellable indexing job was found",
      );
    }

    let cancellation;
    try {
      cancellation = await this.queue.cancel(
        job.bullJobId,
        canonicalRepositoryId,
      );
    } catch (error) {
      throw new RepositoryImportError(
        "INDEXING_QUEUE_UNAVAILABLE",
        "The indexing queue is unavailable",
        { cause: error },
      );
    }

    if (cancellation === "finished") {
      throw new RepositoryImportError(
        "INDEXING_ALREADY_FINISHED",
        "The indexing job has already finished",
      );
    }

    job.status = "cancelled";
    job.errorMessage = "Repository indexing was cancelled";
    job.completedAt = new Date();
    repository.status = "failed";
    repository.errorMessage = "Repository indexing was cancelled";
    await Promise.all([job.save(), repository.save()]);

    return {
      repositoryId: canonicalRepositoryId,
      jobId: job.bullJobId,
      status: "cancelled",
    };
  }

  private async enqueueRepository(
    repositoryId: string,
    userId: string,
    repositoryUrl: string,
    branch: string | undefined,
  ): Promise<RepositoryIndexingResult> {
    const data: RepositoryIndexingJobData = {
      repositoryId,
      userId,
      repositoryUrl,
      requestedAt: new Date().toISOString(),
      ...(branch === undefined ? {} : { branch }),
    };

    let queued;
    try {
      queued = await this.queue.enqueue(data);
    } catch (error) {
      await RepositoryModel.updateOne(
        { _id: toObjectId(repositoryId, "Repository ID") },
        {
          $set: {
            status: "failed",
            errorMessage: "The indexing queue is unavailable",
          },
        },
      ).exec();
      throw new RepositoryImportError(
        "INDEXING_QUEUE_UNAVAILABLE",
        "The indexing queue is unavailable",
        { cause: error },
      );
    }

    await IndexingJobModel.findOneAndUpdate(
      { bullJobId: queued.jobId },
      {
        $setOnInsert: {
          repositoryId: toObjectId(repositoryId, "Repository ID"),
          status: "waiting",
          progress: 0,
          currentStep: "queued",
        },
      },
      { upsert: true, runValidators: true },
    ).exec();

    return {
      repositoryId,
      jobId: queued.jobId,
      status: "queued",
      deduplicated: false,
    };
  }

  private async requireOwnedRepository(
    authenticatedUserId: string,
    repositoryId: string,
  ) {
    const repository = await RepositoryModel.findOne({
      _id: toObjectId(repositoryId, "Repository ID"),
      userId: toObjectId(authenticatedUserId, "Authenticated user ID"),
    }).exec();

    if (!repository) {
      throw new RepositoryImportError(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found",
      );
    }
    return repository;
  }
}

let defaultService: RepositoryImportService | undefined;

export function getDefaultRepositoryImportService(): RepositoryImportService {
  defaultService ??= new RepositoryImportService(
    getDefaultRepositoryIndexingQueue(),
  );
  return defaultService;
}
