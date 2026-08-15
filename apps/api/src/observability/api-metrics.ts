import type { RequestHandler } from "express";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

import type { AnswerTokenUsage } from "@codebase-explainer/ai";

import { env } from "../config/env.js";
import { getDefaultGitHubWebhookQueue } from "../queues/github-webhook.queue.js";
import { getDefaultRepositoryIndexingQueue } from "../queues/repository-indexing.queue.js";

export type ObservabilityOutcome = "success" | "failure";
export type ApiDependency = "mongodb" | "qdrant" | "redis";
export type ApiAiOperation = "embedding" | "generation";

export type ApiQueueDepthSample = {
  queue: "indexing" | "github_webhook";
  state: "waiting" | "active" | "delayed" | "failed";
  value: number;
};

export type ApiMetricsOptions = {
  aiProvider?: string;
  collectRuntimeMetrics?: boolean;
  queueDepthCollector?: () => Promise<ApiQueueDepthSample[]>;
};

export interface ApiMetricsObserver {
  observeDependency(input: {
    dependency: ApiDependency;
    operation: string;
    outcome: ObservabilityOutcome;
    durationSeconds: number;
  }): void;
  observeAi(input: {
    operation: ApiAiOperation;
    outcome: ObservabilityOutcome;
    durationSeconds: number;
    embeddingRequests?: number;
    embeddingTokens?: number;
    answerUsage?: AnswerTokenUsage;
  }): void;
}

const httpDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const dependencyDurationBuckets = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  120,
];

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function metricRoute(request: Parameters<RequestHandler>[0]): string {
  const route: unknown = request.route?.path;
  if (typeof route !== "string") {
    return "unmatched";
  }
  return `${request.baseUrl}${route}` || route;
}

function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

export class ApiMetrics implements ApiMetricsObserver {
  readonly registry = new Registry();
  private readonly aiProvider: string;
  private readonly queueDepthCollector: (() => Promise<ApiQueueDepthSample[]>) | undefined;
  private readonly httpRequestsTotal;
  private readonly httpRequestDurationSeconds;
  private readonly httpRequestsInFlight;
  private readonly apiErrorsTotal;
  private readonly dependencyDurationSeconds;
  private readonly aiRequestsTotal;
  private readonly aiRequestDurationSeconds;
  private readonly aiTokensTotal;
  private readonly queueDepth;
  private readonly collectionErrorsTotal;

  constructor(options: ApiMetricsOptions = {}) {
    this.aiProvider = options.aiProvider?.trim() || "unknown";
    this.queueDepthCollector = options.queueDepthCollector;
    this.registry.setDefaultLabels({ service: "api" });
    if (options.collectRuntimeMetrics ?? true) {
      collectDefaultMetrics({
        prefix: "codebase_explainer_api_process_",
        register: this.registry,
      });
    }
    this.httpRequestsTotal = new Counter({
      name: "codebase_explainer_api_http_requests_total",
      help: "Total completed API HTTP requests.",
      labelNames: ["method", "route", "status_class"] as const,
      registers: [this.registry],
    });
    this.httpRequestDurationSeconds = new Histogram({
      name: "codebase_explainer_api_http_request_duration_seconds",
      help: "API HTTP request duration in seconds.",
      labelNames: ["method", "route", "status_class"] as const,
      buckets: httpDurationBuckets,
      registers: [this.registry],
    });
    this.httpRequestsInFlight = new Gauge({
      name: "codebase_explainer_api_http_requests_in_flight",
      help: "API HTTP requests currently being processed.",
      registers: [this.registry],
    });
    this.apiErrorsTotal = new Counter({
      name: "codebase_explainer_api_errors_total",
      help: "Total normalized API errors.",
      labelNames: ["code", "status_class"] as const,
      registers: [this.registry],
    });
    this.dependencyDurationSeconds = new Histogram({
      name: "codebase_explainer_api_dependency_duration_seconds",
      help: "API dependency operation duration in seconds.",
      labelNames: ["dependency", "operation", "outcome"] as const,
      buckets: dependencyDurationBuckets,
      registers: [this.registry],
    });
    this.aiRequestsTotal = new Counter({
      name: "codebase_explainer_api_ai_requests_total",
      help: "Total API requests to an AI provider.",
      labelNames: ["provider", "operation", "outcome"] as const,
      registers: [this.registry],
    });
    this.aiRequestDurationSeconds = new Histogram({
      name: "codebase_explainer_api_ai_request_duration_seconds",
      help: "API AI provider request duration in seconds.",
      labelNames: ["provider", "operation", "outcome"] as const,
      buckets: dependencyDurationBuckets,
      registers: [this.registry],
    });
    this.aiTokensTotal = new Counter({
      name: "codebase_explainer_api_ai_tokens_total",
      help: "Total API AI tokens by operation and token type.",
      labelNames: ["provider", "operation", "type"] as const,
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: "codebase_explainer_api_queue_jobs",
      help: "Current BullMQ jobs by queue and state.",
      labelNames: ["queue", "state"] as const,
      registers: [this.registry],
    });
    this.collectionErrorsTotal = new Counter({
      name: "codebase_explainer_api_metric_collection_errors_total",
      help: "Total metric collector failures.",
      labelNames: ["collector"] as const,
      registers: [this.registry],
    });
  }

  createHttpMiddleware(): RequestHandler {
    return (request, response, next) => {
      if (request.path === "/api/metrics") {
        next();
        return;
      }
      const startedAt = process.hrtime.bigint();
      this.httpRequestsInFlight.inc();
      let recorded = false;
      const record = (): void => {
        if (recorded) {
          return;
        }
        recorded = true;
        this.httpRequestsInFlight.dec();
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const labels = {
          method: request.method,
          route: metricRoute(request),
          status_class: statusClass(response.statusCode),
        };
        this.httpRequestsTotal.inc(labels);
        this.httpRequestDurationSeconds.observe(labels, durationSeconds);
      };
      response.once("finish", record);
      response.once("close", record);
      next();
    };
  }

  recordApiError(code: string, statusCode: number): void {
    this.apiErrorsTotal.inc({
      code,
      status_class: statusClass(statusCode),
    });
  }

  observeDependency(input: {
    dependency: ApiDependency;
    operation: string;
    outcome: ObservabilityOutcome;
    durationSeconds: number;
  }): void {
    this.dependencyDurationSeconds.observe(
      {
        dependency: input.dependency,
        operation: input.operation,
        outcome: input.outcome,
      },
      finiteDuration(input.durationSeconds),
    );
  }

  observeAi(input: {
    operation: ApiAiOperation;
    outcome: ObservabilityOutcome;
    durationSeconds: number;
    embeddingRequests?: number;
    embeddingTokens?: number;
    answerUsage?: AnswerTokenUsage;
  }): void {
    const labels = {
      provider: this.aiProvider,
      operation: input.operation,
      outcome: input.outcome,
    };
    this.aiRequestsTotal.inc(
      labels,
      input.operation === "embedding"
        ? Math.max(1, input.embeddingRequests ?? 1)
        : 1,
    );
    this.aiRequestDurationSeconds.observe(
      labels,
      finiteDuration(input.durationSeconds),
    );
    if (input.embeddingTokens !== undefined && input.embeddingTokens > 0) {
      this.aiTokensTotal.inc(
        {
          provider: this.aiProvider,
          operation: input.operation,
          type: "total",
        },
        input.embeddingTokens,
      );
    }
    if (input.answerUsage !== undefined) {
      const usage = input.answerUsage;
      for (const [type, value] of [
        ["input", usage.inputTokens],
        ["output", usage.outputTokens],
        ["reasoning", usage.reasoningTokens],
        ["total", usage.totalTokens],
      ] as const) {
        if (value > 0) {
          this.aiTokensTotal.inc(
            { provider: this.aiProvider, operation: input.operation, type },
            value,
          );
        }
      }
    }
  }

  async metrics(): Promise<string> {
    await this.refreshQueueDepth();
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private async refreshQueueDepth(): Promise<void> {
    if (this.queueDepthCollector === undefined) {
      return;
    }
    this.queueDepth.reset();
    try {
      for (const sample of await this.queueDepthCollector()) {
        this.queueDepth.set(
          { queue: sample.queue, state: sample.state },
          Math.max(0, sample.value),
        );
      }
    } catch {
      this.collectionErrorsTotal.inc({ collector: "bullmq" });
    }
  }
}

async function collectDefaultQueueDepth(): Promise<ApiQueueDepthSample[]> {
  const [indexing, webhook] = await Promise.all([
    getDefaultRepositoryIndexingQueue().getOperationalCounts(),
    getDefaultGitHubWebhookQueue().getOperationalCounts(),
  ]);
  return ([
    ["indexing", indexing],
    ["github_webhook", webhook],
  ] as const).flatMap(([queue, counts]) =>
    (Object.entries(counts) as Array<
      [ApiQueueDepthSample["state"], number]
    >).map(([state, value]) => ({ queue, state, value })),
  );
}

let defaultApiMetrics: ApiMetrics | undefined;

export function getDefaultApiMetrics(): ApiMetrics {
  defaultApiMetrics ??= new ApiMetrics({
    aiProvider: env.AI_PROVIDER,
    queueDepthCollector: collectDefaultQueueDepth,
  });
  return defaultApiMetrics;
}
