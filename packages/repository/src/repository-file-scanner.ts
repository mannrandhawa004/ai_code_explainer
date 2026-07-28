import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

export type RepositoryScanEntry = {
  absolutePath: string;
  relativePath: string;
  name: string;
  depth: number;
  stats: Stats;
};

export type ScannedRepositoryFile = RepositoryScanEntry & {
  size: number;
  modifiedAtMs: number;
  mode: number;
};

export type RepositoryScanOptions = {
  maxEntries?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  fileSystemErrors?: "error" | "skip";
  shouldEnterDirectory?: (
    entry: RepositoryScanEntry,
  ) => boolean | Promise<boolean>;
  shouldIncludeFile?: (
    entry: RepositoryScanEntry,
  ) => boolean | Promise<boolean>;
};

export type RepositoryScanResult = {
  rootDirectory: string;
  files: ScannedRepositoryFile[];
  directoriesVisited: number;
  entriesVisited: number;
  totalBytes: number;
  skippedSymlinks: string[];
  skippedSpecialFiles: string[];
  skippedByPolicy: string[];
  skippedUnreadable: string[];
};

export type RepositoryScanErrorCode =
  | "INVALID_ROOT"
  | "ROOT_SYMLINK"
  | "PATH_ESCAPE"
  | "MAX_ENTRIES_EXCEEDED"
  | "MAX_DEPTH_EXCEEDED"
  | "SCAN_ABORTED"
  | "FILESYSTEM_ERROR"
  | "POLICY_ERROR";

export class RepositoryScanError extends Error {
  override readonly name = "RepositoryScanError";

  constructor(
    readonly code: RepositoryScanErrorCode,
    message: string,
    readonly relativePath: string | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const defaultMaxEntries = 100_000;
const defaultMaxDepth = 64;

function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isInsideRoot(rootDirectory: string, candidate: string): boolean {
  const relative = path.relative(rootDirectory, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepositoryScanError(
      "SCAN_ABORTED",
      "Repository scan was cancelled",
    );
  }
}

export class RepositoryFileScanner {
  async scan(
    rootDirectory: string,
    options: RepositoryScanOptions = {},
  ): Promise<RepositoryScanResult> {
    const maxEntries = options.maxEntries ?? defaultMaxEntries;
    const maxDepth = options.maxDepth ?? defaultMaxDepth;

    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Repository scan maxEntries must be a positive integer");
    }

    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new Error("Repository scan maxDepth must be a non-negative integer");
    }

    assertNotAborted(options.signal);

    const requestedRoot = path.resolve(rootDirectory);
    let requestedRootStats: Stats;

    try {
      requestedRootStats = await fs.lstat(requestedRoot);
    } catch (cause) {
      throw new RepositoryScanError(
        "INVALID_ROOT",
        "Repository scan root does not exist or cannot be accessed",
        undefined,
        { cause },
      );
    }

    if (requestedRootStats.isSymbolicLink()) {
      throw new RepositoryScanError(
        "ROOT_SYMLINK",
        "Repository scan root cannot be a symbolic link",
      );
    }

    if (!requestedRootStats.isDirectory()) {
      throw new RepositoryScanError(
        "INVALID_ROOT",
        "Repository scan root must be a directory",
      );
    }

    const resolvedRoot = await fs.realpath(requestedRoot);
    const result: RepositoryScanResult = {
      rootDirectory: resolvedRoot,
      files: [],
      directoriesVisited: 1,
      entriesVisited: 0,
      totalBytes: 0,
      skippedSymlinks: [],
      skippedSpecialFiles: [],
      skippedByPolicy: [],
      skippedUnreadable: [],
    };

    const handleFileSystemError = (
      relativePath: string,
      cause: unknown,
    ): "skip" => {
      if (options.fileSystemErrors === "skip") {
        result.skippedUnreadable.push(relativePath);
        return "skip";
      }

      throw new RepositoryScanError(
        "FILESYSTEM_ERROR",
        `Unable to inspect repository path ${relativePath}`,
        relativePath,
        { cause },
      );
    };

    const evaluatePolicy = async (
      policy: RepositoryScanOptions["shouldEnterDirectory"] | undefined,
      entry: RepositoryScanEntry,
    ): Promise<boolean> => {
      if (!policy) {
        return true;
      }

      try {
        return await policy(entry);
      } catch (cause) {
        throw new RepositoryScanError(
          "POLICY_ERROR",
          `Repository scan policy failed for ${entry.relativePath}`,
          entry.relativePath,
          { cause },
        );
      }
    };

    const visitDirectory = async (
      absoluteDirectory: string,
      relativeDirectory: string,
      depth: number,
    ): Promise<void> => {
      assertNotAborted(options.signal);
      let directoryEntries;

      try {
        directoryEntries = await fs.readdir(absoluteDirectory, {
          withFileTypes: true,
        });
      } catch (cause) {
        handleFileSystemError(relativeDirectory || ".", cause);
        return;
      }

      directoryEntries.sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
      );

      for (const directoryEntry of directoryEntries) {
        assertNotAborted(options.signal);
        result.entriesVisited += 1;

        if (result.entriesVisited > maxEntries) {
          throw new RepositoryScanError(
            "MAX_ENTRIES_EXCEEDED",
            `Repository contains more than ${maxEntries} filesystem entries`,
          );
        }

        const relativePath = toPosixPath(
          path.join(relativeDirectory, directoryEntry.name),
        );
        const absolutePath = path.resolve(absoluteDirectory, directoryEntry.name);

        if (!isInsideRoot(resolvedRoot, absolutePath)) {
          throw new RepositoryScanError(
            "PATH_ESCAPE",
            `Repository path escaped the scan root: ${relativePath}`,
            relativePath,
          );
        }

        let stats: Stats;

        try {
          stats = await fs.lstat(absolutePath);
        } catch (cause) {
          handleFileSystemError(relativePath, cause);
          continue;
        }

        if (stats.isSymbolicLink()) {
          result.skippedSymlinks.push(relativePath);
          continue;
        }

        const entry: RepositoryScanEntry = {
          absolutePath,
          relativePath,
          name: directoryEntry.name,
          depth: depth + 1,
          stats,
        };

        if (stats.isDirectory()) {
          const shouldEnter = await evaluatePolicy(
            options.shouldEnterDirectory,
            entry,
          );

          if (!shouldEnter) {
            result.skippedByPolicy.push(relativePath);
            continue;
          }

          if (entry.depth > maxDepth) {
            throw new RepositoryScanError(
              "MAX_DEPTH_EXCEEDED",
              `Repository directory depth exceeds ${maxDepth}`,
              relativePath,
            );
          }

          result.directoriesVisited += 1;
          await visitDirectory(absolutePath, relativePath, entry.depth);
          continue;
        }

        if (!stats.isFile()) {
          result.skippedSpecialFiles.push(relativePath);
          continue;
        }

        const shouldInclude = await evaluatePolicy(
          options.shouldIncludeFile,
          entry,
        );

        if (!shouldInclude) {
          result.skippedByPolicy.push(relativePath);
          continue;
        }

        result.files.push({
          ...entry,
          size: stats.size,
          modifiedAtMs: stats.mtimeMs,
          mode: stats.mode,
        });
        result.totalBytes += stats.size;
      }
    };

    await visitDirectory(resolvedRoot, "", 0);
    return result;
  }
}
