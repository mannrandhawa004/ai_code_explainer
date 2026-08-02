import { promises as fs } from "node:fs";

import pLimit from "p-limit";

import { createRepositoryContentHash } from "./line-based-chunker.js";
import type { ScannedRepositoryFile } from "./repository-file-scanner.js";

export const defaultRepositoryHashConcurrency = 8;

export type HashedRepositoryFile = {
  file: ScannedRepositoryFile;
  contentHash: string;
};

export type RepositoryFileHasherOptions = {
  maxFileBytes: number;
  concurrency?: number;
  signal?: AbortSignal;
};

export type RepositoryFileHashErrorCode =
  | "INVALID_CONFIGURATION"
  | "FILE_TOO_LARGE"
  | "INVALID_UTF8"
  | "FILE_READ_FAILED"
  | "HASHING_ABORTED";

export class RepositoryFileHashError extends Error {
  override readonly name = "RepositoryFileHashError";

  constructor(
    readonly code: RepositoryFileHashErrorCode,
    message: string,
    readonly relativePath: string | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepositoryFileHashError(
      "HASHING_ABORTED",
      "Repository file hashing was cancelled",
      undefined,
      { cause: signal.reason },
    );
  }
}

export class RepositoryFileHasher {
  async hashFiles(
    files: readonly ScannedRepositoryFile[],
    options: RepositoryFileHasherOptions,
  ): Promise<HashedRepositoryFile[]> {
    const concurrency =
      options.concurrency ?? defaultRepositoryHashConcurrency;
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes <= 0) {
      throw new RepositoryFileHashError(
        "INVALID_CONFIGURATION",
        "maxFileBytes must be a positive integer",
      );
    }
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new RepositoryFileHashError(
        "INVALID_CONFIGURATION",
        "concurrency must be a positive integer",
      );
    }

    assertNotAborted(options.signal);
    const limit = pLimit(concurrency);
    return Promise.all(
      files.map((file) =>
        limit(async () => {
          assertNotAborted(options.signal);
          if (file.size > options.maxFileBytes) {
            throw new RepositoryFileHashError(
              "FILE_TOO_LARGE",
              `Source file ${file.relativePath} exceeds the hashing size limit`,
              file.relativePath,
            );
          }

          let bytes: Buffer;
          try {
            bytes = await fs.readFile(file.absolutePath);
          } catch (cause) {
            throw new RepositoryFileHashError(
              "FILE_READ_FAILED",
              `Unable to read source file ${file.relativePath}`,
              file.relativePath,
              { cause },
            );
          }
          assertNotAborted(options.signal);
          if (bytes.byteLength > options.maxFileBytes) {
            throw new RepositoryFileHashError(
              "FILE_TOO_LARGE",
              `Source file ${file.relativePath} exceeds the hashing size limit`,
              file.relativePath,
            );
          }

          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (cause) {
            throw new RepositoryFileHashError(
              "INVALID_UTF8",
              `Source file ${file.relativePath} is not valid UTF-8 text`,
              file.relativePath,
              { cause },
            );
          }

          return {
            file,
            contentHash: createRepositoryContentHash(content),
          } satisfies HashedRepositoryFile;
        }),
      ),
    );
  }
}
