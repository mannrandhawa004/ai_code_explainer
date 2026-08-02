import { UnrecoverableError, Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import {
  githubWebhookJobName,
  githubWebhookQueueName,
  parseGitHubWebhookJobData,
  type GitHubWebhookJobData,
  type GitHubWebhookJobResult,
} from "@codebase-explainer/shared";

import { logger as defaultLogger } from "./config/logger.js";
import {
  GitHubWebhookProcessingError,
  type GitHubWebhookProcessorContract,
} from "./jobs/github-webhook.processor.js";

export type CreateGitHubWebhookWorkerOptions = {
  connection: Redis;
  processor: GitHubWebhookProcessorContract;
  concurrency: number;
  logger?: Logger;
  autorun?: boolean;
  prefix?: string;
};

const retentionSeconds = 30 * 24 * 60 * 60;

export function createGitHubWebhookWorker(
  options: CreateGitHubWebhookWorkerOptions,
): Worker<
  GitHubWebhookJobData,
  GitHubWebhookJobResult,
  typeof githubWebhookJobName
> {
  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("Webhook worker concurrency must be a positive integer");
  }

  const log = options.logger ?? defaultLogger;
  const workerOptions: WorkerOptions = {
    connection: options.connection,
    concurrency: options.concurrency,
    autorun: options.autorun ?? true,
    maxStalledCount: 1,
    removeOnComplete: { age: retentionSeconds, count: 100_000 },
    removeOnFail: { age: retentionSeconds, count: 100_000 },
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };

  const worker = new Worker<
    GitHubWebhookJobData,
    GitHubWebhookJobResult,
    typeof githubWebhookJobName
  >(
    githubWebhookQueueName,
    async (job) => {
      if (job.name !== githubWebhookJobName || !job.id) {
        throw new UnrecoverableError("GitHub webhook job is invalid");
      }

      let data: GitHubWebhookJobData;
      try {
        data = parseGitHubWebhookJobData(job.data);
      } catch {
        throw new UnrecoverableError("GitHub webhook job data is invalid");
      }

      try {
        return await options.processor.process(data);
      } catch (error) {
        if (error instanceof GitHubWebhookProcessingError && !error.retryable) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    },
    workerOptions,
  );

  worker.on("completed", (job, result) => {
    log.info(
      {
        deliveryId: job.id,
        kind: result.kind,
        queuedRepositories: result.queuedRepositories,
        revokedRepositories: result.revokedRepositories,
      },
      "GitHub webhook processed",
    );
  });
  worker.on("failed", (job, error) => {
    log.warn(
      {
        error,
        deliveryId: job?.id,
        kind: job?.data.kind,
        attemptsMade: job?.attemptsMade,
      },
      "GitHub webhook processing failed",
    );
  });
  worker.on("stalled", (jobId) => {
    log.warn({ deliveryId: jobId }, "GitHub webhook job stalled");
  });
  worker.on("error", (error) => {
    log.error({ error }, "GitHub webhook worker error");
  });

  return worker;
}
