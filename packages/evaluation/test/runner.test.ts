import { describe, expect, it } from "vitest";

import {
  EvaluationRunner,
  EvaluationRunnerConfigError,
  EvaluationValidationError,
  evaluateRecording,
  parseEvaluationDataset,
  parseEvaluationRecording,
  type EvaluationCase,
  type EvaluationObservation,
} from "../src/index.js";

function createDataset(caseCount = 3) {
  return parseEvaluationDataset({
    schemaVersion: 1,
    name: "runner-suite",
    repository: { owner: "example", name: "repository" },
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${index + 1}`,
      question: `Question ${index + 1}?`,
      expectedFiles: [`src/file-${index + 1}.ts`],
      expectedSymbols: [`symbol${index + 1}`],
      expectedLineRanges: [
        {
          filePath: `src/file-${index + 1}.ts`,
          startLine: 1,
          endLine: 10,
        },
      ],
      expectedAnswerConcepts: [
        { id: `concept-${index + 1}`, terms: [`answer ${index + 1}`] },
      ],
    })),
  });
}

function createObservation(evaluationCase: EvaluationCase): EvaluationObservation {
  const index = evaluationCase.id.split("-")[1]!;
  const filePath = evaluationCase.expectedFiles[0]!;
  return {
    answer: `Answer ${index}`,
    retrievedSources: [
      {
        filePath,
        ...(evaluationCase.expectedSymbols?.[0] === undefined
          ? {}
          : { symbolName: evaluationCase.expectedSymbols[0] }),
        startLine: 1,
        endLine: 10,
      },
    ],
    citations: [{ filePath, startLine: 1, endLine: 10 }],
    timings: { retrievalMs: 5, generationMs: 10 },
  };
}

describe("EvaluationRunner", () => {
  it("bounds concurrency and keeps results in dataset order", async () => {
    const dataset = createDataset(5);
    let active = 0;
    let maximumActive = 0;
    const runner = new EvaluationRunner({
      concurrency: 2,
      caseTimeoutMs: 1_000,
      thresholds: { minimumRecallAt5: 1 },
      target: {
        async evaluate(evaluationCase) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return createObservation(evaluationCase);
        },
      },
    });

    const report = await runner.run(dataset);

    expect(maximumActive).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.cases.map(({ caseId }) => caseId)).toEqual([
      "case-1",
      "case-2",
      "case-3",
      "case-4",
      "case-5",
    ]);
  });

  it("turns timeouts and invalid adapter observations into case failures", async () => {
    const dataset = createDataset(2);
    const runner = new EvaluationRunner({
      concurrency: 1,
      caseTimeoutMs: 20,
      target: {
        async evaluate(evaluationCase) {
          if (evaluationCase.id === "case-1") {
            return new Promise<EvaluationObservation>(() => undefined);
          }
          return { ...createObservation(evaluationCase), answer: "" };
        },
      },
    });

    const report = await runner.run(dataset);

    expect(report.passed).toBe(false);
    expect(report.cases[0]?.failure?.code).toBe("CASE_TIMEOUT");
    expect(report.cases[1]?.failure?.code).toBe("INVALID_OBSERVATION");
    expect(report.aggregate.caseSuccessRate).toBe(0);
  });

  it("validates concurrency and timeout configuration", () => {
    expect(
      () =>
        new EvaluationRunner({
          target: { evaluate: async (item) => createObservation(item) },
          concurrency: 17,
        }),
    ).toThrow(EvaluationRunnerConfigError);
    expect(
      () =>
        new EvaluationRunner({
          target: { evaluate: async (item) => createObservation(item) },
          caseTimeoutMs: 0,
        }),
    ).toThrow(EvaluationRunnerConfigError);
  });
});

describe("recorded evaluation", () => {
  it("scores reproducible observations and fails missing cases", () => {
    const dataset = createDataset(2);
    const recording = parseEvaluationRecording({
      schemaVersion: 1,
      datasetName: dataset.name,
      observations: { "case-1": createObservation(dataset.cases[0]!) },
    });

    const report = evaluateRecording(dataset, recording, {
      thresholds: { minimumCaseSuccessRate: 1 },
    });

    expect(report.passed).toBe(false);
    expect(report.cases[1]?.failure?.code).toBe("MISSING_OBSERVATION");
    expect(report.violations[0]?.metric).toBe("caseSuccessRate");
  });

  it("rejects recordings from another dataset or with stale case ids", () => {
    const dataset = createDataset(1);
    const wrongDataset = parseEvaluationRecording({
      schemaVersion: 1,
      datasetName: "another-suite",
      observations: {},
    });
    expect(() => evaluateRecording(dataset, wrongDataset)).toThrow(
      EvaluationValidationError,
    );

    const stale = parseEvaluationRecording({
      schemaVersion: 1,
      datasetName: dataset.name,
      observations: {
        "stale-case": createObservation(dataset.cases[0]!),
      },
    });
    expect(() => evaluateRecording(dataset, stale)).toThrow(/unknown case id/u);
  });
});
