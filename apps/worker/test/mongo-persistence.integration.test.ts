import {
  IndexingJobModel,
  RepositoryFileModel,
  RepositoryModel,
  SymbolModel,
  connectDatabase,
  disconnectDatabase,
} from "@codebase-explainer/database";
import { Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MongoIndexingPersistence } from "../src/persistence/indexing-persistence.js";

const mongoTestUri = process.env.MONGODB_TEST_URI;
const describeWithMongo = mongoTestUri ? describe : describe.skip;

describeWithMongo("Mongo indexing persistence integration", () => {
  const userId = new Types.ObjectId();
  const repositoryId = new Types.ObjectId();
  const bullJobId = `mongo-persistence-${repositoryId.toString()}`;

  beforeAll(async () => {
    await connectDatabase(mongoTestUri as string, {
      serverSelectionTimeoutMS: 5_000,
    });
    await RepositoryModel.create({
      _id: repositoryId,
      userId,
      owner: "owner",
      name: "persistence-fixture",
      fullName: `owner/persistence-fixture-${repositoryId.toString()}`,
      private: false,
      selectedBranch: "main",
      defaultBranch: "main",
      status: "queued",
    });
  });

  afterAll(async () => {
    await Promise.all([
      IndexingJobModel.deleteOne({ bullJobId }),
      RepositoryFileModel.deleteMany({ repositoryId }),
      SymbolModel.deleteMany({ repositoryId }),
      RepositoryModel.deleteOne({ _id: repositoryId }),
    ]);
    await disconnectDatabase();
  });

  it("persists progress, file metadata, and the final ready state", async () => {
    const persistence = new MongoIndexingPersistence();
    const ids = {
      bullJobId,
      repositoryId: repositoryId.toString(),
      userId: userId.toString(),
    };

    await expect(
      persistence.findRepository(ids.repositoryId),
    ).resolves.toMatchObject({
      id: ids.repositoryId,
      userId: ids.userId,
      fullName: expect.stringContaining("persistence-fixture"),
    });
    await persistence.begin({
      ...ids,
      progress: 5,
      currentStep: "cloning",
      repositoryStatus: "cloning",
    });
    await persistence.updateProgress({
      ...ids,
      progress: 65,
      currentStep: "embedding",
      repositoryStatus: "embedding",
    });
    await persistence.complete({
      ...ids,
      branch: "main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      files: [
        {
          filePath: "src/index.ts",
          language: "typescript",
          contentHash: "a".repeat(64),
          sourceBytes: 26,
          imports: ["./dependency.js"],
          exports: ["ready"],
          symbols: [
            {
              name: "ready",
              type: "variable",
              startLine: 1,
              endLine: 1,
              imports: ["./dependency.js"],
              references: [],
            },
          ],
        },
      ],
      chunks: 2,
      languages: new Map([["typescript", 1]]),
    });

    const [repository, job, file, symbol] = await Promise.all([
      RepositoryModel.findById(repositoryId).lean().exec(),
      IndexingJobModel.findOne({ bullJobId }).lean().exec(),
      RepositoryFileModel.findOne({ repositoryId }).lean().exec(),
      SymbolModel.findOne({ repositoryId }).lean().exec(),
    ]);
    expect(repository).toMatchObject({
      status: "ready",
      selectedBranch: "main",
      lastIndexedCommit: "0123456789abcdef0123456789abcdef01234567",
      stats: { files: 1, chunks: 2 },
    });
    expect(job).toMatchObject({
      status: "completed",
      progress: 100,
      currentStep: "completed",
    });
    expect(file).toMatchObject({
      path: "src/index.ts",
      language: "typescript",
      size: 26,
      imports: ["./dependency.js"],
      exports: ["ready"],
      symbols: ["ready"],
    });
    expect(symbol).toMatchObject({
      name: "ready",
      type: "variable",
      startLine: 1,
      endLine: 1,
    });
  });
});
