import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositoryImportGraphError,
  type RepositoryImportGraphResult,
  type RepositoryImportGraphServiceContract,
} from "../src/services/repository-import-graph.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const result: RepositoryImportGraphResult = {
  repositoryId,
  branch: "main",
  commitSha: "c".repeat(40),
  nodes: [
    {
      id: "src/index.ts",
      path: "src/index.ts",
      language: "typescript",
      imports: 0,
      importedBy: 0,
      inCycle: false,
    },
  ],
  edges: [],
  unresolvedImports: [],
  cycles: [],
  stats: {
    files: 1,
    internalImports: 0,
    unresolvedInternalImports: 0,
    cyclicFiles: 0,
    cycleGroups: 0,
  },
};

function createService(): RepositoryImportGraphServiceContract {
  return { getGraph: vi.fn().mockResolvedValue(result) };
}

function createTestApp(service: RepositoryImportGraphServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositoryImportGraphService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("GET /api/repositories/:id/import-graph", () => {
  it("fails closed without a server-authenticated identity", async () => {
    const service = createService();
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositoryImportGraphService: service,
    });

    const response = await request(app)
      .get(`/api/repositories/${repositoryId}/import-graph`)
      .set("x-user-id", userId)
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.getGraph).not.toHaveBeenCalled();
  });

  it("validates the repository identifier before service access", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get("/api/repositories/not-an-object-id/import-graph")
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_IMPORT_GRAPH_REQUEST");
    expect(service.getGraph).not.toHaveBeenCalled();
  });

  it("returns the repository-scoped graph contract", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/import-graph`)
      .expect(200);

    expect(response.body).toEqual({ data: result });
    expect(service.getGraph).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
    });
  });

  it.each([
    ["REPOSITORY_NOT_FOUND", 404],
    ["REPOSITORY_NOT_READY", 409],
    ["GRAPH_TOO_LARGE", 413],
    ["GRAPH_DATA_UNAVAILABLE", 503],
  ] as const)("maps %s to HTTP %i without leaking causes", async (code, status) => {
    const service = createService();
    vi.mocked(service.getGraph).mockRejectedValue(
      new RepositoryImportGraphError(code, "Safe graph error", {
        cause: new Error("mongodb://username:secret@internal"),
      }),
    );

    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/import-graph`)
      .expect(status);

    expect(response.body.error).toMatchObject({ code, message: "Safe graph error" });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
