import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  RepositoryApplicationFlowError,
  type RepositoryApplicationFlowResult,
  type RepositoryApplicationFlowServiceContract,
} from "../src/services/repository-application-flow.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const result: RepositoryApplicationFlowResult = {
  repositoryId,
  branch: "main",
  commitSha: "c".repeat(40),
  route: "GET /users",
  nodes: [],
  edges: [],
  flows: [],
  stats: {
    routes: 0,
    controllers: 0,
    services: 0,
    models: 0,
    edges: 0,
    flows: 0,
    completeFlows: 0,
    ambiguousReferences: 0,
    inspectedReferenceNames: 0,
    flowsTruncated: false,
  },
};

function createService(): RepositoryApplicationFlowServiceContract {
  return { getFlow: vi.fn().mockResolvedValue(result) };
}

function createTestApp(service: RepositoryApplicationFlowServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    repositoryApplicationFlowService: service,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("GET /api/repositories/:id/application-flow", () => {
  it("fails closed without a server-authenticated identity", async () => {
    const service = createService();
    const app = createApp({
      logger: pino({ level: "silent" }),
      disableRateLimit: true,
      repositoryApplicationFlowService: service,
    });

    const response = await request(app)
      .get(`/api/repositories/${repositoryId}/application-flow`)
      .set("x-user-id", userId)
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    expect(service.getFlow).not.toHaveBeenCalled();
  });

  it("validates repository and strict query input", async () => {
    const service = createService();
    const app = createTestApp(service);
    const invalidId = await request(app)
      .get("/api/repositories/not-an-id/application-flow")
      .expect(400);
    expect(invalidId.body.error.code).toBe("INVALID_APPLICATION_FLOW_REQUEST");

    const unexpectedQuery = await request(app)
      .get(`/api/repositories/${repositoryId}/application-flow`)
      .query({ unexpected: "value" })
      .expect(400);
    expect(unexpectedQuery.body.error.code).toBe(
      "INVALID_APPLICATION_FLOW_REQUEST",
    );
    expect(service.getFlow).not.toHaveBeenCalled();
  });

  it("returns a route-filtered application flow", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/application-flow`)
      .query({ route: " GET /users " })
      .expect(200);

    expect(response.body).toEqual({ data: result });
    expect(service.getFlow).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
      route: "GET /users",
    });
  });

  it("returns the full flow graph when route is omitted", async () => {
    const service = createService();
    await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/application-flow`)
      .expect(200);

    expect(service.getFlow).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
    });
  });

  it.each([
    ["REPOSITORY_NOT_FOUND", 404],
    ["ROUTE_NOT_FOUND", 404],
    ["REPOSITORY_NOT_READY", 409],
    ["FLOW_TOO_LARGE", 413],
    ["FLOW_DATA_UNAVAILABLE", 503],
  ] as const)("maps %s to HTTP %i without leaking causes", async (code, status) => {
    const service = createService();
    vi.mocked(service.getFlow).mockRejectedValue(
      new RepositoryApplicationFlowError(code, "Safe flow error", {
        cause: new Error("mongodb://username:secret@internal"),
      }),
    );

    const response = await request(createTestApp(service))
      .get(`/api/repositories/${repositoryId}/application-flow`)
      .expect(status);

    expect(response.body.error).toMatchObject({
      code,
      message: "Safe flow error",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
