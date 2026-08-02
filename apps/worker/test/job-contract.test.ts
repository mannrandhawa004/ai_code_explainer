import { describe, expect, it } from "vitest";

import {
  parseGitHubWebhookJobData,
  parseRepositoryIndexingJobData,
} from "@codebase-explainer/shared";

describe("repository indexing queue contract", () => {
  const valid = {
    repositoryId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    repositoryUrl: "https://github.com/owner/repository",
    requestedAt: "2026-07-30T12:00:00.000Z",
    branch: "main",
  };

  it("accepts the strict worker payload shape", () => {
    expect(parseRepositoryIndexingJobData(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, repositoryId: "not-an-object-id" },
    { ...valid, requestedAt: "not-a-date" },
    { ...valid, extra: "unexpected" },
    { ...valid, repositoryUrl: " https://github.com/owner/repository" },
  ])("rejects malformed or unexpected queue data", (value) => {
    expect(() => parseRepositoryIndexingJobData(value)).toThrow(
      "Repository indexing job data is invalid",
    );
  });
});

describe("GitHub webhook queue contract", () => {
  const valid = {
    kind: "push" as const,
    deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    payloadSha256: "b".repeat(64),
    receivedAt: "2026-08-02T12:00:00.000Z",
    installationId: 501,
    githubRepositoryId: 9001,
    owner: "owner",
    repository: "repository",
    fullName: "owner/repository",
    repositoryUrl: "https://github.com/owner/repository",
    private: true,
    defaultBranch: "main",
    branch: "main",
    commitSha: "a".repeat(40),
  };

  it("accepts strict minimized push data", () => {
    expect(parseGitHubWebhookJobData(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, deliveryId: "invalid:delivery" },
    { ...valid, installationId: -1 },
    { ...valid, payloadSha256: "not-a-hash" },
    { ...valid, extra: "raw payloads are forbidden" },
    { ...valid, fullName: "different/repository" },
  ])("rejects unsafe webhook queue data", (value) => {
    expect(() => parseGitHubWebhookJobData(value)).toThrow(
      "GitHub webhook job data is invalid",
    );
  });
});
