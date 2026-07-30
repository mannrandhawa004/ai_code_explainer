import { describe, expect, it } from "vitest";

import { BullMqRepositoryIndexingQueue } from "../src/queues/repository-indexing.queue.js";

const redisTestUrl = process.env.REDIS_TEST_URL;
const describeWithRedis = redisTestUrl ? describe : describe.skip;

describeWithRedis("repository indexing queue integration", () => {
  it("deduplicates active repository jobs and cancels queued work", async () => {
    const queue = new BullMqRepositoryIndexingQueue(redisTestUrl as string);
    const data = {
      repositoryId: "cccccccccccccccccccccccc",
      userId: "dddddddddddddddddddddddd",
      repositoryUrl: "https://github.com/owner/queue-fixture",
      requestedAt: new Date().toISOString(),
      branch: "main",
    };

    try {
      await expect(queue.health()).resolves.toBe(true);
      const first = await queue.enqueue(data);
      const duplicate = await queue.enqueue(data);

      expect(duplicate.jobId).toBe(first.jobId);
      await expect(
        queue.cancel(first.jobId, data.repositoryId),
      ).resolves.toBe("cancelled");
    } finally {
      await queue.close();
    }
  }, 15_000);
});
