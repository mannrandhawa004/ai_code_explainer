import type { EmbeddedCodeChunk } from "@codebase-explainer/ai";
import pLimit from "p-limit";

import {
  QdrantVectorStore,
  type QdrantClientContract,
  type VectorStoreConfig,
} from "./vector-store.js";

export const codeChunkPayloadSchemaVersion = 1;
export const defaultCodeChunkUpsertBatchSize = 100;
export const defaultCodeChunkWriteConcurrency = 2;
export const maximumCodeChunkUpsertBatchSize = 1_000;

const sha256Pattern = /^[0-9a-f]{64}$/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type CodeChunkPayload = {
  [key: string]: unknown;
  schemaVersion: typeof codeChunkPayloadSchemaVersion;
  chunkId: string;
  userId: string;
  repositoryId: string;
  branch: string;
  commitSha: string;
  filePath: string;
  language: string;
  symbolType?: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
  contentHash: string;
  content: string;
  imports: string[];
  exports: string[];
  references: string[];
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingTokenCount: number;
  embeddingInputHash: string;
};

export type CodeChunkVectorPoint = {
  id: string;
  vector: number[];
  payload: CodeChunkPayload;
};

export type CodeChunkUpsertOptions = {
  batchSize?: number;
  writeConcurrency?: number;
  wait?: boolean;
  signal?: AbortSignal;
};

export type CodeChunkUpsertResult = {
  collectionName: string;
  pointsUpserted: number;
  batches: number;
  operationIds: Array<number | string>;
  status: "acknowledged" | "completed";
};

export type CodeChunkDeleteSelector = {
  userId: string;
  repositoryId: string;
  branch?: string;
  commitSha?: string;
};

export type CodeChunkDeleteOptions = {
  wait?: boolean;
  signal?: AbortSignal;
};

export type CodeChunkDeleteResult = {
  collectionName: string;
  status: "acknowledged" | "completed";
  operationId?: number | string;
};

export type CodeChunkStoreErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_CHUNK"
  | "INVALID_SELECTOR"
  | "DUPLICATE_CHUNK_ID"
  | "VECTOR_DIMENSION_MISMATCH"
  | "INVALID_VECTOR"
  | "WRITE_FAILED"
  | "WRITE_INCOMPLETE"
  | "DELETE_FAILED"
  | "DELETE_INCOMPLETE"
  | "VECTOR_STORE_ABORTED";

export class CodeChunkStoreError extends Error {
  constructor(
    readonly code: CodeChunkStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeChunkStoreError";
  }
}

type QdrantOperationResult = {
  operation_id?: number | string | null;
  status: "acknowledged" | "completed" | "wait_timeout";
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CodeChunkStoreError(
      "INVALID_CONFIGURATION",
      `${fieldName} must be a positive integer`,
    );
  }
}

function assertSafeString(
  value: string,
  fieldName: string,
  code: "INVALID_CHUNK" | "INVALID_SELECTOR" = "INVALID_CHUNK",
): void {
  if (!value.trim() || value.includes("\0")) {
    throw new CodeChunkStoreError(
      code,
      `${fieldName} must be a non-empty string without null bytes`,
    );
  }
}

function assertHash(value: string, fieldName: string): void {
  if (!sha256Pattern.test(value)) {
    throw new CodeChunkStoreError(
      "INVALID_CHUNK",
      `${fieldName} must be a lowercase SHA-256 hash`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CodeChunkStoreError(
      "VECTOR_STORE_ABORTED",
      "The vector-store operation was aborted",
      { cause: signal.reason },
    );
  }
}

function readOperationResult(value: unknown): QdrantOperationResult {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    throw new CodeChunkStoreError(
      "WRITE_INCOMPLETE",
      "Qdrant returned an invalid operation result",
    );
  }

  const status = value.status;
  if (
    status !== "acknowledged" &&
    status !== "completed" &&
    status !== "wait_timeout"
  ) {
    throw new CodeChunkStoreError(
      "WRITE_INCOMPLETE",
      "Qdrant returned an unknown operation status",
    );
  }

  const operationId = "operation_id" in value ? value.operation_id : undefined;
  if (
    operationId !== undefined &&
    operationId !== null &&
    typeof operationId !== "number" &&
    typeof operationId !== "string"
  ) {
    throw new CodeChunkStoreError(
      "WRITE_INCOMPLETE",
      "Qdrant returned an invalid operation identifier",
    );
  }

  return {
    status,
    ...(operationId === undefined ? {} : { operation_id: operationId }),
  };
}

function requireCompletedOperation(
  result: QdrantOperationResult,
  wait: boolean,
  incompleteCode: "WRITE_INCOMPLETE" | "DELETE_INCOMPLETE",
): void {
  if (result.status === "wait_timeout" || (wait && result.status !== "completed")) {
    throw new CodeChunkStoreError(
      incompleteCode,
      `Qdrant did not complete the operation (status: ${result.status})`,
    );
  }
}

export function toCodeChunkVectorPoint(
  item: EmbeddedCodeChunk,
  expectedVectorSize: number,
): CodeChunkVectorPoint {
  const { chunk } = item;

  if (!canonicalUuidPattern.test(chunk.id)) {
    throw new CodeChunkStoreError(
      "INVALID_CHUNK",
      "chunk.id must be a canonical UUID accepted by Qdrant",
    );
  }

  for (const [fieldName, value] of [
    ["userId", chunk.userId],
    ["repositoryId", chunk.repositoryId],
    ["branch", chunk.branch],
    ["commitSha", chunk.commitSha],
    ["filePath", chunk.filePath],
    ["language", chunk.language],
    ["content", chunk.content],
    ["embeddingModel", item.embeddingModel],
  ] as const) {
    assertSafeString(value, fieldName);
  }

  if (chunk.symbolType !== undefined) {
    assertSafeString(chunk.symbolType, "symbolType");
  }
  if (chunk.symbolName !== undefined) {
    assertSafeString(chunk.symbolName, "symbolName");
  }

  if (
    !Number.isInteger(chunk.startLine) ||
    chunk.startLine <= 0 ||
    !Number.isInteger(chunk.endLine) ||
    chunk.endLine < chunk.startLine ||
    !Number.isInteger(chunk.chunkIndex) ||
    chunk.chunkIndex < 0
  ) {
    throw new CodeChunkStoreError(
      "INVALID_CHUNK",
      "Chunk line range and index must be valid integers",
    );
  }

  assertHash(chunk.contentHash, "contentHash");
  assertHash(item.embeddingInputHash, "embeddingInputHash");

  if (!Number.isInteger(item.embeddingTokenCount) || item.embeddingTokenCount <= 0) {
    throw new CodeChunkStoreError(
      "INVALID_CHUNK",
      "embeddingTokenCount must be a positive integer",
    );
  }

  if (
    item.embeddingDimensions !== expectedVectorSize ||
    item.embedding.length !== expectedVectorSize
  ) {
    throw new CodeChunkStoreError(
      "VECTOR_DIMENSION_MISMATCH",
      `Chunk vector dimension must match collection size ${expectedVectorSize}`,
    );
  }

  if (!item.embedding.every(Number.isFinite)) {
    throw new CodeChunkStoreError(
      "INVALID_VECTOR",
      "Chunk vector values must all be finite numbers",
    );
  }

  return {
    id: chunk.id,
    vector: [...item.embedding],
    payload: {
      schemaVersion: codeChunkPayloadSchemaVersion,
      chunkId: chunk.id,
      userId: chunk.userId,
      repositoryId: chunk.repositoryId,
      branch: chunk.branch,
      commitSha: chunk.commitSha,
      filePath: chunk.filePath,
      language: chunk.language,
      ...(chunk.symbolType === undefined ? {} : { symbolType: chunk.symbolType }),
      ...(chunk.symbolName === undefined ? {} : { symbolName: chunk.symbolName }),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkIndex: chunk.chunkIndex,
      contentHash: chunk.contentHash,
      content: chunk.content,
      imports: [...chunk.imports],
      exports: [...chunk.exports],
      references: [...(chunk.references ?? [])],
      embeddingModel: item.embeddingModel,
      embeddingDimensions: item.embeddingDimensions,
      embeddingTokenCount: item.embeddingTokenCount,
      embeddingInputHash: item.embeddingInputHash,
    },
  };
}

function createRepositoryFilter(selector: CodeChunkDeleteSelector): {
  must: Array<{ key: string; match: { value: string } }>;
} {
  assertSafeString(selector.userId, "userId", "INVALID_SELECTOR");
  assertSafeString(selector.repositoryId, "repositoryId", "INVALID_SELECTOR");

  const values: Array<[string, string]> = [
    ["userId", selector.userId],
    ["repositoryId", selector.repositoryId],
  ];

  if (selector.branch !== undefined) {
    assertSafeString(selector.branch, "branch", "INVALID_SELECTOR");
    values.push(["branch", selector.branch]);
  }
  if (selector.commitSha !== undefined) {
    assertSafeString(selector.commitSha, "commitSha", "INVALID_SELECTOR");
    values.push(["commitSha", selector.commitSha]);
  }

  return {
    must: values.map(([key, value]) => ({ key, match: { value } })),
  };
}

function batchPoints(
  points: readonly CodeChunkVectorPoint[],
  batchSize: number,
): CodeChunkVectorPoint[][] {
  const batches: CodeChunkVectorPoint[][] = [];
  for (let index = 0; index < points.length; index += batchSize) {
    batches.push(points.slice(index, index + batchSize));
  }
  return batches;
}

export class QdrantCodeChunkStore {
  readonly vectorStore: QdrantVectorStore;

  constructor(config: VectorStoreConfig, client?: QdrantClientContract) {
    this.vectorStore = new QdrantVectorStore(config, client);
  }

  async upsert(
    items: readonly EmbeddedCodeChunk[],
    options: CodeChunkUpsertOptions = {},
  ): Promise<CodeChunkUpsertResult> {
    const batchSize = options.batchSize ?? defaultCodeChunkUpsertBatchSize;
    const writeConcurrency =
      options.writeConcurrency ?? defaultCodeChunkWriteConcurrency;
    const wait = options.wait ?? true;

    assertPositiveInteger(batchSize, "batchSize");
    assertPositiveInteger(writeConcurrency, "writeConcurrency");
    if (batchSize > maximumCodeChunkUpsertBatchSize) {
      throw new CodeChunkStoreError(
        "INVALID_CONFIGURATION",
        `batchSize cannot exceed ${maximumCodeChunkUpsertBatchSize}`,
      );
    }
    assertNotAborted(options.signal);

    if (items.length === 0) {
      return {
        collectionName: this.vectorStore.config.collectionName,
        pointsUpserted: 0,
        batches: 0,
        operationIds: [],
        status: "completed",
      };
    }

    const identifiers = new Set<string>();
    for (const { chunk } of items) {
      if (identifiers.has(chunk.id)) {
        throw new CodeChunkStoreError(
          "DUPLICATE_CHUNK_ID",
          `Duplicate chunk identifier: ${chunk.id}`,
        );
      }
      identifiers.add(chunk.id);
    }

    const points = items.map((item) =>
      toCodeChunkVectorPoint(item, this.vectorStore.config.vectorSize),
    );
    const batches = batchPoints(points, batchSize);
    const limit = pLimit(writeConcurrency);

    try {
      const results = await Promise.all(
        batches.map((batch) =>
          limit(async () => {
            assertNotAborted(options.signal);
            const rawResult = await this.vectorStore.client.upsert(
              this.vectorStore.config.collectionName,
              {
                wait,
                ordering: "medium",
                points: batch,
              },
            );
            const result = readOperationResult(rawResult);
            requireCompletedOperation(result, wait, "WRITE_INCOMPLETE");
            return result;
          }),
        ),
      );

      return {
        collectionName: this.vectorStore.config.collectionName,
        pointsUpserted: points.length,
        batches: batches.length,
        operationIds: results.flatMap((result) =>
          result.operation_id === undefined || result.operation_id === null
            ? []
            : [result.operation_id],
        ),
        status: results.every((result) => result.status === "completed")
          ? "completed"
          : "acknowledged",
      };
    } catch (error) {
      if (error instanceof CodeChunkStoreError) {
        throw error;
      }
      throw new CodeChunkStoreError(
        "WRITE_FAILED",
        "Qdrant failed to persist code-chunk vectors",
        { cause: error },
      );
    }
  }

  async deleteRepositoryChunks(
    selector: CodeChunkDeleteSelector,
    options: CodeChunkDeleteOptions = {},
  ): Promise<CodeChunkDeleteResult> {
    const wait = options.wait ?? true;
    const filter = createRepositoryFilter(selector);
    assertNotAborted(options.signal);

    try {
      const rawResult = await this.vectorStore.client.delete(
        this.vectorStore.config.collectionName,
        {
          wait,
          ordering: "medium",
          filter,
        },
      );
      const result = readOperationResult(rawResult);
      requireCompletedOperation(result, wait, "DELETE_INCOMPLETE");

      return {
        collectionName: this.vectorStore.config.collectionName,
        status: result.status === "completed" ? "completed" : "acknowledged",
        ...(result.operation_id === undefined || result.operation_id === null
          ? {}
          : { operationId: result.operation_id }),
      };
    } catch (error) {
      if (error instanceof CodeChunkStoreError) {
        if (error.code === "WRITE_INCOMPLETE") {
          throw new CodeChunkStoreError("DELETE_INCOMPLETE", error.message, {
            cause: error,
          });
        }
        throw error;
      }
      throw new CodeChunkStoreError(
        "DELETE_FAILED",
        "Qdrant failed to delete repository code chunks",
        { cause: error },
      );
    }
  }
}
