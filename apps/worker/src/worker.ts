import {
  UnrecoverableError,
  Worker,
  type Job,
  type WorkerOptions,
} from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import {
  indexingJobName,
  indexingQueueName,
  parseRepositoryIndexingJobData,
  type RepositoryIndexingJobData,
  type RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";

import { logger as defaultLogger } from "./config/logger.js";
import {
  RepositoryIndexingError,
  type IndexingJobContract,
} from "./jobs/repository-indexing.processor.js";
import type { WorkerMetricsObserver } from "./observability/worker-metrics.js";

export interface RepositoryIndexingProcessorContract {
  process(
    job: IndexingJobContract,
    data: RepositoryIndexingJobData,
    signal?: AbortSignal,
  ): Promise<RepositoryIndexingJobResult>;
}

export type CreateRepositoryIndexingWorkerOptions = {
  connection: Redis;
  processor: RepositoryIndexingProcessorContract;
  concurrency: number;
  logger?: Logger;
  autorun?: boolean;
  prefix?: string;
  metrics?: WorkerMetricsObserver;
};

function durationSeconds(job: Job<RepositoryIndexingJobData> | undefined): number {
  return Math.max(0, (Date.now() - (job?.processedOn ?? Date.now())) / 1_000);
}

function reportMetric(report: () => void): void {
  try {
    report();
  } catch {
    // Worker processing must not depend on metric collection.
  }
}

function maximumAttempts(job: Job<RepositoryIndexingJobData>): number {
  const attempts = job.opts.attempts ?? 1;
  return Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
}

export function createRepositoryIndexingWorker(
  options: CreateRepositoryIndexingWorkerOptions,
): Worker<
  RepositoryIndexingJobData,
  RepositoryIndexingJobResult,
  typeof indexingJobName
> {
  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("Worker concurrency must be a positive integer");
  }

  const log = options.logger ?? defaultLogger;
  const workerOptions: WorkerOptions = {
    connection: options.connection,
    concurrency: options.concurrency,
    autorun: options.autorun ?? true,
    maxStalledCount: 1,
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };

  const worker = new Worker<
    RepositoryIndexingJobData,
    RepositoryIndexingJobResult,
    typeof indexingJobName
  >(
    indexingQueueName,
    async (job, _token, signal) => {
      if (job.name !== indexingJobName || !job.id) {
        throw new UnrecoverableError("Repository indexing job is invalid");
      }

      let data: RepositoryIndexingJobData;
      try {
        data = parseRepositoryIndexingJobData(job.data);
      } catch {
        throw new UnrecoverableError("Repository indexing job data is invalid");
      }

      try {
        return await options.processor.process(
          {
            id: job.id,
            attemptsMade: job.attemptsMade,
            maxAttempts: maximumAttempts(job),
            updateProgress: (progress) => job.updateProgress(progress),
          },
          data,
          signal,
        );
      } catch (error) {
        if (error instanceof RepositoryIndexingError && !error.retryable) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    },
    workerOptions,
  );

  worker.on("active", () => {
    reportMetric(() => options.metrics?.recordJobStarted("indexing"));
  });
  worker.on("completed", (job, result) => {
    reportMetric(() =>
      options.metrics?.recordJobCompleted(
        "indexing",
        durationSeconds(job),
        result,
      ),
    );
    log.info(
      {
        jobId: job.id,
        repositoryId: result.repositoryId,
        filesIndexed: result.filesIndexed,
        chunksIndexed: result.chunksIndexed,
      },
      "Repository indexing job completed",
    );
  });
  worker.on("failed", (job, error) => {
    reportMetric(() =>
      options.metrics?.recordJobFailed("indexing", durationSeconds(job)),
    );
    log.warn(
      {
        error,
        jobId: job?.id,
        repositoryId: job?.data.repositoryId,
        attemptsMade: job?.attemptsMade,
      },
      "Repository indexing job failed",
    );
  });
  worker.on("stalled", (jobId) => {
    reportMetric(() => options.metrics?.recordJobStalled("indexing"));
    log.warn({ jobId }, "Repository indexing job stalled");
  });
  worker.on("error", (error) => {
    reportMetric(() => options.metrics?.recordWorkerError("indexing"));
    log.error({ error }, "Repository indexing worker error");
  });

  return worker;
}
