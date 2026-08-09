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

export const defaultOllamaUrl = "http://localhost:11434";
export const defaultOllamaEmbeddingModel = "qwen3-embedding:0.6b";
export const defaultOllamaEmbeddingDimensions = 1_024;
export const defaultOllamaChatModel = "qwen2.5-coder:3b";
export const defaultOllamaRequestTimeoutMs = 300_000;
export const defaultOllamaKeepAlive = "10m";

export type OllamaProviderConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  keepAlive?: string;
  fetchImplementation?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AIProviderError(
      "ollama",
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

function createAbortError(): Error {
  const error = new Error("Ollama request was cancelled");
  error.name = "AbortError";
  return error;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function responseErrorMessage(payload: unknown, fallback: string): string {
  const message = asJsonObject(payload)?.error;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : fallback;
}

function classifyHttpError(
  statusCode: number,
  payload: unknown,
  model: string,
): AIProviderError {
  if (statusCode === 404) {
    return new AIProviderError(
      "ollama",
      "MODEL_NOT_FOUND",
      `Ollama model "${model}" is not installed. Run: ollama pull ${model}`,
      false,
      statusCode,
    );
  }
  if (statusCode === 408) {
    return new AIProviderError(
      "ollama",
      "TIMEOUT",
      "The local Ollama request timed out.",
      true,
      statusCode,
    );
  }
  if (statusCode === 429 || statusCode >= 500) {
    return new AIProviderError(
      "ollama",
      statusCode === 429 ? "RATE_LIMITED" : "UNAVAILABLE",
      responseErrorMessage(payload, "The local Ollama service is temporarily unavailable."),
      true,
      statusCode,
    );
  }
  return new AIProviderError(
    "ollama",
    statusCode === 401 || statusCode === 403
      ? "AUTHENTICATION_FAILED"
      : "REQUEST_REJECTED",
    responseErrorMessage(
      payload,
      "Ollama rejected the request. Check the model and dimension settings.",
    ),
    false,
    statusCode,
  );
}

class OllamaHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(config: OllamaProviderConfig = {}) {
    const configuredUrl = (config.baseUrl ?? defaultOllamaUrl).trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(configuredUrl);
    } catch (cause) {
      throw new AIProviderError(
        "ollama",
        "INVALID_CONFIGURATION",
        "OLLAMA_URL must be a valid HTTP or HTTPS URL",
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
        "ollama",
        "INVALID_CONFIGURATION",
        "OLLAMA_URL must use HTTP or HTTPS without embedded credentials",
        false,
      );
    }

    this.baseUrl = parsedUrl.toString().replace(/\/$/u, "");
    this.timeoutMs = config.timeoutMs ?? defaultOllamaRequestTimeoutMs;
    assertPositiveInteger(this.timeoutMs, "OLLAMA_REQUEST_TIMEOUT_MS");
    this.keepAlive = (config.keepAlive ?? defaultOllamaKeepAlive).trim();
    if (!this.keepAlive || this.keepAlive.includes("\0")) {
      throw new AIProviderError(
        "ollama",
        "INVALID_CONFIGURATION",
        "OLLAMA_KEEP_ALIVE must be a non-empty safe value",
        false,
      );
    }
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  async post(
    endpoint: "/api/embed" | "/api/chat",
    model: string,
    body: JsonObject,
    externalSignal: AbortSignal | undefined,
  ): Promise<JsonObject> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("Ollama request timeout")),
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, model, keep_alive: this.keepAlive }),
          signal,
        },
      );
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = responseText ? JSON.parse(responseText) : undefined;
      } catch (cause) {
        throw new AIProviderError(
          "ollama",
          "INVALID_RESPONSE",
          "Ollama returned a response that was not valid JSON.",
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
          "ollama",
          "INVALID_RESPONSE",
          "Ollama returned an invalid response body.",
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
          "ollama",
          "TIMEOUT",
          `Ollama did not respond within ${this.timeoutMs}ms.`,
          true,
          undefined,
          { cause },
        );
      }
      throw new AIProviderError(
        "ollama",
        "UNAVAILABLE",
        `Ollama is not reachable at ${this.baseUrl}. Start Ollama and retry.`,
        true,
        undefined,
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OllamaHttpClient;

  constructor(config: OllamaProviderConfig = {}) {
    this.client = new OllamaHttpClient(config);
  }

  async createEmbeddings(
    request: EmbeddingProviderRequest,
    options: EmbeddingProviderRequestOptions = {},
  ): Promise<EmbeddingProviderResponse> {
    const response = await this.client.post(
      "/api/embed",
      request.model,
      {
        input: request.input,
        dimensions: request.dimensions,
        truncate: false,
      },
      options.signal,
    );
    const embeddings = response.embeddings;
    if (!Array.isArray(embeddings)) {
      throw new AIProviderError(
        "ollama",
        "INVALID_RESPONSE",
        "Ollama embedding response did not include vectors.",
        false,
      );
    }
    const model = response.model;
    if (typeof model !== "string" || !model.trim()) {
      throw new AIProviderError(
        "ollama",
        "INVALID_RESPONSE",
        "Ollama embedding response did not include a model.",
        false,
      );
    }
    const promptTokens = response.prompt_eval_count ?? 0;
    if (
      typeof promptTokens !== "number" ||
      !Number.isSafeInteger(promptTokens) ||
      promptTokens < 0
    ) {
      throw new AIProviderError(
        "ollama",
        "INVALID_RESPONSE",
        "Ollama embedding response included invalid token usage.",
        false,
      );
    }

    const parsedEmbeddings = embeddings.map((embedding) => {
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        embedding.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
      ) {
        throw new AIProviderError(
          "ollama",
          "INVALID_RESPONSE",
          "Ollama embedding response included an invalid vector.",
          false,
        );
      }
      return embedding as number[];
    });

    return {
      data: parsedEmbeddings.map((embedding, index) => ({
        embedding: [...embedding],
        index,
      })),
      model,
      usage: { promptTokens, totalTokens: promptTokens },
    };
  }
}

export class OllamaAnswerProvider implements AnswerProvider {
  private readonly client: OllamaHttpClient;

  constructor(config: OllamaProviderConfig = {}) {
    this.client = new OllamaHttpClient(config);
  }

  async createAnswer(
    request: AnswerProviderRequest,
    options: AnswerProviderRequestOptions = {},
  ): Promise<AnswerProviderResponse> {
    const response = await this.client.post(
      "/api/chat",
      request.model,
      {
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
        format: request.outputSchema,
        stream: false,
        options: { temperature: 0, num_predict: request.maxOutputTokens },
      },
      options.signal,
    );
    const message = asJsonObject(response.message);
    const outputText = message?.content;
    const model = response.model;
    const done = response.done;
    if (
      typeof outputText !== "string" ||
      typeof model !== "string" ||
      !model.trim() ||
      typeof done !== "boolean"
    ) {
      throw new AIProviderError(
        "ollama",
        "INVALID_RESPONSE",
        "Ollama chat response is missing required fields.",
        false,
      );
    }
    const inputTokens = Number(response.prompt_eval_count ?? 0);
    const outputTokens = Number(response.eval_count ?? 0);
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    ) {
      throw new AIProviderError(
        "ollama",
        "INVALID_RESPONSE",
        "Ollama chat response included invalid token usage.",
        false,
      );
    }

    return {
      responseId: `ollama-${randomUUID()}`,
      outputText,
      model,
      status: done ? "completed" : "incomplete",
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}

function providerConfigFromEnv(
  environment: NodeJS.ProcessEnv,
): OllamaProviderConfig {
  return {
    baseUrl: environment.OLLAMA_URL?.trim() || defaultOllamaUrl,
    timeoutMs: readPositiveInteger(
      environment,
      "OLLAMA_REQUEST_TIMEOUT_MS",
      defaultOllamaRequestTimeoutMs,
    ),
    keepAlive: environment.OLLAMA_KEEP_ALIVE?.trim() || defaultOllamaKeepAlive,
  };
}

export function createOllamaEmbeddingGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingGenerator {
  return new EmbeddingGenerator(
    new OllamaEmbeddingProvider(providerConfigFromEnv(environment)),
    new Cl100kEmbeddingTokenCounter(),
    {
      model:
        environment.OLLAMA_EMBEDDING_MODEL?.trim() ||
        defaultOllamaEmbeddingModel,
      dimensions: readPositiveInteger(
        environment,
        "OLLAMA_EMBEDDING_DIMENSIONS",
        defaultOllamaEmbeddingDimensions,
      ),
      batchSize: readPositiveInteger(
        environment,
        "OLLAMA_EMBEDDING_BATCH_SIZE",
        16,
      ),
      requestConcurrency: readPositiveInteger(
        environment,
        "OLLAMA_EMBEDDING_REQUEST_CONCURRENCY",
        1,
      ),
      maxInputTokens: readPositiveInteger(
        environment,
        "OLLAMA_EMBEDDING_MAX_INPUT_TOKENS",
        8_192,
      ),
      maxRequestTokens: readPositiveInteger(
        environment,
        "OLLAMA_EMBEDDING_MAX_REQUEST_TOKENS",
        65_536,
      ),
    },
  );
}

export function createOllamaRepositoryAnswerGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryAnswerGenerator {
  return new RepositoryAnswerGenerator(
    new OllamaAnswerProvider(providerConfigFromEnv(environment)),
    {
      model: environment.OLLAMA_CHAT_MODEL?.trim() || defaultOllamaChatModel,
      maxOutputTokens: readPositiveInteger(
        environment,
        "OLLAMA_ANSWER_MAX_OUTPUT_TOKENS",
        2_000,
      ),
      maxContextCharacters: readPositiveInteger(
        environment,
        "OLLAMA_MAX_CONTEXT_CHARACTERS",
        60_000,
      ),
      maxHistoryCharacters: readPositiveInteger(
        environment,
        "OLLAMA_MAX_HISTORY_CHARACTERS",
        12_000,
      ),
    },
  );
}
