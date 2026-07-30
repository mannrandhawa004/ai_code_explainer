import {
  IndexingJobModel,
  RepositoryModel,
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";
import { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BullMqRepositoryIndexingQueue } from "../src/queues/repository-indexing.queue.js";
import { RepositoryImportService } from "../src/services/repository-import.service.js";

const mongoTestUri = process.env.MONGODB_TEST_URI;
const redisTestUrl = process.env.REDIS_TEST_URL;
const describeWithInfrastructure =
  mongoTestUri && redisTestUrl ? describe : describe.skip;

describeWithInfrastructure("repository import service integration", () => {
  const userId = new Types.ObjectId().toString();
  const suffix = new Types.ObjectId().toString();
  const fullName = `owner/import-fixture-${suffix}`;
  const repositoryUrl = `https://github.com/${fullName}`;
  let queue: BullMqRepositoryIndexingQueue;
  let repositoryId: string | undefined;

  beforeAll(async () => {
    await connectDatabase(mongoTestUri as string, {
      serverSelectionTimeoutMS: 5_000,
    });
    queue = new BullMqRepositoryIndexingQueue(redisTestUrl as string);
  });

  afterAll(async () => {
    if (repositoryId) {
      await IndexingJobModel.deleteMany({
        repositoryId: new Types.ObjectId(repositoryId),
      });
      await RepositoryModel.deleteOne({
        _id: new Types.ObjectId(repositoryId),
      });
    }
    await queue.close();
    await disconnectDatabase();
  });

  it("persists, deduplicates, reports, and cancels a queued import", async () => {
    const service = new RepositoryImportService(queue);
    const first = await service.importPublic({
      authenticatedUserId: userId,
      repositoryUrl,
      branch: "main",
    });
    repositoryId = first.repositoryId;

    expect(first).toMatchObject({ status: "queued", deduplicated: false });
    await expect(
      service.importPublic({
        authenticatedUserId: userId,
        repositoryUrl,
        branch: "main",
      }),
    ).resolves.toEqual({ ...first, deduplicated: true });
    await expect(
      service.getStatus(userId, first.repositoryId),
    ).resolves.toMatchObject({
      repositoryId: first.repositoryId,
      status: "queued",
      job: { id: first.jobId, status: "waiting", progress: 0 },
    });
    await expect(
      service.cancel(userId, first.repositoryId),
    ).resolves.toEqual({
      repositoryId: first.repositoryId,
      jobId: first.jobId,
      status: "cancelled",
    });

    const repository = await RepositoryModel.findById(first.repositoryId)
      .lean()
      .exec();
    expect(repository).toMatchObject({
      fullName,
      status: "failed",
      errorMessage: "Repository indexing was cancelled",
    });
  });
});
