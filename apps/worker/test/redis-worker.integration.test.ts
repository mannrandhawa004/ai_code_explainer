import { randomUUID } from "node:crypto";

import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  indexingJobName,
  indexingQueueName,
  type RepositoryIndexingJobData,
  type RepositoryIndexingJobResult,
} from "@codebase-explainer/shared";

import { createRepositoryIndexingWorker } from "../src/worker.js";

const redisTestUrl = process.env.REDIS_TEST_URL;
const describeWithRedis = redisTestUrl ? describe : describe.skip;

describeWithRedis("BullMQ worker integration", () => {
  it("moves a typed repository job from Redis through the worker", async () => {
    const prefix = `codebase-explainer-test-${randomUUID()}`;
    const producerConnection = new Redis(redisTestUrl as string, {
      maxRetriesPerRequest: 1,
    });
    const workerConnection = new Redis(redisTestUrl as string, {
      maxRetriesPerRequest: null,
    });
    const eventConnection = new Redis(redisTestUrl as string, {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue<
      RepositoryIndexingJobData,
      RepositoryIndexingJobResult,
      typeof indexingJobName
    >(indexingQueueName, { connection: producerConnection, prefix });
    const events = new QueueEvents(indexingQueueName, {
      connection: eventConnection,
      prefix,
    });
    const process = vi.fn().mockResolvedValue({
      repositoryId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      filesIndexed: 1,
      chunksIndexed: 2,
      embeddingModel: "integration-model",
      embeddingTokens: 10,
    });
    const worker = createRepositoryIndexingWorker({
      connection: workerConnection,
      processor: { process },
      concurrency: 1,
      prefix,
      logger: pino({ level: "silent" }),
    });

    try {
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      const data: RepositoryIndexingJobData = {
        repositoryId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
        repositoryUrl: "https://github.com/owner/repository",
        branch: "main",
        requestedAt: new Date().toISOString(),
      };
      const job = await queue.add(indexingJobName, data, {
        attempts: 3,
        backoff: { type: "exponential", delay: 10 },
      });
      const result = await job.waitUntilFinished(events, 10_000);

      expect(result).toMatchObject({
        repositoryId: data.repositoryId,
        chunksIndexed: 2,
      });
      expect(process).toHaveBeenCalledWith(
        expect.objectContaining({ id: job.id, maxAttempts: 3 }),
        data,
        expect.any(AbortSignal),
      );
    } finally {
      await worker.close(true);
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await Promise.all([
        producerConnection.quit(),
        workerConnection.quit(),
        eventConnection.quit(),
      ]);
    }
  }, 20_000);
});
