import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { ApiMetrics } from "../src/observability/api-metrics.js";

const metricsToken = "m".repeat(32);

function createMetrics() {
  return new ApiMetrics({
    aiProvider: "google",
    collectRuntimeMetrics: false,
    queueDepthCollector: vi.fn().mockResolvedValue([
      { queue: "indexing", state: "waiting", value: 3 },
      { queue: "indexing", state: "active", value: 1 },
      { queue: "github_webhook", state: "failed", value: 2 },
    ]),
  });
}

function createTestApp(metrics: ApiMetrics) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    apiMetrics: metrics,
    metricsEnabled: true,
    metricsBearerToken: metricsToken,
  });
}

describe("API operational metrics", () => {
  it("protects the scrape endpoint and returns Prometheus exposition", async () => {
    const metrics = createMetrics();
    const app = createTestApp(metrics);

    const unauthorized = await request(app).get("/api/metrics").expect(401);
    expect(unauthorized.headers["www-authenticate"]).toBe("Bearer");
    expect(unauthorized.body.error.code).toBe(
      "METRICS_AUTHENTICATION_REQUIRED",
    );

    const response = await request(app)
      .get("/api/metrics")
      .set("authorization", `Bearer ${metricsToken}`)
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text).toContain("codebase_explainer_api_queue_jobs");
    expect(response.text).toContain('queue="indexing"');
    expect(response.text).toContain('state="waiting"');
    expect(response.text).not.toContain(metricsToken);
  });

  it("records bounded HTTP routes, status classes, and normalized errors", async () => {
    const metrics = createMetrics();
    const app = createTestApp(metrics);

    await request(app).get("/api/health").expect(200);
    await request(app).get("/api/private-value-123").expect(404);
    const exposition = await metrics.metrics();

    expect(exposition).toContain(
      'codebase_explainer_api_http_requests_total{method="GET",route="/api/health",status_class="2xx",service="api"} 1',
    );
    expect(exposition).toContain('route="unmatched"');
    expect(exposition).not.toContain("private-value-123");
    expect(exposition).toContain('code="ROUTE_NOT_FOUND"');
  });

  it("records dependency, AI request, duration, and token signals", async () => {
    const metrics = createMetrics();
    metrics.observeDependency({
      dependency: "qdrant",
      operation: "retrieval",
      outcome: "success",
      durationSeconds: 0.125,
    });
    metrics.observeAi({
      operation: "embedding",
      outcome: "success",
      durationSeconds: 0.25,
      embeddingRequests: 2,
      embeddingTokens: 40,
    });
    metrics.observeAi({
      operation: "generation",
      outcome: "success",
      durationSeconds: 0.5,
      answerUsage: {
        inputTokens: 20,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 27,
      },
    });

    const exposition = await metrics.metrics();
    expect(exposition).toContain('dependency="qdrant"');
    expect(exposition).toContain('provider="google"');
    expect(exposition).toContain('operation="embedding"');
    expect(exposition).toContain('type="total"');
  });

  it("keeps the scrape available when queue collection fails", async () => {
    const metrics = new ApiMetrics({
      collectRuntimeMetrics: false,
      queueDepthCollector: vi.fn().mockRejectedValue(new Error("redis secret")),
    });

    await expect(metrics.metrics()).resolves.toContain(
      "codebase_explainer_api_metric_collection_errors_total",
    );
    expect(await metrics.metrics()).not.toContain("redis secret");
  });
});
