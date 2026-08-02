import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { GitHubRepositoryServiceContract } from "../src/services/github-repository.service.js";
import type { RepositoryImportServiceContract } from "../src/services/repository-import.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";

function createGitHubService(): GitHubRepositoryServiceContract {
  return {
    listInstallations: vi.fn().mockResolvedValue([
      {
        id: 501,
        account: {
          id: 100,
          login: "owner",
          avatarUrl: "https://avatars.example/owner",
          type: "Organization",
        },
        repositorySelection: "selected",
        targetType: "Organization",
      },
    ]),
    listRepositories: vi.fn().mockResolvedValue([]),
    listBranches: vi.fn().mockResolvedValue([
      { name: "main", commitSha: "a".repeat(40), protected: true },
    ]),
    authorizeRepository: vi.fn().mockResolvedValue({
      id: 9001,
      nodeId: "R_fixture",
      owner: "owner",
      name: "private-repository",
      fullName: "owner/private-repository",
      private: true,
      htmlUrl: "https://github.com/owner/private-repository",
      defaultBranch: "main",
      installationId: 501,
    }),
  };
}

function createImportService(): RepositoryImportServiceContract {
  return {
    importPublic: vi.fn(),
    importGitHub: vi.fn().mockResolvedValue({
      repositoryId,
      jobId: "job-1",
      status: "queued",
      deduplicated: false,
    }),
    enqueueExisting: vi.fn(),
    getStatus: vi.fn(),
    cancel: vi.fn(),
  };
}

function createTestApp(
  githubService: GitHubRepositoryServiceContract,
  importService: RepositoryImportServiceContract,
) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    githubRepositoryService: githubService,
    repositoryImportService: importService,
    resolveAuthenticatedUserId: () => userId,
  });
}

describe("GitHub repository routes", () => {
  it("lists only server-authorized installations", async () => {
    const service = createGitHubService();
    const response = await request(createTestApp(service, createImportService()))
      .get("/api/github/installations")
      .expect(200);

    expect(response.body.data[0].id).toBe(501);
    expect(service.listInstallations).toHaveBeenCalledWith(userId);
  });

  it("requires an installation ID when listing branches", async () => {
    const service = createGitHubService();
    const response = await request(createTestApp(service, createImportService()))
      .get("/api/github/repositories/owner/repository/branches")
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_GITHUB_REPOSITORY");
    expect(service.listBranches).not.toHaveBeenCalled();
  });

  it("queues a private import through the authorization-aware service", async () => {
    const importService = createImportService();
    const response = await request(
      createTestApp(createGitHubService(), importService),
    )
      .post("/api/github/repositories/owner/private-repository/import")
      .send({ installationId: 501, branch: "main" })
      .expect(202);

    expect(response.body.data.repositoryId).toBe(repositoryId);
    expect(importService.importGitHub).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      installationId: 501,
      owner: "owner",
      repository: "private-repository",
      branch: "main",
    });
  });
});
