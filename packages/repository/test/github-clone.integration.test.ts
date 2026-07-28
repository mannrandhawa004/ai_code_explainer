import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PublicRepositoryCloner } from "../src/index.js";

const runGitHubCloneTests = process.env.RUN_GITHUB_CLONE_TESTS === "true";
const describeWithGitHub = runGitHubCloneTests ? describe : describe.skip;
let tempRoot: string;

describeWithGitHub("public GitHub clone integration", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(tmpdir(), "github-clone-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("shallow-clones a real public repository and removes it afterward", async () => {
    const cloner = new PublicRepositoryCloner({
      tempRoot,
      timeoutMs: 60_000,
    });

    const metadata = await cloner.withClone(
      { repositoryUrl: "https://github.com/octocat/Hello-World" },
      async (repository) => {
        await expect(fs.access(repository.directory)).resolves.toBeUndefined();
        await expect(
          fs.access(path.join(repository.directory, ".git", "shallow")),
        ).resolves.toBeUndefined();

        return {
          branch: repository.branch,
          commitSha: repository.commitSha,
          fullName: repository.fullName,
        };
      },
    );

    expect(metadata.fullName).toBe("octocat/Hello-World");
    expect(metadata.branch).not.toBe("");
    expect(metadata.commitSha).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});
