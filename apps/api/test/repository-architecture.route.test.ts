import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositoryArchitectureError,
  type RepositoryArchitectureResult,
  type RepositoryArchitectureServiceContract,
} from "../src/services/repository-architecture.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const result: RepositoryArchitectureResult = {
  repositoryId,
  branch: "main",
  commitSha: "c".repeat(40),
  summary: {
    overview: "A small TypeScript repository.",
    metrics: {
      files: 1,
      languages: 1,
      internalImports: 0,
      importCycles: 0,
      symbols: 1,
      resolvedReferences: 0,
      routes: 0,
      controllers: 0,
      services: 0,
      models: 0,
      completeFlows: 0,
      incompleteFlows: 0,
    },
    languages: [{ name: "typescript", files: 1 }],
    entryPoints: [],
    dependencyHubs: [],
    risks: [],
  },
  diagrams: {
    imports: {
      mermaid: 'flowchart LR\n  F0["src/index.ts"]',
      nodes: 1,
      edges: 0,
      truncated: false,
    },
    applicationFlow: {
      mermaid: 'flowchart LR\n  EMPTY["No application flow discovered"]',
      nodes: 0,
      edges: 0,
      truncated: false,
    },
  },
};

function createService(): RepositoryArchitectureServiceContract {
  return { getArchitecture: vi.fn().mockResolvedValue(result) };
}

function createTestApp(service: RepositoryArchitectureServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositoryArchitectureService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("GET /api/repositories/:id/architecture", () => {
  it("fails closed without a server-authenticated identity", async () => {
    const service = createService();
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositoryArchitectureService: service,
    });

    const response = await request(app)
      .get(`/api/repositories/${repositoryId}/architecture`)
      .set("x-user-id", userId)
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.getArchitecture).not.toHaveBeenCalled();
  });

  it("validates the repository ID and rejects unexpected query input", async () => {
    const service = createService();
    const app = createTestApp(service);
    const invalidId = await request(app)
      .get("/api/repositories/not-an-id/architecture")
      .expect(400);
    expect(invalidId.body.error.code).toBe("INVALID_ARCHITECTURE_REQUEST");

    const unexpectedQuery = await request(app)
      .get(`/api/repositories/${repositoryId}/architecture`)
      .query({ route: "GET /users" })
      .expect(400);
    expect(unexpectedQuery.body.error.code).toBe(
      "INVALID_ARCHITECTURE_REQUEST",
    );
    expect(service.getArchitecture).not.toHaveBeenCalled();
  });

  it("returns the architecture summary and Mermaid diagrams", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/architecture`)
      .expect(200);

    expect(response.body).toEqual({ data: result });
    expect(service.getArchitecture).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
    });
  });

  it.each([
    ["REPOSITORY_NOT_FOUND", 404],
    ["REPOSITORY_NOT_READY", 409],
    ["ARCHITECTURE_TOO_LARGE", 413],
    ["ARCHITECTURE_DATA_INVALID", 500],
    ["ARCHITECTURE_DATA_UNAVAILABLE", 503],
  ] as const)("maps %s to HTTP %i without leaking causes", async (code, status) => {
    const service = createService();
    vi.mocked(service.getArchitecture).mockRejectedValue(
      new RepositoryArchitectureError(code, "Safe architecture error", {
        cause: new Error("mongodb://username:secret@internal"),
      }),
    );

    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/architecture`)
      .expect(status);

    expect(response.body.error).toMatchObject({
      code,
      message: "Safe architecture error",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
