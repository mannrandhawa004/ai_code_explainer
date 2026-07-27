import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";

import { createApp } from "../src/app.js";

const mongodbTestUri = process.env.MONGODB_TEST_URI;
const describeWithMongo = mongodbTestUri ? describe : describe.skip;

describeWithMongo("API MongoDB health integration", () => {
  beforeAll(async () => {
    await connectDatabase(mongodbTestUri as string);
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it("reports MongoDB as healthy through the API", async () => {
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
    });
    const response = await request(app).get("/api/health/database").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "mongodb",
      connection: "connected",
    });
  });
});
