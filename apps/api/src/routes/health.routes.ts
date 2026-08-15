import { Router } from "express";

import {
  getDatabaseStatus,
  pingDatabase,
} from "@codebase-explainer/database";

import { env } from "../config/env.js";
import { vectorStore } from "../config/vector-store.js";
import {
  getDefaultApiMetrics,
  type ApiDependency,
} from "../observability/api-metrics.js";
import { getDefaultRepositoryIndexingQueue } from "../queues/repository-indexing.queue.js";

const startedAt = new Date().toISOString();
const metrics = env.METRICS_ENABLED ? getDefaultApiMetrics() : undefined;

async function observeHealthDependency<Result>(
  dependency: ApiDependency,
  action: () => Promise<Result>,
): Promise<Result> {
  const startedAt = performance.now();
  try {
    const result = await action();
    try {
      metrics?.observeDependency({
        dependency,
        operation: "health_check",
        outcome: "success",
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
    } catch {
      // Health availability must not depend on metric collection.
    }
    return result;
  } catch (error) {
    try {
      metrics?.observeDependency({
        dependency,
        operation: "health_check",
        outcome: "failure",
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
    } catch {
      // Preserve the dependency error when metric collection fails.
    }
    throw error;
  }
}

export const healthRouter = Router();

healthRouter.get("/health", (_request, response) => {
  response.status(200).json({
    status: "ok",
    service: "api",
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/health/database", async (_request, response) => {
  const healthy = await observeHealthDependency("mongodb", pingDatabase);

  response.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "unavailable",
    service: "mongodb",
    connection: getDatabaseStatus(),
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/health/qdrant", async (_request, response) => {
  const health = await observeHealthDependency("qdrant", () =>
    vectorStore.health(),
  );

  response.status(health.status === "ok" ? 200 : 503).json({
    ...health,
    service: "qdrant",
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/health/redis", async (_request, response) => {
  const healthy = await observeHealthDependency("redis", () =>
    getDefaultRepositoryIndexingQueue().health(),
  );

  response.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "unavailable",
    service: "redis",
    timestamp: new Date().toISOString(),
  });
});
