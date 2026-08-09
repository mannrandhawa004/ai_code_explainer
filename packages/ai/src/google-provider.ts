import { randomUUID } from "node:crypto";

import {
  Cl100kEmbeddingTokenCounter,
  EmbeddingGenerator,
  type EmbeddingProvider,
  type EmbeddingProviderRequest,
  type EmbeddingProviderRequestOptions,
  type EmbeddingProviderResponse,
} from "./embedding-generator.js";
import { AIProviderError } from "./provider-error.js";
import {
  RepositoryAnswerGenerator,
  type AnswerProvider,
  type AnswerProviderRequest,
  type AnswerProviderRequestOptions,
  type AnswerProviderResponse,
} from "./repository-answer-generator.js";

export const defaultGoogleApiBaseUrl =
  "https://generativelanguage.googleapis.com/v1beta";
export const defaultGoogleEmbeddingModel = "gemini-embedding-2";
export const defaultGoogleEmbeddingDimensions = 768;
export const defaultGoogleChatModel = "gemini-2.5-flash-lite";
export const defaultGoogleRequestTimeoutMs = 120_000;

export type GoogleEmbeddingPurpose = "document" | "query";

export type GoogleProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

export type GoogleEmbeddingProviderConfig = GoogleProviderConfig & {
  purpose?: GoogleEmbeddingPurpose;
};

type JsonObject = Record<string, unknown>;

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AIProviderError(
      "google",
      "INVALID_CONFIGURATION",
      `${fieldName} must be a positive integer`,
      false,
    );
  }
}

function readPositiveInteger(
  environment: NodeJS.ProcessEnv,
  fieldName: string,
  fallback: number,
): number {
  const raw = environment[fieldName];
  if (raw === undefined || !raw.trim()) {
    return fallback;
  }
  const parsed = Number(raw);
  assertPositiveInteger(parsed, fieldName);
  return parsed;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function googleErrorDetails(payload: unknown): JsonObject | undefined {
  return asJsonObject(asJsonObject(payload)?.error);
}

function safeErrorMessage(payload: unknown, fallback: string): string {
  const message = googleErrorDetails(payload)?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : fallback;
}

function classifyHttpError(
  statusCode: number,
  payload: unknown,
  model: string,
): AIProviderError {
  const details = googleErrorDetails(payload);
  const providerStatus =
    typeof details?.status === "string" ? details.status.toUpperCase() : "";
  const providerMessage = safeErrorMessage(payload, "");
  const authenticationFailure =
    statusCode === 401 ||
    statusCode === 403 ||
    providerStatus === "PERMISSION_DENIED" ||
    /api key(?: not valid| invalid)|api_key_invalid/iu.test(providerMessage);

  if (authenticationFailure) {
    return new AIProviderError(
      "google",
      "AUTHENTICATION_FAILED",
      "Google AI authentication failed. Check GOOGLE_API_KEY or GEMINI_API_KEY and confirm that the Gemini API is enabled.",
      false,
      statusCode,
    );
  }
  if (statusCode === 404 || providerStatus === "NOT_FOUND") {
    return new AIProviderError(
      "google",
      "MODEL_NOT_FOUND",
      `Google AI model "${model}" is unavailable for this API key or region.`,
      false,
      statusCode,
    );
  }
  if (statusCode === 408 || statusCode === 504) {
    return new AIProviderError(
      "google",
      "TIMEOUT",
      "The Google AI request timed out.",
      true,
      statusCode,
    );
  }
  if (statusCode === 429 || providerStatus === "RESOURCE_EXHAUSTED") {
    return new AIProviderError(
      "google",
      "RATE_LIMITED",
      "Google AI free-tier rate limit or quota was reached. Wait for the quota window to reset, then retry.",
      true,
      statusCode,
    );
  }
  if (statusCode >= 500) {
    return new AIProviderError(
      "google",
      "UNAVAILABLE",
      "Google AI is temporarily unavailable.",
      true,
      statusCode,
    );
  }
  return new AIProviderError(
    "google",
    "REQUEST_REJECTED",
    safeErrorMessage(
      payload,
      "Google AI rejected the request. Check the selected model and embedding dimensions.",
    ),
    false,
    statusCode,
  );
}

function createAbortError(): Error {
  const error = new Error("Google AI request was cancelled");
  error.name = "AbortError";
  return error;
}

class GoogleHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(config: GoogleProviderConfig) {
    this.apiKey = config.apiKey.trim();
    if (!this.apiKey || this.apiKey.includes("\0")) {
      throw new AIProviderError(
        "google",
        "INVALID_CONFIGURATION",
        "GOOGLE_API_KEY or GEMINI_API_KEY is required for Google AI",
        false,
      );
    }

    const configuredUrl = (config.baseUrl ?? defaultGoogleApiBaseUrl).trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(configuredUrl);
    } catch (cause) {
      throw new AIProviderError(
        "google",
        "INVALID_CONFIGURATION",
        "GOOGLE_API_BASE_URL must be a valid HTTP or HTTPS URL",
        false,
        undefined,
        { cause },
      );
    }
    if (
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new AIProviderError(
        "google",
        "INVALID_CONFIGURATION",
        "GOOGLE_API_BASE_URL must use HTTP or HTTPS without embedded credentials",
        false,
      );
    }

    this.baseUrl = parsedUrl.toString().replace(/\/$/u, "");
    this.timeoutMs = config.timeoutMs ?? defaultGoogleRequestTimeoutMs;
    assertPositiveInteger(this.timeoutMs, "GOOGLE_REQUEST_TIMEOUT_MS");
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  async post(
    endpoint: string,
    model: string,
    body: JsonObject,
    externalSignal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("Google AI request timeout")),
      this.timeoutMs,
    );
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}${endpoint}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify(body),
          signal,
        },
      );
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = responseText ? JSON.parse(responseText) : undefined;
      } catch (cause) {
        throw new AIProviderError(
          "google",
          "INVALID_RESPONSE",
          "Google AI returned a response that was not valid JSON.",
          false,
          response.status,
          { cause },
        );
      }
      if (!response.ok) {
        throw classifyHttpError(response.status, payload, model);
      }
      const object = asJsonObject(payload);
      if (object === undefined) {
        throw new AIProviderError(
          "google",
          "INVALID_RESPONSE",
          "Google AI returned an invalid response body.",
          false,
          response.status,
        );
      }
      return object;
    } catch (cause) {
      if (externalSignal?.aborted) {
        throw createAbortError();
      }
      if (cause instanceof AIProviderError) {
        throw cause;
      }
      if (timeoutController.signal.aborted) {
        throw new AIProviderError(
          "google",
          "TIMEOUT",
          `Google AI did not respond within ${this.timeoutMs}ms.`,
          true,
          undefined,
          { cause },
        );
      }
      throw new AIProviderError(
        "google",
        "UNAVAILABLE",
        "Google AI is not reachable. Check the internet connection and retry.",
        true,
        undefined,
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function formatEmbeddingInput(
  text: string,
  purpose: GoogleEmbeddingPurpose,
): string {
  return purpose === "query"
    ? `task: code retrieval | query: ${text}`
    : `title: repository code | text: ${text}`;
}

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  private readonly client: GoogleHttpClient;
  private readonly purpose: GoogleEmbeddingPurpose;
  private readonly tokenCounter = new Cl100kEmbeddingTokenCounter();

  constructor(config: GoogleEmbeddingProviderConfig) {
    this.client = new GoogleHttpClient(config);
    this.purpose = config.purpose ?? "document";
  }

  async createEmbeddings(
    request: EmbeddingProviderRequest,
    options: EmbeddingProviderRequestOptions = {},
  ): Promise<EmbeddingProviderResponse> {
    const formattedInputs = request.input.map((text) =>
      formatEmbeddingInput(text, this.purpose),
    );
    const response = await this.client.post(
      `/models/${encodeURIComponent(request.model)}:batchEmbedContents`,
      request.model,
      {
        requests: formattedInputs.map((text) => ({
          model: `models/${request.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: request.dimensions,
        })),
      },
      options.signal,
    );
    const embeddings = response.embeddings;
    if (!Array.isArray(embeddings)) {
      throw new AIProviderError(
        "google",
        "INVALID_RESPONSE",
        "Google AI embedding response did not include vectors.",
        false,
      );
    }

    const parsedEmbeddings = embeddings.map((value) => {
      const vector = asJsonObject(value)?.values;
      if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.some(
          (component) =>
            typeof component !== "number" || !Number.isFinite(component),
        )
      ) {
        throw new AIProviderError(
          "google",
          "INVALID_RESPONSE",
          "Google AI embedding response included an invalid vector.",
          false,
        );
      }
      return vector as number[];
    });
    const promptTokens = formattedInputs.reduce(
      (total, text) => total + this.tokenCounter.count(text),
      0,
    );

    return {
      data: parsedEmbeddings.map((embedding, index) => ({
        embedding: [...embedding],
        index,
      })),
      model: request.model,
      usage: { promptTokens, totalTokens: promptTokens },
    };
  }
}

function readTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export class GoogleAnswerProvider implements AnswerProvider {
  private readonly client: GoogleHttpClient;

  constructor(config: GoogleProviderConfig) {
    this.client = new GoogleHttpClient(config);
  }

  async createAnswer(
    request: AnswerProviderRequest,
    options: AnswerProviderRequestOptions = {},
  ): Promise<AnswerProviderResponse> {
    const response = await this.client.post(
      `/models/${encodeURIComponent(request.model)}:generateContent`,
      request.model,
      {
        system_instruction: { parts: [{ text: request.instructions }] },
        contents: [{ role: "user", parts: [{ text: request.input }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: request.outputSchema,
        },
      },
      options.signal,
    );
    const candidate = Array.isArray(response.candidates)
      ? asJsonObject(response.candidates[0])
      : undefined;
    const content = asJsonObject(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const outputText = parts
      .map((part) => asJsonObject(part))
      .filter((part) => part?.thought !== true)
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    const finishReason =
      typeof candidate?.finishReason === "string"
        ? candidate.finishReason
        : undefined;
    const usage = asJsonObject(response.usageMetadata);
    const inputTokens = readTokenCount(usage?.promptTokenCount);
    const outputTokens = readTokenCount(usage?.candidatesTokenCount);
    const reasoningTokens = readTokenCount(usage?.thoughtsTokenCount);
    const reportedTotalTokens = readTokenCount(usage?.totalTokenCount);

    return {
      responseId:
        typeof response.responseId === "string" && response.responseId.trim()
          ? response.responseId
          : `google-${randomUUID()}`,
      outputText,
      model:
        typeof response.modelVersion === "string" && response.modelVersion.trim()
          ? response.modelVersion
          : request.model,
      status: finishReason === "STOP" ? "completed" : "incomplete",
      ...(finishReason === undefined || finishReason === "STOP"
        ? {}
        : { errorMessage: `Google AI finish reason: ${finishReason}` }),
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens:
          reportedTotalTokens ||
          inputTokens + outputTokens + reasoningTokens,
      },
    };
  }
}

function googleApiKey(environment: NodeJS.ProcessEnv): string {
  const apiKey =
    environment.GOOGLE_API_KEY?.trim() ||
    environment.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new AIProviderError(
      "google",
      "INVALID_CONFIGURATION",
      "GOOGLE_API_KEY or GEMINI_API_KEY is required for Google AI",
      false,
    );
  }
  return apiKey;
}

function providerConfigFromEnv(
  environment: NodeJS.ProcessEnv,
): GoogleProviderConfig {
  return {
    apiKey: googleApiKey(environment),
    baseUrl:
      environment.GOOGLE_API_BASE_URL?.trim() || defaultGoogleApiBaseUrl,
    timeoutMs: readPositiveInteger(
      environment,
      "GOOGLE_REQUEST_TIMEOUT_MS",
      defaultGoogleRequestTimeoutMs,
    ),
  };
}

export function createGoogleEmbeddingGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  purpose: GoogleEmbeddingPurpose = "document",
): EmbeddingGenerator {
  const providerConfig = providerConfigFromEnv(environment);
  return new EmbeddingGenerator(
    new GoogleEmbeddingProvider({ ...providerConfig, purpose }),
    new Cl100kEmbeddingTokenCounter(),
    {
      model:
        environment.GOOGLE_EMBEDDING_MODEL?.trim() ||
        defaultGoogleEmbeddingModel,
      dimensions: readPositiveInteger(
        environment,
        "GOOGLE_EMBEDDING_DIMENSIONS",
        defaultGoogleEmbeddingDimensions,
      ),
      batchSize: readPositiveInteger(
        environment,
        "GOOGLE_EMBEDDING_BATCH_SIZE",
        16,
      ),
      requestConcurrency: readPositiveInteger(
        environment,
        "GOOGLE_EMBEDDING_REQUEST_CONCURRENCY",
        1,
      ),
      maxInputTokens: readPositiveInteger(
        environment,
        "GOOGLE_EMBEDDING_MAX_INPUT_TOKENS",
        8_192,
      ),
      maxRequestTokens: readPositiveInteger(
        environment,
        "GOOGLE_EMBEDDING_MAX_REQUEST_TOKENS",
        65_536,
      ),
    },
  );
}

export function createGoogleRepositoryAnswerGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryAnswerGenerator {
  return new RepositoryAnswerGenerator(
    new GoogleAnswerProvider(providerConfigFromEnv(environment)),
    {
      model: environment.GOOGLE_CHAT_MODEL?.trim() || defaultGoogleChatModel,
      maxOutputTokens: readPositiveInteger(
        environment,
        "GOOGLE_ANSWER_MAX_OUTPUT_TOKENS",
        2_000,
      ),
      maxContextCharacters: readPositiveInteger(
        environment,
        "GOOGLE_MAX_CONTEXT_CHARACTERS",
        60_000,
      ),
      maxHistoryCharacters: readPositiveInteger(
        environment,
        "GOOGLE_MAX_HISTORY_CHARACTERS",
        12_000,
      ),
    },
  );
}
