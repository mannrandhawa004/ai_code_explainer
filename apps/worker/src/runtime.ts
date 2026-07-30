import {
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";

import type {
  RepositoryIndexingJobData,
  RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";
import { indexingJobName } from "@codebase-explainer/shared";

import { env, type WorkerEnvironment } from "./config/env.js";
import { logger } from "./config/logger.js";
import { createWorkerRedisConnection } from "./config/redis.js";
import { createDefaultRepositoryIndexingProcessor } from "./jobs/repository-indexing.processor.js";
import { createRepositoryIndexingWorker } from "./worker.js";

export type WorkerRuntime = {
  worker: Worker<
    RepositoryIndexingJobData,
    RepositoryIndexingJobResult,
    typeof indexingJobName
  >;
  connection: Redis;
  close(force?: boolean): Promise<void>;
};

export async function startWorkerRuntime(
  environment: WorkerEnvironment = env,
): Promise<WorkerRuntime> {
  await connectDatabase(environment.MONGODB_URI, {
    serverSelectionTimeoutMS: environment.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  });

  const connection = createWorkerRedisConnection(environment.REDIS_URL);
  connection.on("error", (error) => {
    logger.error({ error }, "Worker Redis connection error");
  });

  try {
    await connection.connect();
    await connection.ping();
    const processor = createDefaultRepositoryIndexingProcessor(environment);
    const worker = createRepositoryIndexingWorker({
      connection,
      processor,
      concurrency: environment.INDEXING_CONCURRENCY,
    });

    let closePromise: Promise<void> | undefined;
    const close = (force = false): Promise<void> => {
      closePromise ??= (async () => {
        await worker.close(force);
        await connection.quit();
        await disconnectDatabase();
      })();
      return closePromise;
    };

    logger.info(
      { concurrency: environment.INDEXING_CONCURRENCY },
      "Repository indexing worker started",
    );
    return { worker, connection, close };
  } catch (error) {
    connection.disconnect();
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
      process.exit(1);
    }, environment.WORKER_SHUTDOWN_TIMEOUT_MS);
    forcedShutdown.unref();

    try {
      await runtime.close();
      clearTimeout(forcedShutdown);
      logger.info("Repository indexing worker stopped");
    } catch (error) {
      clearTimeout(forcedShutdown);
      logger.error({ error }, "Repository indexing worker failed to stop");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
