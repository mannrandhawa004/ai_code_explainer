import type {
  HashedRepositoryFile,
  ScannedRepositoryFile,
} from "@codebase-explainer/repository";

import type {
  PersistedFileSummary,
  PersistedRepositoryFile,
} from "../persistence/indexing-persistence.js";

export type IncrementalIndexingMode = "full" | "incremental";

export type IncrementalIndexingPlan = {
  mode: IncrementalIndexingMode;
  changedFiles: ScannedRepositoryFile[];
  retainedFiles: PersistedRepositoryFile[];
  removedFilePaths: string[];
  expectedHashes: ReadonlyMap<string, string>;
};

export type IncrementalIndexingStats = {
  totalFiles: number;
  totalChunks: number;
  languages: ReadonlyMap<string, number>;
};

function uniqueByPath<Value>(
  values: readonly Value[],
  pathOf: (value: Value) => string,
  label: string,
): Map<string, Value> {
  const indexed = new Map<string, Value>();
  for (const value of values) {
    const filePath = pathOf(value);
    if (indexed.has(filePath)) {
      throw new Error(`${label} contains duplicate path ${filePath}`);
    }
    indexed.set(filePath, value);
  }
  return indexed;
}

export function createIncrementalIndexingPlan(input: {
  lastIndexedCommit: string | undefined;
  currentFiles: readonly HashedRepositoryFile[];
  persistedFiles: readonly PersistedRepositoryFile[];
}): IncrementalIndexingPlan {
  const currentByPath = uniqueByPath(
    input.currentFiles,
    (value) => value.file.relativePath,
    "Current repository files",
  );
  const persistedByPath = uniqueByPath(
    input.persistedFiles,
    (value) => value.filePath,
    "Persisted repository files",
  );
  const legacyMetadata = input.persistedFiles.some(
    (file) => file.chunkCount === undefined,
  );
  const mode: IncrementalIndexingMode =
    input.lastIndexedCommit === undefined || legacyMetadata
      ? "full"
      : "incremental";
  const changedFiles: ScannedRepositoryFile[] = [];
  const retainedFiles: PersistedRepositoryFile[] = [];
  const expectedHashes = new Map<string, string>();

  for (const current of input.currentFiles) {
    const filePath = current.file.relativePath;
    const persisted = persistedByPath.get(filePath);
    expectedHashes.set(filePath, current.contentHash);
    if (
      mode === "full" ||
      persisted === undefined ||
      persisted.contentHash !== current.contentHash
    ) {
      changedFiles.push(current.file);
    } else {
      retainedFiles.push(persisted);
    }
  }

  return {
    mode,
    changedFiles,
    retainedFiles,
    removedFilePaths: [...persistedByPath.keys()].filter(
      (filePath) => !currentByPath.has(filePath),
    ),
    expectedHashes,
  };
}

export function summarizeIncrementalIndexingPlan(
  plan: IncrementalIndexingPlan,
  indexedFiles: readonly PersistedFileSummary[],
): IncrementalIndexingStats {
  const indexedByPath = uniqueByPath(
    indexedFiles,
    (value) => value.filePath,
    "Indexed repository files",
  );
  if (indexedByPath.size !== plan.changedFiles.length) {
    throw new Error("Changed repository file summaries are incomplete");
  }

  for (const changed of plan.changedFiles) {
    const summary = indexedByPath.get(changed.relativePath);
    const expectedHash = plan.expectedHashes.get(changed.relativePath);
    if (!summary || summary.contentHash !== expectedHash) {
      throw new Error(
        `Changed repository file ${changed.relativePath} was not indexed consistently`,
      );
    }
  }

  const languages = new Map<string, number>();
  let totalChunks = 0;
  for (const file of [...plan.retainedFiles, ...indexedFiles]) {
    const chunkCount = file.chunkCount;
    if (chunkCount === undefined) {
      throw new Error(`Repository file ${file.filePath} has no chunk count`);
    }
    totalChunks += chunkCount;
    languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
  }

  return {
    totalFiles: plan.retainedFiles.length + indexedFiles.length,
    totalChunks,
    languages,
  };
}
