import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import {
  getDefaultWorkerMetrics,
  type WorkerMetrics,
} from "./worker-metrics.js";

export type WorkerMetricsRenderer = Pick<
  WorkerMetrics,
  "metrics" | "contentType"
>;

export type StartWorkerMetricsServerOptions = {
  host: string;
  port: number;
  metrics?: WorkerMetricsRenderer;
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

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export async function startWorkerMetricsServer(
  options: StartWorkerMetricsServerOptions,
): Promise<Server> {
  if (!options.host.trim() || !Number.isInteger(options.port) || options.port < 0) {
    throw new Error("Worker metrics server address is invalid");
  }
  const metrics = options.metrics ?? getDefaultWorkerMetrics();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://worker.local");
      if (request.method !== "GET") {
        json(response, 405, { status: "method_not_allowed" });
        return;
      }
      if (url.pathname === "/health") {
        json(response, 200, {
          status: "ok",
          service: "worker",
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (url.pathname !== "/metrics") {
        json(response, 404, { status: "not_found" });
        return;
      }
      if (
        options.bearerToken !== undefined &&
        !authorized(request.headers.authorization, options.bearerToken)
      ) {
        response.setHeader("www-authenticate", "Bearer");
        json(response, 401, { status: "authentication_required" });
        return;
      }
      try {
        const body = await metrics.metrics();
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": metrics.contentType,
        });
        response.end(body);
      } catch {
        json(response, 503, { status: "metrics_unavailable" });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  return server;
}

export function closeWorkerMetricsServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
