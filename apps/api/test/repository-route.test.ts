import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositoryImportError,
  type RepositoryImportServiceContract,
} from "../src/services/repository-import.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const queuedResult = {
  repositoryId,
  jobId: "job-1",
  status: "queued" as const,
  deduplicated: false,
};

function createService(): RepositoryImportServiceContract {
  return {
    importPublic: vi.fn().mockResolvedValue(queuedResult),
    importGitHub: vi.fn().mockResolvedValue(queuedResult),
    enqueueExisting: vi.fn().mockResolvedValue(queuedResult),
    getStatus: vi.fn().mockResolvedValue({
      repositoryId,
      status: "embedding",
      selectedBranch: "main",
      stats: { files: 12, chunks: 30 },
      job: {
        id: "job-1",
        status: "active",
        progress: 65,
        currentStep: "embedding",
      },
    }),
    cancel: vi.fn().mockResolvedValue({
      repositoryId,
      jobId: "job-1",
      status: "cancelled",
    }),
  };
}

function createTestApp(service: RepositoryImportServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositoryImportService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("repository indexing routes", () => {
  it("fails closed when repository import has no authenticated identity", async () => {
    const service = createService();
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositoryImportService: service,
    });

    const response = await request(app)
      .post("/api/repositories/import")
      .set("x-user-id", userId)
      .send({ repositoryUrl: "https://github.com/owner/repository" })
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.importPublic).not.toHaveBeenCalled();
  });

  it("validates and queues a public repository import", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .post("/api/repositories/import")
      .send({
        repositoryUrl: "https://github.com/owner/repository",
        branch: "main",
      })
      .expect(202);

    expect(response.body).toEqual({ data: queuedResult });
    expect(service.importPublic).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryUrl: "https://github.com/owner/repository",
      branch: "main",
    });
  });

  it("rejects malformed import bodies before queue access", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .post("/api/repositories/import")
      .send({ repositoryUrl: "file:///tmp/repository", unexpected: true })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_REPOSITORY_IMPORT");
    expect(service.importPublic).not.toHaveBeenCalled();
  });

  it("returns persisted indexing progress", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/status`)
      .expect(200);

    expect(response.body.data).toMatchObject({
      repositoryId,
      status: "embedding",
      job: { id: "job-1", progress: 65, currentStep: "embedding" },
    });
    expect(service.getStatus).toHaveBeenCalledWith(userId, repositoryId);
  });

  it("queues an existing repository for reindexing", async () => {
    const service = createService();
    await request(createTestApp(service))
      .post(`/api/repositories/${repositoryId}/index`)
      .expect(202);

    expect(service.enqueueExisting).toHaveBeenCalledWith(userId, repositoryId);
  });

  it("requests cancellation of the current indexing job", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .post(`/api/repositories/${repositoryId}/index/cancel`)
      .expect(200);

    expect(response.body.data.status).toBe("cancelled");
    expect(service.cancel).toHaveBeenCalledWith(userId, repositoryId);
  });

  it("maps queue failures without leaking dependency details", async () => {
    const service = createService();
    vi.mocked(service.importPublic).mockRejectedValue(
      new RepositoryImportError(
        "INDEXING_QUEUE_UNAVAILABLE",
        "The indexing queue is unavailable",
        { cause: new Error("redis://username:secret@internal:6379") },
      ),
    );

    const response = await request(createTestApp(service))
      .post("/api/repositories/import")
      .send({ repositoryUrl: "https://github.com/owner/repository" })
      .expect(503);

    expect(response.body.error).toMatchObject({
      code: "INDEXING_QUEUE_UNAVAILABLE",
      message: "The indexing queue is unavailable",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
