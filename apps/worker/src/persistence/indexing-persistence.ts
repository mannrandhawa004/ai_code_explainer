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
};

export type PersistedFileSummary = {
  filePath: string;
  language: string;
  contentHash: string;
  sourceBytes: number;
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
  chunks: number;
  languages: ReadonlyMap<string, number>;
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
  isCancellationRequested(bullJobId: string): Promise<boolean>;
  begin(input: IndexingProgressPersistence): Promise<void>;
  updateProgress(input: IndexingProgressPersistence): Promise<void>;
  complete(input: IndexingCompletionPersistence): Promise<void>;
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
          "selectedBranch lastIndexedCommit",
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
    };
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

  async complete(input: IndexingCompletionPersistence): Promise<void> {
    const repositoryId = objectId(input.repositoryId);
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

    await requireRepositoryUpdate(input.repositoryId, input.userId, {
      $set: {
        status: "ready",
        selectedBranch: input.branch,
        defaultBranch: input.branch,
        lastIndexedCommit: input.commitSha,
        indexedAt: new Date(),
        "stats.files": input.files.length,
        "stats.chunks": input.chunks,
        "stats.languages": Object.fromEntries(input.languages),
      },
      $unset: { errorMessage: 1 },
    });

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
