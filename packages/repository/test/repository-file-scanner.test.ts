import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RepositoryFileScanner,
  RepositoryScanError,
} from "../src/index.js";

describe("RepositoryFileScanner", () => {
  let rootDirectory: string;
  let outsideDirectory: string;

  beforeEach(async () => {
    rootDirectory = await fs.mkdtemp(path.join(tmpdir(), "scanner-root-"));
    outsideDirectory = await fs.mkdtemp(path.join(tmpdir(), "scanner-outside-"));
  });

  afterEach(async () => {
    await fs.rm(rootDirectory, { recursive: true, force: true });
    await fs.rm(outsideDirectory, { recursive: true, force: true });
  });

  it("returns deterministic relative paths and file metadata", async () => {
    await fs.mkdir(path.join(rootDirectory, "src"));
    await fs.writeFile(path.join(rootDirectory, "z.txt"), "z");
    await fs.writeFile(path.join(rootDirectory, "a.txt"), "alpha");
    await fs.writeFile(path.join(rootDirectory, "..config"), "dot");
    await fs.writeFile(path.join(rootDirectory, "src", "index.ts"), "export {};");

    const result = await new RepositoryFileScanner().scan(rootDirectory);

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "..config",
      "a.txt",
      "src/index.ts",
      "z.txt",
    ]);
    expect(result.files[1]).toMatchObject({
      name: "a.txt",
      depth: 1,
      size: 5,
    });
    expect(result.directoriesVisited).toBe(2);
    expect(result.entriesVisited).toBe(5);
    expect(result.totalBytes).toBe(19);
  });

  it("never follows a directory link outside the repository", async ({ skip }) => {
    await fs.writeFile(path.join(outsideDirectory, "secret.txt"), "secret");

    try {
      await fs.symlink(
        outsideDirectory,
        path.join(rootDirectory, "outside-link"),
        "junction",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }

    const result = await new RepositoryFileScanner().scan(rootDirectory);

    expect(result.files).toEqual([]);
    expect(result.skippedSymlinks).toEqual(["outside-link"]);
  });

  it("supports directory pruning and file selection policies", async () => {
    await fs.mkdir(path.join(rootDirectory, ".git"));
    await fs.mkdir(path.join(rootDirectory, "src"));
    await fs.writeFile(path.join(rootDirectory, ".git", "config"), "git");
    await fs.writeFile(path.join(rootDirectory, "src", "index.ts"), "source");
    await fs.writeFile(path.join(rootDirectory, "README.md"), "readme");

    const result = await new RepositoryFileScanner().scan(rootDirectory, {
      shouldEnterDirectory: ({ relativePath }) => relativePath !== ".git",
      shouldIncludeFile: ({ relativePath }) => relativePath.endsWith(".ts"),
    });

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "src/index.ts",
    ]);
    expect(result.skippedByPolicy).toEqual([".git", "README.md"]);
  });

  it("stops when the filesystem entry limit is exceeded", async () => {
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        fs.writeFile(path.join(rootDirectory, `${name}.txt`), name),
      ),
    );

    await expect(
      new RepositoryFileScanner().scan(rootDirectory, { maxEntries: 2 }),
    ).rejects.toMatchObject({ code: "MAX_ENTRIES_EXCEEDED" });
  });

  it("stops when an entered directory exceeds the depth limit", async () => {
    await fs.mkdir(path.join(rootDirectory, "one", "two"), { recursive: true });

    await expect(
      new RepositoryFileScanner().scan(rootDirectory, { maxDepth: 1 }),
    ).rejects.toMatchObject({
      code: "MAX_DEPTH_EXCEEDED",
      relativePath: "one/two",
    });
  });

  it("honors cancellation before touching repository files", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new RepositoryFileScanner().scan(rootDirectory, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "SCAN_ABORTED" });
  });

  it("rejects a regular file as the scan root", async () => {
    const filePath = path.join(rootDirectory, "not-a-directory.txt");
    await fs.writeFile(filePath, "content");

    await expect(new RepositoryFileScanner().scan(filePath)).rejects.toBeInstanceOf(
      RepositoryScanError,
    );
  });

  it("wraps policy failures without exposing absolute paths", async () => {
    await fs.writeFile(path.join(rootDirectory, "index.ts"), "content");

    await expect(
      new RepositoryFileScanner().scan(rootDirectory, {
        shouldIncludeFile: () => {
          throw new Error("policy implementation details");
        },
      }),
    ).rejects.toMatchObject({
      code: "POLICY_ERROR",
      message: "Repository scan policy failed for index.ts",
      relativePath: "index.ts",
    });
  });
});
