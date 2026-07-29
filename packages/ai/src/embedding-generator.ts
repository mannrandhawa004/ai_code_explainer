import { createHash } from "node:crypto";

import { getEncoding, type Tiktoken } from "js-tiktoken";
import OpenAI, { type ClientOptions } from "openai";
import pLimit from "p-limit";

export const defaultEmbeddingModel = "text-embedding-3-small";
export const defaultEmbeddingDimensions = 1_536;
export const defaultEmbeddingBatchSize = 50;
export const defaultEmbeddingRequestConcurrency = 2;
export const defaultMaxEmbeddingInputTokens = 8_192;
export const defaultMaxEmbeddingRequestTokens = 290_000;
export const maximumOpenAIEmbeddingInputsPerRequest = 2_048;
export const maximumOpenAIEmbeddingTokensPerRequest = 300_000;
export const defaultOpenAIRequestTimeoutMs = 60_000;
export const defaultOpenAIMaxRetries = 3;

export type EmbeddingInput = {
  id: string;
  text: string;
};

export type GeneratedEmbedding = {
  id: string;
  vector: number[];
  model: string;
  dimensions: number;
  tokenCount: number;
  inputHash: string;
};

export type EmbeddingGenerationUsage = {
  promptTokens: number;
  totalTokens: number;
  requests: number;
  uniqueInputs: number;
};

export type EmbeddingGenerationResult = {
  embeddings: GeneratedEmbedding[];
  model: string;
  dimensions: number;
  usage: EmbeddingGenerationUsage;
};

export type EmbeddingGenerationOptions = {
  endUserId?: string;
  signal?: AbortSignal;
};

export type EmbeddingGeneratorConfig = {
  model?: string;
  dimensions?: number;
  batchSize?: number;
  requestConcurrency?: number;
  maxInputTokens?: number;
  maxRequestTokens?: number;
};

export type EmbeddingProviderRequest = {
  model: string;
  input: string[];
  dimensions: number;
  encodingFormat: "float";
  user?: string;
};

export type EmbeddingProviderResponse = {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
};

export type EmbeddingProviderRequestOptions = {
  signal?: AbortSignal;
};

export interface EmbeddingProvider {
  createEmbeddings(
    request: EmbeddingProviderRequest,
    options?: EmbeddingProviderRequestOptions,
  ): Promise<EmbeddingProviderResponse>;
}

export interface EmbeddingTokenCounter {
  count(text: string): number;
}

export type OpenAIEmbeddingProviderConfig = {
  apiKey: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type OpenAIEmbeddingGeneratorConfig = EmbeddingGeneratorConfig &
  OpenAIEmbeddingProviderConfig;

export type EmbeddingGenerationErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "DUPLICATE_INPUT_ID"
  | "INPUT_TOKEN_LIMIT_EXCEEDED"
  | "PROVIDER_ERROR"
  | "RESPONSE_COUNT_MISMATCH"
  | "RESPONSE_INDEX_INVALID"
  | "INVALID_VECTOR"
  | "DIMENSION_MISMATCH"
  | "INCONSISTENT_MODEL_RESPONSE"
  | "EMBEDDING_ABORTED";

export class EmbeddingGenerationError extends Error {
  override readonly name = "EmbeddingGenerationError";

  constructor(
    readonly code: EmbeddingGenerationErrorCode,
    message: string,
    readonly inputId: string | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type PreparedEmbeddingInput = EmbeddingInput & {
  inputHash: string;
  tokenCount: number;
};

type BatchEmbeddingResult = {
  vectors: Array<{
    input: PreparedEmbeddingInput;
    vector: number[];
    model: string;
  }>;
  promptTokens: number;
  totalTokens: number;
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EmbeddingGenerationError(
      "INVALID_CONFIGURATION",
      `${name} must be a positive integer`,
    );
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EmbeddingGenerationError(
      "INVALID_CONFIGURATION",
      `${name} must be a non-negative integer`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EmbeddingGenerationError(
      "EMBEDDING_ABORTED",
      "Embedding generation was cancelled",
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown }).name === "AbortError";
}

function hashEmbeddingInput(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parsePositiveEnvironmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const rawValue = environment[name];

  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number(rawValue);
  assertPositiveInteger(value, name);
  return value;
}

function parseNonNegativeEnvironmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const rawValue = environment[name];

  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number(rawValue);
  assertNonNegativeInteger(value, name);
  return value;
}

export class Cl100kEmbeddingTokenCounter implements EmbeddingTokenCounter {
  private readonly encoding: Tiktoken = getEncoding("cl100k_base");

  count(text: string): number {
    return this.encoding.encode(text).length;
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;

  constructor(config: OpenAIEmbeddingProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new EmbeddingGenerationError(
        "INVALID_CONFIGURATION",
        "OpenAI API key is required",
      );
    }

    const timeoutMs = config.timeoutMs ?? defaultOpenAIRequestTimeoutMs;
    const maxRetries = config.maxRetries ?? defaultOpenAIMaxRetries;
    assertPositiveInteger(timeoutMs, "timeoutMs");
    assertNonNegativeInteger(maxRetries, "maxRetries");

    const clientOptions: ClientOptions = {
      apiKey: config.apiKey.trim(),
      timeout: timeoutMs,
      maxRetries,
    };

    if (config.organization?.trim()) {
      clientOptions.organization = config.organization.trim();
    }

    if (config.project?.trim()) {
      clientOptions.project = config.project.trim();
    }

    this.client = new OpenAI(clientOptions);
  }

  async createEmbeddings(
    request: EmbeddingProviderRequest,
    options: EmbeddingProviderRequestOptions = {},
  ): Promise<EmbeddingProviderResponse> {
    const body = {
      model: request.model,
      input: request.input,
      dimensions: request.dimensions,
      encoding_format: request.encodingFormat,
      ...(request.user === undefined ? {} : { user: request.user }),
    } as const;
    const response = await this.client.embeddings.create(
      body,
      options.signal === undefined ? undefined : { signal: options.signal },
    );

    return {
      data: response.data.map((item) => ({
        embedding: item.embedding,
        index: item.index,
      })),
      model: response.model,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        totalTokens: response.usage.total_tokens,
      },
    };
  }
}

export class EmbeddingGenerator {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly batchSize: number;
  private readonly requestConcurrency: number;
  private readonly maxInputTokens: number;
  private readonly maxRequestTokens: number;

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly tokenCounter: EmbeddingTokenCounter = new Cl100kEmbeddingTokenCounter(),
    config: EmbeddingGeneratorConfig = {},
  ) {
    this.model = (config.model ?? defaultEmbeddingModel).trim();
    this.dimensions = config.dimensions ?? defaultEmbeddingDimensions;
    this.batchSize = config.batchSize ?? defaultEmbeddingBatchSize;
    this.requestConcurrency =
      config.requestConcurrency ?? defaultEmbeddingRequestConcurrency;
    this.maxInputTokens =
      config.maxInputTokens ?? defaultMaxEmbeddingInputTokens;
    this.maxRequestTokens =
      config.maxRequestTokens ?? defaultMaxEmbeddingRequestTokens;

    if (!this.model.trim() || this.model.includes("\0")) {
      throw new EmbeddingGenerationError(
        "INVALID_CONFIGURATION",
        "Embedding model must be a non-empty safe string",
      );
    }

    assertPositiveInteger(this.dimensions, "dimensions");
    assertPositiveInteger(this.batchSize, "batchSize");
    assertPositiveInteger(this.requestConcurrency, "requestConcurrency");
    assertPositiveInteger(this.maxInputTokens, "maxInputTokens");
    assertPositiveInteger(this.maxRequestTokens, "maxRequestTokens");

    if (this.batchSize > maximumOpenAIEmbeddingInputsPerRequest) {
      throw new EmbeddingGenerationError(
        "INVALID_CONFIGURATION",
        `batchSize cannot exceed ${maximumOpenAIEmbeddingInputsPerRequest}`,
      );
    }

    if (this.maxInputTokens > defaultMaxEmbeddingInputTokens) {
      throw new EmbeddingGenerationError(
        "INVALID_CONFIGURATION",
        `maxInputTokens cannot exceed ${defaultMaxEmbeddingInputTokens}`,
      );
    }

    if (this.maxRequestTokens > maximumOpenAIEmbeddingTokensPerRequest) {
      throw new EmbeddingGenerationError(
        "INVALID_CONFIGURATION",
        `maxRequestTokens cannot exceed ${maximumOpenAIEmbeddingTokensPerRequest}`,
      );
    }

    if (this.maxRequestTokens < this.maxInputTokens) {
      throw new EmbeddingGenerationError(
        "INVALID_CONFIGURATION",
        "maxRequestTokens must be at least maxInputTokens",
      );
    }
  }

  async generate(
    inputs: readonly EmbeddingInput[],
    options: EmbeddingGenerationOptions = {},
  ): Promise<EmbeddingGenerationResult> {
    assertNotAborted(options.signal);

    if (
      options.endUserId !== undefined &&
      (!options.endUserId.trim() || options.endUserId.includes("\0"))
    ) {
      throw new EmbeddingGenerationError(
        "INVALID_INPUT",
        "endUserId must be non-empty when provided",
      );
    }

    if (inputs.length === 0) {
      return {
        embeddings: [],
        model: this.model,
        dimensions: this.dimensions,
        usage: {
          promptTokens: 0,
          totalTokens: 0,
          requests: 0,
          uniqueInputs: 0,
        },
      };
    }

    const preparedInputs = this.prepareInputs(inputs);
    const uniqueByText = new Map<string, PreparedEmbeddingInput>();

    for (const input of preparedInputs) {
      if (!uniqueByText.has(input.text)) {
        uniqueByText.set(input.text, input);
      }
    }

    const batches = this.createBatches([...uniqueByText.values()]);
    const limit = pLimit(this.requestConcurrency);
    const batchResults = await Promise.all(
      batches.map((batch) =>
        limit(() => this.generateBatch(batch, options)),
      ),
    );
    const vectorByText = new Map<
      string,
      { vector: number[]; model: string }
    >();
    const responseModels = new Set<string>();
    let promptTokens = 0;
    let totalTokens = 0;

    for (const batchResult of batchResults) {
      promptTokens += batchResult.promptTokens;
      totalTokens += batchResult.totalTokens;

      for (const item of batchResult.vectors) {
        responseModels.add(item.model);
        vectorByText.set(item.input.text, {
          vector: item.vector,
          model: item.model,
        });
      }
    }

    if (responseModels.size !== 1) {
      throw new EmbeddingGenerationError(
        "INCONSISTENT_MODEL_RESPONSE",
        "Embedding provider returned inconsistent models across batches",
      );
    }

    const responseModel = responseModels.values().next().value as string;
    const embeddings = preparedInputs.map((input): GeneratedEmbedding => {
      const generated = vectorByText.get(input.text);

      if (!generated) {
        throw new EmbeddingGenerationError(
          "RESPONSE_COUNT_MISMATCH",
          `Embedding response is missing input ${input.id}`,
          input.id,
        );
      }

      return {
        id: input.id,
        vector: [...generated.vector],
        model: generated.model,
        dimensions: generated.vector.length,
        tokenCount: input.tokenCount,
        inputHash: input.inputHash,
      };
    });

    return {
      embeddings,
      model: responseModel,
      dimensions: this.dimensions,
      usage: {
        promptTokens,
        totalTokens,
        requests: batches.length,
        uniqueInputs: uniqueByText.size,
      },
    };
  }

  private prepareInputs(
    inputs: readonly EmbeddingInput[],
  ): PreparedEmbeddingInput[] {
    const seenIds = new Set<string>();

    return inputs.map((input) => {
      if (!input.id.trim() || input.id.includes("\0")) {
        throw new EmbeddingGenerationError(
          "INVALID_INPUT",
          "Embedding input ID must be a non-empty safe string",
        );
      }

      if (seenIds.has(input.id)) {
        throw new EmbeddingGenerationError(
          "DUPLICATE_INPUT_ID",
          `Embedding input ID is duplicated: ${input.id}`,
          input.id,
        );
      }

      seenIds.add(input.id);

      if (!input.text.trim() || input.text.includes("\0")) {
        throw new EmbeddingGenerationError(
          "INVALID_INPUT",
          `Embedding input ${input.id} must contain non-empty safe text`,
          input.id,
        );
      }

      const tokenCount = this.tokenCounter.count(input.text);

      if (!Number.isSafeInteger(tokenCount) || tokenCount <= 0) {
        throw new EmbeddingGenerationError(
          "INVALID_CONFIGURATION",
          "Embedding token counter returned an invalid result",
          input.id,
        );
      }

      if (tokenCount > this.maxInputTokens) {
        throw new EmbeddingGenerationError(
          "INPUT_TOKEN_LIMIT_EXCEEDED",
          `Embedding input ${input.id} exceeds the ${this.maxInputTokens} token limit`,
          input.id,
        );
      }

      return {
        ...input,
        tokenCount,
        inputHash: hashEmbeddingInput(input.text),
      };
    });
  }

  private createBatches(
    inputs: readonly PreparedEmbeddingInput[],
  ): PreparedEmbeddingInput[][] {
    const batches: PreparedEmbeddingInput[][] = [];
    let currentBatch: PreparedEmbeddingInput[] = [];
    let currentTokens = 0;

    for (const input of inputs) {
      const exceedsBatchSize = currentBatch.length >= this.batchSize;
      const exceedsTokenBudget =
        currentBatch.length > 0 &&
        currentTokens + input.tokenCount > this.maxRequestTokens;

      if (exceedsBatchSize || exceedsTokenBudget) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }

      currentBatch.push(input);
      currentTokens += input.tokenCount;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private async generateBatch(
    batch: readonly PreparedEmbeddingInput[],
    options: EmbeddingGenerationOptions,
  ): Promise<BatchEmbeddingResult> {
    assertNotAborted(options.signal);
    const request: EmbeddingProviderRequest = {
      model: this.model,
      input: batch.map((input) => input.text),
      dimensions: this.dimensions,
      encodingFormat: "float",
      ...(options.endUserId === undefined
        ? {}
        : { user: options.endUserId }),
    };

    let response: EmbeddingProviderResponse;

    try {
      response = await this.provider.createEmbeddings(
        request,
        options.signal === undefined ? undefined : { signal: options.signal },
      );
    } catch (cause) {
      if (cause instanceof EmbeddingGenerationError) {
        throw cause;
      }

      if (isAbortError(cause) || options.signal?.aborted) {
        throw new EmbeddingGenerationError(
          "EMBEDDING_ABORTED",
          "Embedding generation was cancelled",
          undefined,
          { cause },
        );
      }

      throw new EmbeddingGenerationError(
        "PROVIDER_ERROR",
        "Embedding provider request failed",
        undefined,
        { cause },
      );
    }

    if (response.data.length !== batch.length) {
      throw new EmbeddingGenerationError(
        "RESPONSE_COUNT_MISMATCH",
        "Embedding provider returned an unexpected number of vectors",
      );
    }

    if (!response.model.trim()) {
      throw new EmbeddingGenerationError(
        "INCONSISTENT_MODEL_RESPONSE",
        "Embedding provider returned an empty model identifier",
      );
    }

    if (
      !Number.isSafeInteger(response.usage.promptTokens) ||
      !Number.isSafeInteger(response.usage.totalTokens) ||
      response.usage.promptTokens < 0 ||
      response.usage.totalTokens < response.usage.promptTokens
    ) {
      throw new EmbeddingGenerationError(
        "PROVIDER_ERROR",
        "Embedding provider returned invalid usage metadata",
      );
    }

    const orderedVectors = new Array<number[] | undefined>(batch.length);

    for (const item of response.data) {
      if (
        !Number.isSafeInteger(item.index) ||
        item.index < 0 ||
        item.index >= batch.length ||
        orderedVectors[item.index] !== undefined
      ) {
        throw new EmbeddingGenerationError(
          "RESPONSE_INDEX_INVALID",
          "Embedding provider returned an invalid or duplicate vector index",
        );
      }

      if (
        item.embedding.length === 0 ||
        item.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new EmbeddingGenerationError(
          "INVALID_VECTOR",
          "Embedding provider returned a non-finite or empty vector",
        );
      }

      if (item.embedding.length !== this.dimensions) {
        throw new EmbeddingGenerationError(
          "DIMENSION_MISMATCH",
          `Embedding provider returned ${item.embedding.length} dimensions; expected ${this.dimensions}`,
        );
      }

      orderedVectors[item.index] = [...item.embedding];
    }

    return {
      vectors: batch.map((input, index) => {
        const vector = orderedVectors[index];

        if (!vector) {
          throw new EmbeddingGenerationError(
            "RESPONSE_COUNT_MISMATCH",
            "Embedding provider response omitted a vector",
            input.id,
          );
        }

        return { input, vector, model: response.model };
      }),
      promptTokens: response.usage.promptTokens,
      totalTokens: response.usage.totalTokens,
    };
  }
}

export function createOpenAIEmbeddingGenerator(
  config: OpenAIEmbeddingGeneratorConfig,
): EmbeddingGenerator {
  return new EmbeddingGenerator(
    new OpenAIEmbeddingProvider(config),
    new Cl100kEmbeddingTokenCounter(),
    config,
  );
}

export function createOpenAIEmbeddingGeneratorFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingGenerator {
  const apiKey = environment.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new EmbeddingGenerationError(
      "INVALID_CONFIGURATION",
      "OPENAI_API_KEY is required for embedding generation",
    );
  }

  return createOpenAIEmbeddingGenerator({
    apiKey,
    model: environment.OPENAI_EMBEDDING_MODEL?.trim() || defaultEmbeddingModel,
    dimensions: parsePositiveEnvironmentInteger(
      environment,
      "OPENAI_EMBEDDING_DIMENSIONS",
      defaultEmbeddingDimensions,
    ),
    batchSize: parsePositiveEnvironmentInteger(
      environment,
      "EMBEDDING_BATCH_SIZE",
      defaultEmbeddingBatchSize,
    ),
    requestConcurrency: parsePositiveEnvironmentInteger(
      environment,
      "EMBEDDING_REQUEST_CONCURRENCY",
      defaultEmbeddingRequestConcurrency,
    ),
    maxInputTokens: parsePositiveEnvironmentInteger(
      environment,
      "EMBEDDING_MAX_INPUT_TOKENS",
      defaultMaxEmbeddingInputTokens,
    ),
    maxRequestTokens: parsePositiveEnvironmentInteger(
      environment,
      "EMBEDDING_MAX_REQUEST_TOKENS",
      defaultMaxEmbeddingRequestTokens,
    ),
    timeoutMs: parsePositiveEnvironmentInteger(
      environment,
      "OPENAI_REQUEST_TIMEOUT_MS",
      defaultOpenAIRequestTimeoutMs,
    ),
    maxRetries: parseNonNegativeEnvironmentInteger(
      environment,
      "OPENAI_MAX_RETRIES",
      defaultOpenAIMaxRetries,
    ),
    ...(environment.OPENAI_ORG_ID?.trim()
      ? { organization: environment.OPENAI_ORG_ID.trim() }
      : {}),
    ...(environment.OPENAI_PROJECT_ID?.trim()
      ? { project: environment.OPENAI_PROJECT_ID.trim() }
      : {}),
  });
}
