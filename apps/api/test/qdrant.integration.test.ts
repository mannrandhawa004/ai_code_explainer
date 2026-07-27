import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { vectorStore } from "../src/config/vector-store.js";

const qdrantTestUrl = process.env.QDRANT_TEST_URL;
const describeWithQdrant = qdrantTestUrl ? describe : describe.skip;

describeWithQdrant("API Qdrant health integration", () => {
  beforeAll(async () => {
    await vectorStore.ensureCollection();
  });

  afterAll(async () => {
    await fetch(
      `${qdrantTestUrl as string}/collections/${encodeURIComponent(env.QDRANT_COLLECTION)}`,
      { method: "DELETE" },
    );
  });

  it("reports Qdrant as healthy through the API", async () => {
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
    });
    const response = await request(app).get("/api/health/qdrant").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "qdrant",
      collectionName: env.QDRANT_COLLECTION,
      collectionExists: true,
    });
    expect(response.body.version).toEqual(expect.any(String));
  });
});
