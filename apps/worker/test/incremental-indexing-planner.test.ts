import type {
  HashedRepositoryFile,
  ScannedRepositoryFile,
} from "@codebase-explainer/repository";
import { describe, expect, it } from "vitest";

import {
  createIncrementalIndexingPlan,
  summarizeIncrementalIndexingPlan,
} from "../src/services/incremental-indexing-planner.js";
import type {
  PersistedFileSummary,
  PersistedRepositoryFile,
} from "../src/persistence/indexing-persistence.js";

function currentFile(
  filePath: string,
  contentHash: string,
): HashedRepositoryFile {
  const file: ScannedRepositoryFile = {
    absolutePath: `C:/repository/${filePath}`,
    relativePath: filePath,
    name: filePath.split("/").at(-1) as string,
    depth: filePath.split("/").length,
    stats: {} as ScannedRepositoryFile["stats"],
    size: 10,
    modifiedAtMs: 0,
    mode: 0o100644,
  };
  return { file, contentHash };
}

function persistedFile(
  filePath: string,
  contentHash: string,
  chunkCount: number | undefined = 1,
): PersistedRepositoryFile {
  return {
    filePath,
    language: "typescript",
    contentHash,
    sourceBytes: 10,
    ...(chunkCount === undefined ? {} : { chunkCount }),
  };
}

function indexedFile(
  filePath: string,
  contentHash: string,
  chunkCount: number,
): PersistedFileSummary {
  return {
    filePath,
    language: "typescript",
    contentHash,
    sourceBytes: 10,
    chunkCount,
    imports: [],
    exports: [],
    symbols: [],
  };
}

describe("incremental indexing planner", () => {
  it("classifies added, modified, unchanged, and removed files by content hash", () => {
    const plan = createIncrementalIndexingPlan({
      lastIndexedCommit: "1".repeat(40),
      currentFiles: [
        currentFile("src/unchanged.ts", "a".repeat(64)),
        currentFile("src/modified.ts", "b".repeat(64)),
        currentFile("src/added.ts", "c".repeat(64)),
      ],
      persistedFiles: [
        persistedFile("src/unchanged.ts", "a".repeat(64), 2),
        persistedFile("src/modified.ts", "d".repeat(64), 3),
        persistedFile("src/removed.ts", "e".repeat(64), 4),
      ],
    });

    expect(plan.mode).toBe("incremental");
    expect(plan.changedFiles.map((file) => file.relativePath)).toEqual([
      "src/modified.ts",
      "src/added.ts",
    ]);
    expect(plan.retainedFiles.map((file) => file.filePath)).toEqual([
      "src/unchanged.ts",
    ]);
    expect(plan.removedFilePaths).toEqual(["src/removed.ts"]);

    const stats = summarizeIncrementalIndexingPlan(plan, [
      indexedFile("src/modified.ts", "b".repeat(64), 5),
      indexedFile("src/added.ts", "c".repeat(64), 1),
    ]);
    expect(stats).toEqual({
      totalFiles: 3,
      totalChunks: 8,
      languages: new Map([["typescript", 3]]),
    });
  });

  it("falls back to a full rebuild when legacy metadata has no chunk count", () => {
    const legacyFile = persistedFile(
      "src/index.ts",
      "a".repeat(64),
    );
    delete legacyFile.chunkCount;
    const plan = createIncrementalIndexingPlan({
      lastIndexedCommit: "1".repeat(40),
      currentFiles: [currentFile("src/index.ts", "a".repeat(64))],
      persistedFiles: [legacyFile],
    });

    expect(plan.mode).toBe("full");
    expect(plan.changedFiles).toHaveLength(1);
    expect(plan.retainedFiles).toHaveLength(0);
  });

  it("rejects incomplete or hash-inconsistent changed file summaries", () => {
    const plan = createIncrementalIndexingPlan({
      lastIndexedCommit: "1".repeat(40),
      currentFiles: [currentFile("src/index.ts", "a".repeat(64))],
      persistedFiles: [],
    });

    expect(() => summarizeIncrementalIndexingPlan(plan, [])).toThrow(
      "summaries are incomplete",
    );
    expect(() =>
      summarizeIncrementalIndexingPlan(plan, [
        indexedFile("src/index.ts", "b".repeat(64), 1),
      ]),
    ).toThrow("was not indexed consistently");
  });
});
