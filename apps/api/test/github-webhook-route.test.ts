import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { GitHubWebhookServiceContract } from "../src/services/github-webhook.service.js";

const deliveryId = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

function createService(): GitHubWebhookServiceContract {
  return {
    receive: vi.fn().mockResolvedValue({
      accepted: true,
      deliveryId,
      eventName: "ping",
      status: "ignored",
    }),
  };
}

function createTestApp(service: GitHubWebhookServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    githubWebhookService: service,
  });
}

describe("GitHub webhook route", () => {
  it("preserves the exact raw JSON body for signature verification", async () => {
    const service = createService();
    const rawBody = '{"zen":"Keep it logically awesome.","unicode":"✓"}';
    const response = await request(createTestApp(service))
      .post("/api/github/webhook")
      .set("content-type", "application/json")
      .set("x-github-delivery", deliveryId)
      .set("x-github-event", "ping")
      .set("x-hub-signature-256", `sha256=${"a".repeat(64)}`)
      .send(rawBody)
      .expect(202);

    expect(response.body.data.status).toBe("ignored");
    expect(service.receive).toHaveBeenCalledWith({
      deliveryId,
      eventName: "ping",
      signature: `sha256=${"a".repeat(64)}`,
      rawBody: Buffer.from(rawBody),
    });
  });

  it("rejects non-JSON content before webhook processing", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .post("/api/github/webhook")
      .set("content-type", "text/plain")
      .set("x-github-delivery", deliveryId)
      .set("x-github-event", "ping")
      .set("x-hub-signature-256", `sha256=${"a".repeat(64)}`)
      .send("payload")
      .expect(415);

    expect(response.body.error.code).toBe("INVALID_WEBHOOK_CONTENT_TYPE");
    expect(service.receive).not.toHaveBeenCalled();
  });

  it("requires all GitHub delivery headers", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .post("/api/github/webhook")
      .set("content-type", "application/json")
      .send("{}")
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_WEBHOOK_HEADERS");
    expect(service.receive).not.toHaveBeenCalled();
  });
});
