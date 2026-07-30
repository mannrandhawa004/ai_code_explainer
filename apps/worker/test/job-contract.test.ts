import { describe, expect, it } from "vitest";

import { parseRepositoryIndexingJobData } from "@codebase-explainer/shared";

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
