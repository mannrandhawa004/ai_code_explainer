import { describe, expect, it } from "vitest";

import { createOpenAIRepositoryAnswerGeneratorFromEnv } from "../src/index.js";

const runLiveTest =
  process.env.RUN_OPENAI_ANSWER_TESTS === "true" &&
  Boolean(process.env.OPENAI_API_KEY);
const describeWithOpenAI = runLiveTest ? describe : describe.skip;

describeWithOpenAI("OpenAI repository answer integration", () => {
  it("generates a grounded answer through the Responses API", async () => {
    const generator = createOpenAIRepositoryAnswerGeneratorFromEnv(process.env);

    const result = await generator.generate({
      userId: "integration-user",
      repositoryName: "example/repository",
      branch: "main",
      commitSha: "abc123",
      question: "What does the add function do?",
      category: "semantic",
      sources: [
        {
          id: "integration-chunk",
          score: 1,
          filePath: "src/math.ts",
          language: "typescript",
          symbolType: "function",
          symbolName: "add",
          startLine: 1,
          endLine: 3,
          content:
            "export function add(left: number, right: number) {\n  return left + right;\n}",
        },
      ],
    });

    expect(result.answer).not.toHaveLength(0);
    expect(result.answer).toContain("[src/math.ts:L1-L3]");
    expect(result.sources).toEqual([
      {
        filePath: "src/math.ts",
        startLine: 1,
        endLine: 3,
        symbolName: "add",
      },
    ]);
    expect(result.responseId).not.toHaveLength(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  }, 120_000);
});
