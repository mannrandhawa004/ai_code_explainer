export const evaluationSchemaVersion = 1 as const;

export type EvaluationRepository = {
  owner: string;
  name: string;
  branch?: string;
  commitSha?: string;
};

export type EvaluationLineRange = {
  filePath: string;
  startLine: number;
  endLine: number;
};

export type EvaluationAnswerConcept = {
  id: string;
  terms: readonly string[];
};

export type EvaluationCase = {
  id: string;
  question: string;
  expectedFiles: readonly string[];
  expectedSymbols?: readonly string[];
  expectedLineRanges?: readonly EvaluationLineRange[];
  expectedAnswerConcepts?: readonly EvaluationAnswerConcept[];
  forbiddenAnswerTerms?: readonly string[];
  tags?: readonly string[];
};

export type EvaluationDataset = {
  schemaVersion: typeof evaluationSchemaVersion;
  name: string;
  description?: string;
  repository: EvaluationRepository;
  cases: readonly EvaluationCase[];
};

export type EvaluationSource = {
  id?: string;
  filePath: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  score?: number;
};

export type EvaluationCitation = {
  filePath: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
};

export type EvaluationTimings = {
  retrievalMs: number;
  generationMs: number;
  indexingMs?: number;
};

export type EvaluationUsage = {
  embeddingTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type EvaluationObservation = {
  answer: string;
  retrievedSources: readonly EvaluationSource[];
  citations: readonly EvaluationCitation[];
  timings: EvaluationTimings;
  usage?: EvaluationUsage;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
};

export type EvaluationRecording = {
  schemaVersion: typeof evaluationSchemaVersion;
  datasetName: string;
  observations: Readonly<Record<string, EvaluationObservation>>;
};

export type EvaluationPricing = {
  embeddingUsdPerMillionTokens?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
};

export type EvaluationThresholds = {
  minimumCaseSuccessRate?: number;
  minimumRecallAt5?: number;
  minimumRecallAt10?: number;
  minimumPrecisionAt5?: number;
  minimumPrecisionAt10?: number;
  minimumMeanReciprocalRank?: number;
  minimumExactFileHitRate?: number;
  minimumExactSymbolHitRate?: number;
  minimumLineHitRate?: number;
  minimumCitationPrecision?: number;
  minimumCitationRecall?: number;
  minimumCitationGroundedness?: number;
  minimumAnswerCompleteness?: number;
  maximumHallucinationRate?: number;
  maximumRetrievalP95Ms?: number;
  maximumGenerationP95Ms?: number;
  maximumIndexingP95Ms?: number;
  maximumTotalCostUsd?: number;
};

export type RetrievalEvaluationMetrics = {
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  precisionAt10: number;
  meanReciprocalRank: number;
  exactFileHitRate: number;
  exactSymbolHitRate: number | null;
  lineHitRate: number | null;
};

export type CitationEvaluationMetrics = {
  precision: number;
  recall: number;
  f1: number;
  groundedness: number;
};

export type AnswerEvaluationMetrics = {
  completeness: number;
  forbiddenClaimRate: number;
  unsupportedCitationRate: number;
  hallucinationRate: number;
};

export type EvaluationCost = {
  embeddingUsd?: number;
  generationInputUsd?: number;
  generationOutputUsd?: number;
  totalUsd: number | null;
};

export type EvaluationCaseMetrics = {
  retrieval: RetrievalEvaluationMetrics;
  citations: CitationEvaluationMetrics;
  answer: AnswerEvaluationMetrics;
  cost: EvaluationCost;
};

export type EvaluationFailure = {
  code: string;
  message: string;
};

export type EvaluationCaseResult = {
  caseId: string;
  question: string;
  success: boolean;
  observation?: EvaluationObservation;
  metrics: EvaluationCaseMetrics;
  failure?: EvaluationFailure;
};

export type EvaluationLatencySummary = {
  averageMs: number | null;
  p95Ms: number | null;
};

export type EvaluationAggregateMetrics = {
  caseCount: number;
  successfulCaseCount: number;
  caseSuccessRate: number;
  retrieval: RetrievalEvaluationMetrics;
  citations: CitationEvaluationMetrics;
  answer: AnswerEvaluationMetrics;
  latency: {
    retrieval: EvaluationLatencySummary;
    generation: EvaluationLatencySummary;
    indexing: EvaluationLatencySummary;
  };
  usage: {
    embeddingTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  cost: EvaluationCost;
};

export type EvaluationGateViolation = {
  metric: string;
  operator: ">=" | "<=";
  threshold: number;
  actual: number | null;
};

export type EvaluationReport = {
  schemaVersion: typeof evaluationSchemaVersion;
  datasetName: string;
  repository: EvaluationRepository;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  passed: boolean;
  thresholds: EvaluationThresholds;
  aggregate: EvaluationAggregateMetrics;
  violations: readonly EvaluationGateViolation[];
  cases: readonly EvaluationCaseResult[];
};

export type EvaluationTargetContext = {
  dataset: EvaluationDataset;
  signal: AbortSignal;
};

export interface EvaluationTarget {
  evaluate(
    evaluationCase: EvaluationCase,
    context: EvaluationTargetContext,
  ): Promise<EvaluationObservation>;
}
