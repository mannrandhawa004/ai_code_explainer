import { createServer, type Server } from "node:http";

import {
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { vectorStore } from "./config/vector-store.js";
import { closeDefaultRepositoryIndexingQueue } from "./queues/repository-indexing.queue.js";

const shutdownTimeoutMs = 10_000;

export async function startServer(): Promise<Server> {
  await connectDatabase(env.MONGODB_URI, {
    serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  });

  try {
    const collection = await vectorStore.ensureCollection();
    logger.info(collection, "Qdrant collection ready");
  } catch (error) {
    await disconnectDatabase();
    throw error;
  }

  const server = createServer(createApp());

  server.listen(env.API_PORT, () => {
    logger.info(
      { environment: env.NODE_ENV, port: env.API_PORT },
      "API server started",
    );
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Graceful shutdown started");

    const forcedShutdown = setTimeout(() => {
      logger.error("Graceful shutdown timed out");
      process.exit(1);
    }, shutdownTimeoutMs);
    forcedShutdown.unref();

    server.close(async (error) => {
      clearTimeout(forcedShutdown);

      if (error) {
        logger.error({ error }, "API server failed to close");
        process.exitCode = 1;
        return;
      }

      await Promise.all([
        closeDefaultRepositoryIndexingQueue(),
        disconnectDatabase(),
      ]);
      logger.info("API server stopped");
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
}
