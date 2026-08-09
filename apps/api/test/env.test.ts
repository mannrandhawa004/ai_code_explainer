import { describe, expect, it } from "vitest";

import { parseApiEnvironment } from "../src/config/env.js";

const secureProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.com",
  MONGODB_URI: "mongodb+srv://user:password@cluster.example/database",
  REDIS_URL: "rediss://cache.example.com:6380",
  QDRANT_URL: "https://vectors.example.com",
  QDRANT_API_KEY: "qdrant-test-key",
  QDRANT_VECTOR_SIZE: "1536",
  AI_PROVIDER: "openai",
  OPENAI_API_KEY: "openai-test-key",
  GITHUB_APP_ID: "123456",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  GITHUB_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "w".repeat(32),
  GITHUB_CALLBACK_URL: "https://api.example.com/api/auth/github/callback",
  JWT_SECRET: "j".repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("API environment", () => {
  it("accepts a fully encrypted production configuration", () => {
    const result = parseApiEnvironment(secureProductionEnvironment);

    expect(result.NODE_ENV).toBe("production");
    expect(result.MONGODB_URI).toMatch(/^mongodb\+srv:\/\//u);
    expect(result.REDIS_URL).toMatch(/^rediss:\/\//u);
    expect(result.QDRANT_URL).toMatch(/^https:\/\//u);
    expect(result.INDEXING_MAX_ATTEMPTS).toBe(1);
  });

  it.each([
    {
      field: "MongoDB",
      environment: {
        ...secureProductionEnvironment,
        MONGODB_URI: "mongodb://database.example.com/app",
      },
      message: "MONGODB_URI must use TLS",
    },
    {
      field: "Qdrant",
      environment: {
        ...secureProductionEnvironment,
        QDRANT_URL: "http://vectors.example.com",
      },
      message: "QDRANT_URL must use HTTPS",
    },
    {
      field: "OpenAI",
      environment: {
        ...secureProductionEnvironment,
        OPENAI_API_KEY: "",
      },
      message: "OPENAI_API_KEY must be configured",
    },
  ])("rejects an insecure or missing $field production setting", ({ environment, message }) => {
    expect(() => parseApiEnvironment(environment)).toThrow(message);
  });

  it("accepts explicit TLS on a standard MongoDB connection string", () => {
    const result = parseApiEnvironment({
      ...secureProductionEnvironment,
      MONGODB_URI: "mongodb://database.example.com/app?tls=true",
    });

    expect(result.MONGODB_URI).toContain("tls=true");
  });

  it("accepts Ollama without an OpenAI key when vector dimensions match", () => {
    const result = parseApiEnvironment({
      ...secureProductionEnvironment,
      AI_PROVIDER: "ollama",
      OPENAI_API_KEY: "",
      QDRANT_VECTOR_SIZE: "1024",
    });

    expect(result.AI_PROVIDER).toBe("ollama");
    expect(result.OLLAMA_EMBEDDING_DIMENSIONS).toBe(1_024);
  });

  it("accepts Google AI without an OpenAI key when vector dimensions match", () => {
    const result = parseApiEnvironment({
      ...secureProductionEnvironment,
      AI_PROVIDER: "google",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "google-test-key",
      QDRANT_VECTOR_SIZE: "768",
    });

    expect(result.AI_PROVIDER).toBe("google");
    expect(result.GOOGLE_EMBEDDING_DIMENSIONS).toBe(768);
  });

  it("requires a Google AI key when Google is selected in production", () => {
    expect(() =>
      parseApiEnvironment({
        ...secureProductionEnvironment,
        AI_PROVIDER: "google",
        OPENAI_API_KEY: "",
        GOOGLE_API_KEY: "",
        GEMINI_API_KEY: "",
        QDRANT_VECTOR_SIZE: "768",
      }),
    ).toThrow("GOOGLE_API_KEY or GEMINI_API_KEY must be configured");
  });
});
