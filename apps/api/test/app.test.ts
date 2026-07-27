import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const app = createApp({
  logger: pino({ level: "silent" }),
  disableRateLimit: true,
});

describe("Express API", () => {
  it("returns service health metadata", async () => {
    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "api",
    });
    expect(response.body.timestamp).toEqual(expect.any(String));
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("reports an unavailable database without crashing the API", async () => {
    const response = await request(app).get("/api/health/database").expect(503);

    expect(response.body).toMatchObject({
      status: "unavailable",
      service: "mongodb",
      connection: "disconnected",
    });
  });

  it("returns a normalized response for unknown routes", async () => {
    const response = await request(app).get("/api/unknown").expect(404);

    expect(response.body).toMatchObject({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route GET /api/unknown was not found",
      },
    });
    expect(response.body.error.requestId).toEqual(expect.any(String));
  });

  it("rejects malformed JSON with a safe error", async () => {
    const response = await request(app)
      .post("/api/unknown")
      .set("content-type", "application/json")
      .send('{"broken":')
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: "INVALID_JSON",
      message: "The request body contains invalid JSON",
    });
  });

  it("rejects requests from origins outside the CORS allowlist", async () => {
    const response = await request(app)
      .get("/api/health")
      .set("origin", "https://untrusted.example")
      .expect(403);

    expect(response.body.error).toMatchObject({
      code: "CORS_ORIGIN_DENIED",
      message: "This origin is not allowed",
    });
  });
});
