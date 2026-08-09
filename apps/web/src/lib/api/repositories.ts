import { apiRequest } from "./client";

export const repositoryIdPattern = /^[0-9a-f]{24}$/iu;

export type RepositoryStatus =
  | "pending"
  | "queued"
  | "cloning"
  | "scanning"
  | "parsing"
  | "embedding"
  | "indexing"
  | "ready"
  | "failed";

export type RepositoryIndexingResult = {
  repositoryId: string;
  jobId: string;
  status: "queued";
  deduplicated: boolean;
};

export type RepositoryIndexingStatus = {
  repositoryId: string;
  status: RepositoryStatus;
  selectedBranch: string;
  lastIndexedCommit?: string;
  indexedAt?: string;
  errorMessage?: string;
  stats: {
    files: number;
    chunks: number;
  };
  job?: {
    id: string;
    status: "waiting" | "active" | "completed" | "failed" | "cancelled" | "delayed";
    progress: number;
    currentStep?: string;
    errorMessage?: string;
  };
};

export type ImportRepositoryInput = {
  repositoryUrl: string;
  branch?: string;
};

export function importRepository(
  input: ImportRepositoryInput,
): Promise<RepositoryIndexingResult> {
  return apiRequest<RepositoryIndexingResult>("/api/repositories/import", {
    method: "POST",
    body: JSON.stringify({
      repositoryUrl: input.repositoryUrl.trim(),
      ...(input.branch?.trim() ? { branch: input.branch.trim() } : {}),
    }),
  });
}

export function getRepositoryStatus(
  repositoryId: string,
): Promise<RepositoryIndexingStatus> {
  return apiRequest<RepositoryIndexingStatus>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/status`,
  );
}

export function retryRepositoryIndexing(
  repositoryId: string,
): Promise<RepositoryIndexingResult> {
  return apiRequest<RepositoryIndexingResult>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/index`,
    { method: "POST" },
  );
}

export function isRepositoryProcessing(status: RepositoryStatus): boolean {
  return status !== "ready" && status !== "failed";
}

export function repositoryFailureMessage(
  status: RepositoryIndexingStatus,
): string {
  const currentStep = status.job?.currentStep ?? status.status;
  if (currentStep === "embedding") {
    const providerMessage = status.job?.errorMessage ?? status.errorMessage;
    if (
      providerMessage &&
      providerMessage !== "A repository indexing dependency is unavailable"
    ) {
      return providerMessage;
    }
    return "Embedding generation failed. For Google AI, check the server's GOOGLE_API_KEY or GEMINI_API_KEY, API access, and free-tier quota.";
  }
  return (
    status.job?.errorMessage ??
    status.errorMessage ??
    "Repository indexing failed. Check the worker logs, then retry."
  );
}
