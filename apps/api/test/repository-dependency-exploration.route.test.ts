import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositoryDependencyExplorationError,
  type RepositoryDependencyExplorationResult,
  type RepositoryDependencyExplorationServiceContract,
  type RepositoryRelatedFilesResult,
} from "../src/services/repository-dependency-exploration.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const dependencyResult: RepositoryDependencyExplorationResult = {
  repositoryId,
  branch: "main",
  commitSha: "c".repeat(40),
  origin: "src/index.ts",
  direction: "both",
  depth: 2,
  nodes: [
    {
      id: "src/index.ts",
      path: "src/index.ts",
      language: "typescript",
      imports: 0,
      importedBy: 0,
      inCycle: false,
      distance: 0,
      relation: "origin",
    },
  ],
  edges: [],
  stats: {
    availableFiles: 1,
    returnedFiles: 1,
    returnedEdges: 0,
    truncated: false,
  },
};
const relatedFilesResult: RepositoryRelatedFilesResult = {
  repositoryId,
  branch: "main",
  commitSha: "c".repeat(40),
  origin: "src/index.ts",
  suggestions: [],
  stats: {
    consideredFiles: 0,
    matchingFiles: 0,
    returnedFiles: 0,
    truncated: false,
  },
};

function createService(): RepositoryDependencyExplorationServiceContract {
  return {
    exploreDependencies: vi.fn().mockResolvedValue(dependencyResult),
    suggestRelatedFiles: vi.fn().mockResolvedValue(relatedFilesResult),
  };
}

function createTestApp(service: RepositoryDependencyExplorationServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositoryDependencyExplorationService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("repository dependency exploration routes", () => {
  it("fails closed without a server-authenticated identity", async () => {
    const service = createService();
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositoryDependencyExplorationService: service,
    });

    const response = await request(app)
      .get(`/api/repositories/${repositoryId}/dependencies`)
      .query({ file: "src/index.ts" })
      .set("x-user-id", userId)
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.exploreDependencies).not.toHaveBeenCalled();
  });

  it("validates repository, file, direction, depth, and strict query input", async () => {
    const service = createService();
    const app = createTestApp(service);
    const invalidId = await request(app)
      .get("/api/repositories/not-an-id/dependencies")
      .query({ file: "src/index.ts" })
      .expect(400);
    expect(invalidId.body.error.code).toBe(
      "INVALID_DEPENDENCY_EXPLORATION_REQUEST",
    );

    await request(app)
      .get(`/api/repositories/${repositoryId}/dependencies`)
      .query({ file: "src/index.ts", direction: "sideways" })
      .expect(400);
    await request(app)
      .get(`/api/repositories/${repositoryId}/dependencies`)
      .query({ file: "src/index.ts", depth: 5 })
      .expect(400);
    await request(app)
      .get(`/api/repositories/${repositoryId}/dependencies`)
      .query({ file: "src/index.ts", unexpected: "value" })
      .expect(400);
    await request(app)
      .get(`/api/repositories/${repositoryId}/related-files`)
      .query({ file: "src/index.ts", limit: 51 })
      .expect(400);

    expect(service.exploreDependencies).not.toHaveBeenCalled();
    expect(service.suggestRelatedFiles).not.toHaveBeenCalled();
  });

  it("returns dependency traversal with documented query defaults", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/dependencies`)
      .query({ file: " src/index.ts " })
      .expect(200);

    expect(response.body).toEqual({ data: dependencyResult });
    expect(service.exploreDependencies).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
      filePath: "src/index.ts",
      direction: "both",
      depth: 2,
    });
  });

  it("returns related-file suggestions with the default limit", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/related-files`)
      .query({ file: "src/index.ts" })
      .expect(200);

    expect(response.body).toEqual({ data: relatedFilesResult });
    expect(service.suggestRelatedFiles).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
      filePath: "src/index.ts",
      limit: 10,
    });
  });

  it.each([
    ["INVALID_REQUEST", 400],
    ["REPOSITORY_NOT_FOUND", 404],
    ["FILE_NOT_FOUND", 404],
    ["REPOSITORY_NOT_READY", 409],
    ["DEPENDENCY_TOO_LARGE", 413],
    ["DEPENDENCY_DATA_INVALID", 500],
    ["DEPENDENCY_DATA_UNAVAILABLE", 503],
  ] as const)("maps %s to HTTP %i without leaking causes", async (code, status) => {
    const service = createService();
    vi.mocked(service.exploreDependencies).mockRejectedValue(
      new RepositoryDependencyExplorationError(
        code,
        "Safe dependency error",
        { cause: new Error("mongodb://username:secret@internal") },
      ),
    );

    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/dependencies`)
      .query({ file: "src/index.ts" })
      .expect(status);

    expect(response.body.error).toMatchObject({
      code,
      message: "Safe dependency error",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
