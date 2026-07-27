import { createServer, type Server } from "node:http";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";

const shutdownTimeoutMs = 10_000;

export function startServer(): Server {
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

    server.close((error) => {
      clearTimeout(forcedShutdown);

      if (error) {
        logger.error({ error }, "API server failed to close");
        process.exitCode = 1;
        return;
      }

      logger.info("API server stopped");
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
}
