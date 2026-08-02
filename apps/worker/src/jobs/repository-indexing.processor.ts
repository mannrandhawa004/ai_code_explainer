import {
  createOpenAICodeChunkEmbeddingServiceFromEnv,
  type CodeChunkEmbeddingResult,
  type CodeChunkEmbeddingService,
} from "@codebase-explainer/ai";
import {
  PublicRepositoryCloner,
  RepositoryChunkingError,
  RepositoryCloneError,
  RepositoryFileFilter,
  RepositoryFileFilterError,
  RepositoryFileHashError,
  RepositoryFileHasher,
  RepositoryLineBasedChunker,
  RepositoryTreeSitterChunker,
  RepositoryScanError,
  defaultMaxRepositoryChunks,
  normalizePublicGitHubRepository,
  type ClonedPublicRepository,
  type FilteredRepositoryFiles,
  type HashedRepositoryFile,
  type PublicRepositoryCloneRequest,
  type RepositoryChunkingResult,
} from "@codebase-explainer/repository";
import {
  type RepositoryIndexingJobData,
  type RepositoryIndexingJobProgress,
  type RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";
import {
  QdrantCodeChunkStore,
  QdrantVectorStore,
  type CodeChunkUpsertResult,
  type CodeChunkBatchDeleteResult,
  type CodeChunkDeleteResult,
  type EnsureCollectionResult,
  type VectorStoreConfig,
} from "@codebase-explainer/vector-store";

import { env, type WorkerEnvironment } from "../config/env.js";
import {
  MongoIndexingPersistence,
  IndexingCancellationRequestedError,
  RepositoryAccessRevokedError,
  type IndexableRepository,
  type IndexingPersistence,
  type PersistedFileSummary,
} from "../persistence/indexing-persistence.js";
import {
  createIncrementalIndexingPlan,
  summarizeIncrementalIndexingPlan,
} from "../services/incremental-indexing-planner.js";
import {
  GitHubInstallationTokenProvider,
  InstallationTokenError,
  type InstallationTokenProviderContract,
} from "../services/github-installation-token.service.js";

export type IndexingJobContract = {
  id: string;
  attemptsMade: number;
  maxAttempts: number;
  updateProgress(progress: RepositoryIndexingJobProgress): Promise<void>;
};

export interface RepositoryClonerContract {
  withClone<Result>(
    request: PublicRepositoryCloneRequest,
    operation: (repository: ClonedPublicRepository) => Promise<Result>,
  ): Promise<Result>;
}

export interface RepositoryFilterContract {
  filter(
    rootDirectory: string,
    options?: Parameters<RepositoryFileFilter["filter"]>[1],
  ): Promise<FilteredRepositoryFiles>;
}

export interface RepositoryChunkerContract {
  chunkFiles(
    files: FilteredRepositoryFiles["files"],
    context: Parameters<RepositoryLineBasedChunker["chunkFiles"]>[1],
    options?: Parameters<RepositoryLineBasedChunker["chunkFiles"]>[2],
  ): Promise<RepositoryChunkingResult>;
}

export interface RepositoryFileHasherContract {
  hashFiles(
    files: readonly FilteredRepositoryFiles["files"][number][],
    options: {
      maxFileBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<HashedRepositoryFile[]>;
}

export interface CodeChunkEmbedderContract {
  embedChunks(
    chunks: RepositoryChunkingResult["chunks"],
    options?: Parameters<CodeChunkEmbeddingService["embedChunks"]>[1],
  ): Promise<CodeChunkEmbeddingResult>;
}

export interface VectorCollectionContract {
  ensureCollection(): Promise<EnsureCollectionResult>;
}

export interface CodeChunkStoreContract {
  upsert(
    items: CodeChunkEmbeddingResult["items"],
    options?: Parameters<QdrantCodeChunkStore["upsert"]>[1],
  ): Promise<CodeChunkUpsertResult>;
  deleteRepositoryChunks(
    selector: Parameters<QdrantCodeChunkStore["deleteRepositoryChunks"]>[0],
    options?: Parameters<QdrantCodeChunkStore["deleteRepositoryChunks"]>[1],
  ): Promise<CodeChunkDeleteResult>;
  deleteFileChunks(
    selector: Parameters<QdrantCodeChunkStore["deleteFileChunks"]>[0],
    options?: Parameters<QdrantCodeChunkStore["deleteFileChunks"]>[1],
  ): Promise<CodeChunkBatchDeleteResult>;
  promoteRepositoryCommit(
    input: Parameters<QdrantCodeChunkStore["promoteRepositoryCommit"]>[0],
    options?: Parameters<QdrantCodeChunkStore["promoteRepositoryCommit"]>[1],
  ): Promise<CodeChunkDeleteResult>;
}

export type RepositoryIndexingProcessorDependencies = {
  persistence: IndexingPersistence;
  cloner: RepositoryClonerContract;
  filter: RepositoryFilterContract;
  hasher: RepositoryFileHasherContract;
  chunker: RepositoryChunkerContract;
  embedder: CodeChunkEmbedderContract;
  vectorCollection: VectorCollectionContract;
  chunkStore: CodeChunkStoreContract;
  installationTokenProvider?: InstallationTokenProviderContract;
};

export type RepositoryIndexingLimits = {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
};

export type RepositoryIndexingErrorCode =
  | "INVALID_JOB"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_ACCESS_DENIED"
  | "PRIVATE_REPOSITORY_ACCESS_DENIED"
  | "REPOSITORY_MISMATCH"
  | "INDEXING_CANCELLED"
  | "REPOSITORY_LIMIT_EXCEEDED"
  | "INDEXING_DEPENDENCY_FAILED";

export class RepositoryIndexingError extends Error {
  override readonly name = "RepositoryIndexingError";

  constructor(
    readonly code: RepositoryIndexingErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const progressStages = {
  cloning: {
    percentage: 5,
    step: "cloning",
    message: "Cloning the repository",
    repositoryStatus: "cloning",
  },
  scanning: {
    percentage: 20,
    step: "scanning",
    message: "Scanning and filtering source files",
    repositoryStatus: "scanning",
  },
  chunking: {
    percentage: 40,
    step: "chunking",
    message: "Creating source-code chunks",
    repositoryStatus: "parsing",
  },
  embedding: {
    percentage: 65,
    step: "embedding",
    message: "Generating code embeddings",
    repositoryStatus: "embedding",
  },
  indexing: {
    percentage: 85,
    step: "indexing",
    message: "Persisting vectors and file metadata",
    repositoryStatus: "indexing",
  },
} as const;

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepositoryIndexingError(
      "INDEXING_CANCELLED",
      "Repository indexing was cancelled",
      false,
      { cause: signal.reason },
    );
  }
}

function isLimitError(error: unknown): boolean {
  return (
    (error instanceof RepositoryFileFilterError &&
      (error.code === "MAX_FILES_EXCEEDED" ||
        error.code === "MAX_TOTAL_BYTES_EXCEEDED")) ||
    (error instanceof RepositoryScanError &&
      (error.code === "MAX_ENTRIES_EXCEEDED" ||
        error.code === "MAX_DEPTH_EXCEEDED")) ||
    (error instanceof RepositoryFileHashError &&
      error.code === "FILE_TOO_LARGE") ||
    (error instanceof RepositoryChunkingError && error.code.startsWith("MAX_"))
  );
}

function normalizeIndexingError(
  error: unknown,
  signal: AbortSignal | undefined,
): RepositoryIndexingError {
  if (error instanceof RepositoryIndexingError) {
    return error;
  }

  if (error instanceof IndexingCancellationRequestedError) {
    return new RepositoryIndexingError(
      "INDEXING_CANCELLED",
      "Repository indexing was cancelled",
      false,
      { cause: error },
    );
  }

  if (error instanceof RepositoryAccessRevokedError) {
    return new RepositoryIndexingError(
      "REPOSITORY_ACCESS_DENIED",
      "GitHub repository access has been revoked",
      false,
      { cause: error },
    );
  }

  if (signal?.aborted) {
    return new RepositoryIndexingError(
      "INDEXING_CANCELLED",
      "Repository indexing was cancelled",
      false,
      { cause: signal.reason ?? error },
    );
  }

  if (isLimitError(error)) {
    return new RepositoryIndexingError(
      "REPOSITORY_LIMIT_EXCEEDED",
      error instanceof Error ? error.message : "Repository safety limit exceeded",
      false,
      { cause: error },
    );
  }

  if (
    error instanceof RepositoryCloneError &&
    (error.code === "INVALID_REPOSITORY_URL" || error.code === "INVALID_BRANCH")
  ) {
    return new RepositoryIndexingError(
      "INVALID_JOB",
      error.message,
      false,
      { cause: error },
    );
  }

  if (error instanceof InstallationTokenError) {
    return new RepositoryIndexingError(
      error.code === "ACCESS_DENIED"
        ? "PRIVATE_REPOSITORY_ACCESS_DENIED"
        : "INDEXING_DEPENDENCY_FAILED",
      error.message,
      error.code === "GITHUB_UNAVAILABLE",
      { cause: error },
    );
  }

  if (
    error instanceof RepositoryFileFilterError ||
    error instanceof RepositoryFileHashError ||
    error instanceof RepositoryScanError ||
    error instanceof RepositoryChunkingError
  ) {
    return new RepositoryIndexingError(
      "INVALID_JOB",
      "Repository source files could not be processed safely",
      false,
      { cause: error },
    );
  }

  return new RepositoryIndexingError(
    "INDEXING_DEPENDENCY_FAILED",
    "A repository indexing dependency is unavailable",
    true,
    { cause: error },
  );
}

const maximumCoalescedIndexingCycles = 3;

function validateRepository(
  repository: IndexableRepository | null,
  data: RepositoryIndexingJobData,
): IndexableRepository {
  if (!repository) {
    throw new RepositoryIndexingError(
      "REPOSITORY_NOT_FOUND",
      "Repository was not found",
      false,
    );
  }

  if (repository.userId !== data.userId) {
    throw new RepositoryIndexingError(
      "REPOSITORY_ACCESS_DENIED",
      "Repository indexing ownership could not be verified",
      false,
    );
  }

  if (repository.githubAccessRevokedAt !== undefined) {
    throw new RepositoryIndexingError(
      "REPOSITORY_ACCESS_DENIED",
      "GitHub repository access has been revoked",
      false,
    );
  }

  let fullName: string;
  try {
    fullName = normalizePublicGitHubRepository(data.repositoryUrl).fullName;
  } catch (error) {
    throw new RepositoryIndexingError(
      "INVALID_JOB",
      "Repository URL is invalid",
      false,
      { cause: error },
    );
  }

  if (fullName.toLowerCase() !== repository.fullName.toLowerCase()) {
    throw new RepositoryIndexingError(
      "REPOSITORY_MISMATCH",
      "Queued repository does not match the persisted repository",
      false,
    );
  }

  return repository;
}

export class RepositoryIndexingProcessor {
  constructor(
    private readonly dependencies: RepositoryIndexingProcessorDependencies,
    private readonly limits: RepositoryIndexingLimits,
  ) {}

  async process(
    job: IndexingJobContract,
    data: RepositoryIndexingJobData,
    signal?: AbortSignal,
  ): Promise<RepositoryIndexingJobResult> {
    assertNotCancelled(signal);
    let repository = validateRepository(
      await this.dependencies.persistence.findRepository(data.repositoryId),
      data,
    );
    let filesIndexed = 0;
    let chunksIndexed = 0;
    let embeddingTokens = 0;

    try {
      for (
        let cycleIndex = 0;
        cycleIndex < maximumCoalescedIndexingCycles;
        cycleIndex += 1
      ) {
        if (cycleIndex > 0) {
          repository = validateRepository(
            await this.dependencies.persistence.findRepository(
              data.repositoryId,
            ),
            data,
          );
        }
        const cycle = await this.processCycle(
          job,
          data,
          repository,
          signal,
        );
        filesIndexed += cycle.result.filesIndexed;
        chunksIndexed += cycle.result.chunksIndexed;
        embeddingTokens += cycle.result.embeddingTokens;

        if (!cycle.superseded) {
          await job.updateProgress({
            percentage: 100,
            step: "completed",
            message: "Repository indexing completed",
          });
          return {
            ...cycle.result,
            filesIndexed,
            chunksIndexed,
            embeddingTokens,
          };
        }
      }

      throw new RepositoryIndexingError(
        "INDEXING_DEPENDENCY_FAILED",
        "New repository updates are waiting to be indexed",
        true,
      );
    } catch (error) {
      const normalized = normalizeIndexingError(error, signal);

      if (
        error instanceof RepositoryAccessRevokedError ||
        (normalized.code === "REPOSITORY_ACCESS_DENIED" &&
          repository.githubAccessRevokedAt !== undefined)
      ) {
        throw normalized;
      }

      try {
        if (normalized.code === "INDEXING_CANCELLED") {
          await this.dependencies.persistence.cancel({
            bullJobId: job.id,
            repositoryId: data.repositoryId,
            userId: data.userId,
            errorMessage: normalized.message,
          });
        } else {
          const attemptsRemaining = Math.max(
            0,
            job.maxAttempts - (job.attemptsMade + 1),
          );
          await this.dependencies.persistence.fail({
            bullJobId: job.id,
            repositoryId: data.repositoryId,
            userId: data.userId,
            errorMessage: normalized.message,
            willRetry: normalized.retryable && attemptsRemaining > 0,
          });
        }
      } catch (persistenceError) {
        if (persistenceError instanceof RepositoryAccessRevokedError) {
          throw new RepositoryIndexingError(
            "REPOSITORY_ACCESS_DENIED",
            "GitHub repository access has been revoked",
            false,
            { cause: persistenceError },
          );
        }
        throw new RepositoryIndexingError(
          "INDEXING_DEPENDENCY_FAILED",
          "Repository indexing failed and its status could not be persisted",
          true,
          { cause: persistenceError },
        );
      }

      throw normalized;
    }
  }

  private async processCycle(
    job: IndexingJobContract,
    data: RepositoryIndexingJobData,
    repository: IndexableRepository,
    signal: AbortSignal | undefined,
  ): Promise<{
    result: RepositoryIndexingJobResult;
    superseded: boolean;
  }> {
    const expectedPendingCommit = repository.pendingIndexCommit;
    await this.reportProgress(job, data, progressStages.cloning, true);
    const accessToken = await this.privateRepositoryAccessToken(repository);

    return this.dependencies.cloner.withClone(
      {
        repositoryUrl: data.repositoryUrl,
        ...(data.branch === undefined ? {} : { branch: data.branch }),
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(signal === undefined ? {} : { signal }),
      },
      async (clonedRepository) => {
        if (
          clonedRepository.fullName.toLowerCase() !==
          repository.fullName.toLowerCase()
        ) {
          throw new RepositoryIndexingError(
            "REPOSITORY_MISMATCH",
            "Cloned repository does not match the persisted repository",
            false,
          );
        }

        await this.reportProgress(job, data, progressStages.scanning);
        const filtered = await this.dependencies.filter.filter(
          clonedRepository.directory,
          {
            maxFiles: this.limits.maxFiles,
            maxTotalBytes: this.limits.maxTotalBytes,
            maxFileBytes: this.limits.maxFileBytes,
            scanOptions: {
              fileSystemErrors: "skip",
              ...(signal === undefined ? {} : { signal }),
            },
          },
        );
        const [hashedFiles, persistedFiles] = await Promise.all([
          this.dependencies.hasher.hashFiles(filtered.files, {
            maxFileBytes: this.limits.maxFileBytes,
            ...(signal === undefined ? {} : { signal }),
          }),
          this.dependencies.persistence.findRepositoryFiles(
            data.repositoryId,
            clonedRepository.branch,
          ),
        ]);
        const plan = createIncrementalIndexingPlan({
          lastIndexedCommit: repository.lastIndexedCommit,
          currentFiles: hashedFiles,
          persistedFiles,
        });

        await this.reportProgress(job, data, progressStages.chunking);
        const chunked = await this.dependencies.chunker.chunkFiles(
          plan.changedFiles,
          {
            userId: data.userId,
            repositoryId: data.repositoryId,
            branch: clonedRepository.branch,
            commitSha: clonedRepository.commitSha,
          },
          signal === undefined ? {} : { signal },
        );

        const fileSummaries: PersistedFileSummary[] =
          chunked.fileSummaries.map((file) => ({
            filePath: file.filePath,
            language: file.language,
            contentHash: file.contentHash,
            sourceBytes: file.sourceBytes,
            chunkCount: file.chunkCount,
            imports: file.imports,
            exports: file.exports,
            symbols: file.symbols,
          }));
        const stats = summarizeIncrementalIndexingPlan(plan, fileSummaries);
        if (stats.totalChunks > defaultMaxRepositoryChunks) {
          throw new RepositoryIndexingError(
            "REPOSITORY_LIMIT_EXCEEDED",
            `Repository would contain more than ${defaultMaxRepositoryChunks} chunks`,
            false,
          );
        }

        await this.reportProgress(job, data, progressStages.embedding);
        const embedded = await this.dependencies.embedder.embedChunks(
          chunked.chunks,
          {
            repositoryLabel: clonedRepository.fullName,
            endUserId: data.userId,
            ...(signal === undefined ? {} : { signal }),
          },
        );

        await this.reportProgress(job, data, progressStages.indexing);
        await this.dependencies.vectorCollection.ensureCollection();
        const vectorOptions =
          signal === undefined ? { wait: true } : { signal, wait: true };
        if (plan.mode === "full") {
          await this.dependencies.chunkStore.deleteRepositoryChunks(
            {
              userId: data.userId,
              repositoryId: data.repositoryId,
              branch: clonedRepository.branch,
            },
            vectorOptions,
          );
        } else {
          await this.dependencies.chunkStore.deleteFileChunks(
            {
              userId: data.userId,
              repositoryId: data.repositoryId,
              branch: clonedRepository.branch,
              filePaths: [
                ...plan.changedFiles.map((file) => file.relativePath),
                ...plan.removedFilePaths,
              ],
            },
            vectorOptions,
          );
        }
        await this.dependencies.chunkStore.upsert(
          embedded.items,
          vectorOptions,
        );
        if (plan.mode === "incremental") {
          await this.dependencies.chunkStore.promoteRepositoryCommit(
            {
              userId: data.userId,
              repositoryId: data.repositoryId,
              branch: clonedRepository.branch,
              toCommitSha: clonedRepository.commitSha,
            },
            vectorOptions,
          );
        }
        assertNotCancelled(signal);
        if (
          await this.dependencies.persistence.isCancellationRequested(job.id)
        ) {
          throw new RepositoryIndexingError(
            "INDEXING_CANCELLED",
            "Repository indexing was cancelled",
            false,
          );
        }

        const completion = await this.dependencies.persistence.complete({
          bullJobId: job.id,
          repositoryId: data.repositoryId,
          userId: data.userId,
          branch: clonedRepository.branch,
          commitSha: clonedRepository.commitSha,
          files: fileSummaries,
          retainedFilePaths: plan.retainedFiles.map((file) => file.filePath),
          removedFilePaths: plan.removedFilePaths,
          ...(expectedPendingCommit === undefined
            ? {}
            : { expectedPendingCommit }),
          totalFiles: stats.totalFiles,
          totalChunks: stats.totalChunks,
          languages: stats.languages,
        });

        return {
          result: {
            repositoryId: data.repositoryId,
            branch: clonedRepository.branch,
            commitSha: clonedRepository.commitSha,
            filesIndexed: fileSummaries.length,
            chunksIndexed: embedded.items.length,
            embeddingModel: embedded.model,
            embeddingTokens: embedded.usage.totalTokens,
          },
          superseded: completion.superseded,
        };
      },
    );
  }

  private async reportProgress(
    job: IndexingJobContract,
    data: RepositoryIndexingJobData,
    stage: (typeof progressStages)[keyof typeof progressStages],
    beginning = false,
  ): Promise<void> {
    if (
      await this.dependencies.persistence.isCancellationRequested(job.id)
    ) {
      throw new RepositoryIndexingError(
        "INDEXING_CANCELLED",
        "Repository indexing was cancelled",
        false,
      );
    }

    const progress: RepositoryIndexingJobProgress = {
      percentage: stage.percentage,
      step: stage.step,
      message: stage.message,
    };
    const persistenceInput = {
      bullJobId: job.id,
      repositoryId: data.repositoryId,
      userId: data.userId,
      progress: stage.percentage,
      currentStep: stage.step,
      repositoryStatus: stage.repositoryStatus,
    };

    if (beginning) {
      await this.dependencies.persistence.begin(persistenceInput);
    } else {
      await this.dependencies.persistence.updateProgress(persistenceInput);
    }
    await job.updateProgress(progress);
  }

  private async privateRepositoryAccessToken(
    repository: IndexableRepository,
  ): Promise<string | undefined> {
    if (!repository.private) {
      return undefined;
    }
    if (
      repository.installationId === undefined ||
      repository.githubRepositoryId === undefined ||
      !this.dependencies.installationTokenProvider
    ) {
      throw new RepositoryIndexingError(
        "PRIVATE_REPOSITORY_ACCESS_DENIED",
        "Private repository access could not be verified",
        false,
      );
    }
    return this.dependencies.installationTokenProvider.createRepositoryToken({
      installationId: repository.installationId,
      repositoryId: repository.githubRepositoryId,
    });
  }
}

function createVectorStoreConfig(
  environment: WorkerEnvironment,
): VectorStoreConfig {
  return {
    url: environment.QDRANT_URL,
    apiKey: environment.QDRANT_API_KEY,
    collectionName: environment.QDRANT_COLLECTION,
    vectorSize: environment.QDRANT_VECTOR_SIZE,
    requestTimeoutMs: environment.QDRANT_REQUEST_TIMEOUT_MS,
  };
}

export function createDefaultRepositoryIndexingProcessor(
  environment: WorkerEnvironment = env,
): RepositoryIndexingProcessor {
  const vectorConfig = createVectorStoreConfig(environment);
  const vectorCollection = new QdrantVectorStore(vectorConfig);

  return new RepositoryIndexingProcessor(
    {
      persistence: new MongoIndexingPersistence(),
      cloner: new PublicRepositoryCloner({
        ...(environment.TEMP_REPOSITORY_DIR === undefined
          ? {}
          : { tempRoot: environment.TEMP_REPOSITORY_DIR }),
      }),
      filter: new RepositoryFileFilter(),
      hasher: new RepositoryFileHasher(),
      chunker: new RepositoryTreeSitterChunker(),
      embedder: createOpenAICodeChunkEmbeddingServiceFromEnv(process.env),
      vectorCollection,
      chunkStore: new QdrantCodeChunkStore(vectorConfig, vectorCollection.client),
      ...(environment.GITHUB_APP_ID && environment.GITHUB_PRIVATE_KEY
        ? {
            installationTokenProvider: new GitHubInstallationTokenProvider(
              environment.GITHUB_APP_ID,
              environment.GITHUB_PRIVATE_KEY,
            ),
          }
        : {}),
    },
    {
      maxFiles: environment.MAX_REPOSITORY_FILES,
      maxTotalBytes: environment.MAX_REPOSITORY_SIZE_MB * 1024 * 1024,
      maxFileBytes: environment.MAX_FILE_SIZE_KB * 1024,
    },
  );
}
