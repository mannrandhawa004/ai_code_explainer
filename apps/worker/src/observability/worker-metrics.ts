import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

import { env } from "../config/env.js";

export type WorkerQueue = "indexing" | "github_webhook";
export type WorkerMetricOutcome = "success" | "failure";

export interface WorkerMetricsObserver {
  recordJobStarted(queue: WorkerQueue): void;
  recordJobCompleted(
    queue: WorkerQueue,
    durationSeconds: number,
    result?: { filesIndexed: number; chunksIndexed: number },
  ): void;
  recordJobFailed(queue: WorkerQueue, durationSeconds: number): void;
  recordJobStalled(queue: WorkerQueue): void;
  recordWorkerError(queue: WorkerQueue): void;
  observeDependency(input: {
    dependency: "qdrant";
    operation: string;
    outcome: WorkerMetricOutcome;
    durationSeconds: number;
  }): void;
  observeAi(input: {
    operation: "embedding";
    outcome: WorkerMetricOutcome;
    durationSeconds: number;
    requests?: number;
    tokens?: number;
  }): void;
}

export type WorkerMetricsOptions = {
  aiProvider?: string;
  collectRuntimeMetrics?: boolean;
};

const durationBuckets = [
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
  60,
  120,
  300,
  900,
  1_800,
  3_600,
];

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export class WorkerMetrics implements WorkerMetricsObserver {
  readonly registry = new Registry();
  private readonly aiProvider: string;
  private readonly activeCounts: Record<WorkerQueue, number> = {
    indexing: 0,
    github_webhook: 0,
  };
  private readonly jobsTotal;
  private readonly jobDurationSeconds;
  private readonly activeJobs;
  private readonly stalledJobsTotal;
  private readonly workerErrorsTotal;
  private readonly indexedFilesTotal;
  private readonly indexedChunksTotal;
  private readonly dependencyDurationSeconds;
  private readonly aiRequestsTotal;
  private readonly aiRequestDurationSeconds;
  private readonly aiTokensTotal;

  constructor(options: WorkerMetricsOptions = {}) {
    this.aiProvider = options.aiProvider?.trim() || "unknown";
    this.registry.setDefaultLabels({ service: "worker" });
    if (options.collectRuntimeMetrics ?? true) {
      collectDefaultMetrics({
        prefix: "codebase_explainer_worker_process_",
        register: this.registry,
      });
    }
    this.jobsTotal = new Counter({
      name: "codebase_explainer_worker_jobs_total",
      help: "Total completed worker job attempts by outcome.",
      labelNames: ["queue", "outcome"] as const,
      registers: [this.registry],
    });
    this.jobDurationSeconds = new Histogram({
      name: "codebase_explainer_worker_job_duration_seconds",
      help: "Worker job attempt duration in seconds.",
      labelNames: ["queue", "outcome"] as const,
      buckets: durationBuckets,
      registers: [this.registry],
    });
    this.activeJobs = new Gauge({
      name: "codebase_explainer_worker_active_jobs",
      help: "Worker jobs currently active in this process.",
      labelNames: ["queue"] as const,
      registers: [this.registry],
    });
    this.stalledJobsTotal = new Counter({
      name: "codebase_explainer_worker_stalled_jobs_total",
      help: "Total BullMQ stalled job events.",
      labelNames: ["queue"] as const,
      registers: [this.registry],
    });
    this.workerErrorsTotal = new Counter({
      name: "codebase_explainer_worker_errors_total",
      help: "Total BullMQ worker error events.",
      labelNames: ["queue"] as const,
      registers: [this.registry],
    });
    this.indexedFilesTotal = new Counter({
      name: "codebase_explainer_worker_indexed_files_total",
      help: "Total files written by successful indexing jobs.",
      registers: [this.registry],
    });
    this.indexedChunksTotal = new Counter({
      name: "codebase_explainer_worker_indexed_chunks_total",
      help: "Total chunks written by successful indexing jobs.",
      registers: [this.registry],
    });
    this.dependencyDurationSeconds = new Histogram({
      name: "codebase_explainer_worker_dependency_duration_seconds",
      help: "Worker dependency operation duration in seconds.",
      labelNames: ["dependency", "operation", "outcome"] as const,
      buckets: durationBuckets,
      registers: [this.registry],
    });
    this.aiRequestsTotal = new Counter({
      name: "codebase_explainer_worker_ai_requests_total",
      help: "Total worker requests to an AI provider.",
      labelNames: ["provider", "operation", "outcome"] as const,
      registers: [this.registry],
    });
    this.aiRequestDurationSeconds = new Histogram({
      name: "codebase_explainer_worker_ai_request_duration_seconds",
      help: "Worker AI provider request duration in seconds.",
      labelNames: ["provider", "operation", "outcome"] as const,
      buckets: durationBuckets,
      registers: [this.registry],
    });
    this.aiTokensTotal = new Counter({
      name: "codebase_explainer_worker_ai_tokens_total",
      help: "Total worker embedding tokens.",
      labelNames: ["provider", "operation", "type"] as const,
      registers: [this.registry],
    });
  }

  recordJobStarted(queue: WorkerQueue): void {
    this.activeCounts[queue] += 1;
    this.activeJobs.set({ queue }, this.activeCounts[queue]);
  }

  recordJobCompleted(
    queue: WorkerQueue,
    durationSeconds: number,
    result?: { filesIndexed: number; chunksIndexed: number },
  ): void {
    this.finishJob(queue, "success", durationSeconds);
    if (result !== undefined) {
      if (result.filesIndexed > 0) {
        this.indexedFilesTotal.inc(result.filesIndexed);
      }
      if (result.chunksIndexed > 0) {
        this.indexedChunksTotal.inc(result.chunksIndexed);
      }
    }
  }

  recordJobFailed(queue: WorkerQueue, durationSeconds: number): void {
    this.finishJob(queue, "failure", durationSeconds);
  }

  recordJobStalled(queue: WorkerQueue): void {
    this.activeCounts[queue] = Math.max(0, this.activeCounts[queue] - 1);
    this.activeJobs.set({ queue }, this.activeCounts[queue]);
    this.stalledJobsTotal.inc({ queue });
  }

  recordWorkerError(queue: WorkerQueue): void {
    this.workerErrorsTotal.inc({ queue });
  }

  observeDependency(input: {
    dependency: "qdrant";
    operation: string;
    outcome: WorkerMetricOutcome;
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
    operation: "embedding";
    outcome: WorkerMetricOutcome;
    durationSeconds: number;
    requests?: number;
    tokens?: number;
  }): void {
    const labels = {
      provider: this.aiProvider,
      operation: input.operation,
      outcome: input.outcome,
    };
    this.aiRequestsTotal.inc(labels, Math.max(1, input.requests ?? 1));
    this.aiRequestDurationSeconds.observe(
      labels,
      finiteDuration(input.durationSeconds),
    );
    if (input.tokens !== undefined && input.tokens > 0) {
      this.aiTokensTotal.inc(
        {
          provider: this.aiProvider,
          operation: input.operation,
          type: "total",
        },
        input.tokens,
      );
    }
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private finishJob(
    queue: WorkerQueue,
    outcome: WorkerMetricOutcome,
    durationSeconds: number,
  ): void {
    this.activeCounts[queue] = Math.max(0, this.activeCounts[queue] - 1);
    this.activeJobs.set({ queue }, this.activeCounts[queue]);
    this.jobsTotal.inc({ queue, outcome });
    this.jobDurationSeconds.observe(
      { queue, outcome },
      finiteDuration(durationSeconds),
    );
  }
}

let defaultWorkerMetrics: WorkerMetrics | undefined;

export function getDefaultWorkerMetrics(): WorkerMetrics {
  defaultWorkerMetrics ??= new WorkerMetrics({ aiProvider: env.AI_PROVIDER });
  return defaultWorkerMetrics;
}
