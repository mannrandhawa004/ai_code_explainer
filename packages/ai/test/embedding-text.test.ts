import type { CodeChunk } from "@codebase-explainer/repository";
import { describe, expect, it } from "vitest";

import {
  EmbeddingTextFormatError,
  formatCodeChunkForEmbedding,
} from "../src/index.js";

const chunk: CodeChunk = {
  id: "chunk-1",
  userId: "user-1",
  repositoryId: "repository-1",
  branch: "main",
  commitSha: "abc123",
  filePath: "src/controllers/user.controller.ts",
  language: "typescript",
  symbolType: "function",
  symbolName: "createUser",
  startLine: 12,
  endLine: 17,
  chunkIndex: 0,
  content: "export const createUser = async () => {};",
  contentHash: "content-hash",
  imports: ["User from ../models/user.model"],
  exports: ["createUser"],
};

describe("formatCodeChunkForEmbedding", () => {
  it("adds structured repository, symbol, source, and relationship metadata", () => {
    expect(
      formatCodeChunkForEmbedding(chunk, {
        repositoryLabel: "mann/task-flow",
      }),
    ).toBe(`Repository: mann/task-flow
Repository ID: repository-1
Branch: main
Commit: abc123
File: src/controllers/user.controller.ts
Language: typescript
Symbol type: function
Symbol name: createUser
Lines: 12-17

Imports:
- User from ../models/user.model

Exports:
- createUser

Code:
export const createUser = async () => {};`);
  });

  it("uses the repository ID and explicit empty lists for line chunks", () => {
    const lineChunk: CodeChunk = {
      id: chunk.id,
      userId: chunk.userId,
      repositoryId: chunk.repositoryId,
      branch: chunk.branch,
      commitSha: chunk.commitSha,
      filePath: chunk.filePath,
      language: chunk.language,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      contentHash: chunk.contentHash,
      imports: [],
      exports: [],
    };
    const text = formatCodeChunkForEmbedding(lineChunk);

    expect(text).toContain("Repository: repository-1");
    expect(text).not.toContain("Repository ID:");
    expect(text).not.toContain("Symbol type:");
    expect(text).toContain("Imports:\n(none)\n\nExports:\n(none)");
  });

  it("keeps code formatting but normalizes metadata to single lines", () => {
    const text = formatCodeChunkForEmbedding({
      ...chunk,
      branch: "feature\nunsafe-header",
      content: "first\n  second",
    });

    expect(text).toContain("Branch: feature unsafe-header");
    expect(text).toContain("Code:\nfirst\n  second");
  });

  it("rejects invalid line ranges and unsafe metadata", () => {
    expect(() =>
      formatCodeChunkForEmbedding({ ...chunk, startLine: 0 }),
    ).toThrowError(EmbeddingTextFormatError);
    expect(() =>
      formatCodeChunkForEmbedding(chunk, { repositoryLabel: "  " }),
    ).toThrowError(EmbeddingTextFormatError);
  });
});
