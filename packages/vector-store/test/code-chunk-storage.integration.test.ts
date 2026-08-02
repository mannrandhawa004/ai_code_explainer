import type { EmbeddedCodeChunk } from "@codebase-explainer/ai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  QdrantCodeChunkSearch,
  QdrantCodeChunkStore,
} from "../src/index.js";

const qdrantTestUrl = process.env.QDRANT_TEST_URL;
const describeWithQdrant = qdrantTestUrl ? describe : describe.skip;
const collectionName = `code_chunks_storage_test_${randomUUID().replaceAll("-", "")}`;
const client = qdrantTestUrl ? new QdrantClient({ url: qdrantTestUrl }) : undefined;

function createEmbeddedChunk(): EmbeddedCodeChunk {
  return {
    chunk: {
      id: "22222222-2222-8222-8222-222222222222",
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      commitSha: "integration-commit",
      filePath: "src/integration.ts",
      language: "typescript",
      symbolType: "variable",
      symbolName: "original",
      startLine: 1,
      endLine: 1,
      chunkIndex: 0,
      content: "export const original = true;",
      contentHash: "c".repeat(64),
      imports: [],
      exports: ["original"],
    },
    embedding: [0.1, 0.2, 0.3, 0.4],
    embeddingModel: "integration-model",
    embeddingDimensions: 4,
    embeddingTokenCount: 5,
    embeddingInputHash: "d".repeat(64),
  };
}

function expectCosineStoredVector(
  actual: unknown,
  input: readonly number[],
): void {
  expect(Array.isArray(actual)).toBe(true);
  const magnitude = Math.sqrt(
    input.reduce((total, value) => total + value * value, 0),
  );
  for (const [index, value] of input.entries()) {
    expect((actual as number[])[index]).toBeCloseTo(value / magnitude, 6);
  }
}

describeWithQdrant("Qdrant code-chunk storage", () => {
  afterAll(async () => {
    if (client && (await client.collectionExists(collectionName)).exists) {
      await client.deleteCollection(collectionName);
    }
  });

  it("upserts, replaces, retrieves, and tenant-scoped deletes a point", async () => {
    const store = new QdrantCodeChunkStore({
      url: qdrantTestUrl as string,
      apiKey: undefined,
      collectionName,
      vectorSize: 4,
      requestTimeoutMs: 5_000,
    });
    await store.vectorStore.ensureCollection();

    const original = createEmbeddedChunk();
    await store.upsert([original]);

    const inserted = await client!.retrieve(collectionName, {
      ids: [original.chunk.id],
      with_payload: true,
      with_vector: true,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.payload).toMatchObject({
      userId: "integration-user",
      repositoryId: "integration-repository",
      filePath: "src/integration.ts",
      startLine: 1,
      endLine: 1,
      content: "export const original = true;",
    });
    expectCosineStoredVector(inserted[0]?.vector, [0.1, 0.2, 0.3, 0.4]);

    const replacement = createEmbeddedChunk();
    replacement.chunk.content = "export const replacement = true;";
    replacement.chunk.contentHash = "e".repeat(64);
    replacement.embedding = [0.4, 0.3, 0.2, 0.1];
    replacement.chunk.exports = ["replacement"];
    replacement.chunk.symbolName = "replacement";
    await store.upsert([replacement]);

    const occurrence = createEmbeddedChunk();
    occurrence.chunk.id = "33333333-3333-8333-8333-333333333333";
    occurrence.chunk.filePath = "src/use-replacement.ts";
    occurrence.chunk.symbolName = "useReplacement";
    occurrence.chunk.content = "export function useReplacement() { return replacement; }";
    occurrence.chunk.contentHash = "f".repeat(64);
    occurrence.chunk.exports = ["useReplacement"];
    occurrence.chunk.references = ["replacement"];
    occurrence.embeddingInputHash = "1".repeat(64);
    await store.upsert([occurrence]);

    const replaced = await client!.retrieve(collectionName, {
      ids: [replacement.chunk.id],
      with_payload: true,
      with_vector: true,
    });
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.payload?.content).toBe(
      "export const replacement = true;",
    );
    expectCosineStoredVector(replaced[0]?.vector, [0.4, 0.3, 0.2, 0.1]);

    const search = new QdrantCodeChunkSearch(store.vectorStore.config);
    const searchResults = await search.search({
      vector: [0.4, 0.3, 0.2, 0.1],
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      commitSha: "integration-commit",
      limit: 5,
    });
    expect(searchResults[0]).toMatchObject({
      id: replacement.chunk.id,
      filePath: "src/integration.ts",
      content: "export const replacement = true;",
    });
    const exactResults = await search.searchExactSymbol({
      symbolName: "replacement",
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      commitSha: "integration-commit",
      limit: 5,
    });
    expect(exactResults).toEqual([
      expect.objectContaining({
        id: replacement.chunk.id,
        symbolName: "replacement",
        score: 1,
      }),
      expect.objectContaining({
        id: occurrence.chunk.id,
        symbolName: "useReplacement",
        score: 0.95,
      }),
    ]);

    await store.promoteRepositoryCommit({
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      toCommitSha: "2".repeat(40),
    });
    await expect(
      search.search({
        vector: [0.4, 0.3, 0.2, 0.1],
        userId: "integration-user",
        repositoryId: "integration-repository",
        branch: "main",
        commitSha: "integration-commit",
        limit: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      search.search({
        vector: [0.4, 0.3, 0.2, 0.1],
        userId: "integration-user",
        repositoryId: "integration-repository",
        branch: "main",
        commitSha: "2".repeat(40),
        limit: 5,
      }),
    ).resolves.toHaveLength(2);

    await store.deleteFileChunks({
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      filePaths: ["src/integration.ts"],
    });
    await expect(
      client!.retrieve(collectionName, {
        ids: [replacement.chunk.id, occurrence.chunk.id],
        with_payload: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: occurrence.chunk.id }),
    ]);

    await store.deleteRepositoryChunks({
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      commitSha: "2".repeat(40),
    });

    await expect(
      client!.retrieve(collectionName, {
        ids: [replacement.chunk.id, occurrence.chunk.id],
        with_payload: true,
      }),
    ).resolves.toEqual([]);
  });
});
