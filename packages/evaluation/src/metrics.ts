import {
  evaluationSchemaVersion,
  type AnswerEvaluationMetrics,
  type CitationEvaluationMetrics,
  type EvaluationAggregateMetrics,
  type EvaluationCase,
  type EvaluationCaseMetrics,
  type EvaluationCaseResult,
  type EvaluationCitation,
  type EvaluationCost,
  type EvaluationDataset,
  type EvaluationGateViolation,
  type EvaluationLatencySummary,
  type EvaluationLineRange,
  type EvaluationObservation,
  type EvaluationPricing,
  type EvaluationReport,
  type EvaluationSource,
  type EvaluationThresholds,
  type RetrievalEvaluationMetrics,
} from "./types.js";

function clampRate(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function divide(numerator: number, denominator: number, emptyValue = 0): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : mean(present);
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function summarizeLatency(values: readonly number[]): EvaluationLatencySummary {
  return {
    averageMs: values.length === 0 ? null : mean(values),
    p95Ms: percentile95(values),
  };
}

function rangesOverlap(
  left: Pick<EvaluationLineRange, "startLine" | "endLine">,
  right: Pick<EvaluationLineRange, "startLine" | "endLine">,
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function uniqueRankedFiles(sources: readonly EvaluationSource[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const source of sources) {
    if (!seen.has(source.filePath)) {
      seen.add(source.filePath);
      files.push(source.filePath);
    }
  }
  return files;
}

function retrievalAtK(
  rankedFiles: readonly string[],
  expectedFiles: ReadonlySet<string>,
  k: number,
): { recall: number; precision: number } {
  const hits = rankedFiles
    .slice(0, k)
    .filter((filePath) => expectedFiles.has(filePath)).length;
  return {
    recall: divide(hits, expectedFiles.size),
    precision: divide(hits, k),
  };
}

function scoreRetrieval(
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
): RetrievalEvaluationMetrics {
  const expectedFiles = new Set(evaluationCase.expectedFiles);
  const rankedFiles = uniqueRankedFiles(observation.retrievedSources);
  const at5 = retrievalAtK(rankedFiles, expectedFiles, 5);
  const at10 = retrievalAtK(rankedFiles, expectedFiles, 10);
  const firstRelevantIndex = rankedFiles.findIndex((filePath) =>
    expectedFiles.has(filePath),
  );
  const retrievedFiles = new Set(rankedFiles);
  const exactFileHits = evaluationCase.expectedFiles.filter((filePath) =>
    retrievedFiles.has(filePath),
  ).length;

  const expectedSymbols = evaluationCase.expectedSymbols;
  const retrievedSymbols = new Set(
    observation.retrievedSources.flatMap((source) =>
      source.symbolName === undefined ? [] : [source.symbolName],
    ),
  );
  const exactSymbolHitRate =
    expectedSymbols === undefined || expectedSymbols.length === 0
      ? null
      : divide(
          expectedSymbols.filter((symbol) => retrievedSymbols.has(symbol)).length,
          expectedSymbols.length,
        );

  const expectedLineRanges = evaluationCase.expectedLineRanges;
  const lineHitRate =
    expectedLineRanges === undefined || expectedLineRanges.length === 0
      ? null
      : divide(
          expectedLineRanges.filter((range) =>
            observation.retrievedSources.some(
              (source) =>
                source.filePath === range.filePath &&
                rangesOverlap(source, range),
            ),
          ).length,
          expectedLineRanges.length,
        );

  return {
    recallAt5: clampRate(at5.recall),
    recallAt10: clampRate(at10.recall),
    precisionAt5: clampRate(at5.precision),
    precisionAt10: clampRate(at10.precision),
    meanReciprocalRank:
      firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1),
    exactFileHitRate: divide(exactFileHits, expectedFiles.size),
    exactSymbolHitRate,
    lineHitRate,
  };
}

type ExpectedCitationUnit = {
  filePath: string;
  startLine?: number;
  endLine?: number;
};

function createExpectedCitationUnits(
  evaluationCase: EvaluationCase,
): ExpectedCitationUnit[] {
  const ranges = evaluationCase.expectedLineRanges ?? [];
  const filesWithRanges = new Set(ranges.map(({ filePath }) => filePath));
  return [
    ...ranges,
    ...evaluationCase.expectedFiles
      .filter((filePath) => !filesWithRanges.has(filePath))
      .map((filePath) => ({ filePath })),
  ];
}

function citationMatchesExpectedUnit(
  citation: EvaluationCitation,
  unit: ExpectedCitationUnit,
): boolean {
  if (citation.filePath !== unit.filePath) {
    return false;
  }
  return unit.startLine === undefined || unit.endLine === undefined
    ? true
    : rangesOverlap(citation, {
        startLine: unit.startLine,
        endLine: unit.endLine,
      });
}

function scoreCitations(
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
): CitationEvaluationMetrics {
  const expectedUnits = createExpectedCitationUnits(evaluationCase);
  const relevantCitations = observation.citations.filter((citation) =>
    expectedUnits.some((unit) => citationMatchesExpectedUnit(citation, unit)),
  ).length;
  const matchedUnits = expectedUnits.filter((unit) =>
    observation.citations.some((citation) =>
      citationMatchesExpectedUnit(citation, unit),
    ),
  ).length;
  const precision = divide(relevantCitations, observation.citations.length);
  const recall = divide(matchedUnits, expectedUnits.length);
  const groundedCitations = observation.citations.filter((citation) =>
    observation.retrievedSources.some(
      (source) =>
        source.filePath === citation.filePath &&
        citation.startLine >= source.startLine &&
        citation.endLine <= source.endLine,
    ),
  ).length;

  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    groundedness: divide(
      groundedCitations,
      observation.citations.length,
      observation.citations.length === 0 ? 0 : 1,
    ),
  };
}

function normalizeAnswerText(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function scoreAnswer(
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
  citations: CitationEvaluationMetrics,
): AnswerEvaluationMetrics {
  const normalizedAnswer = normalizeAnswerText(observation.answer);
  const concepts = evaluationCase.expectedAnswerConcepts ?? [];
  const matchedConcepts = concepts.filter((concept) =>
    concept.terms.some((term) =>
      normalizedAnswer.includes(normalizeAnswerText(term)),
    ),
  ).length;
  const forbiddenTerms = evaluationCase.forbiddenAnswerTerms ?? [];
  const forbiddenClaims = forbiddenTerms.filter((term) =>
    normalizedAnswer.includes(normalizeAnswerText(term)),
  ).length;
  const forbiddenClaimRate = divide(forbiddenClaims, forbiddenTerms.length, 0);
  const unsupportedCitationRate =
    observation.citations.length === 0 ? 1 : 1 - citations.groundedness;

  return {
    completeness: divide(matchedConcepts, concepts.length, 1),
    forbiddenClaimRate,
    unsupportedCitationRate,
    hallucinationRate: Math.max(forbiddenClaimRate, unsupportedCitationRate),
  };
}

function priceTokens(tokens: number, price: number | undefined): number | undefined {
  return price === undefined ? undefined : (tokens / 1_000_000) * price;
}

function scoreCost(
  observation: EvaluationObservation,
  pricing: EvaluationPricing,
): EvaluationCost {
  const embeddingUsd = priceTokens(
    observation.usage?.embeddingTokens ?? 0,
    pricing.embeddingUsdPerMillionTokens,
  );
  const generationInputUsd = priceTokens(
    observation.usage?.inputTokens ?? 0,
    pricing.inputUsdPerMillionTokens,
  );
  const generationOutputUsd = priceTokens(
    observation.usage?.outputTokens ?? 0,
    pricing.outputUsdPerMillionTokens,
  );
  const pricedComponents = [
    embeddingUsd,
    generationInputUsd,
    generationOutputUsd,
  ].filter((value): value is number => value !== undefined);
  return {
    ...(embeddingUsd === undefined ? {} : { embeddingUsd }),
    ...(generationInputUsd === undefined ? {} : { generationInputUsd }),
    ...(generationOutputUsd === undefined ? {} : { generationOutputUsd }),
    totalUsd:
      pricedComponents.length === 0
        ? null
        : pricedComponents.reduce((total, value) => total + value, 0),
  };
}

export function scoreEvaluationCase(
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
  pricing: EvaluationPricing = {},
): EvaluationCaseMetrics {
  const citations = scoreCitations(evaluationCase, observation);
  return {
    retrieval: scoreRetrieval(evaluationCase, observation),
    citations,
    answer: scoreAnswer(evaluationCase, observation, citations),
    cost: scoreCost(observation, pricing),
  };
}

export function createFailedCaseMetrics(
  evaluationCase: EvaluationCase,
): EvaluationCaseMetrics {
  return {
    retrieval: {
      recallAt5: 0,
      recallAt10: 0,
      precisionAt5: 0,
      precisionAt10: 0,
      meanReciprocalRank: 0,
      exactFileHitRate: 0,
      exactSymbolHitRate:
        (evaluationCase.expectedSymbols?.length ?? 0) === 0 ? null : 0,
      lineHitRate:
        (evaluationCase.expectedLineRanges?.length ?? 0) === 0 ? null : 0,
    },
    citations: { precision: 0, recall: 0, f1: 0, groundedness: 0 },
    answer: {
      completeness: 0,
      forbiddenClaimRate: 0,
      unsupportedCitationRate: 0,
      hallucinationRate: 0,
    },
    cost: { totalUsd: null },
  };
}

function sumOptionalCost(
  results: readonly EvaluationCaseResult[],
  key: "embeddingUsd" | "generationInputUsd" | "generationOutputUsd",
): number | undefined {
  const values = results.flatMap(({ metrics }) => {
    const value = metrics.cost[key];
    return value === undefined ? [] : [value];
  });
  return values.length === 0
    ? undefined
    : values.reduce((total, value) => total + value, 0);
}

export function aggregateEvaluationResults(
  results: readonly EvaluationCaseResult[],
): EvaluationAggregateMetrics {
  const successful = results.filter((result) => result.success);
  const retrievalLatencies = successful.flatMap((result) =>
    result.observation === undefined
      ? []
      : [result.observation.timings.retrievalMs],
  );
  const generationLatencies = successful.flatMap((result) =>
    result.observation === undefined
      ? []
      : [result.observation.timings.generationMs],
  );
  const indexingLatencies = successful.flatMap((result) => {
    const indexingMs = result.observation?.timings.indexingMs;
    return indexingMs === undefined ? [] : [indexingMs];
  });
  const embeddingUsd = sumOptionalCost(results, "embeddingUsd");
  const generationInputUsd = sumOptionalCost(results, "generationInputUsd");
  const generationOutputUsd = sumOptionalCost(results, "generationOutputUsd");

  return {
    caseCount: results.length,
    successfulCaseCount: successful.length,
    caseSuccessRate: divide(successful.length, results.length),
    retrieval: {
      recallAt5: mean(results.map(({ metrics }) => metrics.retrieval.recallAt5)),
      recallAt10: mean(results.map(({ metrics }) => metrics.retrieval.recallAt10)),
      precisionAt5: mean(
        results.map(({ metrics }) => metrics.retrieval.precisionAt5),
      ),
      precisionAt10: mean(
        results.map(({ metrics }) => metrics.retrieval.precisionAt10),
      ),
      meanReciprocalRank: mean(
        results.map(({ metrics }) => metrics.retrieval.meanReciprocalRank),
      ),
      exactFileHitRate: mean(
        results.map(({ metrics }) => metrics.retrieval.exactFileHitRate),
      ),
      exactSymbolHitRate: meanNullable(
        results.map(({ metrics }) => metrics.retrieval.exactSymbolHitRate),
      ),
      lineHitRate: meanNullable(
        results.map(({ metrics }) => metrics.retrieval.lineHitRate),
      ),
    },
    citations: {
      precision: mean(results.map(({ metrics }) => metrics.citations.precision)),
      recall: mean(results.map(({ metrics }) => metrics.citations.recall)),
      f1: mean(results.map(({ metrics }) => metrics.citations.f1)),
      groundedness: mean(
        results.map(({ metrics }) => metrics.citations.groundedness),
      ),
    },
    answer: {
      completeness: mean(
        results.map(({ metrics }) => metrics.answer.completeness),
      ),
      forbiddenClaimRate: mean(
        results.map(({ metrics }) => metrics.answer.forbiddenClaimRate),
      ),
      unsupportedCitationRate: mean(
        results.map(({ metrics }) => metrics.answer.unsupportedCitationRate),
      ),
      hallucinationRate: mean(
        results.map(({ metrics }) => metrics.answer.hallucinationRate),
      ),
    },
    latency: {
      retrieval: summarizeLatency(retrievalLatencies),
      generation: summarizeLatency(generationLatencies),
      indexing: summarizeLatency(indexingLatencies),
    },
    usage: {
      embeddingTokens: successful.reduce(
        (total, result) => total + (result.observation?.usage?.embeddingTokens ?? 0),
        0,
      ),
      inputTokens: successful.reduce(
        (total, result) => total + (result.observation?.usage?.inputTokens ?? 0),
        0,
      ),
      outputTokens: successful.reduce(
        (total, result) => total + (result.observation?.usage?.outputTokens ?? 0),
        0,
      ),
    },
    cost: {
      ...(embeddingUsd === undefined ? {} : { embeddingUsd }),
      ...(generationInputUsd === undefined ? {} : { generationInputUsd }),
      ...(generationOutputUsd === undefined ? {} : { generationOutputUsd }),
      totalUsd: (() => {
        const totals = results.flatMap(({ metrics }) =>
          metrics.cost.totalUsd === null ? [] : [metrics.cost.totalUsd],
        );
        return totals.length === 0
          ? null
          : totals.reduce((total, value) => total + value, 0);
      })(),
    },
  };
}

type GateDefinition = {
  thresholdKey: keyof EvaluationThresholds;
  metric: string;
  operator: ">=" | "<=";
  readActual: (aggregate: EvaluationAggregateMetrics) => number | null;
};

const gateDefinitions: readonly GateDefinition[] = [
  { thresholdKey: "minimumCaseSuccessRate", metric: "caseSuccessRate", operator: ">=", readActual: (value) => value.caseSuccessRate },
  { thresholdKey: "minimumRecallAt5", metric: "retrieval.recallAt5", operator: ">=", readActual: (value) => value.retrieval.recallAt5 },
  { thresholdKey: "minimumRecallAt10", metric: "retrieval.recallAt10", operator: ">=", readActual: (value) => value.retrieval.recallAt10 },
  { thresholdKey: "minimumPrecisionAt5", metric: "retrieval.precisionAt5", operator: ">=", readActual: (value) => value.retrieval.precisionAt5 },
  { thresholdKey: "minimumPrecisionAt10", metric: "retrieval.precisionAt10", operator: ">=", readActual: (value) => value.retrieval.precisionAt10 },
  { thresholdKey: "minimumMeanReciprocalRank", metric: "retrieval.meanReciprocalRank", operator: ">=", readActual: (value) => value.retrieval.meanReciprocalRank },
  { thresholdKey: "minimumExactFileHitRate", metric: "retrieval.exactFileHitRate", operator: ">=", readActual: (value) => value.retrieval.exactFileHitRate },
  { thresholdKey: "minimumExactSymbolHitRate", metric: "retrieval.exactSymbolHitRate", operator: ">=", readActual: (value) => value.retrieval.exactSymbolHitRate },
  { thresholdKey: "minimumLineHitRate", metric: "retrieval.lineHitRate", operator: ">=", readActual: (value) => value.retrieval.lineHitRate },
  { thresholdKey: "minimumCitationPrecision", metric: "citations.precision", operator: ">=", readActual: (value) => value.citations.precision },
  { thresholdKey: "minimumCitationRecall", metric: "citations.recall", operator: ">=", readActual: (value) => value.citations.recall },
  { thresholdKey: "minimumCitationGroundedness", metric: "citations.groundedness", operator: ">=", readActual: (value) => value.citations.groundedness },
  { thresholdKey: "minimumAnswerCompleteness", metric: "answer.completeness", operator: ">=", readActual: (value) => value.answer.completeness },
  { thresholdKey: "maximumHallucinationRate", metric: "answer.hallucinationRate", operator: "<=", readActual: (value) => value.answer.hallucinationRate },
  { thresholdKey: "maximumRetrievalP95Ms", metric: "latency.retrieval.p95Ms", operator: "<=", readActual: (value) => value.latency.retrieval.p95Ms },
  { thresholdKey: "maximumGenerationP95Ms", metric: "latency.generation.p95Ms", operator: "<=", readActual: (value) => value.latency.generation.p95Ms },
  { thresholdKey: "maximumIndexingP95Ms", metric: "latency.indexing.p95Ms", operator: "<=", readActual: (value) => value.latency.indexing.p95Ms },
  { thresholdKey: "maximumTotalCostUsd", metric: "cost.totalUsd", operator: "<=", readActual: (value) => value.cost.totalUsd },
];

export function evaluateQualityGates(
  aggregate: EvaluationAggregateMetrics,
  thresholds: EvaluationThresholds,
): EvaluationGateViolation[] {
  return gateDefinitions.flatMap((definition) => {
    const threshold = thresholds[definition.thresholdKey];
    if (threshold === undefined) {
      return [];
    }
    const actual = definition.readActual(aggregate);
    const violated =
      actual === null ||
      (definition.operator === ">="
        ? actual < threshold
        : actual > threshold);
    return violated
      ? [
          {
            metric: definition.metric,
            operator: definition.operator,
            threshold,
            actual,
          } satisfies EvaluationGateViolation,
        ]
      : [];
  });
}

export type CreateEvaluationReportInput = {
  dataset: EvaluationDataset;
  results: readonly EvaluationCaseResult[];
  thresholds?: EvaluationThresholds;
  startedAt: Date;
  completedAt: Date;
};

export function createEvaluationReport(
  input: CreateEvaluationReportInput,
): EvaluationReport {
  const aggregate = aggregateEvaluationResults(input.results);
  const thresholds = input.thresholds ?? {};
  const violations = evaluateQualityGates(aggregate, thresholds);
  return {
    schemaVersion: evaluationSchemaVersion,
    datasetName: input.dataset.name,
    repository: input.dataset.repository,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
    passed:
      aggregate.successfulCaseCount === aggregate.caseCount &&
      violations.length === 0,
    thresholds,
    aggregate,
    violations,
    cases: input.results,
  };
}
