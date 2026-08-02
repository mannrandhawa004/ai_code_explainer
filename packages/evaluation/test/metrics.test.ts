import { describe, expect, it } from "vitest";

import {
  aggregateEvaluationResults,
  createEvaluationReport,
  evaluateQualityGates,
  scoreEvaluationCase,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationObservation,
} from "../src/index.js";

const evaluationCase: EvaluationCase = {
  id: "auth-flow",
  question: "How does authentication work?",
  expectedFiles: ["src/auth.ts", "src/jwt.ts"],
  expectedSymbols: ["authenticateUser", "verifyToken"],
  expectedLineRanges: [
    { filePath: "src/auth.ts", startLine: 10, endLine: 30 },
    { filePath: "src/jwt.ts", startLine: 40, endLine: 60 },
  ],
  expectedAnswerConcepts: [
    { id: "header", terms: ["authorization header", "bearer token"] },
    { id: "verification", terms: ["verifies the token"] },
  ],
  forbiddenAnswerTerms: ["executes repository code"],
};

const observation: EvaluationObservation = {
  answer:
    "It reads the Authorization header and verifies the token. It never executes repository code.",
  retrievedSources: [
    {
      id: "auth-1",
      filePath: "src/auth.ts",
      symbolName: "authenticateUser",
      startLine: 8,
      endLine: 32,
      score: 0.99,
    },
    {
      id: "auth-2",
      filePath: "src/auth.ts",
      symbolName: "helper",
      startLine: 70,
      endLine: 80,
      score: 0.95,
    },
    {
      id: "irrelevant",
      filePath: "src/config.ts",
      startLine: 1,
      endLine: 15,
      score: 0.8,
    },
    {
      id: "jwt-1",
      filePath: "src/jwt.ts",
      symbolName: "verifyToken",
      startLine: 35,
      endLine: 55,
      score: 0.75,
    },
  ],
  citations: [
    { filePath: "src/auth.ts", startLine: 10, endLine: 20 },
    { filePath: "src/missing.ts", startLine: 1, endLine: 5 },
  ],
  timings: { retrievalMs: 20, generationMs: 200, indexingMs: 5_000 },
  usage: { embeddingTokens: 100, inputTokens: 1_000, outputTokens: 200 },
};

describe("evaluation metrics", () => {
  it("scores ranked unique files, symbols, lines, citations, answers, and cost", () => {
    const metrics = scoreEvaluationCase(evaluationCase, observation, {
      embeddingUsdPerMillionTokens: 0.02,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 10,
    });

    expect(metrics.retrieval).toEqual({
      recallAt5: 1,
      recallAt10: 1,
      precisionAt5: 0.4,
      precisionAt10: 0.2,
      meanReciprocalRank: 1,
      exactFileHitRate: 1,
      exactSymbolHitRate: 1,
      lineHitRate: 1,
    });
    expect(metrics.citations.precision).toBe(0.5);
    expect(metrics.citations.recall).toBe(0.5);
    expect(metrics.citations.f1).toBe(0.5);
    expect(metrics.citations.groundedness).toBe(0.5);
    expect(metrics.answer.completeness).toBe(1);
    expect(metrics.answer.forbiddenClaimRate).toBe(1);
    expect(metrics.answer.unsupportedCitationRate).toBe(0.5);
    expect(metrics.answer.hallucinationRate).toBe(1);
    expect(metrics.cost.embeddingUsd).toBeCloseTo(0.000002, 12);
    expect(metrics.cost.generationInputUsd).toBeCloseTo(0.001, 12);
    expect(metrics.cost.generationOutputUsd).toBeCloseTo(0.002, 12);
    expect(metrics.cost.totalUsd).toBeCloseTo(0.003002, 12);
  });

  it("uses full-k precision and returns not-applicable optional metrics", () => {
    const simpleCase: EvaluationCase = {
      id: "single",
      question: "Where is it?",
      expectedFiles: ["src/a.ts"],
    };
    const metrics = scoreEvaluationCase(simpleCase, {
      answer: "It is in source A.",
      retrievedSources: [
        { filePath: "src/a.ts", startLine: 1, endLine: 2 },
      ],
      citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 2 }],
      timings: { retrievalMs: 1, generationMs: 2 },
    });

    expect(metrics.retrieval.precisionAt5).toBe(0.2);
    expect(metrics.retrieval.exactSymbolHitRate).toBeNull();
    expect(metrics.retrieval.lineHitRate).toBeNull();
    expect(metrics.answer.completeness).toBe(1);
    expect(metrics.answer.hallucinationRate).toBe(0);

    const uncited = scoreEvaluationCase(simpleCase, {
      answer: "It is in source A.",
      retrievedSources: [
        { filePath: "src/a.ts", startLine: 1, endLine: 2 },
      ],
      citations: [],
      timings: { retrievalMs: 1, generationMs: 2 },
    });
    expect(uncited.answer.unsupportedCitationRate).toBe(1);
    expect(uncited.answer.hallucinationRate).toBe(1);
  });

  it("aggregates latency percentiles and exposes failed quality gates", () => {
    const metrics = scoreEvaluationCase(evaluationCase, observation);
    const results: EvaluationCaseResult[] = [
      {
        caseId: evaluationCase.id,
        question: evaluationCase.question,
        success: true,
        observation,
        metrics,
      },
      {
        caseId: "failure",
        question: "Failed case",
        success: false,
        metrics: {
          retrieval: {
            recallAt5: 0,
            recallAt10: 0,
            precisionAt5: 0,
            precisionAt10: 0,
            meanReciprocalRank: 0,
            exactFileHitRate: 0,
            exactSymbolHitRate: null,
            lineHitRate: null,
          },
          citations: { precision: 0, recall: 0, f1: 0, groundedness: 0 },
          answer: {
            completeness: 0,
            forbiddenClaimRate: 0,
            unsupportedCitationRate: 0,
            hallucinationRate: 0,
          },
          cost: { totalUsd: null },
        },
        failure: { code: "TARGET_ERROR", message: "failed" },
      },
    ];
    const aggregate = aggregateEvaluationResults(results);

    expect(aggregate.caseSuccessRate).toBe(0.5);
    expect(aggregate.retrieval.recallAt5).toBe(0.5);
    expect(aggregate.latency.retrieval).toEqual({
      averageMs: 20,
      p95Ms: 20,
    });
    expect(
      evaluateQualityGates(aggregate, {
        minimumCaseSuccessRate: 1,
        minimumRecallAt5: 0.8,
        maximumGenerationP95Ms: 100,
      }),
    ).toEqual([
      {
        metric: "caseSuccessRate",
        operator: ">=",
        threshold: 1,
        actual: 0.5,
      },
      {
        metric: "retrieval.recallAt5",
        operator: ">=",
        threshold: 0.8,
        actual: 0.5,
      },
      {
        metric: "latency.generation.p95Ms",
        operator: "<=",
        threshold: 100,
        actual: 200,
      },
    ]);

    const report = createEvaluationReport({
      dataset: {
        schemaVersion: 1,
        name: "test-suite",
        repository: { owner: "owner", name: "repo" },
        cases: [evaluationCase],
      },
      results,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    expect(report.passed).toBe(false);
    expect(report.durationMs).toBe(1_000);
  });
});
