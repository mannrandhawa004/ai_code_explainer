import pino from "pino";

import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "codebase-explainer-worker",
    environment: env.NODE_ENV,
  },
  redact: {
    paths: [
      "redisUrl",
      "repositoryUrl",
      "job.data.repositoryUrl",
      "error.config.headers.authorization",
      "error.request.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
});
