import { QdrantClient } from "@qdrant/js-client-rest";

export type VectorStoreConfig = {
  url: string;
  apiKey: string | undefined;
  collectionName: string;
  vectorSize: number;
  requestTimeoutMs: number;
};

export type VectorStoreHealth = {
  status: "ok" | "unavailable";
  collectionName: string;
  collectionExists: boolean;
  version?: string;
};

export type EnsureCollectionResult = {
  collectionName: string;
  status: "created" | "existing";
  indexedFields: string[];
};

export type QdrantClientContract = Pick<
  QdrantClient,
  | "collectionExists"
  | "createCollection"
  | "createPayloadIndex"
  | "delete"
  | "getCollection"
  | "retrieve"
  | "upsert"
  | "versionInfo"
>;

export const qdrantPayloadIndexes = [
  "userId",
  "repositoryId",
  "branch",
  "commitSha",
  "filePath",
  "language",
  "symbolName",
  "symbolType",
  "contentHash",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCollectionVectors(vectors: unknown, expectedSize: number): void {
  if (!isRecord(vectors) || typeof vectors.size !== "number") {
    throw new Error("Qdrant collection must use one unnamed dense vector");
  }

  if (vectors.size !== expectedSize) {
    throw new Error(
      `Qdrant collection vector size is ${vectors.size}; expected ${expectedSize}`,
    );
  }

  if (vectors.distance !== "Cosine") {
    throw new Error(
      `Qdrant collection distance is ${String(vectors.distance)}; expected Cosine`,
    );
  }
}

export class QdrantVectorStore {
  readonly client: QdrantClientContract;

  constructor(
    readonly config: VectorStoreConfig,
    client?: QdrantClientContract,
  ) {
    if (!config.url.trim()) {
      throw new Error("Qdrant URL is required");
    }

    if (!config.collectionName.trim()) {
      throw new Error("Qdrant collection name is required");
    }

    if (!Number.isInteger(config.vectorSize) || config.vectorSize <= 0) {
      throw new Error("Qdrant vector size must be a positive integer");
    }

    this.client =
      client ??
      new QdrantClient({
        url: config.url,
        timeout: config.requestTimeoutMs,
        checkCompatibility: true,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      });
  }

  async ensureCollection(): Promise<EnsureCollectionResult> {
    const existence = await this.client.collectionExists(
      this.config.collectionName,
    );
    let status: EnsureCollectionResult["status"] = "existing";
    let existingPayloadSchema: Record<string, unknown> = {};

    if (!existence.exists) {
      const created = await this.client.createCollection(
        this.config.collectionName,
        {
          vectors: {
            size: this.config.vectorSize,
            distance: "Cosine",
          },
          on_disk_payload: true,
        },
      );

      if (!created) {
        throw new Error("Qdrant did not create the code-chunk collection");
      }

      status = "created";
    } else {
      const collection = await this.client.getCollection(
        this.config.collectionName,
      );
      validateCollectionVectors(
        collection.config.params.vectors,
        this.config.vectorSize,
      );
      existingPayloadSchema = collection.payload_schema;
    }

    const indexedFields: string[] = [];

    for (const fieldName of qdrantPayloadIndexes) {
      if (fieldName in existingPayloadSchema) {
        indexedFields.push(fieldName);
        continue;
      }

      await this.client.createPayloadIndex(this.config.collectionName, {
        field_name: fieldName,
        field_schema: "keyword",
        wait: true,
      });
      indexedFields.push(fieldName);
    }

    return {
      collectionName: this.config.collectionName,
      status,
      indexedFields,
    };
  }

  async health(): Promise<VectorStoreHealth> {
    try {
      const [version, existence] = await Promise.all([
        this.client.versionInfo(),
        this.client.collectionExists(this.config.collectionName),
      ]);

      return {
        status: existence.exists ? "ok" : "unavailable",
        collectionName: this.config.collectionName,
        collectionExists: existence.exists,
        version: version.version,
      };
    } catch {
      return {
        status: "unavailable",
        collectionName: this.config.collectionName,
        collectionExists: false,
      };
    }
  }
}
