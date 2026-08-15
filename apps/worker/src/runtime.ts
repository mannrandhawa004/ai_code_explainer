import {
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Server } from "node:http";

import type {
  GitHubWebhookJobData,
  GitHubWebhookJobResult,
  RepositoryIndexingJobData,
  RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";
import { githubWebhookJobName, indexingJobName } from "@codebase-explainer/shared";

import { env, type WorkerEnvironment } from "./config/env.js";
import { logger } from "./config/logger.js";
import { createWorkerRedisConnection } from "./config/redis.js";
import { createDefaultRepositoryIndexingProcessor } from "./jobs/repository-indexing.processor.js";
import { GitHubWebhookProcessor } from "./jobs/github-webhook.processor.js";
import { BullMqRepositoryIndexingProducer } from "./queues/repository-indexing.producer.js";
import { GitHubInstallationTokenProvider } from "./services/github-installation-token.service.js";
import { MongoGitHubWebhookRepositoryOperations } from "./services/github-webhook-repository.service.js";
import { createGitHubWebhookWorker } from "./github-webhook.worker.js";
import { createRepositoryIndexingWorker } from "./worker.js";
import {
  closeWorkerMetricsServer,
  startWorkerMetricsServer,
} from "./observability/metrics-server.js";
import { getDefaultWorkerMetrics } from "./observability/worker-metrics.js";

export type WorkerRuntime = {
  worker: Worker<
    RepositoryIndexingJobData,
    RepositoryIndexingJobResult,
    typeof indexingJobName
  >;
  webhookWorker: Worker<
    GitHubWebhookJobData,
    GitHubWebhookJobResult,
    typeof githubWebhookJobName
  >;
  connection: Redis;
  webhookConnection: Redis;
  metricsServer?: Server;
  close(force?: boolean): Promise<void>;
};

export async function startWorkerRuntime(
  environment: WorkerEnvironment = env,
): Promise<WorkerRuntime> {
  await connectDatabase(environment.MONGODB_URI, {
    serverSelectionTimeoutMS: environment.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  });

  const connection = createWorkerRedisConnection(environment.REDIS_URL);
  const webhookConnection = createWorkerRedisConnection(
    environment.REDIS_URL,
    "codebase-explainer-github-webhook-worker",
  );
  connection.on("error", (error) => {
    logger.error({ error }, "Worker Redis connection error");
  });
  webhookConnection.on("error", (error) => {
    logger.error({ error }, "GitHub webhook worker Redis connection error");
  });

  let indexingProducer: BullMqRepositoryIndexingProducer | undefined;
  let repositoryWorker: ReturnType<
    typeof createRepositoryIndexingWorker
  > | undefined;
  let githubWebhookWorker: ReturnType<
    typeof createGitHubWebhookWorker
  > | undefined;
  let metricsServer: Server | undefined;

  try {
    await Promise.all([connection.connect(), webhookConnection.connect()]);
    await Promise.all([connection.ping(), webhookConnection.ping()]);
    const metrics = environment.WORKER_METRICS_ENABLED
      ? getDefaultWorkerMetrics()
      : undefined;
    const processor = createDefaultRepositoryIndexingProcessor(environment);
    const createdRepositoryWorker = createRepositoryIndexingWorker({
      connection,
      processor,
      concurrency: environment.INDEXING_CONCURRENCY,
      ...(metrics === undefined ? {} : { metrics }),
    });
    repositoryWorker = createdRepositoryWorker;
    const createdIndexingProducer = new BullMqRepositoryIndexingProducer(
      environment.REDIS_URL,
      environment.INDEXING_MAX_ATTEMPTS,
    );
    indexingProducer = createdIndexingProducer;
    const repositoryOperations = new MongoGitHubWebhookRepositoryOperations(
      createdIndexingProducer,
    );
    const installationTokens =
      environment.GITHUB_APP_ID && environment.GITHUB_PRIVATE_KEY
        ? new GitHubInstallationTokenProvider(
            environment.GITHUB_APP_ID,
            environment.GITHUB_PRIVATE_KEY,
          )
        : undefined;
    const webhookProcessor = new GitHubWebhookProcessor(
      repositoryOperations,
      installationTokens,
    );
    const createdWebhookWorker = createGitHubWebhookWorker({
      connection: webhookConnection,
      processor: webhookProcessor,
      concurrency: environment.GITHUB_WEBHOOK_CONCURRENCY,
      ...(metrics === undefined ? {} : { metrics }),
    });
    githubWebhookWorker = createdWebhookWorker;
    if (metrics !== undefined) {
      metricsServer = await startWorkerMetricsServer({
        host: environment.WORKER_METRICS_HOST,
        port: environment.WORKER_METRICS_PORT,
        metrics,
        ...(environment.METRICS_BEARER_TOKEN === undefined
          ? {}
          : { bearerToken: environment.METRICS_BEARER_TOKEN }),
      });
    }

    let closePromise: Promise<void> | undefined;
    const close = (force = false): Promise<void> => {
      closePromise ??= (async () => {
        await Promise.all([
          createdRepositoryWorker.close(force),
          createdWebhookWorker.close(force),
        ]);
        await createdIndexingProducer.close();
        if (metricsServer !== undefined) {
          await closeWorkerMetricsServer(metricsServer);
        }
        await Promise.all([connection.quit(), webhookConnection.quit()]);
        await disconnectDatabase();
      })();
      return closePromise;
    };

    logger.info(
      {
        indexingConcurrency: environment.INDEXING_CONCURRENCY,
        webhookConcurrency: environment.GITHUB_WEBHOOK_CONCURRENCY,
        ...(metricsServer === undefined
          ? { metricsEnabled: false }
          : {
              metricsEnabled: true,
              metricsHost: environment.WORKER_METRICS_HOST,
              metricsPort: environment.WORKER_METRICS_PORT,
            }),
      },
      "Repository indexing and GitHub webhook workers started",
    );
    return {
      worker: createdRepositoryWorker,
      webhookWorker: createdWebhookWorker,
      connection,
      webhookConnection,
      ...(metricsServer === undefined ? {} : { metricsServer }),
      close,
    };
  } catch (error) {
    await Promise.allSettled([
      repositoryWorker?.close(true),
      githubWebhookWorker?.close(true),
      indexingProducer?.close(),
      metricsServer === undefined
        ? undefined
        : closeWorkerMetricsServer(metricsServer),
    ]);
    connection.disconnect();
    webhookConnection.disconnect();
    await disconnectDatabase();
    throw error;
  }
}

export async function runWorker(environment: WorkerEnvironment = env): Promise<void> {
  const runtime = await startWorkerRuntime(environment);
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Worker graceful shutdown started");

    const forcedShutdown = setTimeout(() => {
      logger.error("Worker graceful shutdown timed out; forcing close");
      runtime.connection.disconnect();
      runtime.webhookConnection.disconnect();
      process.exit(1);
    }, environment.WORKER_SHUTDOWN_TIMEOUT_MS);
    forcedShutdown.unref();

    try {
      await runtime.close();
      clearTimeout(forcedShutdown);
      logger.info("Repository indexing and GitHub webhook workers stopped");
    } catch (error) {
      clearTimeout(forcedShutdown);
      logger.error({ error }, "Repository indexing worker failed to stop");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
