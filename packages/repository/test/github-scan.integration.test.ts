import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PublicRepositoryCloner,
  RepositoryFileScanner,
} from "../src/index.js";

const runGitHubScanTests = process.env.RUN_GITHUB_SCAN_TESTS === "true";
const describeWithGitHub = runGitHubScanTests ? describe : describe.skip;
let tempRoot: string;

describeWithGitHub("public GitHub clone and scan integration", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(tmpdir(), "github-scan-test-"));
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("discovers files in a real shallow clone without entering Git metadata", async () => {
    const cloner = new PublicRepositoryCloner({
      tempRoot,
      timeoutMs: 60_000,
    });
    const scanner = new RepositoryFileScanner();

    const result = await cloner.withClone(
      { repositoryUrl: "https://github.com/octocat/Hello-World" },
      async (repository) =>
        scanner.scan(repository.directory, {
          shouldEnterDirectory: ({ relativePath }) => relativePath !== ".git",
        }),
    );

    expect(result.files.map((file) => file.relativePath)).toContain("README");
    expect(
      result.files.every((file) => !file.relativePath.startsWith(".git/")),
    ).toBe(true);
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});
