import { timingSafeEqual } from "node:crypto";

import { Router } from "express";

import { AppError } from "../errors/app-error.js";
import {
  getDefaultApiMetrics,
  type ApiMetrics,
} from "../observability/api-metrics.js";

export type MetricsRenderer = Pick<ApiMetrics, "metrics" | "contentType">;

export type CreateMetricsRouterOptions = {
  metrics?: MetricsRenderer;
  bearerToken?: string;
};

function authorized(authorization: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice(prefix.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createMetricsRouter(
  options: CreateMetricsRouterOptions = {},
): Router {
  const router = Router();
  const metrics = options.metrics ?? getDefaultApiMetrics();

  router.get("/metrics", async (request, response) => {
    if (
      options.bearerToken !== undefined &&
      !authorized(request.header("authorization"), options.bearerToken)
    ) {
      response.setHeader("WWW-Authenticate", "Bearer");
      throw new AppError(
        401,
        "METRICS_AUTHENTICATION_REQUIRED",
        "Metrics authentication is required",
      );
    }
    const body = await metrics.metrics();
    response
      .status(200)
      .set("content-type", metrics.contentType)
      .set("cache-control", "no-store")
      .send(body);
  });

  return router;
}
