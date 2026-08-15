import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import {
  githubWebhookJobName,
  githubWebhookQueueName,
  type GitHubWebhookJobData,
  type GitHubWebhookJobResult,
} from "@codebase-explainer/shared";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export type GitHubWebhookEnqueueStatus = "queued" | "duplicate" | "retried";

export type GitHubWebhookEnqueueResult = {
  jobId: string;
  status: GitHubWebhookEnqueueStatus;
};

export type GitHubWebhookOperationalQueueCounts = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
};

export class GitHubWebhookQueueError extends Error {
  override readonly name = "GitHubWebhookQueueError";

  constructor(
    readonly code: "DELIVERY_CONFLICT" | "QUEUE_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubWebhookQueueContract {
  enqueue(data: GitHubWebhookJobData): Promise<GitHubWebhookEnqueueResult>;
  close(): Promise<void>;
}

const retentionSeconds = 30 * 24 * 60 * 60;
const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: retentionSeconds, count: 100_000 },
  removeOnFail: { age: retentionSeconds, count: 100_000 },
};

export class BullMqGitHubWebhookQueue implements GitHubWebhookQueueContract {
  private readonly connection: Redis;
  private readonly queue: Queue<
    GitHubWebhookJobData,
    GitHubWebhookJobResult,
    typeof githubWebhookJobName
  >;
  private connectionPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(redisUrl: string = env.REDIS_URL) {
    this.connection = new Redis(redisUrl, {
      connectionName: "codebase-explainer-api-webhook-queue",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    this.queue = new Queue(githubWebhookQueueName, {
      connection: this.connection,
      defaultJobOptions,
    });
    this.connection.on("error", (error) => {
      logger.warn({ error }, "GitHub webhook queue Redis error");
    });
  }

  async enqueue(data: GitHubWebhookJobData): Promise<GitHubWebhookEnqueueResult> {
    try {
      await this.ensureConnected();
      const existing = await this.queue.getJob(data.deliveryId);
      if (existing) {
        if (existing.data.payloadSha256 !== data.payloadSha256) {
          throw new GitHubWebhookQueueError(
            "DELIVERY_CONFLICT",
            "GitHub delivery identifier was already used for another payload",
          );
        }
        if ((await existing.getState()) === "failed") {
          await existing.retry();
          return { jobId: data.deliveryId, status: "retried" };
        }
        return { jobId: data.deliveryId, status: "duplicate" };
      }

      const job = await this.queue.add(githubWebhookJobName, data, {
        jobId: data.deliveryId,
      });
      if (!job.id) {
        throw new Error("BullMQ did not return a webhook job identifier");
      }
      return { jobId: job.id, status: "queued" };
    } catch (cause) {
      if (cause instanceof GitHubWebhookQueueError) {
        throw cause;
      }
      throw new GitHubWebhookQueueError(
        "QUEUE_UNAVAILABLE",
        "The GitHub webhook queue is unavailable",
        { cause },
      );
    }
  }

  async getOperationalCounts(): Promise<GitHubWebhookOperationalQueueCounts> {
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

let defaultQueue: BullMqGitHubWebhookQueue | undefined;

export function getDefaultGitHubWebhookQueue(): BullMqGitHubWebhookQueue {
  defaultQueue ??= new BullMqGitHubWebhookQueue();
  return defaultQueue;
}

export async function closeDefaultGitHubWebhookQueue(): Promise<void> {
  if (!defaultQueue) {
    return;
  }
  const queue = defaultQueue;
  defaultQueue = undefined;
  await queue.close();
}
