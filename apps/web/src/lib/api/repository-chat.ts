export const maximumQuestionCharacters = 4_000;
export { repositoryIdPattern } from "./repositories";
import { repositoryIdPattern } from "./repositories";

export type RepositoryAnswerSource = {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
};

export type AnswerUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type RepositoryQuestionResult = {
  repositoryId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  answer: string;
  sources: RepositoryAnswerSource[];
  category: string;
  branch: string;
  commitSha: string;
  retrievedChunks: number;
  embeddingModel: string;
  model?: string;
  providerResponseId?: string;
  usage: AnswerUsage;
  latencyMs: number;
};

export type AskRepositoryQuestionInput = {
  repositoryId: string;
  question: string;
  conversationId?: string;
  signal?: AbortSignal;
};

type ApiErrorPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
  };
};

export class RepositoryChatApiError extends Error {
  override readonly name = "RepositoryChatApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAnswerSource(value: unknown): value is RepositoryAnswerSource {
  return (
    isRecord(value) &&
    typeof value.filePath === "string" &&
    Number.isSafeInteger(value.startLine) &&
    (value.startLine as number) >= 1 &&
    Number.isSafeInteger(value.endLine) &&
    (value.endLine as number) >= (value.startLine as number) &&
    (value.symbolName === undefined || typeof value.symbolName === "string")
  );
}

function isUsage(value: unknown): value is AnswerUsage {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.inputTokens) &&
    isNonNegativeNumber(value.outputTokens) &&
    isNonNegativeNumber(value.reasoningTokens) &&
    isNonNegativeNumber(value.totalTokens)
  );
}

function parseQuestionResult(value: unknown): RepositoryQuestionResult {
  if (
    !isRecord(value) ||
    typeof value.repositoryId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.userMessageId !== "string" ||
    typeof value.assistantMessageId !== "string" ||
    typeof value.answer !== "string" ||
    !Array.isArray(value.sources) ||
    !value.sources.every(isAnswerSource) ||
    typeof value.category !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.commitSha !== "string" ||
    !isNonNegativeNumber(value.retrievedChunks) ||
    typeof value.embeddingModel !== "string" ||
    (value.model !== undefined && typeof value.model !== "string") ||
    (value.providerResponseId !== undefined &&
      typeof value.providerResponseId !== "string") ||
    !isUsage(value.usage) ||
    !isNonNegativeNumber(value.latencyMs)
  ) {
    throw new RepositoryChatApiError(
      502,
      "INVALID_API_RESPONSE",
      "The repository service returned an invalid response.",
    );
  }

  return value as RepositoryQuestionResult;
}

function apiBaseUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:5000";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new RepositoryChatApiError(
      0,
      "INVALID_API_CONFIGURATION",
      "The web application API URL is invalid.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RepositoryChatApiError(
      0,
      "INVALID_API_CONFIGURATION",
      "The web application API URL must use HTTP or HTTPS.",
    );
  }
  return url.toString();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function askRepositoryQuestion(
  input: AskRepositoryQuestionInput,
): Promise<RepositoryQuestionResult> {
  const question = input.question.trim();
  if (!repositoryIdPattern.test(input.repositoryId)) {
    throw new RepositoryChatApiError(
      400,
      "INVALID_REPOSITORY_ID",
      "Repository ID must be a 24-character identifier.",
    );
  }
  if (!question || question.length > maximumQuestionCharacters) {
    throw new RepositoryChatApiError(
      400,
      "INVALID_QUESTION",
      `Question must be between 1 and ${maximumQuestionCharacters} characters.`,
    );
  }

  const endpoint = new URL(
    `/api/repositories/${encodeURIComponent(input.repositoryId)}/chat`,
    apiBaseUrl(),
  );
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question,
      ...(input.conversationId === undefined
        ? {}
        : { conversationId: input.conversationId }),
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? (payload as ApiErrorPayload) : {};
    const code =
      typeof errorPayload.error?.code === "string"
        ? errorPayload.error.code
        : "REQUEST_FAILED";
    const message =
      typeof errorPayload.error?.message === "string"
        ? errorPayload.error.message
        : "The repository service could not answer this question.";
    const requestId =
      typeof errorPayload.error?.requestId === "string"
        ? errorPayload.error.requestId
        : undefined;
    throw new RepositoryChatApiError(
      response.status,
      code,
      message,
      requestId,
    );
  }

  if (!isRecord(payload) || !("data" in payload)) {
    throw new RepositoryChatApiError(
      502,
      "INVALID_API_RESPONSE",
      "The repository service returned an invalid response.",
    );
  }
  return parseQuestionResult(payload.data);
}

export function repositoryChatErrorMessage(error: unknown): string {
  if (error instanceof RepositoryChatApiError) {
    switch (error.code) {
      case "AUTHENTICATION_REQUIRED":
        return "Sign in is required before you can ask questions about this repository.";
      case "REPOSITORY_NOT_FOUND":
        return "This repository was not found or is not available to your account.";
      case "REPOSITORY_NOT_READY":
        return "This repository is still being indexed. Try again when indexing is complete.";
      case "CONVERSATION_NOT_FOUND":
        return "This conversation is no longer available. Start a new conversation and try again.";
      case "RATE_LIMIT_EXCEEDED":
        return "Too many questions were sent. Wait a moment, then try again.";
      case "QUESTION_SERVICE_UNAVAILABLE":
        return "Repository question answering is not configured on the server yet.";
      default:
        return error.message;
    }
  }
  if (error instanceof TypeError) {
    return "The API could not be reached. Check that the backend is running and try again.";
  }
  return "Something went wrong while answering your question.";
}
