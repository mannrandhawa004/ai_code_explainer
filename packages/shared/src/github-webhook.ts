export const githubWebhookQueueName = "github-webhooks";
export const githubWebhookJobName = "process-github-webhook";

type GitHubWebhookJobBase = {
  deliveryId: string;
  payloadSha256: string;
  receivedAt: string;
};

export type GitHubPushWebhookJobData = GitHubWebhookJobBase & {
  kind: "push";
  installationId: number;
  githubRepositoryId: number;
  owner: string;
  repository: string;
  fullName: string;
  repositoryUrl: string;
  private: boolean;
  defaultBranch: string;
  branch: string;
  commitSha: string;
};

export type GitHubInstallationRevokedWebhookJobData = GitHubWebhookJobBase & {
  kind: "installation_revoked";
  installationId: number;
};

export type GitHubRepositoriesRevokedWebhookJobData = GitHubWebhookJobBase & {
  kind: "repositories_revoked";
  installationId: number;
  githubRepositoryIds: number[];
};

export type GitHubWebhookJobData =
  | GitHubPushWebhookJobData
  | GitHubInstallationRevokedWebhookJobData
  | GitHubRepositoriesRevokedWebhookJobData;

export type GitHubWebhookJobResult = {
  deliveryId: string;
  kind: GitHubWebhookJobData["kind"];
  matchedRepositories: number;
  queuedRepositories: number;
  deduplicatedRepositories: number;
  revokedRepositories: number;
};

const deliveryIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40,64}$/u;
const ownerPattern = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/u;
const baseKeys = new Set(["kind", "deliveryId", "payloadSha256", "receivedAt"]);

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

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set([...baseKeys, ...keys]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseBase(value: Record<string, unknown>): GitHubWebhookJobBase {
  if (
    typeof value.deliveryId !== "string" ||
    !deliveryIdPattern.test(value.deliveryId) ||
    typeof value.payloadSha256 !== "string" ||
    !sha256Pattern.test(value.payloadSha256) ||
    !isSafeString(value.receivedAt, 64) ||
    Number.isNaN(Date.parse(value.receivedAt)) ||
    new Date(value.receivedAt).toISOString() !== value.receivedAt
  ) {
    throw new TypeError("GitHub webhook job data is invalid");
  }
  return {
    deliveryId: value.deliveryId,
    payloadSha256: value.payloadSha256,
    receivedAt: value.receivedAt,
  };
}

export function parseGitHubWebhookJobData(value: unknown): GitHubWebhookJobData {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("GitHub webhook job data is invalid");
  }
  const base = parseBase(value);

  if (value.kind === "installation_revoked") {
    if (
      !hasOnlyKeys(value, ["installationId"]) ||
      !isPositiveSafeInteger(value.installationId)
    ) {
      throw new TypeError("GitHub webhook job data is invalid");
    }
    return { ...base, kind: value.kind, installationId: value.installationId };
  }

  if (value.kind === "repositories_revoked") {
    if (
      !hasOnlyKeys(value, ["installationId", "githubRepositoryIds"]) ||
      !isPositiveSafeInteger(value.installationId) ||
      !Array.isArray(value.githubRepositoryIds) ||
      value.githubRepositoryIds.length === 0 ||
      value.githubRepositoryIds.length > 1_000 ||
      !value.githubRepositoryIds.every(isPositiveSafeInteger) ||
      new Set(value.githubRepositoryIds).size !== value.githubRepositoryIds.length
    ) {
      throw new TypeError("GitHub webhook job data is invalid");
    }
    return {
      ...base,
      kind: value.kind,
      installationId: value.installationId,
      githubRepositoryIds: value.githubRepositoryIds,
    };
  }

  if (value.kind === "push") {
    if (
      !hasOnlyKeys(value, [
        "installationId",
        "githubRepositoryId",
        "owner",
        "repository",
        "fullName",
        "repositoryUrl",
        "private",
        "defaultBranch",
        "branch",
        "commitSha",
      ]) ||
      !isPositiveSafeInteger(value.installationId) ||
      !isPositiveSafeInteger(value.githubRepositoryId) ||
      !isSafeString(value.owner, 39) ||
      !ownerPattern.test(value.owner) ||
      !isSafeString(value.repository, 100) ||
      !repositoryPattern.test(value.repository) ||
      value.repository === "." ||
      value.repository === ".." ||
      !isSafeString(value.fullName, 140) ||
      value.fullName.toLowerCase() !==
        `${value.owner}/${value.repository}`.toLowerCase() ||
      !isSafeString(value.repositoryUrl, 2_048) ||
      value.repositoryUrl.toLowerCase() !==
        `https://github.com/${value.fullName}`.toLowerCase() ||
      typeof value.private !== "boolean" ||
      !isSafeString(value.defaultBranch, 255) ||
      !isSafeString(value.branch, 255) ||
      typeof value.commitSha !== "string" ||
      !commitPattern.test(value.commitSha)
    ) {
      throw new TypeError("GitHub webhook job data is invalid");
    }
    return {
      ...base,
      kind: value.kind,
      installationId: value.installationId,
      githubRepositoryId: value.githubRepositoryId,
      owner: value.owner,
      repository: value.repository,
      fullName: value.fullName,
      repositoryUrl: value.repositoryUrl,
      private: value.private,
      defaultBranch: value.defaultBranch,
      branch: value.branch,
      commitSha: value.commitSha,
    };
  }

  throw new TypeError("GitHub webhook job data is invalid");
}
