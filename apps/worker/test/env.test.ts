import { describe, expect, it } from "vitest";

import { parseWorkerEnvironment } from "../src/config/env.js";

const secureProductionEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  MONGODB_URI: "mongodb+srv://user:password@cluster.example/database",
  REDIS_URL: "rediss://cache.example.com:6380",
  QDRANT_URL: "https://vectors.example.com",
  QDRANT_API_KEY: "qdrant-test-key",
  OPENAI_API_KEY: "openai-test-key",
  GITHUB_APP_ID: "123456",
  GITHUB_PRIVATE_KEY: "test-private-key",
};

describe("worker environment", () => {
  it("uses bounded local-development defaults", () => {
    const result = parseWorkerEnvironment({ NODE_ENV: "test" });

    expect(result.REDIS_URL).toBe("redis://localhost:6379");
    expect(result.INDEXING_CONCURRENCY).toBe(2);
    expect(result.MAX_REPOSITORY_FILES).toBe(5_000);
    expect(result.GITHUB_WEBHOOK_CONCURRENCY).toBe(1);
  });

  it("requires an encrypted Redis connection in production", () => {
    expect(() =>
      parseWorkerEnvironment({
        NODE_ENV: "production",
        REDIS_URL: "redis://production.example:6379",
      }),
    ).toThrow("REDIS_URL must use TLS");
  });

  it("accepts encrypted managed services in production", () => {
    const result = parseWorkerEnvironment(secureProductionEnvironment);

    expect(result.NODE_ENV).toBe("production");
    expect(result.QDRANT_API_KEY).toBe("qdrant-test-key");
    expect(result.OPENAI_API_KEY).toBe("openai-test-key");
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
    expect(() => parseWorkerEnvironment(environment)).toThrow(message);
  });

  it("rejects unbounded worker concurrency", () => {
    expect(() =>
      parseWorkerEnvironment({ NODE_ENV: "test", INDEXING_CONCURRENCY: "33" }),
    ).toThrow("Invalid worker environment");
  });

  it("requires both GitHub App credentials when private indexing is configured", () => {
    expect(() =>
      parseWorkerEnvironment({ NODE_ENV: "test", GITHUB_APP_ID: "123" }),
    ).toThrow("GITHUB_APP_ID and GITHUB_PRIVATE_KEY");
  });
});
