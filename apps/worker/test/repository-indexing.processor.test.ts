import type { CodeChunkEmbeddingResult } from "@codebase-explainer/ai";
import type {
  ClonedPublicRepository,
  FilteredRepositoryFiles,
  RepositoryChunkingResult,
} from "@codebase-explainer/repository";
import { CodeChunkStoreError } from "@codebase-explainer/vector-store";
import { describe, expect, it, vi } from "vitest";

import {
  RepositoryIndexingError,
  RepositoryIndexingProcessor,
  type IndexingJobContract,
  type RepositoryIndexingProcessorDependencies,
} from "../src/jobs/repository-indexing.processor.js";
import type { IndexingPersistence } from "../src/persistence/indexing-persistence.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const repositoryUrl = "https://github.com/owner/repository";
const jobData = {
  repositoryId,
  userId,
  repositoryUrl,
  requestedAt: "2026-07-30T12:00:00.000Z",
  branch: "main",
};

const clonedRepository: ClonedPublicRepository = {
  owner: "owner",
  name: "repository",
  fullName: "owner/repository",
  htmlUrl: repositoryUrl,
  cloneUrl: `${repositoryUrl}.git`,
  directory: "C:/temporary/repository",
  branch: "main",
  commitSha,
};

const filtered: FilteredRepositoryFiles = {
  rootDirectory: clonedRepository.directory,
  files: [],
  totalBytes: 20,
  exclusions: [],
  scanSummary: {
    directoriesVisited: 1,
    entriesVisited: 1,
    skippedSymlinks: [],
    skippedSpecialFiles: [],
    skippedUnreadable: [],
  },
};

const chunked: RepositoryChunkingResult = {
  chunks: [
    {
      id: "11111111-1111-8111-8111-111111111111",
      userId,
      repositoryId,
      branch: "main",
      commitSha,
      filePath: "src/index.ts",
      language: "typescript",
      symbolType: "file",
      symbolName: "src/index.ts",
      startLine: 1,
      endLine: 1,
      chunkIndex: 0,
      content: "export const ready = true;",
      contentHash: "a".repeat(64),
      imports: [],
      exports: [],
    },
  ],
  fileSummaries: [
    {
      filePath: "src/index.ts",
      language: "typescript",
      sourceBytes: 26,
      sourceCharacters: 26,
      contentHash: "a".repeat(64),
      chunkCount: 1,
    },
  ],
  filesProcessed: 1,
  totalSourceBytes: 26,
  totalSourceCharacters: 26,
};

const embedded: CodeChunkEmbeddingResult = {
  items: [
    {
      chunk: chunked.chunks[0]!,
      embedding: [0.1, 0.2],
      embeddingModel: "test-embedding-model",
      embeddingDimensions: 2,
      embeddingTokenCount: 8,
      embeddingInputHash: "b".repeat(64),
    },
  ],
  model: "test-embedding-model",
  dimensions: 2,
  usage: { promptTokens: 8, totalTokens: 8, requests: 1, uniqueInputs: 1 },
};

function createPersistence(): IndexingPersistence {
  return {
    findRepository: vi.fn().mockResolvedValue({
      id: repositoryId,
      userId,
      fullName: "owner/repository",
      private: false,
      selectedBranch: "main",
    }),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    begin: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

function createDependencies(
  persistence: IndexingPersistence = createPersistence(),
): RepositoryIndexingProcessorDependencies {
  return {
    persistence,
    cloner: {
      withClone: vi.fn(async (_request, operation) =>
        operation(clonedRepository),
      ),
    },
    filter: { filter: vi.fn().mockResolvedValue(filtered) },
    chunker: { chunkFiles: vi.fn().mockResolvedValue(chunked) },
    embedder: { embedChunks: vi.fn().mockResolvedValue(embedded) },
    vectorCollection: {
      ensureCollection: vi.fn().mockResolvedValue({
        collectionName: "code_chunks",
        status: "existing",
        indexedFields: [],
      }),
    },
    chunkStore: {
      upsert: vi.fn().mockResolvedValue({
        collectionName: "code_chunks",
        pointsUpserted: 1,
        batches: 1,
        operationIds: [1],
        status: "completed",
      }),
    },
  };
}

function createJob(): IndexingJobContract {
  return {
    id: "job-1",
    attemptsMade: 0,
    maxAttempts: 3,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function createProcessor(dependencies: RepositoryIndexingProcessorDependencies) {
  return new RepositoryIndexingProcessor(dependencies, {
    maxFiles: 5_000,
    maxTotalBytes: 100 * 1024 * 1024,
    maxFileBytes: 500 * 1024,
  });
}

describe("RepositoryIndexingProcessor", () => {
  it("runs the complete ingestion pipeline and persists ready metadata", async () => {
    const dependencies = createDependencies();
    const job = createJob();

    await expect(
      createProcessor(dependencies).process(job, jobData),
    ).resolves.toEqual({
      repositoryId,
      branch: "main",
      commitSha,
      filesIndexed: 1,
      chunksIndexed: 1,
      embeddingModel: "test-embedding-model",
      embeddingTokens: 8,
    });

    expect(job.updateProgress).toHaveBeenCalledTimes(6);
    expect(dependencies.persistence.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        bullJobId: "job-1",
        repositoryId,
        branch: "main",
        commitSha,
        chunks: 1,
        files: [
          expect.objectContaining({
            filePath: "src/index.ts",
            language: "typescript",
          }),
        ],
      }),
    );
    expect(dependencies.chunkStore.upsert).toHaveBeenCalledWith(
      embedded.items,
      {},
    );
  });

  it("fails closed before cloning when the queued owner does not match", async () => {
    const persistence = createPersistence();
    vi.mocked(persistence.findRepository).mockResolvedValue({
      id: repositoryId,
      userId: "cccccccccccccccccccccccc",
      fullName: "owner/repository",
      private: false,
      selectedBranch: "main",
    });
    const dependencies = createDependencies(persistence);

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).rejects.toMatchObject({
      code: "REPOSITORY_ACCESS_DENIED",
      retryable: false,
    });
    expect(dependencies.cloner.withClone).not.toHaveBeenCalled();
  });

  it("persists a retryable failure while attempts remain", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.chunkStore.upsert).mockRejectedValue(
      new CodeChunkStoreError("WRITE_FAILED", "transport details"),
    );

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RepositoryIndexingError>>({
        code: "INDEXING_DEPENDENCY_FAILED",
        retryable: true,
      }),
    );
    expect(dependencies.persistence.fail).toHaveBeenCalledWith({
      bullJobId: "job-1",
      repositoryId,
      userId,
      errorMessage: "A repository indexing dependency is unavailable",
      willRetry: true,
    });
  });

  it("honors a database cancellation request between phases", async () => {
    const persistence = createPersistence();
    vi.mocked(persistence.isCancellationRequested)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const dependencies = createDependencies(persistence);

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).rejects.toMatchObject({
      code: "INDEXING_CANCELLED",
      retryable: false,
    });
    expect(persistence.cancel).toHaveBeenCalledWith({
      bullJobId: "job-1",
      repositoryId,
      userId,
      errorMessage: "Repository indexing was cancelled",
    });
    expect(dependencies.filter.filter).not.toHaveBeenCalled();
  });
});
