import { describe, expect, it, vi } from "vitest";

import {
  QdrantVectorStore,
  qdrantPayloadIndexes,
  type QdrantClientContract,
  type VectorStoreConfig,
} from "../src/index.js";

const config: VectorStoreConfig = {
  url: "http://localhost:6333",
  apiKey: undefined,
  collectionName: "code_chunks",
  vectorSize: 1_536,
  requestTimeoutMs: 5_000,
};

function createClient(
  overrides: Partial<Record<keyof QdrantClientContract, unknown>> = {},
): QdrantClientContract {
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: false }),
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

describe("QdrantVectorStore", () => {
  it("creates the shared collection and filter indexes", async () => {
    const client = createClient();
    const store = new QdrantVectorStore(config, client);

    const result = await store.ensureCollection();

    expect(result).toEqual({
      collectionName: "code_chunks",
      status: "created",
      indexedFields: [...qdrantPayloadIndexes],
    });
    expect(client.createCollection).toHaveBeenCalledWith("code_chunks", {
      vectors: { size: 1_536, distance: "Cosine" },
      on_disk_payload: true,
    });
    expect(client.createPayloadIndex).toHaveBeenCalledTimes(
      qdrantPayloadIndexes.length,
    );
  });

  it("preserves a compatible existing collection and its indexes", async () => {
    const client = createClient({
      collectionExists: vi.fn().mockResolvedValue({ exists: true }),
      getCollection: vi.fn().mockResolvedValue({
        config: {
          params: { vectors: { size: 1_536, distance: "Cosine" } },
        },
        payload_schema: Object.fromEntries(
          qdrantPayloadIndexes.map((field) => [field, { data_type: "keyword" }]),
        ),
      }),
    });
    const store = new QdrantVectorStore(config, client);

    const result = await store.ensureCollection();

    expect(result.status).toBe("existing");
    expect(client.createCollection).not.toHaveBeenCalled();
    expect(client.createPayloadIndex).not.toHaveBeenCalled();
  });

  it("rejects a collection configured for a different vector size", async () => {
    const client = createClient({
      collectionExists: vi.fn().mockResolvedValue({ exists: true }),
      getCollection: vi.fn().mockResolvedValue({
        config: { params: { vectors: { size: 3_072, distance: "Cosine" } } },
        payload_schema: {},
      }),
    });
    const store = new QdrantVectorStore(config, client);

    await expect(store.ensureCollection()).rejects.toThrow(
      "Qdrant collection vector size is 3072; expected 1536",
    );
  });

  it("returns a safe unavailable health result on connection failure", async () => {
    const client = createClient({
      versionInfo: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const store = new QdrantVectorStore(config, client);

    await expect(store.health()).resolves.toEqual({
      status: "unavailable",
      collectionName: "code_chunks",
      collectionExists: false,
    });
  });
});
