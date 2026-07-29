import type { CodeChunk } from "@codebase-explainer/repository";

export type CodeChunkEmbeddingTextOptions = {
  repositoryLabel?: string;
};

export class EmbeddingTextFormatError extends Error {
  override readonly name = "EmbeddingTextFormatError";
}

function toSingleLine(value: string, fieldName: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();

  if (!normalized || normalized.includes("\0")) {
    throw new EmbeddingTextFormatError(
      `${fieldName} must be a non-empty safe string`,
    );
  }

  return normalized;
}

function formatList(values: readonly string[], fieldName: string): string[] {
  if (values.length === 0) {
    return ["(none)"];
  }

  return values.map((value) => `- ${toSingleLine(value, fieldName)}`);
}

export function formatCodeChunkForEmbedding(
  chunk: CodeChunk,
  options: CodeChunkEmbeddingTextOptions = {},
): string {
  if (
    !Number.isSafeInteger(chunk.startLine) ||
    !Number.isSafeInteger(chunk.endLine) ||
    chunk.startLine <= 0 ||
    chunk.endLine < chunk.startLine
  ) {
    throw new EmbeddingTextFormatError(
      "Chunk line metadata must be a valid one-based inclusive range",
    );
  }

  const repositoryId = toSingleLine(chunk.repositoryId, "repositoryId");
  const repositoryLabel = toSingleLine(
    options.repositoryLabel ?? repositoryId,
    "repositoryLabel",
  );
  const lines = [
    `Repository: ${repositoryLabel}`,
    ...(repositoryLabel === repositoryId
      ? []
      : [`Repository ID: ${repositoryId}`]),
    `Branch: ${toSingleLine(chunk.branch, "branch")}`,
    `Commit: ${toSingleLine(chunk.commitSha, "commitSha")}`,
    `File: ${toSingleLine(chunk.filePath, "filePath")}`,
    `Language: ${toSingleLine(chunk.language, "language")}`,
  ];

  if (chunk.symbolType !== undefined) {
    lines.push(`Symbol type: ${toSingleLine(chunk.symbolType, "symbolType")}`);
  }

  if (chunk.symbolName !== undefined) {
    lines.push(`Symbol name: ${toSingleLine(chunk.symbolName, "symbolName")}`);
  }

  lines.push(
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
    "",
    "Imports:",
    ...formatList(chunk.imports, "import"),
    "",
    "Exports:",
    ...formatList(chunk.exports, "export"),
    "",
    "Code:",
    chunk.content,
  );

  return lines.join("\n");
}
