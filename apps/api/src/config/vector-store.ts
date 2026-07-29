import { QdrantVectorStore } from "@codebase-explainer/vector-store";

import { env } from "./env.js";

export const vectorStoreConfig = {
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY,
  collectionName: env.QDRANT_COLLECTION,
  vectorSize: env.QDRANT_VECTOR_SIZE,
  requestTimeoutMs: env.QDRANT_REQUEST_TIMEOUT_MS,
};

export const vectorStore = new QdrantVectorStore(vectorStoreConfig);
