import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LineBasedChunker,
  RepositoryFileFilter,
  RepositoryFileScanner,
  RepositoryLineBasedChunker,
  detectRepositorySourceLanguage,
  type LineChunkSourceMetadata,
} from "../src/index.js";

const metadata: LineChunkSourceMetadata = {
  userId: "user-1",
  repositoryId: "repository-1",
  branch: "main",
  commitSha: "abc123",
  filePath: "src/example.ts",
};

function createLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join(
    "\n",
  );
}

describe("LineBasedChunker", () => {
  it("creates guide-compatible metadata and deterministic hashes", () => {
    const chunker = new LineBasedChunker();
    const first = chunker.chunk("export const value = 1;\n", metadata);
    const second = chunker.chunk("export const value = 1;\n", metadata);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      userId: "user-1",
      repositoryId: "repository-1",
      branch: "main",
      commitSha: "abc123",
      filePath: "src/example.ts",
      language: "typescript",
      startLine: 1,
      endLine: 2,
      chunkIndex: 0,
      content: "export const value = 1;\n",
      imports: [],
      exports: [],
    });
    expect(first[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("uses 120-line chunks with 20-line overlap by default", () => {
    const chunks = new LineBasedChunker().chunk(createLines(250), metadata);

    expect(
      chunks.map(({ startLine, endLine }) => ({ startLine, endLine })),
    ).toEqual([
      { startLine: 1, endLine: 120 },
      { startLine: 101, endLine: 220 },
      { startLine: 201, endLine: 250 },
    ]);
    expect(chunks[0]?.content.endsWith("line-120")).toBe(true);
    expect(chunks[1]?.content.startsWith("line-101\n")).toBe(true);
    expect(chunks[2]?.content.startsWith("line-201\n")).toBe(true);
  });

  it("does not create an overlap-only chunk at an exact boundary", () => {
    const chunks = new LineBasedChunker().chunk(createLines(120), metadata);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 120 });
  });

  it("normalizes mixed line endings and preserves a trailing empty line", () => {
    const chunks = new LineBasedChunker().chunk(
      "one\r\ntwo\rthree\nfour\n",
      metadata,
    );

    expect(chunks[0]).toMatchObject({
      startLine: 1,
      endLine: 5,
      content: "one\ntwo\nthree\nfour\n",
    });
  });

  it("returns no chunks for an empty source file", () => {
    expect(new LineBasedChunker().chunk("", metadata)).toEqual([]);
  });

  it("supports custom line sizes and overlap", () => {
    const chunks = new LineBasedChunker().chunk(createLines(8), metadata, {
      chunkSizeLines: 4,
      overlapLines: 1,
    });

    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 4],
      [4, 7],
      [7, 8],
    ]);
  });

  it("rejects unsafe configuration, metadata, and excessive source input", () => {
    const chunker = new LineBasedChunker();

    expect(() =>
      chunker.chunk("source", metadata, {
        chunkSizeLines: 20,
        overlapLines: 20,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() =>
      chunker.chunk("source", { ...metadata, filePath: "../secret.ts" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_METADATA" }));
    expect(() =>
      chunker.chunk("12345", metadata, { maxSourceCharacters: 4 }),
    ).toThrowError(
      expect.objectContaining({ code: "MAX_SOURCE_CHARACTERS_EXCEEDED" }),
    );
    expect(() =>
      chunker.chunk(createLines(4), metadata, {
        chunkSizeLines: 2,
        overlapLines: 1,
        maxChunks: 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "MAX_CHUNKS_PER_FILE_EXCEEDED" }),
    );
  });

  it("changes deterministic IDs when source identity changes", () => {
    const chunker = new LineBasedChunker();
    const original = chunker.chunk("source", metadata)[0];
    const changedCommit = chunker.chunk("source", {
      ...metadata,
      commitSha: "def456",
    })[0];
    const changedContent = chunker.chunk("changed", metadata)[0];

    expect(original?.id).not.toBe(changedCommit?.id);
    expect(original?.id).not.toBe(changedContent?.id);
  });

  it.each([
    ["index.js", "javascript"],
    ["component.jsx", "jsx"],
    ["index.ts", "typescript"],
    ["component.tsx", "tsx"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["styles.css", "css"],
    ["theme.scss", "scss"],
    ["index.html", "html"],
    ["custom.txt", "unknown"],
  ])("detects the language for %s", (filePath, expected) => {
    expect(detectRepositorySourceLanguage(filePath)).toBe(expected);
  });
});

describe("RepositoryLineBasedChunker", () => {
  let rootDirectory: string;

  beforeEach(async () => {
    rootDirectory = await fs.mkdtemp(path.join(tmpdir(), "chunker-root-"));
  });

  afterEach(async () => {
    await fs.rm(rootDirectory, { recursive: true, force: true });
  });

  it("reads filtered files in deterministic order and returns file summaries", async () => {
    await fs.mkdir(path.join(rootDirectory, "src"));
    await fs.writeFile(path.join(rootDirectory, "src", "b.ts"), "b1\nb2");
    await fs.writeFile(path.join(rootDirectory, "src", "a.ts"), "a1\na2\na3");
    await fs.writeFile(path.join(rootDirectory, "empty.md"), "");

    const filtered = await new RepositoryFileFilter().filter(rootDirectory);
    const result = await new RepositoryLineBasedChunker().chunkFiles(
      [...filtered.files].reverse(),
      {
        userId: "user-1",
        repositoryId: "repository-1",
        branch: "main",
        commitSha: "abc123",
      },
      { lineChunking: { chunkSizeLines: 2, overlapLines: 1 } },
    );

    expect(result.fileSummaries.map((summary) => summary.filePath)).toEqual([
      "empty.md",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(result.chunks.map((chunk) => chunk.filePath)).toEqual([
      "src/a.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(result.fileSummaries[0]).toMatchObject({
      filePath: "empty.md",
      chunkCount: 0,
      sourceBytes: 0,
      sourceCharacters: 0,
    });
    expect(result.filesProcessed).toBe(3);
    expect(result.totalSourceBytes).toBe(13);
    expect(result.totalSourceCharacters).toBe(13);
  });

  it("validates the complete file as UTF-8, not only an initial sample", async () => {
    const source = Buffer.concat([
      Buffer.alloc(9_000, 65),
      Buffer.from([0xff, 0xfe]),
    ]);
    await fs.writeFile(path.join(rootDirectory, "invalid.ts"), source);
    const scanned = await new RepositoryFileScanner().scan(rootDirectory);

    await expect(
      new RepositoryLineBasedChunker().chunkFiles(scanned.files, {
        userId: "user-1",
        repositoryId: "repository-1",
        branch: "main",
        commitSha: "abc123",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_UTF8",
      filePath: "invalid.ts",
    });
  });

  it("enforces actual source-byte and repository chunk limits", async () => {
    await fs.writeFile(path.join(rootDirectory, "large.ts"), "1\n2\n3");
    const scanned = await new RepositoryFileScanner().scan(rootDirectory);
    const context = {
      userId: "user-1",
      repositoryId: "repository-1",
      branch: "main",
      commitSha: "abc123",
    };
    const chunker = new RepositoryLineBasedChunker();

    await expect(
      chunker.chunkFiles(scanned.files, context, { maxSourceBytesPerFile: 4 }),
    ).rejects.toMatchObject({ code: "MAX_SOURCE_BYTES_EXCEEDED" });
    await expect(
      chunker.chunkFiles(scanned.files, context, { maxTotalSourceBytes: 4 }),
    ).rejects.toMatchObject({ code: "MAX_TOTAL_SOURCE_BYTES_EXCEEDED" });
    await expect(
      chunker.chunkFiles(scanned.files, context, {
        maxTotalChunks: 1,
        lineChunking: { chunkSizeLines: 1, overlapLines: 0 },
      }),
    ).rejects.toMatchObject({ code: "MAX_TOTAL_CHUNKS_EXCEEDED" });
  });

  it("rejects duplicate paths and supports cancellation", async () => {
    await fs.writeFile(path.join(rootDirectory, "index.ts"), "source");
    const scanned = await new RepositoryFileScanner().scan(rootDirectory);
    const context = {
      userId: "user-1",
      repositoryId: "repository-1",
      branch: "main",
      commitSha: "abc123",
    };
    const chunker = new RepositoryLineBasedChunker();

    await expect(
      chunker.chunkFiles([scanned.files[0]!, scanned.files[0]!], context),
    ).rejects.toMatchObject({ code: "DUPLICATE_FILE_PATH" });

    const controller = new AbortController();
    controller.abort();

    await expect(
      chunker.chunkFiles(scanned.files, context, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CHUNKING_ABORTED" });
  });
});
