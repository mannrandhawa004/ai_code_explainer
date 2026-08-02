import {
  IndexingJobModel,
  RepositoryFileModel,
  RepositoryModel,
  SymbolModel,
  type RepositoryStatus,
} from "@codebase-explainer/database";
import { Types, trusted } from "mongoose";

export type IndexableRepository = {
  id: string;
  userId: string;
  fullName: string;
  private: boolean;
  githubRepositoryId?: number;
  installationId?: number;
  githubAccessRevokedAt?: Date;
  selectedBranch: string;
  lastIndexedCommit?: string;
  pendingIndexCommit?: string;
};

export type PersistedRepositoryFile = {
  filePath: string;
  language: string;
  contentHash: string;
  sourceBytes: number;
  chunkCount?: number;
};

export type PersistedFileSummary = {
  filePath: string;
  language: string;
  contentHash: string;
  sourceBytes: number;
  chunkCount: number;
  imports: readonly string[];
  exports: readonly string[];
  symbols: readonly PersistedSymbolSummary[];
};

export type PersistedSymbolSummary = {
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  imports: readonly string[];
  references: readonly string[];
};

export type IndexingProgressPersistence = {
  bullJobId: string;
  repositoryId: string;
  userId: string;
  progress: number;
  currentStep: string;
  repositoryStatus: RepositoryStatus;
};

export type IndexingCompletionPersistence = {
  bullJobId: string;
  repositoryId: string;
  userId: string;
  branch: string;
  commitSha: string;
  files: readonly PersistedFileSummary[];
  retainedFilePaths: readonly string[];
  removedFilePaths: readonly string[];
  expectedPendingCommit?: string;
  totalFiles: number;
  totalChunks: number;
  languages: ReadonlyMap<string, number>;
};

export type IndexingCompletionResult = {
  superseded: boolean;
  pendingCommitSha?: string;
};

export type IndexingFailurePersistence = {
  bullJobId: string;
  repositoryId: string;
  userId: string;
  errorMessage: string;
  willRetry: boolean;
};

export interface IndexingPersistence {
  findRepository(repositoryId: string): Promise<IndexableRepository | null>;
  findRepositoryFiles(
    repositoryId: string,
    branch: string,
  ): Promise<PersistedRepositoryFile[]>;
  isCancellationRequested(bullJobId: string): Promise<boolean>;
  begin(input: IndexingProgressPersistence): Promise<void>;
  updateProgress(input: IndexingProgressPersistence): Promise<void>;
  complete(
    input: IndexingCompletionPersistence,
  ): Promise<IndexingCompletionResult>;
  fail(input: IndexingFailurePersistence): Promise<void>;
  cancel(input: Omit<IndexingFailurePersistence, "willRetry">): Promise<void>;
}

export class IndexingCancellationRequestedError extends Error {
  override readonly name = "IndexingCancellationRequestedError";

  constructor() {
    super("Repository indexing was cancelled");
  }
}

export class RepositoryAccessRevokedError extends Error {
  override readonly name = "RepositoryAccessRevokedError";

  constructor() {
    super("GitHub repository access was revoked");
  }
}

function objectId(value: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/u.test(value)) {
    throw new Error("Repository identifier is invalid");
  }
  return new Types.ObjectId(value);
}

function repositoryFilter(repositoryId: string, userId: string) {
  return {
    _id: objectId(repositoryId),
    userId: objectId(userId),
    githubAccessRevokedAt: trusted({ $exists: false }),
  };
}

async function requireRepositoryUpdate(
  repositoryId: string,
  userId: string,
  update: Record<string, unknown>,
): Promise<void> {
  const result = await RepositoryModel.updateOne(
    repositoryFilter(repositoryId, userId),
    update,
  ).exec();

  if (result.matchedCount !== 1) {
    const revoked = await RepositoryModel.exists({
      _id: objectId(repositoryId),
      userId: objectId(userId),
      githubAccessRevokedAt: trusted({ $exists: true }),
    });
    if (revoked) {
      throw new RepositoryAccessRevokedError();
    }
    throw new Error("Repository was not found for the indexing owner");
  }
}

export class MongoIndexingPersistence implements IndexingPersistence {
  async findRepository(
    repositoryId: string,
  ): Promise<IndexableRepository | null> {
    const repository = await RepositoryModel.findById(objectId(repositoryId))
      .select(
        "userId fullName private githubRepositoryId installationId " +
          "githubAccessRevokedAt " +
          "selectedBranch lastIndexedCommit pendingIndexCommit",
      )
      .lean()
      .exec();

    if (!repository) {
      return null;
    }

    return {
      id: repository._id.toString(),
      userId: repository.userId.toString(),
      fullName: repository.fullName,
      private: repository.private,
      ...(repository.githubRepositoryId === undefined
        ? {}
        : { githubRepositoryId: repository.githubRepositoryId }),
      ...(repository.installationId === undefined
        ? {}
        : { installationId: repository.installationId }),
      ...(repository.githubAccessRevokedAt === undefined
        ? {}
        : { githubAccessRevokedAt: repository.githubAccessRevokedAt }),
      selectedBranch: repository.selectedBranch,
      ...(repository.lastIndexedCommit === undefined
        ? {}
        : { lastIndexedCommit: repository.lastIndexedCommit }),
      ...(repository.pendingIndexCommit === undefined
        ? {}
        : { pendingIndexCommit: repository.pendingIndexCommit }),
    };
  }

  async findRepositoryFiles(
    repositoryId: string,
    branch: string,
  ): Promise<PersistedRepositoryFile[]> {
    const files = await RepositoryFileModel.find({
      repositoryId: objectId(repositoryId),
      branch,
    })
      .select("path language hash size chunkCount")
      .lean()
      .exec();
    return files.map((file) => ({
      filePath: file.path,
      language: file.language,
      contentHash: file.hash,
      sourceBytes: file.size,
      ...(file.chunkCount === undefined
        ? {}
        : { chunkCount: file.chunkCount }),
    }));
  }

  async isCancellationRequested(bullJobId: string): Promise<boolean> {
    const job = await IndexingJobModel.findOne({ bullJobId })
      .select("status")
      .lean()
      .exec();
    return job?.status === "cancelled";
  }

  async begin(input: IndexingProgressPersistence): Promise<void> {
    await Promise.all([
      requireRepositoryUpdate(input.repositoryId, input.userId, {
        $set: {
          status: input.repositoryStatus,
        },
        $unset: { errorMessage: 1 },
      }),
      IndexingJobModel.findOneAndUpdate(
        { bullJobId: input.bullJobId },
        {
          $setOnInsert: {
            repositoryId: objectId(input.repositoryId),
          },
          $set: {
            status: "active",
            progress: input.progress,
            currentStep: input.currentStep,
            startedAt: new Date(),
          },
          $unset: { completedAt: 1, errorMessage: 1 },
        },
        { upsert: true, runValidators: true },
      ).exec(),
    ]);
  }

  async updateProgress(input: IndexingProgressPersistence): Promise<void> {
    await Promise.all([
      requireRepositoryUpdate(input.repositoryId, input.userId, {
        $set: { status: input.repositoryStatus },
      }),
      IndexingJobModel.updateOne(
        {
          bullJobId: input.bullJobId,
          status: trusted({ $ne: "cancelled" }),
        },
        {
          $set: {
            status: "active",
            progress: input.progress,
            currentStep: input.currentStep,
          },
        },
        { runValidators: true },
      ).exec().then((result) => {
        if (result.matchedCount !== 1) {
          throw new IndexingCancellationRequestedError();
        }
      }),
    ]);
  }

  async complete(
    input: IndexingCompletionPersistence,
  ): Promise<IndexingCompletionResult> {
    const repositoryId = objectId(input.repositoryId);
    if (input.removedFilePaths.length > 0) {
      const removedFiles = await RepositoryFileModel.find({
        repositoryId,
        branch: input.branch,
        path: trusted({ $in: [...input.removedFilePaths] }),
      })
        .select("_id")
        .lean()
        .exec();
      const removedFileIds = removedFiles.map((file) => file._id);
      if (removedFileIds.length > 0) {
        await SymbolModel.deleteMany({
          repositoryId,
          fileId: trusted({ $in: removedFileIds }),
        }).exec();
      }
      await RepositoryFileModel.deleteMany({
        repositoryId,
        branch: input.branch,
        path: trusted({ $in: [...input.removedFilePaths] }),
      }).exec();
    }

    if (input.files.length > 0) {
      await RepositoryFileModel.bulkWrite(
        input.files.map((file) => ({
          updateOne: {
            filter: {
              repositoryId,
              branch: input.branch,
              path: file.filePath,
            },
            update: {
              $set: {
                commitSha: input.commitSha,
                language: file.language,
                hash: file.contentHash,
                size: file.sourceBytes,
                chunkCount: file.chunkCount,
                imports: [...file.imports],
                exports: [...file.exports],
                symbols: [
                  ...new Set(file.symbols.map((symbol) => symbol.name)),
                ],
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      const persistedFiles = await RepositoryFileModel.find({
        repositoryId,
        branch: input.branch,
        path: trusted({ $in: input.files.map((file) => file.filePath) }),
      })
        .select("_id path")
        .lean()
        .exec();
      const fileIdsByPath = new Map(
        persistedFiles.map((file) => [file.path, file._id]),
      );
      if (fileIdsByPath.size !== input.files.length) {
        throw new Error("Not all indexed repository files were persisted");
      }

      const fileIds = [...fileIdsByPath.values()];
      await SymbolModel.deleteMany({
        repositoryId,
        fileId: trusted({ $in: fileIds }),
      }).exec();

      const symbols = input.files.flatMap((file) => {
        const fileId = fileIdsByPath.get(file.filePath);
        if (fileId === undefined) {
          throw new Error(`Indexed repository file ${file.filePath} is missing`);
        }
        return file.symbols.map((symbol) => ({
          repositoryId,
          fileId,
          name: symbol.name,
          type: symbol.type,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          imports: [...symbol.imports],
          references: [...symbol.references],
        }));
      });
      if (symbols.length > 0) {
        await SymbolModel.insertMany(symbols, { ordered: true });
      }
    }

    if (input.retainedFilePaths.length > 0) {
      await RepositoryFileModel.updateMany(
        {
          repositoryId,
          branch: input.branch,
          path: trusted({ $in: [...input.retainedFilePaths] }),
        },
        { $set: { commitSha: input.commitSha } },
        { runValidators: true },
      ).exec();
    }

    await requireRepositoryUpdate(input.repositoryId, input.userId, {
      $set: {
        selectedBranch: input.branch,
        defaultBranch: input.branch,
        lastIndexedCommit: input.commitSha,
        "stats.files": input.totalFiles,
        "stats.chunks": input.totalChunks,
        "stats.languages": Object.fromEntries(input.languages),
      },
      $unset: { errorMessage: 1 },
    });

    const finalized = await RepositoryModel.updateOne(
      {
        ...repositoryFilter(input.repositoryId, input.userId),
        pendingIndexCommit:
          input.expectedPendingCommit === undefined
            ? trusted({ $exists: false })
            : input.expectedPendingCommit,
      },
      {
        $set: { status: "ready", indexedAt: new Date() },
        $unset: { pendingIndexCommit: 1, errorMessage: 1 },
      },
      { runValidators: true },
    ).exec();

    if (finalized.matchedCount !== 1) {
      const repository = await RepositoryModel.findOne({
        _id: repositoryId,
        userId: objectId(input.userId),
      })
        .select("githubAccessRevokedAt pendingIndexCommit")
        .lean()
        .exec();
      if (repository?.githubAccessRevokedAt !== undefined) {
        throw new RepositoryAccessRevokedError();
      }
      if (!repository) {
        throw new Error("Repository was not found for the indexing owner");
      }
      return {
        superseded: true,
        ...(repository.pendingIndexCommit === undefined
          ? {}
          : { pendingCommitSha: repository.pendingIndexCommit }),
      };
    }

    await IndexingJobModel.updateOne(
      {
        bullJobId: input.bullJobId,
        status: trusted({ $ne: "cancelled" }),
      },
      {
        $set: {
          status: "completed",
          progress: 100,
          currentStep: "completed",
          completedAt: new Date(),
        },
        $unset: { errorMessage: 1 },
      },
      { runValidators: true },
    ).exec().then((result) => {
      if (result.matchedCount !== 1) {
        throw new IndexingCancellationRequestedError();
      }
    });
    return { superseded: false };
  }

  async fail(input: IndexingFailurePersistence): Promise<void> {
    await Promise.all([
      requireRepositoryUpdate(input.repositoryId, input.userId, {
        $set: {
          status: input.willRetry ? "queued" : "failed",
          errorMessage: input.errorMessage,
        },
      }),
      IndexingJobModel.updateOne(
        { bullJobId: input.bullJobId },
        {
          $set: {
            status: input.willRetry ? "delayed" : "failed",
            errorMessage: input.errorMessage,
            ...(input.willRetry ? {} : { completedAt: new Date() }),
          },
        },
        { runValidators: true },
      ).exec(),
    ]);
  }

  async cancel(
    input: Omit<IndexingFailurePersistence, "willRetry">,
  ): Promise<void> {
    await Promise.all([
      requireRepositoryUpdate(input.repositoryId, input.userId, {
        $set: {
          status: "failed",
          errorMessage: input.errorMessage,
        },
      }),
      IndexingJobModel.updateOne(
        { bullJobId: input.bullJobId },
        {
          $set: {
            status: "cancelled",
            errorMessage: input.errorMessage,
            completedAt: new Date(),
          },
        },
        { runValidators: true },
      ).exec(),
    ]);
  }
}
