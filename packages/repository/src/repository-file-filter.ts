import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import createIgnore from "ignore";
import pLimit from "p-limit";

import {
  RepositoryFileScanner,
  type RepositoryScanEntry,
  type RepositoryScanOptions,
  type RepositoryScanResult,
  type ScannedRepositoryFile,
} from "./repository-file-scanner.js";

export const defaultSupportedRepositoryExtensions = Object.freeze([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
]);

export const defaultIgnoredRepositoryDirectories = Object.freeze([
  ".git",
  ".next",
  ".cache",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "temp",
  "tmp",
  "vendor",
]);

export type RepositoryFileExclusionReason =
  | "default_ignored_directory"
  | "gitignore"
  | "gitignore_file"
  | "unsupported_extension"
  | "secret_file"
  | "generated_file"
  | "lock_file"
  | "file_too_large"
  | "binary_file"
  | "unreadable_file";

export type RepositoryFileExclusion = {
  relativePath: string;
  kind: "file" | "directory";
  reason: RepositoryFileExclusionReason;
};

export type RepositoryFileFilterScanOptions = Omit<
  RepositoryScanOptions,
  "shouldEnterDirectory" | "shouldIncludeFile"
>;

export type RepositoryFileFilterOptions = {
  supportedExtensions?: readonly string[];
  additionalIgnoredDirectoryNames?: readonly string[];
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxGitignoreBytes?: number;
  binarySampleBytes?: number;
  inspectionConcurrency?: number;
  scanOptions?: RepositoryFileFilterScanOptions;
};

export type RepositoryFileFilterScanSummary = {
  directoriesVisited: number;
  entriesVisited: number;
  skippedSymlinks: string[];
  skippedSpecialFiles: string[];
  skippedUnreadable: string[];
};

export type FilteredRepositoryFiles = {
  rootDirectory: string;
  files: ScannedRepositoryFile[];
  totalBytes: number;
  exclusions: RepositoryFileExclusion[];
  scanSummary: RepositoryFileFilterScanSummary;
};

export type RepositoryFileFilterErrorCode =
  | "INVALID_CONFIGURATION"
  | "GITIGNORE_READ_FAILED"
  | "GITIGNORE_TOO_LARGE"
  | "MAX_FILES_EXCEEDED"
  | "MAX_TOTAL_BYTES_EXCEEDED"
  | "FILE_READ_FAILED"
  | "FILTER_ABORTED";

export class RepositoryFileFilterError extends Error {
  override readonly name = "RepositoryFileFilterError";

  constructor(
    readonly code: RepositoryFileFilterErrorCode,
    message: string,
    readonly relativePath: string | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const defaultMaxFiles = 5_000;
const defaultMaxTotalBytes = 100 * 1024 * 1024;
const defaultMaxFileBytes = 500 * 1024;
const defaultMaxGitignoreBytes = 500 * 1024;
const defaultBinarySampleBytes = 8 * 1024;
const defaultInspectionConcurrency = 16;
const suspiciousControlCharacterRatio = 0.1;

type IgnoreMatcher = ReturnType<typeof createIgnore>;

type GitignoreRuleSet = {
  baseDirectory: string;
  matcher: IgnoreMatcher;
};

type FileInspection =
  | { status: "accepted"; file: ScannedRepositoryFile }
  | { status: "excluded"; exclusion: RepositoryFileExclusion };

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RepositoryFileFilterError(
      "INVALID_CONFIGURATION",
      `${name} must be a positive integer`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepositoryFileFilterError(
      "FILTER_ABORTED",
      "Repository file filtering was cancelled",
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function relativeToRuleBase(
  relativePath: string,
  baseDirectory: string,
): string | undefined {
  if (baseDirectory === "") {
    return relativePath;
  }

  if (!relativePath.startsWith(`${baseDirectory}/`)) {
    return undefined;
  }

  return relativePath.slice(baseDirectory.length + 1);
}

function isIgnoredByGitignore(
  ruleSets: readonly GitignoreRuleSet[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;

  for (const ruleSet of ruleSets) {
    const pathWithinBase = relativeToRuleBase(
      relativePath,
      ruleSet.baseDirectory,
    );

    if (!pathWithinBase) {
      continue;
    }

    const result = ruleSet.matcher.test(
      isDirectory ? `${pathWithinBase}/` : pathWithinBase,
    );

    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }

  return ignored;
}

function isSecretFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();

  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === ".npmrc" ||
    normalized === ".pypirc" ||
    normalized === "credentials.json" ||
    normalized === "service-account.json" ||
    normalized === "id_rsa" ||
    normalized === "id_ed25519" ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx")
  );
}

function isLockFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();

  return (
    normalized.endsWith(".lock") ||
    normalized === "package-lock.json" ||
    normalized === "pnpm-lock.yaml" ||
    normalized === "yarn.lock" ||
    normalized === "npm-shrinkwrap.json"
  );
}

function isGeneratedFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();

  return (
    normalized.endsWith(".min.js") ||
    normalized.endsWith(".min.css") ||
    normalized.endsWith(".map")
  );
}

function normalizeExtensions(extensions: readonly string[]): Set<string> {
  const normalized = new Set<string>();

  for (const extension of extensions) {
    const value = extension.trim().toLowerCase();

    if (!/^\.[a-z0-9]+$/u.test(value)) {
      throw new RepositoryFileFilterError(
        "INVALID_CONFIGURATION",
        `Unsupported file extension configuration: ${extension}`,
      );
    }

    normalized.add(value);
  }

  if (normalized.size === 0) {
    throw new RepositoryFileFilterError(
      "INVALID_CONFIGURATION",
      "supportedExtensions must contain at least one extension",
    );
  }

  return normalized;
}

function normalizeDirectoryNames(names: readonly string[]): Set<string> {
  const normalized = new Set<string>();

  for (const name of names) {
    const value = name.trim().toLowerCase();

    if (!value || value.includes("/") || value.includes("\\")) {
      throw new RepositoryFileFilterError(
        "INVALID_CONFIGURATION",
        `Invalid ignored directory name: ${name}`,
      );
    }

    normalized.add(value);
  }

  return normalized;
}

async function isProbablyBinary(
  file: ScannedRepositoryFile,
  sampleBytes: number,
): Promise<boolean> {
  if (file.size === 0) {
    return false;
  }

  const fileHandle = await fs.open(file.absolutePath, fsConstants.O_RDONLY);

  try {
    const buffer = Buffer.alloc(Math.min(file.size, sampleBytes));
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      buffer.length,
      0,
    );
    const sample = buffer.subarray(0, bytesRead);

    if (sample.includes(0)) {
      return true;
    }

    let text: string;

    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(sample, {
        stream: file.size > bytesRead,
      });
    } catch {
      return true;
    }

    if (text.length === 0) {
      return false;
    }

    let suspiciousCharacters = 0;

    for (const character of text) {
      const codePoint = character.codePointAt(0) ?? 0;
      const isAllowedWhitespace =
        codePoint === 8 ||
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 12 ||
        codePoint === 13;

      if ((codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) && !isAllowedWhitespace) {
        suspiciousCharacters += 1;
      }
    }

    return suspiciousCharacters / text.length > suspiciousControlCharacterRatio;
  } finally {
    await fileHandle.close();
  }
}

function toScanSummary(
  scanResult: RepositoryScanResult,
): RepositoryFileFilterScanSummary {
  return {
    directoriesVisited: scanResult.directoriesVisited,
    entriesVisited: scanResult.entriesVisited,
    skippedSymlinks: [...scanResult.skippedSymlinks],
    skippedSpecialFiles: [...scanResult.skippedSpecialFiles],
    skippedUnreadable: [...scanResult.skippedUnreadable],
  };
}

export class RepositoryFileFilter {
  constructor(
    private readonly scanner: RepositoryFileScanner = new RepositoryFileScanner(),
  ) {}

  async filter(
    rootDirectory: string,
    options: RepositoryFileFilterOptions = {},
  ): Promise<FilteredRepositoryFiles> {
    const maxFiles = options.maxFiles ?? defaultMaxFiles;
    const maxTotalBytes = options.maxTotalBytes ?? defaultMaxTotalBytes;
    const maxFileBytes = options.maxFileBytes ?? defaultMaxFileBytes;
    const maxGitignoreBytes =
      options.maxGitignoreBytes ?? defaultMaxGitignoreBytes;
    const binarySampleBytes =
      options.binarySampleBytes ?? defaultBinarySampleBytes;
    const inspectionConcurrency =
      options.inspectionConcurrency ?? defaultInspectionConcurrency;

    assertPositiveInteger(maxFiles, "maxFiles");
    assertPositiveInteger(maxTotalBytes, "maxTotalBytes");
    assertPositiveInteger(maxFileBytes, "maxFileBytes");
    assertPositiveInteger(maxGitignoreBytes, "maxGitignoreBytes");
    assertPositiveInteger(binarySampleBytes, "binarySampleBytes");
    assertPositiveInteger(inspectionConcurrency, "inspectionConcurrency");

    const supportedExtensions = normalizeExtensions(
      options.supportedExtensions ?? defaultSupportedRepositoryExtensions,
    );
    const ignoredDirectoryNames = normalizeDirectoryNames(
      [
        ...defaultIgnoredRepositoryDirectories,
        ...(options.additionalIgnoredDirectoryNames ?? []),
      ],
    );
    const signal = options.scanOptions?.signal;
    const ruleSets: GitignoreRuleSet[] = [];
    const loadedGitignoreDirectories = new Set<string>();
    const exclusions: RepositoryFileExclusion[] = [];

    const loadGitignore = async (
      absoluteDirectory: string,
      relativeDirectory: string,
    ): Promise<void> => {
      if (loadedGitignoreDirectories.has(relativeDirectory)) {
        return;
      }

      loadedGitignoreDirectories.add(relativeDirectory);
      const gitignorePath = path.join(absoluteDirectory, ".gitignore");
      const displayPath = relativeDirectory
        ? `${relativeDirectory}/.gitignore`
        : ".gitignore";

      let stats;

      try {
        stats = await fs.lstat(gitignorePath);
      } catch (cause) {
        if (isMissingFileError(cause)) {
          return;
        }

        throw new RepositoryFileFilterError(
          "GITIGNORE_READ_FAILED",
          `Unable to inspect ${displayPath}`,
          displayPath,
          { cause },
        );
      }

      if (stats.isSymbolicLink() || !stats.isFile()) {
        return;
      }

      if (stats.size > maxGitignoreBytes) {
        throw new RepositoryFileFilterError(
          "GITIGNORE_TOO_LARGE",
          `${displayPath} exceeds the ${maxGitignoreBytes} byte safety limit`,
          displayPath,
        );
      }

      let source: string;

      try {
        source = await fs.readFile(gitignorePath, "utf8");
      } catch (cause) {
        throw new RepositoryFileFilterError(
          "GITIGNORE_READ_FAILED",
          `Unable to read ${displayPath}`,
          displayPath,
          { cause },
        );
      }

      ruleSets.push({
        baseDirectory: relativeDirectory,
        matcher: createIgnore().add(source.replace(/^\uFEFF/u, "")),
      });
    };

    assertNotAborted(signal);
    await loadGitignore(path.resolve(rootDirectory), "");

    const scanResult = await this.scanner.scan(rootDirectory, {
      ...options.scanOptions,
      shouldEnterDirectory: async (entry) => {
        if (ignoredDirectoryNames.has(entry.name.toLowerCase())) {
          exclusions.push({
            relativePath: entry.relativePath,
            kind: "directory",
            reason: "default_ignored_directory",
          });
          return false;
        }

        if (isIgnoredByGitignore(ruleSets, entry.relativePath, true)) {
          exclusions.push({
            relativePath: entry.relativePath,
            kind: "directory",
            reason: "gitignore",
          });
          return false;
        }

        await loadGitignore(entry.absolutePath, entry.relativePath);
        return true;
      },
      shouldIncludeFile: (entry) => {
        const reason = this.classifyFile(
          entry,
          supportedExtensions,
          ruleSets,
          maxFileBytes,
        );

        if (!reason) {
          return true;
        }

        exclusions.push({
          relativePath: entry.relativePath,
          kind: "file",
          reason,
        });
        return false;
      },
    });

    if (scanResult.files.length > maxFiles) {
      throw new RepositoryFileFilterError(
        "MAX_FILES_EXCEEDED",
        `Repository contains more than ${maxFiles} candidate source files`,
      );
    }

    if (scanResult.totalBytes > maxTotalBytes) {
      throw new RepositoryFileFilterError(
        "MAX_TOTAL_BYTES_EXCEEDED",
        `Candidate source files exceed the ${maxTotalBytes} byte repository limit`,
      );
    }

    const limit = pLimit(inspectionConcurrency);
    const inspections = await Promise.all(
      scanResult.files.map((file) =>
        limit(async (): Promise<FileInspection> => {
          assertNotAborted(signal);

          try {
            if (await isProbablyBinary(file, binarySampleBytes)) {
              return {
                status: "excluded",
                exclusion: {
                  relativePath: file.relativePath,
                  kind: "file",
                  reason: "binary_file",
                },
              };
            }
          } catch (cause) {
            if (options.scanOptions?.fileSystemErrors === "skip") {
              return {
                status: "excluded",
                exclusion: {
                  relativePath: file.relativePath,
                  kind: "file",
                  reason: "unreadable_file",
                },
              };
            }

            throw new RepositoryFileFilterError(
              "FILE_READ_FAILED",
              `Unable to inspect source file ${file.relativePath}`,
              file.relativePath,
              { cause },
            );
          }

          return { status: "accepted", file };
        }),
      ),
    );

    const files: ScannedRepositoryFile[] = [];

    for (const inspection of inspections) {
      if (inspection.status === "accepted") {
        files.push(inspection.file);
      } else {
        exclusions.push(inspection.exclusion);
      }
    }

    exclusions.sort((left, right) =>
      left.relativePath === right.relativePath
        ? 0
        : left.relativePath < right.relativePath
          ? -1
          : 1,
    );

    return {
      rootDirectory: scanResult.rootDirectory,
      files,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      exclusions,
      scanSummary: toScanSummary(scanResult),
    };
  }

  private classifyFile(
    entry: RepositoryScanEntry,
    supportedExtensions: ReadonlySet<string>,
    ruleSets: readonly GitignoreRuleSet[],
    maxFileBytes: number,
  ): RepositoryFileExclusionReason | undefined {
    if (entry.name === ".gitignore") {
      return "gitignore_file";
    }

    if (isSecretFile(entry.name)) {
      return "secret_file";
    }

    if (isLockFile(entry.name)) {
      return "lock_file";
    }

    if (isGeneratedFile(entry.name)) {
      return "generated_file";
    }

    if (!supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      return "unsupported_extension";
    }

    if (entry.stats.size > maxFileBytes) {
      return "file_too_large";
    }

    if (isIgnoredByGitignore(ruleSets, entry.relativePath, false)) {
      return "gitignore";
    }

    return undefined;
  }
}
