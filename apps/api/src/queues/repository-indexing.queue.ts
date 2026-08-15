import { randomUUID } from "node:crypto";

import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import {
  indexingJobName,
  indexingQueueName,
  type RepositoryIndexingJobData,
  type RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export type EnqueuedRepositoryIndexingJob = {
  jobId: string;
};

export type QueueCancellationResult =
  | "cancelled"
  | "active"
  | "finished"
  | "not_found";

export type OperationalQueueCounts = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
};

export interface RepositoryIndexingQueueContract {
  enqueue(
    data: RepositoryIndexingJobData,
  ): Promise<EnqueuedRepositoryIndexingJob>;
  cancel(jobId: string, repositoryId: string): Promise<QueueCancellationResult>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

function createDefaultJobOptions(maxAttempts: number): JobsOptions {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10
  ) {
    throw new Error("Indexing maxAttempts must be between 1 and 10");
  }
  return {
    attempts: maxAttempts,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
  };
}

export class BullMqRepositoryIndexingQueue
  implements RepositoryIndexingQueueContract
{
  private readonly connection: Redis;
  private readonly queue: Queue<
    RepositoryIndexingJobData,
    RepositoryIndexingJobResult,
    typeof indexingJobName
  >;
  private connectionPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    redisUrl: string = env.REDIS_URL,
    maxAttempts: number = env.INDEXING_MAX_ATTEMPTS,
  ) {
    this.connection = new Redis(redisUrl, {
      connectionName: "codebase-explainer-api-queue",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    this.queue = new Queue(indexingQueueName, {
      connection: this.connection,
      defaultJobOptions: createDefaultJobOptions(maxAttempts),
    });
    this.connection.on("error", (error) => {
      logger.warn({ error }, "Repository indexing queue Redis error");
    });
  }

  async enqueue(
    data: RepositoryIndexingJobData,
  ): Promise<EnqueuedRepositoryIndexingJob> {
    await this.ensureConnected();
    const job = await this.queue.add(indexingJobName, data, {
      jobId: randomUUID(),
      deduplication: { id: data.repositoryId },
    });

    if (!job.id) {
      throw new Error("BullMQ did not return an indexing job identifier");
    }
    return { jobId: job.id };
  }

  async cancel(
    jobId: string,
    repositoryId: string,
  ): Promise<QueueCancellationResult> {
    await this.ensureConnected();
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return "not_found";
    }

    const state = await job.getState();
    if (state === "active") {
      return "active";
    }
    if (state === "completed" || state === "failed") {
      return "finished";
    }

    await job.remove();
    await this.queue.removeDeduplicationKey(repositoryId);
    return "cancelled";
  }

  async health(): Promise<boolean> {
    try {
      await this.ensureConnected();
      return (await this.connection.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async getOperationalCounts(): Promise<OperationalQueueCounts> {
    await this.ensureConnected();
    const counts = await this.queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      await this.queue.close();
      if (this.connection.status === "ready") {
        await this.connection.quit();
      } else {
        this.connection.disconnect();
      }
    })();
    return this.closePromise;
  }

  private ensureConnected(): Promise<void> {
    if (this.connection.status === "ready") {
      return Promise.resolve();
    }
    this.connectionPromise ??= this.queue
      .waitUntilReady()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.connectionPromise = undefined;
        throw error;
      });
    return this.connectionPromise;
  }
}

let defaultQueue: BullMqRepositoryIndexingQueue | undefined;

export function getDefaultRepositoryIndexingQueue(): BullMqRepositoryIndexingQueue {
  defaultQueue ??= new BullMqRepositoryIndexingQueue();
  return defaultQueue;
}

export async function closeDefaultRepositoryIndexingQueue(): Promise<void> {
  if (!defaultQueue) {
    return;
  }
  const queue = defaultQueue;
  defaultQueue = undefined;
  await queue.close();
}
