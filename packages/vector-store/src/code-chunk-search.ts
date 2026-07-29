import {
  QdrantVectorStore,
  type QdrantClientContract,
  type VectorStoreConfig,
} from "./vector-store.js";

export const defaultCodeChunkSearchLimit = 15;
export const maximumCodeChunkSearchLimit = 50;

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export type CodeChunkSearchRequest = {
  vector: readonly number[];
  userId: string;
  repositoryId: string;
  branch: string;
  commitSha: string;
  limit?: number;
  scoreThreshold?: number;
  signal?: AbortSignal;
};

export type CodeChunkSearchResult = {
  id: string;
  score: number;
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
};

export type CodeChunkSearchErrorCode =
  | "INVALID_QUERY"
  | "VECTOR_DIMENSION_MISMATCH"
  | "INVALID_VECTOR"
  | "SEARCH_FAILED"
  | "INVALID_RESULT"
  | "SEARCH_ABORTED";

export class CodeChunkSearchError extends Error {
  override readonly name = "CodeChunkSearchError";

  constructor(
    readonly code: CodeChunkSearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function assertSafeString(value: string, fieldName: string): void {
  if (!value.trim() || value.includes("\0")) {
    throw new CodeChunkSearchError(
      "INVALID_QUERY",
      `${fieldName} must be a non-empty string without null bytes`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CodeChunkSearchError(
      "SEARCH_ABORTED",
      "The code-chunk search was aborted",
      { cause: signal.reason },
    );
  }
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      `Qdrant result contains an invalid ${key} payload field`,
    );
  }
  return value;
}

function readOptionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      `Qdrant result contains an invalid ${key} payload field`,
    );
  }
  return value;
}

function readInteger(
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      `Qdrant result contains an invalid ${key} payload field`,
    );
  }
  return value as number;
}

function mapSearchResult(
  point: {
    id: number | string;
    score: number;
    payload?: Record<string, unknown> | null;
  },
  request: CodeChunkSearchRequest,
): CodeChunkSearchResult {
  if (typeof point.id !== "string" || !canonicalUuidPattern.test(point.id)) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      "Qdrant result contains an invalid chunk identifier",
    );
  }
  if (!Number.isFinite(point.score)) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      "Qdrant result contains a non-finite score",
    );
  }
  if (!point.payload || typeof point.payload !== "object") {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      "Qdrant result is missing its code-chunk payload",
    );
  }

  const userId = readString(point.payload, "userId");
  const repositoryId = readString(point.payload, "repositoryId");
  const branch = readString(point.payload, "branch");
  const commitSha = readString(point.payload, "commitSha");
  if (
    userId !== request.userId ||
    repositoryId !== request.repositoryId ||
    branch !== request.branch ||
    commitSha !== request.commitSha
  ) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      "Qdrant returned a code chunk outside the requested repository scope",
    );
  }

  const symbolType = readOptionalString(point.payload, "symbolType");
  const symbolName = readOptionalString(point.payload, "symbolName");
  const startLine = readInteger(point.payload, "startLine", 1);
  const endLine = readInteger(point.payload, "endLine", 1);
  if (endLine < startLine) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      "Qdrant result contains an invalid source line range",
    );
  }
  const contentHash = readString(point.payload, "contentHash");
  if (!sha256Pattern.test(contentHash)) {
    throw new CodeChunkSearchError(
      "INVALID_RESULT",
      "Qdrant result contains an invalid contentHash payload field",
    );
  }
  return {
    id: point.id,
    score: point.score,
    userId,
    repositoryId,
    branch,
    commitSha,
    filePath: readString(point.payload, "filePath"),
    language: readString(point.payload, "language"),
    ...(symbolType === undefined ? {} : { symbolType }),
    ...(symbolName === undefined ? {} : { symbolName }),
    startLine,
    endLine,
    chunkIndex: readInteger(point.payload, "chunkIndex", 0),
    contentHash,
    content: readString(point.payload, "content"),
  };
}

export class QdrantCodeChunkSearch {
  readonly vectorStore: QdrantVectorStore;

  constructor(config: VectorStoreConfig, client?: QdrantClientContract) {
    this.vectorStore = new QdrantVectorStore(config, client);
  }

  async search(
    request: CodeChunkSearchRequest,
  ): Promise<CodeChunkSearchResult[]> {
    for (const [fieldName, value] of [
      ["userId", request.userId],
      ["repositoryId", request.repositoryId],
      ["branch", request.branch],
      ["commitSha", request.commitSha],
    ] as const) {
      assertSafeString(value, fieldName);
    }
    const limit = request.limit ?? defaultCodeChunkSearchLimit;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > maximumCodeChunkSearchLimit
    ) {
      throw new CodeChunkSearchError(
        "INVALID_QUERY",
        `limit must be between 1 and ${maximumCodeChunkSearchLimit}`,
      );
    }
    if (
      request.scoreThreshold !== undefined &&
      !Number.isFinite(request.scoreThreshold)
    ) {
      throw new CodeChunkSearchError(
        "INVALID_QUERY",
        "scoreThreshold must be a finite number",
      );
    }
    if (request.vector.length !== this.vectorStore.config.vectorSize) {
      throw new CodeChunkSearchError(
        "VECTOR_DIMENSION_MISMATCH",
        `Question vector dimension must match collection size ${this.vectorStore.config.vectorSize}`,
      );
    }
    if (!request.vector.every(Number.isFinite)) {
      throw new CodeChunkSearchError(
        "INVALID_VECTOR",
        "Question vector values must all be finite numbers",
      );
    }
    assertNotAborted(request.signal);

    try {
      const response = await this.vectorStore.client.query(
        this.vectorStore.config.collectionName,
        {
          query: [...request.vector],
          limit,
          ...(request.scoreThreshold === undefined
            ? {}
            : { score_threshold: request.scoreThreshold }),
          filter: {
            must: [
              { key: "userId", match: { value: request.userId } },
              {
                key: "repositoryId",
                match: { value: request.repositoryId },
              },
              { key: "branch", match: { value: request.branch } },
              { key: "commitSha", match: { value: request.commitSha } },
            ],
          },
          with_payload: true,
          with_vector: false,
        },
      );
      assertNotAborted(request.signal);
      return response.points.map((point) => mapSearchResult(point, request));
    } catch (error) {
      if (error instanceof CodeChunkSearchError) {
        throw error;
      }
      throw new CodeChunkSearchError(
        "SEARCH_FAILED",
        "Qdrant failed to retrieve repository code chunks",
        { cause: error },
      );
    }
  }
}
