type ApiErrorPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
  };
};

export class ApiError extends Error {
  override readonly name = "ApiError";

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

export function apiBaseUrl(): URL {
  const configured =
    process.env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:5000";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new ApiError(
      0,
      "INVALID_API_CONFIGURATION",
      "The web application API URL is invalid.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(
      0,
      "INVALID_API_CONFIGURATION",
      "The web application API URL must use HTTP or HTTPS.",
    );
  }
  return url;
}

export function apiUrl(path: string): string {
  return new URL(path, apiBaseUrl()).toString();
}

export function githubSignInUrl(): string {
  return apiUrl("/api/auth/github");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const payload = response.status === 204 ? undefined : await readJson(response);

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? (payload as ApiErrorPayload) : {};
    throw new ApiError(
      response.status,
      typeof errorPayload.error?.code === "string"
        ? errorPayload.error.code
        : "REQUEST_FAILED",
      typeof errorPayload.error?.message === "string"
        ? errorPayload.error.message
        : "The request could not be completed.",
      typeof errorPayload.error?.requestId === "string"
        ? errorPayload.error.requestId
        : undefined,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  if (!isRecord(payload) || !("data" in payload)) {
    throw new ApiError(
      502,
      "INVALID_API_RESPONSE",
      "The API returned an invalid response.",
    );
  }
  return payload.data as T;
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === "AUTHENTICATION_REQUIRED") {
      return "Your session has expired. Sign in with GitHub to continue.";
    }
    if (error.code === "INDEXING_QUEUE_UNAVAILABLE") {
      return "The indexing worker is unavailable. Start the worker and try again.";
    }
    if (error.code === "PRIVATE_REPOSITORY_UNSUPPORTED") {
      return "This URL is private. Import it from your connected GitHub repositories instead.";
    }
    return error.message;
  }
  if (error instanceof TypeError) {
    return "The API could not be reached. Check that the backend is running and try again.";
  }
  return fallback;
}
