import type { EmbeddedCodeChunk } from "@codebase-explainer/ai";
import { describe, expect, it, vi } from "vitest";

import {
  CodeChunkStoreError,
  QdrantCodeChunkStore,
  codeChunkPayloadSchemaVersion,
  toCodeChunkVectorPoint,
  type QdrantClientContract,
  type VectorStoreConfig,
} from "../src/index.js";

const config: VectorStoreConfig = {
  url: "http://localhost:6333",
  apiKey: undefined,
  collectionName: "code_chunks",
  vectorSize: 4,
  requestTimeoutMs: 5_000,
};

function createClient(
  overrides: Partial<Record<keyof QdrantClientContract, unknown>> = {},
): QdrantClientContract {
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: true }),
    createCollection: vi.fn().mockResolvedValue(true),
    createPayloadIndex: vi.fn().mockResolvedValue({
      operation_id: 1,
      status: "completed",
    }),
    delete: vi.fn().mockResolvedValue({
      operation_id: 1,
      status: "completed",
    }),
    getCollection: vi.fn(),
    retrieve: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({
      operation_id: 1,
      status: "completed",
    }),
    versionInfo: vi.fn().mockResolvedValue({
      title: "qdrant",
      version: "1.18.2",
      commit: "test",
    }),
    ...overrides,
  } as unknown as QdrantClientContract;
}

function createEmbeddedChunk(index = 1): EmbeddedCodeChunk {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    chunk: {
      id: `11111111-1111-8111-8111-${suffix}`,
      userId: "user-1",
      repositoryId: "repo-1",
      branch: "main",
      commitSha: "abc123",
      filePath: `src/file-${index}.ts`,
      language: "typescript",
      symbolType: "function",
      symbolName: `run${index}`,
      startLine: 1,
      endLine: 3,
      chunkIndex: index - 1,
      content: `export function run${index}() {\n  return ${index};\n}`,
      contentHash: "a".repeat(64),
      imports: ["node:path"],
      exports: [`run${index}`],
    },
    embedding: [0.1, 0.2, 0.3, 0.4],
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    embeddingTokenCount: 24,
    embeddingInputHash: "b".repeat(64),
  };
}

describe("toCodeChunkVectorPoint", () => {
  it("maps the full searchable and citation payload without sharing arrays", () => {
    const item = createEmbeddedChunk();

    const point = toCodeChunkVectorPoint(item, 4);
    item.embedding[0] = 9;
    item.chunk.imports[0] = "changed";

    expect(point).toEqual({
      id: "11111111-1111-8111-8111-000000000001",
      vector: [0.1, 0.2, 0.3, 0.4],
      payload: {
        schemaVersion: codeChunkPayloadSchemaVersion,
        chunkId: "11111111-1111-8111-8111-000000000001",
        userId: "user-1",
        repositoryId: "repo-1",
        branch: "main",
        commitSha: "abc123",
        filePath: "src/file-1.ts",
        language: "typescript",
        symbolType: "function",
        symbolName: "run1",
        startLine: 1,
        endLine: 3,
        chunkIndex: 0,
        contentHash: "a".repeat(64),
        content: "export function run1() {\n  return 1;\n}",
        imports: ["node:path"],
        exports: ["run1"],
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 4,
        embeddingTokenCount: 24,
        embeddingInputHash: "b".repeat(64),
      },
    });
  });

  it("omits absent optional symbol metadata", () => {
    const item = createEmbeddedChunk();
    delete item.chunk.symbolType;
    delete item.chunk.symbolName;

    const point = toCodeChunkVectorPoint(item, 4);

    expect(point.payload).not.toHaveProperty("symbolType");
    expect(point.payload).not.toHaveProperty("symbolName");
  });

  it("rejects dimension mismatches and non-finite vector values", () => {
    const wrongDimensions = createEmbeddedChunk();
    wrongDimensions.embeddingDimensions = 3;
    expect(() => toCodeChunkVectorPoint(wrongDimensions, 4)).toThrowError(
      expect.objectContaining({ code: "VECTOR_DIMENSION_MISMATCH" }),
    );

    const nonFinite = createEmbeddedChunk();
    nonFinite.embedding[2] = Number.NaN;
    expect(() => toCodeChunkVectorPoint(nonFinite, 4)).toThrowError(
      expect.objectContaining({ code: "INVALID_VECTOR" }),
    );
  });

  it("rejects malformed identifiers, hashes, and line metadata", () => {
    const invalidId = createEmbeddedChunk();
    invalidId.chunk.id = "not-a-uuid";
    expect(() => toCodeChunkVectorPoint(invalidId, 4)).toThrowError(
      expect.objectContaining({ code: "INVALID_CHUNK" }),
    );

    const invalidHash = createEmbeddedChunk();
    invalidHash.chunk.contentHash = "invalid";
    expect(() => toCodeChunkVectorPoint(invalidHash, 4)).toThrowError(
      expect.objectContaining({ code: "INVALID_CHUNK" }),
    );

    const invalidLines = createEmbeddedChunk();
    invalidLines.chunk.endLine = 0;
    expect(() => toCodeChunkVectorPoint(invalidLines, 4)).toThrowError(
      expect.objectContaining({ code: "INVALID_CHUNK" }),
    );
  });
});

describe("QdrantCodeChunkStore.upsert", () => {
  it("returns a no-op result for an empty input", async () => {
    const client = createClient();
    const store = new QdrantCodeChunkStore(config, client);

    await expect(store.upsert([])).resolves.toEqual({
      collectionName: "code_chunks",
      pointsUpserted: 0,
      batches: 0,
      operationIds: [],
      status: "completed",
    });
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("writes deterministic points in bounded batches", async () => {
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let operationId = 0;
    const upsert = vi.fn().mockImplementation(async () => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWrites -= 1;
      operationId += 1;
      return { operation_id: operationId, status: "completed" };
    });
    const store = new QdrantCodeChunkStore(config, createClient({ upsert }));

    const result = await store.upsert(
      Array.from({ length: 5 }, (_, index) => createEmbeddedChunk(index + 1)),
      { batchSize: 2, writeConcurrency: 2 },
    );

    expect(result).toMatchObject({
      collectionName: "code_chunks",
      pointsUpserted: 5,
      batches: 3,
      status: "completed",
    });
    expect(result.operationIds).toHaveLength(3);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      "code_chunks",
      expect.objectContaining({
        wait: true,
        ordering: "medium",
        points: expect.arrayContaining([
          expect.objectContaining({
            id: "11111111-1111-8111-8111-000000000001",
          }),
        ]),
      }),
    );
    expect(maximumActiveWrites).toBe(2);
  });

  it("rejects duplicate IDs and invalid configuration before network I/O", async () => {
    const client = createClient();
    const store = new QdrantCodeChunkStore(config, client);
    const item = createEmbeddedChunk();

    await expect(store.upsert([item, item])).rejects.toMatchObject({
      code: "DUPLICATE_CHUNK_ID",
    });
    await expect(store.upsert([item], { batchSize: 1_001 })).rejects.toMatchObject(
      { code: "INVALID_CONFIGURATION" },
    );
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("requires completion when synchronous writes are requested", async () => {
    const store = new QdrantCodeChunkStore(
      config,
      createClient({
        upsert: vi.fn().mockResolvedValue({
          operation_id: 7,
          status: "wait_timeout",
        }),
      }),
    );

    await expect(store.upsert([createEmbeddedChunk()])).rejects.toMatchObject({
      code: "WRITE_INCOMPLETE",
    });
  });

  it("wraps transport failures without exposing chunk content", async () => {
    const store = new QdrantCodeChunkStore(
      config,
      createClient({
        upsert: vi.fn().mockRejectedValue(new Error("secret source content")),
      }),
    );

    const failure = store.upsert([createEmbeddedChunk()]);
    await expect(failure).rejects.toBeInstanceOf(CodeChunkStoreError);
    await expect(failure).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await expect(failure).rejects.not.toThrow("secret source content");
  });

  it("honors an already-aborted operation", async () => {
    const client = createClient();
    const store = new QdrantCodeChunkStore(config, client);
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.upsert([createEmbeddedChunk()], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "VECTOR_STORE_ABORTED" });
    expect(client.upsert).not.toHaveBeenCalled();
  });
});

describe("QdrantCodeChunkStore.deleteRepositoryChunks", () => {
  it("always scopes deletion by tenant and repository", async () => {
    const client = createClient();
    const store = new QdrantCodeChunkStore(config, client);

    await expect(
      store.deleteRepositoryChunks({
        userId: "user-1",
        repositoryId: "repo-1",
        branch: "main",
        commitSha: "abc123",
      }),
    ).resolves.toEqual({
      collectionName: "code_chunks",
      operationId: 1,
      status: "completed",
    });
    expect(client.delete).toHaveBeenCalledWith("code_chunks", {
      wait: true,
      ordering: "medium",
      filter: {
        must: [
          { key: "userId", match: { value: "user-1" } },
          { key: "repositoryId", match: { value: "repo-1" } },
          { key: "branch", match: { value: "main" } },
          { key: "commitSha", match: { value: "abc123" } },
        ],
      },
    });
  });

  it("rejects an unsafe selector before network I/O", async () => {
    const client = createClient();
    const store = new QdrantCodeChunkStore(config, client);

    await expect(
      store.deleteRepositoryChunks({ userId: " ", repositoryId: "repo-1" }),
    ).rejects.toMatchObject({ code: "INVALID_SELECTOR" });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("reports incomplete and failed deletion operations", async () => {
    const incomplete = new QdrantCodeChunkStore(
      config,
      createClient({
        delete: vi.fn().mockResolvedValue({ status: "wait_timeout" }),
      }),
    );
    await expect(
      incomplete.deleteRepositoryChunks({
        userId: "user-1",
        repositoryId: "repo-1",
      }),
    ).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });

    const failed = new QdrantCodeChunkStore(
      config,
      createClient({ delete: vi.fn().mockRejectedValue(new Error("offline")) }),
    );
    await expect(
      failed.deleteRepositoryChunks({
        userId: "user-1",
        repositoryId: "repo-1",
      }),
    ).rejects.toMatchObject({ code: "DELETE_FAILED" });
  });
});
