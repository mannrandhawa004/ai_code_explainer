import { describe, expect, it, vi } from "vitest";

import {
  QdrantCodeChunkSearch,
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

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    repositoryId: "repo-1",
    branch: "main",
    commitSha: "abc123",
    filePath: "src/auth.ts",
    language: "typescript",
    symbolType: "function",
    symbolName: "authenticate",
    startLine: 10,
    endLine: 20,
    chunkIndex: 0,
    contentHash: "a".repeat(64),
    content: "export function authenticate() {}",
    ...overrides,
  };
}

function createClient(
  overrides: Partial<Record<keyof QdrantClientContract, unknown>> = {},
): QdrantClientContract {
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: true }),
    createCollection: vi.fn().mockResolvedValue(true),
    createPayloadIndex: vi.fn().mockResolvedValue({ status: "completed" }),
    delete: vi.fn().mockResolvedValue({ status: "completed" }),
    getCollection: vi.fn(),
    query: vi.fn().mockResolvedValue({ points: [] }),
    retrieve: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
    upsert: vi.fn().mockResolvedValue({ status: "completed" }),
    versionInfo: vi.fn().mockResolvedValue({
      title: "qdrant",
      version: "1.18.2",
      commit: "test",
    }),
    ...overrides,
  } as unknown as QdrantClientContract;
}

const searchRequest = {
  vector: [0.1, 0.2, 0.3, 0.4],
  userId: "user-1",
  repositoryId: "repo-1",
  branch: "main",
  commitSha: "abc123",
} as const;

describe("QdrantCodeChunkSearch", () => {
  it("applies the full tenant/current-commit filter and maps payloads", async () => {
    const query = vi.fn().mockResolvedValue({
      points: [
        {
          id: "11111111-1111-8111-8111-111111111111",
          version: 1,
          score: 0.92,
          payload: createPayload(),
        },
      ],
    });
    const search = new QdrantCodeChunkSearch(config, createClient({ query }));

    await expect(
      search.search({ ...searchRequest, limit: 10, scoreThreshold: 0.25 }),
    ).resolves.toEqual([
      {
        id: "11111111-1111-8111-8111-111111111111",
        score: 0.92,
        ...createPayload(),
      },
    ]);
    expect(query).toHaveBeenCalledWith("code_chunks", {
      query: [0.1, 0.2, 0.3, 0.4],
      limit: 10,
      score_threshold: 0.25,
      filter: {
        must: [
          { key: "userId", match: { value: "user-1" } },
          { key: "repositoryId", match: { value: "repo-1" } },
          { key: "branch", match: { value: "main" } },
          { key: "commitSha", match: { value: "abc123" } },
        ],
      },
      with_payload: true,
      with_vector: false,
    });
  });

  it("rejects invalid vectors and limits before network I/O", async () => {
    const client = createClient();
    const search = new QdrantCodeChunkSearch(config, client);

    await expect(
      search.search({ ...searchRequest, vector: [0.1] }),
    ).rejects.toMatchObject({ code: "VECTOR_DIMENSION_MISMATCH" });
    await expect(
      search.search({
        ...searchRequest,
        vector: [0.1, 0.2, Number.NaN, 0.4],
      }),
    ).rejects.toMatchObject({ code: "INVALID_VECTOR" });
    await expect(
      search.search({ ...searchRequest, limit: 51 }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("retrieves exact symbol chunks with the full repository scope", async () => {
    const definition = {
      id: "11111111-1111-8111-8111-111111111111",
      version: 1,
      payload: createPayload(),
    };
    const occurrence = {
      id: "22222222-2222-8222-8222-222222222222",
      version: 1,
      payload: createPayload({
        symbolName: "authorizeRequest",
        startLine: 30,
        endLine: 35,
        chunkIndex: 1,
        references: ["authenticate"],
      }),
    };
    const scroll = vi
      .fn()
      .mockResolvedValueOnce({
        points: [definition],
        next_page_offset: null,
      })
      .mockResolvedValueOnce({
        points: [definition, occurrence],
        next_page_offset: null,
      });
    const search = new QdrantCodeChunkSearch(config, createClient({ scroll }));

    await expect(
      search.searchExactSymbol({
        symbolName: "authenticate",
        userId: "user-1",
        repositoryId: "repo-1",
        branch: "main",
        commitSha: "abc123",
        limit: 5,
      }),
    ).resolves.toEqual([
      {
        id: "11111111-1111-8111-8111-111111111111",
        score: 1,
        ...createPayload(),
      },
      {
        id: "22222222-2222-8222-8222-222222222222",
        score: 0.95,
        ...createPayload({
          symbolName: "authorizeRequest",
          startLine: 30,
          endLine: 35,
          chunkIndex: 1,
        }),
      },
    ]);
    expect(scroll).toHaveBeenNthCalledWith(1, "code_chunks", {
      limit: 5,
      filter: {
        must: [
          { key: "userId", match: { value: "user-1" } },
          { key: "repositoryId", match: { value: "repo-1" } },
          { key: "branch", match: { value: "main" } },
          { key: "commitSha", match: { value: "abc123" } },
          { key: "symbolName", match: { value: "authenticate" } },
        ],
      },
      with_payload: true,
      with_vector: false,
    });
    expect(scroll).toHaveBeenNthCalledWith(2, "code_chunks", {
      limit: 5,
      filter: {
        must: [
          { key: "userId", match: { value: "user-1" } },
          { key: "repositoryId", match: { value: "repo-1" } },
          { key: "branch", match: { value: "main" } },
          { key: "commitSha", match: { value: "abc123" } },
        ],
        should: [
          { key: "references", match: { value: "authenticate" } },
          { key: "imports", match: { value: "authenticate" } },
          { key: "exports", match: { value: "authenticate" } },
        ],
      },
      with_payload: true,
      with_vector: false,
    });
  });

  it("rejects malformed and cross-tenant results", async () => {
    const crossTenant = new QdrantCodeChunkSearch(
      config,
      createClient({
        query: vi.fn().mockResolvedValue({
          points: [
            {
              id: "11111111-1111-8111-8111-111111111111",
              version: 1,
              score: 0.8,
              payload: createPayload({ userId: "different-user" }),
            },
          ],
        }),
      }),
    );
    await expect(crossTenant.search(searchRequest)).rejects.toMatchObject({
      code: "INVALID_RESULT",
    });

    const malformed = new QdrantCodeChunkSearch(
      config,
      createClient({
        query: vi.fn().mockResolvedValue({
          points: [
            {
              id: "11111111-1111-8111-8111-111111111111",
              version: 1,
              score: 0.8,
              payload: createPayload({ startLine: "ten" }),
            },
          ],
        }),
      }),
    );
    await expect(malformed.search(searchRequest)).rejects.toMatchObject({
      code: "INVALID_RESULT",
    });
  });

  it("wraps transport failures and honors aborts", async () => {
    const failed = new QdrantCodeChunkSearch(
      config,
      createClient({
        query: vi.fn().mockRejectedValue(new Error("internal transport detail")),
      }),
    );
    await expect(failed.search(searchRequest)).rejects.toMatchObject({
      code: "SEARCH_FAILED",
      message: "Qdrant failed to retrieve repository code chunks",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      failed.search({ ...searchRequest, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "SEARCH_ABORTED" });
  });
});
