import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PublicRepositoryCloner,
  RepositoryFileFilter,
  RepositoryLineBasedChunker,
} from "../src/index.js";

const runGitHubChunkTests = process.env.RUN_GITHUB_CHUNK_TESTS === "true";
const describeWithGitHub = runGitHubChunkTests ? describe : describe.skip;
let tempRoot: string;

describeWithGitHub("public GitHub clone, filter, and chunk integration", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(tmpdir(), "github-chunk-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("produces cited chunks from a real shallow clone", async () => {
    const cloner = new PublicRepositoryCloner({
      tempRoot,
      timeoutMs: 60_000,
    });
    const filter = new RepositoryFileFilter();
    const chunker = new RepositoryLineBasedChunker();

    const result = await cloner.withClone(
      { repositoryUrl: "https://github.com/octocat/Spoon-Knife" },
      async (repository) => {
        const filtered = await filter.filter(repository.directory);
        return chunker.chunkFiles(filtered.files, {
          userId: "integration-user",
          repositoryId: "octocat-spoon-knife",
          branch: repository.branch,
          commitSha: repository.commitSha,
        });
      },
    );

    const indexChunks = result.chunks.filter(
      (chunk) => chunk.filePath === "index.html",
    );

    expect(indexChunks.length).toBeGreaterThan(0);
    expect(indexChunks[0]).toMatchObject({
      filePath: "index.html",
      language: "html",
      startLine: 1,
      chunkIndex: 0,
    });
    expect(indexChunks.every((chunk) => chunk.endLine >= chunk.startLine)).toBe(
      true,
    );
    expect(result.fileSummaries.length).toBeGreaterThan(0);
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});
