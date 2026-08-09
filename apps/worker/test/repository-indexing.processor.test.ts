import {
  AIProviderError,
  EmbeddingGenerationError,
  type CodeChunkEmbeddingResult,
} from "@codebase-explainer/ai";
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
  files: [
    {
      absolutePath: "C:/temporary/repository/src/index.ts",
      relativePath: "src/index.ts",
      name: "index.ts",
      depth: 2,
      stats: {} as FilteredRepositoryFiles["files"][number]["stats"],
      size: 26,
      modifiedAtMs: 0,
      mode: 0o100644,
    },
  ],
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
      chunkingStrategy: "tree_sitter",
      imports: ["express"],
      exports: ["ready"],
      symbols: [
        {
          name: "ready",
          type: "variable",
          startLine: 1,
          endLine: 1,
          imports: ["express"],
          references: [],
        },
      ],
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
    findRepositoryFiles: vi.fn().mockResolvedValue([]),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    begin: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue({ superseded: false }),
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
    hasher: {
      hashFiles: vi.fn().mockResolvedValue([
        { file: filtered.files[0]!, contentHash: "a".repeat(64) },
      ]),
    },
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
      deleteRepositoryChunks: vi.fn().mockResolvedValue({
        collectionName: "code_chunks",
        status: "completed",
      }),
      deleteFileChunks: vi.fn().mockResolvedValue({
        collectionName: "code_chunks",
        pathsDeleted: 0,
        batches: 0,
        operationIds: [],
        status: "completed",
      }),
      promoteRepositoryCommit: vi.fn().mockResolvedValue({
        collectionName: "code_chunks",
        status: "completed",
      }),
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
        totalChunks: 1,
        totalFiles: 1,
        files: [
          expect.objectContaining({
            filePath: "src/index.ts",
            language: "typescript",
            chunkCount: 1,
            imports: ["express"],
            exports: ["ready"],
            symbols: [expect.objectContaining({ name: "ready" })],
          }),
        ],
      }),
    );
    expect(dependencies.chunkStore.upsert).toHaveBeenCalledWith(
      embedded.items,
      { wait: true },
    );
  });

  it("embeds only changed files and removes deleted paths incrementally", async () => {
    const persistence = createPersistence();
    vi.mocked(persistence.findRepository).mockResolvedValue({
      id: repositoryId,
      userId,
      fullName: "owner/repository",
      private: false,
      selectedBranch: "main",
      lastIndexedCommit: "1".repeat(40),
      pendingIndexCommit: commitSha,
    });
    vi.mocked(persistence.findRepositoryFiles).mockResolvedValue([
      {
        filePath: "src/index.ts",
        language: "typescript",
        contentHash: "d".repeat(64),
        sourceBytes: 24,
        chunkCount: 1,
      },
      {
        filePath: "src/unchanged.ts",
        language: "typescript",
        contentHash: "c".repeat(64),
        sourceBytes: 10,
        chunkCount: 2,
      },
      {
        filePath: "src/removed.ts",
        language: "typescript",
        contentHash: "e".repeat(64),
        sourceBytes: 10,
        chunkCount: 1,
      },
    ]);
    const unchangedFile = {
      ...filtered.files[0]!,
      absolutePath: "C:/temporary/repository/src/unchanged.ts",
      relativePath: "src/unchanged.ts",
      name: "unchanged.ts",
      size: 10,
    };
    const dependencies = createDependencies(persistence);
    vi.mocked(dependencies.filter.filter).mockResolvedValue({
      ...filtered,
      files: [filtered.files[0]!, unchangedFile],
      totalBytes: 36,
    });
    vi.mocked(dependencies.hasher.hashFiles).mockResolvedValue([
      { file: filtered.files[0]!, contentHash: "a".repeat(64) },
      { file: unchangedFile, contentHash: "c".repeat(64) },
    ]);

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).resolves.toMatchObject({
      filesIndexed: 1,
      chunksIndexed: 1,
      commitSha,
    });

    expect(
      dependencies.chunkStore.deleteRepositoryChunks,
    ).not.toHaveBeenCalled();
    expect(dependencies.chunkStore.deleteFileChunks).toHaveBeenCalledWith(
      {
        userId,
        repositoryId,
        branch: "main",
        filePaths: ["src/index.ts", "src/removed.ts"],
      },
      { wait: true },
    );
    expect(
      dependencies.chunkStore.promoteRepositoryCommit,
    ).toHaveBeenCalledWith(
      {
        userId,
        repositoryId,
        branch: "main",
        toCommitSha: commitSha,
      },
      { wait: true },
    );
    expect(persistence.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPendingCommit: commitSha,
        retainedFilePaths: ["src/unchanged.ts"],
        removedFilePaths: ["src/removed.ts"],
        totalFiles: 2,
        totalChunks: 3,
        languages: new Map([["typescript", 2]]),
      }),
    );
  });

  it("coalesces a newer pending push into the active indexing job", async () => {
    const nextCommitSha = "f".repeat(40);
    const persistence = createPersistence();
    vi.mocked(persistence.findRepository)
      .mockResolvedValueOnce({
        id: repositoryId,
        userId,
        fullName: "owner/repository",
        private: false,
        selectedBranch: "main",
        pendingIndexCommit: commitSha,
      })
      .mockResolvedValueOnce({
        id: repositoryId,
        userId,
        fullName: "owner/repository",
        private: false,
        selectedBranch: "main",
        lastIndexedCommit: commitSha,
        pendingIndexCommit: nextCommitSha,
      });
    vi.mocked(persistence.findRepositoryFiles)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          filePath: "src/index.ts",
          language: "typescript",
          contentHash: "a".repeat(64),
          sourceBytes: 26,
          chunkCount: 1,
        },
      ]);
    vi.mocked(persistence.complete)
      .mockResolvedValueOnce({
        superseded: true,
        pendingCommitSha: nextCommitSha,
      })
      .mockResolvedValueOnce({ superseded: false });
    const dependencies = createDependencies(persistence);
    let cloneCount = 0;
    vi.mocked(dependencies.cloner.withClone).mockImplementation(
      async (_request, operation) => {
        cloneCount += 1;
        return operation({
          ...clonedRepository,
          commitSha: cloneCount === 1 ? commitSha : nextCommitSha,
        });
      },
    );
    vi.mocked(dependencies.chunker.chunkFiles)
      .mockResolvedValueOnce(chunked)
      .mockResolvedValueOnce({
        chunks: [],
        fileSummaries: [],
        filesProcessed: 0,
        totalSourceBytes: 0,
        totalSourceCharacters: 0,
      });
    vi.mocked(dependencies.embedder.embedChunks)
      .mockResolvedValueOnce(embedded)
      .mockResolvedValueOnce({
        items: [],
        model: "test-embedding-model",
        dimensions: 2,
        usage: {
          promptTokens: 0,
          totalTokens: 0,
          requests: 0,
          uniqueInputs: 0,
        },
      });

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).resolves.toEqual({
      repositoryId,
      branch: "main",
      commitSha: nextCommitSha,
      filesIndexed: 1,
      chunksIndexed: 1,
      embeddingModel: "test-embedding-model",
      embeddingTokens: 8,
    });
    expect(dependencies.cloner.withClone).toHaveBeenCalledTimes(2);
    expect(persistence.complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedPendingCommit: commitSha }),
    );
    expect(persistence.complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedPendingCommit: nextCommitSha }),
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

  it("fails closed when webhook processing revoked repository access", async () => {
    const persistence = createPersistence();
    vi.mocked(persistence.findRepository).mockResolvedValue({
      id: repositoryId,
      userId,
      fullName: "owner/repository",
      private: true,
      githubRepositoryId: 9001,
      installationId: 501,
      githubAccessRevokedAt: new Date("2026-08-02T12:00:00.000Z"),
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

  it("mints a repository-scoped token immediately before cloning a private repository", async () => {
    const persistence = createPersistence();
    vi.mocked(persistence.findRepository).mockResolvedValue({
      id: repositoryId,
      userId,
      fullName: "owner/repository",
      private: true,
      githubRepositoryId: 9001,
      installationId: 501,
      selectedBranch: "main",
    });
    const dependencies = createDependencies(persistence);
    dependencies.installationTokenProvider = {
      createRepositoryToken: vi.fn().mockResolvedValue("installation-token"),
    };

    await createProcessor(dependencies).process(createJob(), jobData);

    expect(
      dependencies.installationTokenProvider.createRepositoryToken,
    ).toHaveBeenCalledWith({ installationId: 501, repositoryId: 9001 });
    expect(dependencies.cloner.withClone).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "installation-token" }),
      expect.any(Function),
    );
  });

  it("fails closed before Git when private repository metadata is incomplete", async () => {
    const persistence = createPersistence();
    vi.mocked(persistence.findRepository).mockResolvedValue({
      id: repositoryId,
      userId,
      fullName: "owner/repository",
      private: true,
      selectedBranch: "main",
    });
    const dependencies = createDependencies(persistence);

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).rejects.toMatchObject({
      code: "PRIVATE_REPOSITORY_ACCESS_DENIED",
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

  it("does not retry a hosted-provider credit failure from the clone stage", async () => {
    const dependencies = createDependencies();
    const providerError = new AIProviderError(
      "openai",
      "QUOTA_EXHAUSTED",
      "The hosted AI provider has no available credits or quota. Configure Google Gemini's free tier, or update the provider account.",
      false,
      429,
    );
    vi.mocked(dependencies.embedder.embedChunks).mockRejectedValue(
      new EmbeddingGenerationError(
        "PROVIDER_ERROR",
        "Embedding provider request failed",
        undefined,
        { cause: providerError },
      ),
    );

    await expect(
      createProcessor(dependencies).process(createJob(), jobData),
    ).rejects.toMatchObject({
      code: "INDEXING_DEPENDENCY_FAILED",
      retryable: false,
    });
    expect(dependencies.persistence.fail).toHaveBeenCalledWith({
      bullJobId: "job-1",
      repositoryId,
      userId,
      errorMessage:
        "The hosted AI provider has no available credits or quota. Configure Google Gemini's free tier, or update the provider account.",
      willRetry: false,
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
