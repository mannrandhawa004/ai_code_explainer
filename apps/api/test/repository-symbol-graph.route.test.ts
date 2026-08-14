import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositorySymbolGraphError,
  type RepositorySymbolGraphResult,
  type RepositorySymbolGraphServiceContract,
  type RepositorySymbolReferenceResult,
} from "../src/services/repository-symbol-graph.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const commitSha = "c".repeat(40);
const node = {
  id: "symbol-auth",
  name: "authenticate",
  type: "function",
  filePath: "src/auth.ts",
  language: "typescript",
  startLine: 1,
  endLine: 5,
  references: 0,
  referencedBy: 1,
};
const graphResult: RepositorySymbolGraphResult = {
  repositoryId,
  branch: "main",
  commitSha,
  nodes: [node],
  edges: [],
  stats: {
    files: 1,
    symbols: 1,
    resolvedReferences: 0,
    inspectedReferenceNames: 0,
    referencedSymbols: 0,
    ambiguousReferences: 0,
  },
};
const referenceResult: RepositorySymbolReferenceResult = {
  repositoryId,
  branch: "main",
  commitSha,
  symbol: "authenticate",
  ambiguous: false,
  definitions: [node],
  references: [],
  stats: { definitions: 1, references: 0, files: 0 },
};

function createService(): RepositorySymbolGraphServiceContract {
  return {
    getGraph: vi.fn().mockResolvedValue(graphResult),
    findReferences: vi.fn().mockResolvedValue(referenceResult),
  };
}

function createTestApp(service: RepositorySymbolGraphServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositorySymbolGraphService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("repository symbol graph routes", () => {
  it("fails closed without a server-authenticated identity", async () => {
    const service = createService();
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositorySymbolGraphService: service,
    });

    const response = await request(app)
      .get(`/api/repositories/${repositoryId}/symbol-graph`)
      .set("x-user-id", userId)
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.getGraph).not.toHaveBeenCalled();
  });

  it("validates repository identifiers before graph service access", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get("/api/repositories/not-an-id/symbol-graph")
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_SYMBOL_GRAPH_REQUEST");
    expect(service.getGraph).not.toHaveBeenCalled();
  });

  it("returns the repository-scoped symbol graph", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/symbol-graph`)
      .expect(200);

    expect(response.body).toEqual({ data: graphResult });
    expect(service.getGraph).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
    });
  });

  it("validates and returns where-used results", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/symbol-references`)
      .query({ symbol: " authenticate " })
      .expect(200);

    expect(response.body).toEqual({ data: referenceResult });
    expect(service.findReferences).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
      symbol: "authenticate",
    });
  });

  it("rejects missing and unexpected lookup query fields", async () => {
    const service = createService();
    const app = createTestApp(service);

    for (const query of [{}, { symbol: "authenticate", repositoryId }]) {
      const response = await request(app)
        .get(`/api/repositories/${repositoryId}/symbol-references`)
        .query(query)
        .expect(400);
      expect(response.body.error.code).toBe(
        "INVALID_SYMBOL_REFERENCE_REQUEST",
      );
    }
    expect(service.findReferences).not.toHaveBeenCalled();
  });

  it.each([
    ["REPOSITORY_NOT_FOUND", 404],
    ["SYMBOL_NOT_FOUND", 404],
    ["REPOSITORY_NOT_READY", 409],
    ["SYMBOL_GRAPH_TOO_LARGE", 413],
    ["SYMBOL_DATA_UNAVAILABLE", 503],
  ] as const)("maps %s to HTTP %i without leaking causes", async (code, status) => {
    const service = createService();
    vi.mocked(service.getGraph).mockRejectedValue(
      new RepositorySymbolGraphError(code, "Safe symbol graph error", {
        cause: new Error("mongodb://username:secret@internal"),
      }),
    );

    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/symbol-graph`)
      .expect(status);

    expect(response.body.error).toMatchObject({
      code,
      message: "Safe symbol graph error",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
