import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeWorkerMetricsServer,
  startWorkerMetricsServer,
} from "../src/observability/metrics-server.js";
import { WorkerMetrics } from "../src/observability/worker-metrics.js";

const token = "m".repeat(32);
const servers: Awaited<ReturnType<typeof startWorkerMetricsServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeWorkerMetricsServer));
});

describe("worker operational metrics", () => {
  it("records job, failure, dependency, AI, and indexing counters", async () => {
    const metrics = new WorkerMetrics({
      aiProvider: "google",
      collectRuntimeMetrics: false,
    });
    metrics.recordJobStarted("indexing");
    metrics.recordJobCompleted("indexing", 2.5, {
      filesIndexed: 3,
      chunksIndexed: 8,
    });
    metrics.recordJobStarted("github_webhook");
    metrics.recordJobFailed("github_webhook", 0.25);
    metrics.recordJobStalled("indexing");
    metrics.recordWorkerError("github_webhook");
    metrics.observeDependency({
      dependency: "qdrant",
      operation: "upsert_chunks",
      outcome: "success",
      durationSeconds: 0.5,
    });
    metrics.observeAi({
      operation: "embedding",
      outcome: "success",
      durationSeconds: 1,
      requests: 2,
      tokens: 100,
    });

    const exposition = await metrics.metrics();
    expect(exposition).toContain("codebase_explainer_worker_jobs_total");
    expect(exposition).toContain('queue="github_webhook"');
    expect(exposition).toContain('outcome="failure"');
    expect(exposition).toContain(
      'codebase_explainer_worker_active_jobs{queue="indexing",service="worker"} 0',
    );
    expect(exposition).toContain(
      'codebase_explainer_worker_indexed_files_total{service="worker"} 3',
    );
    expect(exposition).toContain(
      'codebase_explainer_worker_indexed_chunks_total{service="worker"} 8',
    );
    expect(exposition).toContain('provider="google"');
    expect(exposition).toContain('dependency="qdrant"');
  });

  it("serves public health and bearer-protected metrics", async () => {
    const metrics = new WorkerMetrics({ collectRuntimeMetrics: false });
    const server = await startWorkerMetricsServer({
      host: "127.0.0.1",
      port: 0,
      metrics,
      bearerToken: token,
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      service: "worker",
    });

    const unauthorized = await fetch(`${baseUrl}/metrics`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("codebase_explainer_worker_jobs_total");
    expect(body).not.toContain(token);
  });

  it("rejects unknown routes and unsupported methods", async () => {
    const server = await startWorkerMetricsServer({
      host: "127.0.0.1",
      port: 0,
      metrics: new WorkerMetrics({ collectRuntimeMetrics: false }),
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/health`, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
  });
});
