import { logger } from "./config/logger.js";
import { runWorker } from "./runtime.js";

void runWorker().catch((error: unknown) => {
  logger.fatal({ error }, "Repository indexing worker failed to start");
  process.exitCode = 1;
});
export {};
