import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PublicRepositoryCloner,
  RepositoryFileFilter,
} from "../src/index.js";

const runGitHubFilterTests = process.env.RUN_GITHUB_FILTER_TESTS === "true";
const describeWithGitHub = runGitHubFilterTests ? describe : describe.skip;
let tempRoot: string;

describeWithGitHub("public GitHub clone and filter integration", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(tmpdir(), "github-filter-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("returns indexable text files from a real shallow clone", async () => {
    const cloner = new PublicRepositoryCloner({
      tempRoot,
      timeoutMs: 60_000,
    });
    const filter = new RepositoryFileFilter();

    const result = await cloner.withClone(
      { repositoryUrl: "https://github.com/octocat/Spoon-Knife" },
      async (repository) => filter.filter(repository.directory),
    );

    expect(result.files.map((file) => file.relativePath)).toContain("index.html");
    expect(result.files.length).toBeGreaterThan(0);
    expect(
      result.files.every((file) => !file.relativePath.startsWith(".git/")),
    ).toBe(true);
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});
