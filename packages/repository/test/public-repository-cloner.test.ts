import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PublicRepositoryCloner,
  RepositoryCloneError,
  normalizePublicGitHubRepository,
  validateGitBranch,
  type CloneCommandRunner,
} from "../src/index.js";

describe("public GitHub repository validation", () => {
  it("normalizes canonical browser and clone URLs", () => {
    expect(
      normalizePublicGitHubRepository("https://github.com/OpenAI/openai-node.git"),
    ).toEqual({
      owner: "OpenAI",
      name: "openai-node",
      fullName: "OpenAI/openai-node",
      htmlUrl: "https://github.com/OpenAI/openai-node",
      cloneUrl: "https://github.com/OpenAI/openai-node.git",
    });
  });

  it.each([
    "http://github.com/owner/repository",
    "https://example.com/owner/repository",
    "https://github.com.evil.example/owner/repository",
    "https://token@github.com/owner/repository",
    "https://github.com/owner/repository/issues",
    "https://github.com/owner/repository?tab=readme",
    "https://github.com/owner%2Frepository",
    "file:///tmp/repository",
  ])("rejects unsafe repository URL %s", (repositoryUrl) => {
    expect(() => normalizePublicGitHubRepository(repositoryUrl)).toThrowError(
      RepositoryCloneError,
    );
  });

  it.each(["main", "feature/repository-import", "release-1.0", "user_name/fix"])(
    "accepts valid branch %s",
    (branch) => expect(validateGitBranch(branch)).toBe(branch),
  );

  it.each([
    "--upload-pack=malware",
    "../main",
    ".hidden/main",
    "feature//broken",
    "feature@{bad",
    "feature name",
    "feature.lock",
    "feature\\name",
  ])("rejects unsafe branch %s", (branch) => {
    expect(() => validateGitBranch(branch)).toThrowError(RepositoryCloneError);
  });
});

describe("PublicRepositoryCloner", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(tmpdir(), "repository-cloner-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function createRunner(options: { failClone?: boolean } = {}): CloneCommandRunner {
    return vi.fn(async (arguments_, commandOptions) => {
      if (arguments_.includes("clone")) {
        if (options.failClone) {
          throw new Error("remote failure containing implementation details");
        }

        const destination = arguments_.at(-1) as string;
        await fs.mkdir(path.join(destination, ".git"), { recursive: true });
        await fs.writeFile(path.join(destination, "README.md"), "fixture");
        return { stdout: "", stderr: "" };
      }

      expect(commandOptions.cwd).toContain(tempRoot);

      if (arguments_.includes("--abbrev-ref")) {
        return { stdout: "main\n", stderr: "" };
      }

      return {
        stdout: "0123456789abcdef0123456789abcdef01234567\n",
        stderr: "",
      };
    });
  }

  it("uses a shallow prompt-free clone and always removes source files", async () => {
    const runner = createRunner();
    const cloner = new PublicRepositoryCloner(
      { tempRoot, timeoutMs: 10_000 },
      runner,
    );

    const result = await cloner.withClone(
      {
        repositoryUrl: "https://github.com/owner/repository",
        branch: "main",
      },
      async (repository) => {
        await expect(
          fs.access(path.join(repository.directory, "README.md")),
        ).resolves.toBeUndefined();
        return repository;
      },
    );

    expect(result).toMatchObject({
      fullName: "owner/repository",
      branch: "main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--branch",
        "main",
        "https://github.com/owner/repository.git",
      ]),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });

  it("removes source files when downstream processing fails", async () => {
    const cloner = new PublicRepositoryCloner(
      { tempRoot },
      createRunner(),
    );

    await expect(
      cloner.withClone(
        { repositoryUrl: "https://github.com/owner/repository" },
        async () => {
          throw new Error("scanner failed");
        },
      ),
    ).rejects.toThrow("scanner failed");
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });

  it("returns a sanitized clone error and removes the session", async () => {
    const cloner = new PublicRepositoryCloner(
      { tempRoot },
      createRunner({ failClone: true }),
    );

    await expect(
      cloner.withClone(
        { repositoryUrl: "https://github.com/owner/repository" },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "CLONE_FAILED",
      message: "Unable to clone public GitHub repository owner/repository",
    });
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });

  it("rejects a cancelled clone before invoking Git", async () => {
    const runner = createRunner();
    const controller = new AbortController();
    controller.abort("user cancelled");
    const cloner = new PublicRepositoryCloner({ tempRoot }, runner);

    await expect(
      cloner.withClone(
        {
          repositoryUrl: "https://github.com/owner/repository",
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "CLONE_ABORTED",
      message: "Repository cloning was cancelled",
    });
    expect(runner).not.toHaveBeenCalled();
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});
