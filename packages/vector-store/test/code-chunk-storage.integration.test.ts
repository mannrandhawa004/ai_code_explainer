import type { EmbeddedCodeChunk } from "@codebase-explainer/ai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { QdrantCodeChunkStore } from "../src/index.js";

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
    expect(inserted[0]?.vector).toEqual([0.1, 0.2, 0.3, 0.4]);

    const replacement = createEmbeddedChunk();
    replacement.chunk.content = "export const replacement = true;";
    replacement.chunk.contentHash = "e".repeat(64);
    replacement.embedding = [0.4, 0.3, 0.2, 0.1];
    replacement.chunk.exports = ["replacement"];
    await store.upsert([replacement]);

    const replaced = await client!.retrieve(collectionName, {
      ids: [replacement.chunk.id],
      with_payload: true,
      with_vector: true,
    });
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.payload?.content).toBe(
      "export const replacement = true;",
    );
    expect(replaced[0]?.vector).toEqual([0.4, 0.3, 0.2, 0.1]);

    await store.deleteRepositoryChunks({
      userId: "integration-user",
      repositoryId: "integration-repository",
      branch: "main",
      commitSha: "integration-commit",
    });

    await expect(
      client!.retrieve(collectionName, {
        ids: [replacement.chunk.id],
        with_payload: true,
      }),
    ).resolves.toEqual([]);
  });
});
