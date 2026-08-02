import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EvaluationValidationError,
  parseEvaluationDataset,
  parseEvaluationObservation,
  parseEvaluationPricing,
  parseEvaluationRecording,
  parseEvaluationThresholds,
} from "../src/index.js";

function createDataset(): unknown {
  return {
    schemaVersion: 1,
    name: "repository-regression",
    description: "Known questions for this repository",
    repository: {
      owner: "example",
      name: "repository",
      branch: "main",
      commitSha: "a".repeat(40),
    },
    cases: [
      {
        id: "jwt-verification",
        question: "Where is JWT verification performed?",
        expectedFiles: ["src\\middleware\\auth.ts"],
        expectedSymbols: ["authenticateUser"],
        expectedLineRanges: [
          {
            filePath: "src/middleware/auth.ts",
            startLine: 10,
            endLine: 30,
          },
        ],
        expectedAnswerConcepts: [
          { id: "verification", terms: ["verify token", "token validation"] },
        ],
        forbiddenAnswerTerms: ["tokens are never verified"],
        tags: ["authentication"],
      },
    ],
  };
}

function createObservation(): unknown {
  return {
    answer: "The token validation happens in the authentication middleware.",
    retrievedSources: [
      {
        id: "chunk-1",
        filePath: "src/middleware/auth.ts",
        symbolName: "authenticateUser",
        startLine: 8,
        endLine: 32,
        score: -0.1,
      },
    ],
    citations: [
      {
        filePath: "src/middleware/auth.ts",
        symbolName: "authenticateUser",
        startLine: 10,
        endLine: 30,
      },
    ],
    timings: { retrievalMs: 12.5, generationMs: 30, indexingMs: 1_000 },
    usage: { embeddingTokens: 8, inputTokens: 100, outputTokens: 20 },
    metadata: { model: "test-model", cached: false, attempt: 1, note: null },
  };
}

describe("evaluation input validation", () => {
  it("validates the checked-in dataset and production thresholds", async () => {
    const repositoryRoot = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "../../..",
    );
    const [datasetJson, thresholdsJson] = await Promise.all([
      readFile(
        resolve(
          repositoryRoot,
          "evaluations/datasets/ai-codebase-explainer.v1.json",
        ),
        "utf8",
      ),
      readFile(
        resolve(repositoryRoot, "evaluations/thresholds/production.v1.json"),
        "utf8",
      ),
    ]);

    const dataset = parseEvaluationDataset(JSON.parse(datasetJson));
    const thresholds = parseEvaluationThresholds(JSON.parse(thresholdsJson));
    expect(dataset.cases).toHaveLength(5);
    expect(dataset.repository.commitSha).toBe(
      "9c8c82f48da4d0756e98fc39be7c077480cd7343",
    );
    expect(thresholds.minimumRecallAt5).toBe(0.8);
  });

  it("parses, normalizes, and isolates a versioned repository dataset", () => {
    const dataset = parseEvaluationDataset(createDataset());

    expect(dataset.name).toBe("repository-regression");
    expect(dataset.cases[0]?.expectedFiles).toEqual([
      "src/middleware/auth.ts",
    ]);
    expect(dataset.repository.commitSha).toHaveLength(40);
  });

  it.each([
    {
      name: "path traversal",
      mutate: (dataset: any) => {
        dataset.cases[0].expectedFiles = ["../secret.env"];
      },
    },
    {
      name: "duplicate case ids",
      mutate: (dataset: any) => {
        dataset.cases.push(structuredClone(dataset.cases[0]));
      },
    },
    {
      name: "unknown fields",
      mutate: (dataset: any) => {
        dataset.cases[0].prompt = "untrusted";
      },
    },
    {
      name: "line files absent from expected files",
      mutate: (dataset: any) => {
        dataset.cases[0].expectedLineRanges[0].filePath = "src/other.ts";
      },
    },
  ])("rejects $name", ({ mutate }) => {
    const dataset = createDataset();
    mutate(dataset);

    expect(() => parseEvaluationDataset(dataset)).toThrow(
      EvaluationValidationError,
    );
  });

  it("validates observations and rejects unsafe adapter output", () => {
    const observation = parseEvaluationObservation(createObservation());
    expect(observation.retrievedSources[0]?.score).toBe(-0.1);

    const unsafe = createObservation() as any;
    unsafe.citations[0].filePath = "C:/secrets.txt";
    expect(() => parseEvaluationObservation(unsafe)).toThrow(
      /repository-relative path/u,
    );
  });

  it("validates recordings, thresholds, and configurable pricing", () => {
    const recording = parseEvaluationRecording({
      schemaVersion: 1,
      datasetName: "repository-regression",
      observations: { "jwt-verification": createObservation() },
    });
    expect(recording.observations["jwt-verification"]).toBeDefined();

    expect(
      parseEvaluationThresholds({
        minimumRecallAt5: 0.8,
        maximumGenerationP95Ms: 60_000,
      }),
    ).toEqual({ minimumRecallAt5: 0.8, maximumGenerationP95Ms: 60_000 });
    expect(() =>
      parseEvaluationThresholds({ minimumRecallAt5: 1.1 }),
    ).toThrow(/between 0 and 1/u);

    expect(
      parseEvaluationPricing({
        embeddingUsdPerMillionTokens: 0.02,
        inputUsdPerMillionTokens: 1.25,
        outputUsdPerMillionTokens: 10,
      }),
    ).toEqual({
      embeddingUsdPerMillionTokens: 0.02,
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 10,
    });
  });
});
