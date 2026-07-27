import { randomUUID } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";
import { afterAll, describe, expect, it } from "vitest";

import {
  QdrantVectorStore,
  qdrantPayloadIndexes,
} from "../src/index.js";

const qdrantTestUrl = process.env.QDRANT_TEST_URL;
const describeWithQdrant = qdrantTestUrl ? describe : describe.skip;
const collectionName = `code_chunks_test_${randomUUID().replaceAll("-", "")}`;
const client = qdrantTestUrl ? new QdrantClient({ url: qdrantTestUrl }) : undefined;

describeWithQdrant("Qdrant connection", () => {
  afterAll(async () => {
    await client?.deleteCollection(collectionName);
  });

  it("creates, validates, and reports a real collection", async () => {
    const store = new QdrantVectorStore({
      url: qdrantTestUrl as string,
      apiKey: undefined,
      collectionName,
      vectorSize: 4,
      requestTimeoutMs: 5_000,
    });

    const collection = await store.ensureCollection();
    const health = await store.health();

    expect(collection.status).toBe("created");
    expect(collection.indexedFields).toEqual([...qdrantPayloadIndexes]);
    expect(health).toMatchObject({
      status: "ok",
      collectionName,
      collectionExists: true,
    });
  });
});
