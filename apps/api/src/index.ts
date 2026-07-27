import { startServer } from "./server.js";
import { logger } from "./config/logger.js";

try {
  await startServer();
} catch (error) {
  logger.fatal({ error }, "API server failed to start");
  process.exitCode = 1;
}
