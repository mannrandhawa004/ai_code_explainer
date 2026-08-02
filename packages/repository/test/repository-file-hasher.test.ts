import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RepositoryFileHasher,
  createRepositoryContentHash,
  type ScannedRepositoryFile,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function createFile(
  name: string,
  bytes: string | Uint8Array,
): Promise<ScannedRepositoryFile> {
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "repository-file-hasher-"),
  );
  temporaryDirectories.push(directory);
  const absolutePath = path.join(directory, name);
  await fs.writeFile(absolutePath, bytes);
  const stats = await fs.stat(absolutePath);
  return {
    absolutePath,
    relativePath: name,
    name,
    depth: 1,
    stats,
    size: stats.size,
    modifiedAtMs: stats.mtimeMs,
    mode: stats.mode,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("RepositoryFileHasher", () => {
  it("hashes decoded UTF-8 content using the chunker-compatible algorithm", async () => {
    const file = await createFile("index.ts", "export const ready = true;\n");

    await expect(
      new RepositoryFileHasher().hashFiles([file], { maxFileBytes: 1_024 }),
    ).resolves.toEqual([
      {
        file,
        contentHash: createRepositoryContentHash(
          "export const ready = true;\n",
        ),
      },
    ]);
  });

  it("rejects invalid UTF-8 and files that exceed the bound", async () => {
    const invalid = await createFile(
      "invalid.ts",
      Uint8Array.from([0xc3, 0x28]),
    );
    await expect(
      new RepositoryFileHasher().hashFiles([invalid], {
        maxFileBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UTF8" });

    const oversized = await createFile("large.ts", "too large");
    await expect(
      new RepositoryFileHasher().hashFiles([oversized], { maxFileBytes: 4 }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("honors cancellation before filesystem work", async () => {
    const file = await createFile("index.ts", "export {};\n");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      new RepositoryFileHasher().hashFiles([file], {
        maxFileBytes: 1_024,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "HASHING_ABORTED" });
  });
});
