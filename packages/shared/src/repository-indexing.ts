export const indexingQueueName = "repository-indexing";
export const indexingJobName = "index-repository";

export const indexingSteps = [
  "queued",
  "cloning",
  "scanning",
  "chunking",
  "embedding",
  "indexing",
  "completed",
] as const;

export type IndexingJobStep = (typeof indexingSteps)[number];

export type RepositoryIndexingJobData = {
  repositoryId: string;
  userId: string;
  repositoryUrl: string;
  requestedAt: string;
  branch?: string;
};

export type RepositoryIndexingJobProgress = {
  percentage: number;
  step: IndexingJobStep;
  message: string;
};

export type RepositoryIndexingJobResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  filesIndexed: number;
  chunksIndexed: number;
  embeddingModel: string;
  embeddingTokens: number;
};

const objectIdPattern = /^[0-9a-f]{24}$/u;
const allowedKeys = new Set([
  "repositoryId",
  "userId",
  "repositoryUrl",
  "requestedAt",
  "branch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

export function parseRepositoryIndexingJobData(
  value: unknown,
): RepositoryIndexingJobData {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.repositoryId !== "string" ||
    !objectIdPattern.test(value.repositoryId) ||
    typeof value.userId !== "string" ||
    !objectIdPattern.test(value.userId) ||
    !isSafeString(value.repositoryUrl, 2_048) ||
    !isSafeString(value.requestedAt, 64) ||
    Number.isNaN(Date.parse(value.requestedAt)) ||
    new Date(value.requestedAt).toISOString() !== value.requestedAt ||
    (value.branch !== undefined && !isSafeString(value.branch, 255))
  ) {
    throw new TypeError("Repository indexing job data is invalid");
  }

  return {
    repositoryId: value.repositoryId,
    userId: value.userId,
    repositoryUrl: value.repositoryUrl,
    requestedAt: value.requestedAt,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
  };
}
