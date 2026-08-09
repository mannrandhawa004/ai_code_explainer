import { APIError } from "openai";
import { describe, expect, it } from "vitest";

import {
  EmbeddingGenerationError,
  classifyAIProviderError,
} from "../src/index.js";

describe("AI provider failure classification", () => {
  it("finds a permanent OpenAI credit failure through wrapped causes", () => {
    const openAIError = APIError.generate(
      429,
      {
        error: {
          message: "billing detail",
          code: "credit_balance_exhausted",
          type: "insufficient_quota",
        },
      },
      undefined,
      new Headers(),
    );
    const wrapped = new EmbeddingGenerationError(
      "PROVIDER_ERROR",
      "Embedding provider request failed",
      undefined,
      { cause: openAIError },
    );

    expect(classifyAIProviderError(wrapped)).toEqual({
      provider: "openai",
      code: "QUOTA_EXHAUSTED",
      message:
        "The hosted AI provider has no available credits or quota. Configure Google Gemini's free tier, or update the provider account.",
      retryable: false,
      statusCode: 429,
    });
  });

  it("keeps a normal rate limit retryable", () => {
    expect(
      classifyAIProviderError(
        APIError.generate(
          429,
          {
            error: {
              message: "slow down",
              code: "rate_limit_exceeded",
            },
          },
          undefined,
          new Headers(),
        ),
      ),
    ).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });
});
