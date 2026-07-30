import { describe, expect, it } from "vitest";

import { parseWorkerEnvironment } from "../src/config/env.js";

describe("worker environment", () => {
  it("uses bounded local-development defaults", () => {
    const result = parseWorkerEnvironment({ NODE_ENV: "test" });

    expect(result.REDIS_URL).toBe("redis://localhost:6379");
    expect(result.INDEXING_CONCURRENCY).toBe(2);
    expect(result.MAX_REPOSITORY_FILES).toBe(5_000);
  });

  it("requires an encrypted Redis connection in production", () => {
    expect(() =>
      parseWorkerEnvironment({
        NODE_ENV: "production",
        REDIS_URL: "redis://production.example:6379",
      }),
    ).toThrow("REDIS_URL must use TLS");
  });

  it("rejects unbounded worker concurrency", () => {
    expect(() =>
      parseWorkerEnvironment({ NODE_ENV: "test", INDEXING_CONCURRENCY: "33" }),
    ).toThrow("Invalid worker environment");
  });
});
