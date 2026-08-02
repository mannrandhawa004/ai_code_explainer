import { randomUUID } from "node:crypto";

import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import {
  indexingJobName,
  indexingQueueName,
  type RepositoryIndexingJobData,
  type RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";

import { logger } from "../config/logger.js";

export type RepositoryIndexingProducerResult = { jobId: string };

export interface RepositoryIndexingProducerContract {
  enqueue(
    data: RepositoryIndexingJobData,
  ): Promise<RepositoryIndexingProducerResult>;
  close(): Promise<void>;
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
};

export class BullMqRepositoryIndexingProducer
  implements RepositoryIndexingProducerContract
{
  private readonly connection: Redis;
  private readonly queue: Queue<
    RepositoryIndexingJobData,
    RepositoryIndexingJobResult,
    typeof indexingJobName
  >;
  private connectionPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, {
      connectionName: "codebase-explainer-webhook-indexing-producer",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    this.queue = new Queue(indexingQueueName, {
      connection: this.connection,
      defaultJobOptions,
    });
    this.connection.on("error", (error) => {
      logger.warn({ error }, "Webhook indexing producer Redis error");
    });
  }

  async enqueue(
    data: RepositoryIndexingJobData,
  ): Promise<RepositoryIndexingProducerResult> {
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
