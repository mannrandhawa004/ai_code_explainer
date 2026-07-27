import { Router } from "express";

import {
  getDatabaseStatus,
  pingDatabase,
} from "@codebase-explainer/database";

const startedAt = new Date().toISOString();

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
  const healthy = await pingDatabase();

  response.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "unavailable",
    service: "mongodb",
    connection: getDatabaseStatus(),
    timestamp: new Date().toISOString(),
  });
});
