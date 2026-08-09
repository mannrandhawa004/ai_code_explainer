import { afterEach, describe, expect, it, vi } from "vitest";

import {
  importRepository,
  repositoryFailureMessage,
  type RepositoryIndexingStatus,
} from "./repositories";

afterEach(() => vi.unstubAllGlobals());

describe("repository API", () => {
  it("imports a normalized public GitHub repository through the authenticated API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            repositoryId: "aaaaaaaaaaaaaaaaaaaaaaaa",
            jobId: "job-1",
            status: "queued",
            deduplicated: false,
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await importRepository({
      repositoryUrl: " https://github.com/openai/openai-node ",
      branch: " main ",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5000/api/repositories/import",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          repositoryUrl: "https://github.com/openai/openai-node",
          branch: "main",
        }),
      }),
    );
  });

  it("turns an embedding-stage dependency failure into an actionable message", () => {
    const status: RepositoryIndexingStatus = {
      repositoryId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      status: "failed",
      selectedBranch: "main",
      errorMessage: "A repository indexing dependency is unavailable",
      stats: { files: 12, chunks: 48 },
      job: {
        id: "job-1",
        status: "failed",
        progress: 65,
        currentStep: "embedding",
      },
    };

    expect(repositoryFailureMessage(status)).toContain("GOOGLE_API_KEY");
  });
});
