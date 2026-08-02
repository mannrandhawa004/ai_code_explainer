import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import type { ScannedRepositoryFile } from "./repository-file-scanner.js";

export const defaultLineChunkSize = 120;
export const defaultLineChunkOverlap = 20;
export const defaultMaxSourceCharactersPerFile = 500 * 1024;
export const defaultMaxChunksPerFile = 10_000;
export const defaultMaxSourceBytesPerFile = 500 * 1024;
export const defaultMaxRepositorySourceBytes = 100 * 1024 * 1024;
export const defaultMaxRepositorySourceCharacters = 100 * 1024 * 1024;
export const defaultMaxRepositoryChunks = 100_000;
export const defaultSourceReadConcurrency = 8;

export type RepositorySourceLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "json"
  | "markdown"
  | "css"
  | "scss"
  | "html"
  | "unknown";

export type CodeChunk = {
  id: string;
  userId: string;
  repositoryId: string;
  branch: string;
  commitSha: string;
  filePath: string;
  language: string;
  symbolType?: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  chunkIndex: number;
  content: string;
  contentHash: string;
  imports: string[];
  exports: string[];
  references?: string[];
};

export type LineChunkSourceMetadata = {
  userId: string;
  repositoryId: string;
  branch: string;
  commitSha: string;
  filePath: string;
  language?: string;
  sourceStartLine?: number;
  symbolType?: string;
  symbolName?: string;
  imports?: readonly string[];
  exports?: readonly string[];
  references?: readonly string[];
};

export type RepositoryChunkContext = Pick<
  LineChunkSourceMetadata,
  "userId" | "repositoryId" | "branch" | "commitSha"
>;

export type LineBasedChunkerOptions = {
  chunkSizeLines?: number;
  overlapLines?: number;
  maxSourceCharacters?: number;
  maxChunks?: number;
};

export type RepositoryLineChunkerOptions = {
  lineChunking?: LineBasedChunkerOptions;
  maxSourceBytesPerFile?: number;
  maxTotalSourceBytes?: number;
  maxTotalSourceCharacters?: number;
  maxTotalChunks?: number;
  readConcurrency?: number;
  signal?: AbortSignal;
};

export type ChunkedRepositoryFileSummary = {
  filePath: string;
  language: RepositorySourceLanguage;
  sourceBytes: number;
  sourceCharacters: number;
  contentHash: string;
  chunkCount: number;
  chunkingStrategy: "line" | "tree_sitter" | "line_fallback";
  imports: string[];
  exports: string[];
  symbols: ChunkedRepositorySymbol[];
};

export type ChunkedRepositorySymbol = {
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  imports: string[];
  references: string[];
};

export type SourceFileChunkingResult = {
  chunks: CodeChunk[];
  chunkingStrategy: ChunkedRepositoryFileSummary["chunkingStrategy"];
  imports: string[];
  exports: string[];
  symbols: ChunkedRepositorySymbol[];
};

export type RepositoryChunkingResult = {
  chunks: CodeChunk[];
  fileSummaries: ChunkedRepositoryFileSummary[];
  filesProcessed: number;
  totalSourceBytes: number;
  totalSourceCharacters: number;
};

export type RepositoryChunkingErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_METADATA"
  | "DUPLICATE_FILE_PATH"
  | "SOURCE_NOT_REGULAR_FILE"
  | "SOURCE_READ_FAILED"
  | "INVALID_UTF8"
  | "MAX_SOURCE_BYTES_EXCEEDED"
  | "MAX_SOURCE_CHARACTERS_EXCEEDED"
  | "MAX_CHUNKS_PER_FILE_EXCEEDED"
  | "MAX_TOTAL_SOURCE_BYTES_EXCEEDED"
  | "MAX_TOTAL_SOURCE_CHARACTERS_EXCEEDED"
  | "MAX_TOTAL_CHUNKS_EXCEEDED"
  | "CHUNKING_ABORTED";

export class RepositoryChunkingError extends Error {
  override readonly name = "RepositoryChunkingError";

  constructor(
    readonly code: RepositoryChunkingErrorCode,
    message: string,
    readonly filePath: string | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const languagesByExtension: Readonly<
  Partial<Record<string, RepositorySourceLanguage>>
> = Object.freeze({
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
});

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RepositoryChunkingError(
      "INVALID_CONFIGURATION",
      `${name} must be a positive integer`,
    );
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RepositoryChunkingError(
      "INVALID_CONFIGURATION",
      `${name} must be a non-negative integer`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RepositoryChunkingError(
      "CHUNKING_ABORTED",
      "Repository source chunking was cancelled",
    );
  }
}

function assertMetadataValue(value: string, name: string): void {
  if (!value.trim() || value.includes("\0")) {
    throw new RepositoryChunkingError(
      "INVALID_METADATA",
      `${name} must be a non-empty safe string`,
    );
  }
}

function assertCanonicalFilePath(filePath: string): void {
  assertMetadataValue(filePath, "filePath");

  if (
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    path.posix.normalize(filePath) !== filePath ||
    filePath === ".." ||
    filePath.startsWith("../")
  ) {
    throw new RepositoryChunkingError(
      "INVALID_METADATA",
      "filePath must be a canonical repository-relative POSIX path",
      filePath,
    );
  }
}

function validateSourceMetadata(metadata: LineChunkSourceMetadata): void {
  assertMetadataValue(metadata.userId, "userId");
  assertMetadataValue(metadata.repositoryId, "repositoryId");
  assertMetadataValue(metadata.branch, "branch");
  assertMetadataValue(metadata.commitSha, "commitSha");
  assertCanonicalFilePath(metadata.filePath);

  if (metadata.language !== undefined) {
    assertMetadataValue(metadata.language, "language");
  }
  if (metadata.sourceStartLine !== undefined) {
    assertPositiveInteger(metadata.sourceStartLine, "sourceStartLine");
  }
  if (metadata.symbolType !== undefined) {
    assertMetadataValue(metadata.symbolType, "symbolType");
  }
  if (metadata.symbolName !== undefined) {
    assertMetadataValue(metadata.symbolName, "symbolName");
  }
  for (const [fieldName, values] of [
    ["imports", metadata.imports],
    ["exports", metadata.exports],
    ["references", metadata.references],
  ] as const) {
    for (const value of values ?? []) {
      assertMetadataValue(value, fieldName);
    }
  }
}

function validateRepositoryContext(context: RepositoryChunkContext): void {
  assertMetadataValue(context.userId, "userId");
  assertMetadataValue(context.repositoryId, "repositoryId");
  assertMetadataValue(context.branch, "branch");
  assertMetadataValue(context.commitSha, "commitSha");
}

export function createRepositoryContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function createDeterministicChunkId(identity: string): string {
  const hash = createHash("sha256").update(identity, "utf8").digest("hex");
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `8${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function compareFilePaths(
  left: ScannedRepositoryFile,
  right: ScannedRepositoryFile,
): number {
  return left.relativePath === right.relativePath
    ? 0
    : left.relativePath < right.relativePath
      ? -1
      : 1;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown }).name === "AbortError";
}

export function detectRepositorySourceLanguage(
  filePath: string,
): RepositorySourceLanguage {
  return languagesByExtension[path.posix.extname(filePath).toLowerCase()] ?? "unknown";
}

export class LineBasedChunker {
  chunk(
    content: string,
    metadata: LineChunkSourceMetadata,
    options: LineBasedChunkerOptions = {},
  ): CodeChunk[] {
    const chunkSizeLines = options.chunkSizeLines ?? defaultLineChunkSize;
    const overlapLines = options.overlapLines ?? defaultLineChunkOverlap;
    const maxSourceCharacters =
      options.maxSourceCharacters ?? defaultMaxSourceCharactersPerFile;
    const maxChunks = options.maxChunks ?? defaultMaxChunksPerFile;

    assertPositiveInteger(chunkSizeLines, "chunkSizeLines");
    assertNonNegativeInteger(overlapLines, "overlapLines");
    assertPositiveInteger(maxSourceCharacters, "maxSourceCharacters");
    assertPositiveInteger(maxChunks, "maxChunks");

    if (overlapLines >= chunkSizeLines) {
      throw new RepositoryChunkingError(
        "INVALID_CONFIGURATION",
        "overlapLines must be smaller than chunkSizeLines",
      );
    }

    validateSourceMetadata(metadata);

    if (content.length > maxSourceCharacters) {
      throw new RepositoryChunkingError(
        "MAX_SOURCE_CHARACTERS_EXCEEDED",
        `${metadata.filePath} exceeds the ${maxSourceCharacters} character source limit`,
        metadata.filePath,
      );
    }

    if (content.length === 0) {
      return [];
    }

    const lines = content.split(/\r\n|\n|\r/u);
    const step = chunkSizeLines - overlapLines;
    const expectedChunks =
      lines.length <= chunkSizeLines
        ? 1
        : 1 + Math.ceil((lines.length - chunkSizeLines) / step);

    if (expectedChunks > maxChunks) {
      throw new RepositoryChunkingError(
        "MAX_CHUNKS_PER_FILE_EXCEEDED",
        `${metadata.filePath} would create more than ${maxChunks} chunks`,
        metadata.filePath,
      );
    }

    const language =
      metadata.language ?? detectRepositorySourceLanguage(metadata.filePath);
    const chunks: CodeChunk[] = [];
    let start = 0;

    while (start < lines.length) {
      const end = Math.min(start + chunkSizeLines, lines.length);
      const chunkContent = lines.slice(start, end).join("\n");
      const contentHash = createRepositoryContentHash(chunkContent);
      const sourceStartLine = metadata.sourceStartLine ?? 1;
      const startLine = sourceStartLine + start;
      const endLine = sourceStartLine + end - 1;
      const chunkIndex = chunks.length;
      const identityParts: Array<string | number> = [
        metadata.userId,
        metadata.repositoryId,
        metadata.branch,
        metadata.commitSha,
        metadata.filePath,
        startLine,
        endLine,
        contentHash,
      ];
      if (metadata.symbolType !== undefined || metadata.symbolName !== undefined) {
        identityParts.push(metadata.symbolType ?? "", metadata.symbolName ?? "");
      }
      const identity = identityParts.join("\0");

      chunks.push({
        id: createDeterministicChunkId(identity),
        userId: metadata.userId,
        repositoryId: metadata.repositoryId,
        branch: metadata.branch,
        commitSha: metadata.commitSha,
        filePath: metadata.filePath,
        language,
        ...(metadata.symbolType === undefined
          ? {}
          : { symbolType: metadata.symbolType }),
        ...(metadata.symbolName === undefined
          ? {}
          : { symbolName: metadata.symbolName }),
        startLine,
        endLine,
        chunkIndex,
        content: chunkContent,
        contentHash,
        imports: [...(metadata.imports ?? [])],
        exports: [...(metadata.exports ?? [])],
        ...(metadata.references === undefined
          ? {}
          : { references: [...metadata.references] }),
      });

      if (end === lines.length) {
        break;
      }

      start += step;
    }

    return chunks;
  }
}

export class RepositoryLineBasedChunker {
  constructor(
    private readonly lineChunker: LineBasedChunker = new LineBasedChunker(),
  ) {}

  async chunkFiles(
    files: readonly ScannedRepositoryFile[],
    context: RepositoryChunkContext,
    options: RepositoryLineChunkerOptions = {},
  ): Promise<RepositoryChunkingResult> {
    const maxSourceBytesPerFile =
      options.maxSourceBytesPerFile ?? defaultMaxSourceBytesPerFile;
    const maxTotalSourceBytes =
      options.maxTotalSourceBytes ?? defaultMaxRepositorySourceBytes;
    const maxTotalSourceCharacters =
      options.maxTotalSourceCharacters ?? defaultMaxRepositorySourceCharacters;
    const maxTotalChunks =
      options.maxTotalChunks ?? defaultMaxRepositoryChunks;
    const readConcurrency =
      options.readConcurrency ?? defaultSourceReadConcurrency;

    assertPositiveInteger(maxSourceBytesPerFile, "maxSourceBytesPerFile");
    assertPositiveInteger(maxTotalSourceBytes, "maxTotalSourceBytes");
    assertPositiveInteger(
      maxTotalSourceCharacters,
      "maxTotalSourceCharacters",
    );
    assertPositiveInteger(maxTotalChunks, "maxTotalChunks");
    assertPositiveInteger(readConcurrency, "readConcurrency");
    validateRepositoryContext(context);
    assertNotAborted(options.signal);

    const orderedFiles = [...files].sort(compareFilePaths);
    const seenPaths = new Set<string>();

    for (const file of orderedFiles) {
      assertCanonicalFilePath(file.relativePath);

      if (seenPaths.has(file.relativePath)) {
        throw new RepositoryChunkingError(
          "DUPLICATE_FILE_PATH",
          `Repository file list contains duplicate path ${file.relativePath}`,
          file.relativePath,
        );
      }

      seenPaths.add(file.relativePath);
    }

    let totalSourceBytes = 0;
    let totalSourceCharacters = 0;
    let totalChunks = 0;
    const limit = pLimit(readConcurrency);
    const results = await Promise.all(
      orderedFiles.map((file) =>
        limit(async () => {
          assertNotAborted(options.signal);
          const contentBytes = await this.readSourceFile(
            file,
            maxSourceBytesPerFile,
            options.signal,
          );
          assertNotAborted(options.signal);

          let content: string;

          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(
              contentBytes,
            );
          } catch (cause) {
            throw new RepositoryChunkingError(
              "INVALID_UTF8",
              `Source file ${file.relativePath} is not valid UTF-8 text`,
              file.relativePath,
              { cause },
            );
          }

          const language = detectRepositorySourceLanguage(file.relativePath);
          const sourceResult = this.chunkSource(
            content,
            {
              ...context,
              filePath: file.relativePath,
              language,
            },
            options.lineChunking,
          );
          const { chunks } = sourceResult;

          totalSourceBytes += contentBytes.byteLength;
          totalSourceCharacters += content.length;
          totalChunks += chunks.length;

          if (totalSourceBytes > maxTotalSourceBytes) {
            throw new RepositoryChunkingError(
              "MAX_TOTAL_SOURCE_BYTES_EXCEEDED",
              `Repository sources exceed the ${maxTotalSourceBytes} byte chunking limit`,
            );
          }

          if (totalSourceCharacters > maxTotalSourceCharacters) {
            throw new RepositoryChunkingError(
              "MAX_TOTAL_SOURCE_CHARACTERS_EXCEEDED",
              `Repository sources exceed the ${maxTotalSourceCharacters} character limit`,
            );
          }

          if (totalChunks > maxTotalChunks) {
            throw new RepositoryChunkingError(
              "MAX_TOTAL_CHUNKS_EXCEEDED",
              `Repository would create more than ${maxTotalChunks} chunks`,
            );
          }

          return {
            chunks,
            summary: {
              filePath: file.relativePath,
              language,
              sourceBytes: contentBytes.byteLength,
              sourceCharacters: content.length,
              contentHash: createRepositoryContentHash(content),
              chunkCount: chunks.length,
              chunkingStrategy: sourceResult.chunkingStrategy,
              imports: sourceResult.imports,
              exports: sourceResult.exports,
              symbols: sourceResult.symbols,
            } satisfies ChunkedRepositoryFileSummary,
          };
        }),
      ),
    );

    return {
      chunks: results.flatMap((result) => result.chunks),
      fileSummaries: results.map((result) => result.summary),
      filesProcessed: results.length,
      totalSourceBytes,
      totalSourceCharacters,
    };
  }

  protected chunkSource(
    content: string,
    metadata: LineChunkSourceMetadata,
    options: LineBasedChunkerOptions | undefined,
  ): SourceFileChunkingResult {
    return {
      chunks: this.lineChunker.chunk(content, metadata, options),
      chunkingStrategy: "line",
      imports: [],
      exports: [],
      symbols: [],
    };
  }

  private async readSourceFile(
    file: ScannedRepositoryFile,
    maxSourceBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    let stats;

    try {
      stats = await fs.lstat(file.absolutePath);
    } catch (cause) {
      throw new RepositoryChunkingError(
        "SOURCE_READ_FAILED",
        `Unable to inspect source file ${file.relativePath}`,
        file.relativePath,
        { cause },
      );
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new RepositoryChunkingError(
        "SOURCE_NOT_REGULAR_FILE",
        `Source path ${file.relativePath} is no longer a regular file`,
        file.relativePath,
      );
    }

    if (stats.size > maxSourceBytes) {
      throw new RepositoryChunkingError(
        "MAX_SOURCE_BYTES_EXCEEDED",
        `${file.relativePath} exceeds the ${maxSourceBytes} byte chunking limit`,
        file.relativePath,
      );
    }

    try {
      const content = await fs.readFile(file.absolutePath, { signal });

      if (content.byteLength > maxSourceBytes) {
        throw new RepositoryChunkingError(
          "MAX_SOURCE_BYTES_EXCEEDED",
          `${file.relativePath} exceeds the ${maxSourceBytes} byte chunking limit`,
          file.relativePath,
        );
      }

      return content;
    } catch (cause) {
      if (cause instanceof RepositoryChunkingError) {
        throw cause;
      }

      if (isAbortError(cause)) {
        throw new RepositoryChunkingError(
          "CHUNKING_ABORTED",
          "Repository source chunking was cancelled",
          file.relativePath,
          { cause },
        );
      }

      throw new RepositoryChunkingError(
        "SOURCE_READ_FAILED",
        `Unable to read source file ${file.relativePath}`,
        file.relativePath,
        { cause },
      );
    }
  }
}
