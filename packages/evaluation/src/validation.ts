import {
  evaluationSchemaVersion,
  type EvaluationAnswerConcept,
  type EvaluationCase,
  type EvaluationCitation,
  type EvaluationDataset,
  type EvaluationLineRange,
  type EvaluationObservation,
  type EvaluationPricing,
  type EvaluationRecording,
  type EvaluationRepository,
  type EvaluationSource,
  type EvaluationThresholds,
  type EvaluationTimings,
  type EvaluationUsage,
} from "./types.js";

const maximumEvaluationCases = 1_000;
const maximumSourcesPerObservation = 10_000;
const maximumArrayItems = 200;
const maximumQuestionCharacters = 10_000;
const maximumAnswerCharacters = 1_000_000;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const commitShaPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export class EvaluationValidationError extends Error {
  override readonly name = "EvaluationValidationError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new EvaluationValidationError(`${fieldName} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new EvaluationValidationError(
      `${fieldName} contains an unknown field: ${unknown}`,
    );
  }
}

function readString(
  value: unknown,
  fieldName: string,
  maximumCharacters = 1_000,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.length > maximumCharacters
  ) {
    throw new EvaluationValidationError(
      `${fieldName} must be a non-empty safe string of at most ${maximumCharacters} characters`,
    );
  }
  return value.trim();
}

function readIdentifier(value: unknown, fieldName: string): string {
  const identifier = readString(value, fieldName, 128);
  if (!identifierPattern.test(identifier)) {
    throw new EvaluationValidationError(
      `${fieldName} must contain only lowercase letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return identifier;
}

function readFiniteNonNegativeNumber(
  value: unknown,
  fieldName: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EvaluationValidationError(
      `${fieldName} must be a finite non-negative number`,
    );
  }
  return value;
}

function readFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EvaluationValidationError(`${fieldName} must be a finite number`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EvaluationValidationError(
      `${fieldName} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function readPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new EvaluationValidationError(
      `${fieldName} must be a positive safe integer`,
    );
  }
  return value as number;
}

function readArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximumArrayItems) {
    throw new EvaluationValidationError(
      `${fieldName} must be an array with at most ${maximumArrayItems} items`,
    );
  }
  return value;
}

function requireUnique(values: readonly string[], fieldName: string): void {
  if (new Set(values).size !== values.length) {
    throw new EvaluationValidationError(`${fieldName} must not contain duplicates`);
  }
}

export function normalizeRepositoryPath(
  value: unknown,
  fieldName = "filePath",
): string {
  const normalized = readString(value, fieldName, 4_096).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new EvaluationValidationError(
      `${fieldName} must be a normalized repository-relative path`,
    );
  }
  return normalized;
}

function readStringArray(
  value: unknown,
  fieldName: string,
  options: { minimumItems?: number; maximumCharacters?: number } = {},
): string[] {
  const items = readArray(value, fieldName).map((item, index) =>
    readString(
      item,
      `${fieldName}[${index}]`,
      options.maximumCharacters ?? 1_000,
    ),
  );
  if (items.length < (options.minimumItems ?? 0)) {
    throw new EvaluationValidationError(
      `${fieldName} must contain at least ${options.minimumItems ?? 0} item(s)`,
    );
  }
  requireUnique(items, fieldName);
  return items;
}

function readRepository(value: unknown): EvaluationRepository {
  const repository = readRecord(value, "repository");
  assertKnownKeys(repository, "repository", [
    "owner",
    "name",
    "branch",
    "commitSha",
  ]);
  const commitSha =
    repository.commitSha === undefined
      ? undefined
      : readString(repository.commitSha, "repository.commitSha", 64);
  if (commitSha !== undefined && !commitShaPattern.test(commitSha)) {
    throw new EvaluationValidationError(
      "repository.commitSha must be a lowercase 40- or 64-character hexadecimal commit hash",
    );
  }
  return {
    owner: readString(repository.owner, "repository.owner", 200),
    name: readString(repository.name, "repository.name", 200),
    ...(repository.branch === undefined
      ? {}
      : { branch: readString(repository.branch, "repository.branch", 500) }),
    ...(commitSha === undefined ? {} : { commitSha }),
  };
}

function readLineRange(
  value: unknown,
  fieldName: string,
  expectedFiles: ReadonlySet<string>,
): EvaluationLineRange {
  const range = readRecord(value, fieldName);
  assertKnownKeys(range, fieldName, ["filePath", "startLine", "endLine"]);
  const filePath = normalizeRepositoryPath(range.filePath, `${fieldName}.filePath`);
  const startLine = readPositiveInteger(range.startLine, `${fieldName}.startLine`);
  const endLine = readPositiveInteger(range.endLine, `${fieldName}.endLine`);
  if (endLine < startLine) {
    throw new EvaluationValidationError(
      `${fieldName}.endLine must be greater than or equal to startLine`,
    );
  }
  if (!expectedFiles.has(filePath)) {
    throw new EvaluationValidationError(
      `${fieldName}.filePath must also appear in expectedFiles`,
    );
  }
  return { filePath, startLine, endLine };
}

function readAnswerConcept(
  value: unknown,
  fieldName: string,
): EvaluationAnswerConcept {
  const concept = readRecord(value, fieldName);
  assertKnownKeys(concept, fieldName, ["id", "terms"]);
  return {
    id: readIdentifier(concept.id, `${fieldName}.id`),
    terms: readStringArray(concept.terms, `${fieldName}.terms`, {
      minimumItems: 1,
      maximumCharacters: 500,
    }),
  };
}

function readEvaluationCase(value: unknown, index: number): EvaluationCase {
  const fieldName = `cases[${index}]`;
  const evaluationCase = readRecord(value, fieldName);
  assertKnownKeys(evaluationCase, fieldName, [
    "id",
    "question",
    "expectedFiles",
    "expectedSymbols",
    "expectedLineRanges",
    "expectedAnswerConcepts",
    "forbiddenAnswerTerms",
    "tags",
  ]);
  const expectedFiles = readArray(
    evaluationCase.expectedFiles,
    `${fieldName}.expectedFiles`,
  ).map((filePath, fileIndex) =>
    normalizeRepositoryPath(
      filePath,
      `${fieldName}.expectedFiles[${fileIndex}]`,
    ),
  );
  if (expectedFiles.length === 0) {
    throw new EvaluationValidationError(
      `${fieldName}.expectedFiles must contain at least one file`,
    );
  }
  requireUnique(expectedFiles, `${fieldName}.expectedFiles`);

  const expectedAnswerConcepts =
    evaluationCase.expectedAnswerConcepts === undefined
      ? undefined
      : readArray(
          evaluationCase.expectedAnswerConcepts,
          `${fieldName}.expectedAnswerConcepts`,
        ).map((concept, conceptIndex) =>
          readAnswerConcept(
            concept,
            `${fieldName}.expectedAnswerConcepts[${conceptIndex}]`,
          ),
        );
  if (expectedAnswerConcepts !== undefined) {
    requireUnique(
      expectedAnswerConcepts.map(({ id }) => id),
      `${fieldName}.expectedAnswerConcepts ids`,
    );
  }
  const expectedLineRanges =
    evaluationCase.expectedLineRanges === undefined
      ? undefined
      : readArray(
          evaluationCase.expectedLineRanges,
          `${fieldName}.expectedLineRanges`,
        ).map((range, rangeIndex) =>
          readLineRange(
            range,
            `${fieldName}.expectedLineRanges[${rangeIndex}]`,
            new Set(expectedFiles),
          ),
        );
  if (expectedLineRanges !== undefined) {
    requireUnique(
      expectedLineRanges.map(
        ({ filePath, startLine, endLine }) =>
          `${filePath}:${startLine}:${endLine}`,
      ),
      `${fieldName}.expectedLineRanges`,
    );
  }

  return {
    id: readIdentifier(evaluationCase.id, `${fieldName}.id`),
    question: readString(
      evaluationCase.question,
      `${fieldName}.question`,
      maximumQuestionCharacters,
    ),
    expectedFiles,
    ...(evaluationCase.expectedSymbols === undefined
      ? {}
      : {
          expectedSymbols: readStringArray(
            evaluationCase.expectedSymbols,
            `${fieldName}.expectedSymbols`,
          ),
        }),
    ...(expectedLineRanges === undefined ? {} : { expectedLineRanges }),
    ...(expectedAnswerConcepts === undefined
      ? {}
      : { expectedAnswerConcepts }),
    ...(evaluationCase.forbiddenAnswerTerms === undefined
      ? {}
      : {
          forbiddenAnswerTerms: readStringArray(
            evaluationCase.forbiddenAnswerTerms,
            `${fieldName}.forbiddenAnswerTerms`,
            { maximumCharacters: 500 },
          ),
        }),
    ...(evaluationCase.tags === undefined
      ? {}
      : {
          tags: readStringArray(
            evaluationCase.tags,
            `${fieldName}.tags`,
            { maximumCharacters: 100 },
          ),
        }),
  };
}

export function parseEvaluationDataset(value: unknown): EvaluationDataset {
  const dataset = readRecord(value, "dataset");
  assertKnownKeys(dataset, "dataset", [
    "schemaVersion",
    "name",
    "description",
    "repository",
    "cases",
  ]);
  if (dataset.schemaVersion !== evaluationSchemaVersion) {
    throw new EvaluationValidationError(
      `dataset.schemaVersion must equal ${evaluationSchemaVersion}`,
    );
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new EvaluationValidationError("dataset.cases must be a non-empty array");
  }
  if (dataset.cases.length > maximumEvaluationCases) {
    throw new EvaluationValidationError(
      `dataset.cases cannot exceed ${maximumEvaluationCases} cases`,
    );
  }
  const cases = dataset.cases.map(readEvaluationCase);
  requireUnique(
    cases.map(({ id }) => id),
    "dataset case ids",
  );
  return {
    schemaVersion: evaluationSchemaVersion,
    name: readIdentifier(dataset.name, "dataset.name"),
    ...(dataset.description === undefined
      ? {}
      : {
          description: readString(
            dataset.description,
            "dataset.description",
            5_000,
          ),
        }),
    repository: readRepository(dataset.repository),
    cases,
  };
}

function readSource(value: unknown, fieldName: string): EvaluationSource {
  const source = readRecord(value, fieldName);
  assertKnownKeys(source, fieldName, [
    "id",
    "filePath",
    "symbolName",
    "startLine",
    "endLine",
    "score",
  ]);
  const startLine = readPositiveInteger(source.startLine, `${fieldName}.startLine`);
  const endLine = readPositiveInteger(source.endLine, `${fieldName}.endLine`);
  if (endLine < startLine) {
    throw new EvaluationValidationError(
      `${fieldName}.endLine must be greater than or equal to startLine`,
    );
  }
  return {
    ...(source.id === undefined
      ? {}
      : { id: readString(source.id, `${fieldName}.id`, 500) }),
    filePath: normalizeRepositoryPath(source.filePath, `${fieldName}.filePath`),
    ...(source.symbolName === undefined
      ? {}
      : {
          symbolName: readString(
            source.symbolName,
            `${fieldName}.symbolName`,
            1_000,
          ),
        }),
    startLine,
    endLine,
    ...(source.score === undefined
      ? {}
      : { score: readFiniteNumber(source.score, `${fieldName}.score`) }),
  };
}

function readCitation(value: unknown, fieldName: string): EvaluationCitation {
  const citation = readRecord(value, fieldName);
  assertKnownKeys(citation, fieldName, [
    "filePath",
    "symbolName",
    "startLine",
    "endLine",
  ]);
  const source = readSource(citation, fieldName);
  return {
    filePath: source.filePath,
    ...(source.symbolName === undefined ? {} : { symbolName: source.symbolName }),
    startLine: source.startLine,
    endLine: source.endLine,
  };
}

function readTimings(value: unknown, fieldName: string): EvaluationTimings {
  const timings = readRecord(value, fieldName);
  assertKnownKeys(timings, fieldName, [
    "retrievalMs",
    "generationMs",
    "indexingMs",
  ]);
  return {
    retrievalMs: readFiniteNonNegativeNumber(
      timings.retrievalMs,
      `${fieldName}.retrievalMs`,
    ),
    generationMs: readFiniteNonNegativeNumber(
      timings.generationMs,
      `${fieldName}.generationMs`,
    ),
    ...(timings.indexingMs === undefined
      ? {}
      : {
          indexingMs: readFiniteNonNegativeNumber(
            timings.indexingMs,
            `${fieldName}.indexingMs`,
          ),
        }),
  };
}

function readUsage(value: unknown, fieldName: string): EvaluationUsage {
  const usage = readRecord(value, fieldName);
  assertKnownKeys(usage, fieldName, [
    "embeddingTokens",
    "inputTokens",
    "outputTokens",
  ]);
  return {
    ...(usage.embeddingTokens === undefined
      ? {}
      : {
          embeddingTokens: readNonNegativeInteger(
            usage.embeddingTokens,
            `${fieldName}.embeddingTokens`,
          ),
        }),
    ...(usage.inputTokens === undefined
      ? {}
      : {
          inputTokens: readNonNegativeInteger(
            usage.inputTokens,
            `${fieldName}.inputTokens`,
          ),
        }),
    ...(usage.outputTokens === undefined
      ? {}
      : {
          outputTokens: readNonNegativeInteger(
            usage.outputTokens,
            `${fieldName}.outputTokens`,
          ),
        }),
  };
}

function readMetadata(
  value: unknown,
  fieldName: string,
): Record<string, string | number | boolean | null> {
  const metadata = readRecord(value, fieldName);
  if (Object.keys(metadata).length > 100) {
    throw new EvaluationValidationError(
      `${fieldName} cannot contain more than 100 fields`,
    );
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(metadata)) {
    readString(key, `${fieldName} key`, 200);
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new EvaluationValidationError(
        `${fieldName}.${key} must be a JSON scalar`,
      );
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new EvaluationValidationError(
        `${fieldName}.${key} must be finite`,
      );
    }
    if (typeof item === "string" && item.length > 10_000) {
      throw new EvaluationValidationError(
        `${fieldName}.${key} cannot exceed 10000 characters`,
      );
    }
    result[key] = item;
  }
  return result;
}

export function parseEvaluationObservation(
  value: unknown,
  fieldName = "observation",
): EvaluationObservation {
  const observation = readRecord(value, fieldName);
  assertKnownKeys(observation, fieldName, [
    "answer",
    "retrievedSources",
    "citations",
    "timings",
    "usage",
    "metadata",
  ]);
  if (
    !Array.isArray(observation.retrievedSources) ||
    observation.retrievedSources.length > maximumSourcesPerObservation
  ) {
    throw new EvaluationValidationError(
      `${fieldName}.retrievedSources must be an array with at most ${maximumSourcesPerObservation} items`,
    );
  }
  if (
    !Array.isArray(observation.citations) ||
    observation.citations.length > maximumSourcesPerObservation
  ) {
    throw new EvaluationValidationError(
      `${fieldName}.citations must be an array with at most ${maximumSourcesPerObservation} items`,
    );
  }
  return {
    answer: readString(observation.answer, `${fieldName}.answer`, maximumAnswerCharacters),
    retrievedSources: observation.retrievedSources.map((source, index) =>
      readSource(source, `${fieldName}.retrievedSources[${index}]`),
    ),
    citations: observation.citations.map((citation, index) =>
      readCitation(citation, `${fieldName}.citations[${index}]`),
    ),
    timings: readTimings(observation.timings, `${fieldName}.timings`),
    ...(observation.usage === undefined
      ? {}
      : { usage: readUsage(observation.usage, `${fieldName}.usage`) }),
    ...(observation.metadata === undefined
      ? {}
      : {
          metadata: readMetadata(
            observation.metadata,
            `${fieldName}.metadata`,
          ),
        }),
  };
}

export function parseEvaluationRecording(value: unknown): EvaluationRecording {
  const recording = readRecord(value, "recording");
  assertKnownKeys(recording, "recording", [
    "schemaVersion",
    "datasetName",
    "observations",
  ]);
  if (recording.schemaVersion !== evaluationSchemaVersion) {
    throw new EvaluationValidationError(
      `recording.schemaVersion must equal ${evaluationSchemaVersion}`,
    );
  }
  const observations = readRecord(recording.observations, "recording.observations");
  if (Object.keys(observations).length > maximumEvaluationCases) {
    throw new EvaluationValidationError(
      `recording.observations cannot exceed ${maximumEvaluationCases} cases`,
    );
  }
  const parsed: Record<string, EvaluationObservation> = {};
  for (const [caseId, observation] of Object.entries(observations)) {
    readIdentifier(caseId, `recording observation id ${caseId}`);
    parsed[caseId] = parseEvaluationObservation(
      observation,
      `recording.observations.${caseId}`,
    );
  }
  return {
    schemaVersion: evaluationSchemaVersion,
    datasetName: readIdentifier(recording.datasetName, "recording.datasetName"),
    observations: parsed,
  };
}

const rateThresholdKeys = [
  "minimumCaseSuccessRate",
  "minimumRecallAt5",
  "minimumRecallAt10",
  "minimumPrecisionAt5",
  "minimumPrecisionAt10",
  "minimumMeanReciprocalRank",
  "minimumExactFileHitRate",
  "minimumExactSymbolHitRate",
  "minimumLineHitRate",
  "minimumCitationPrecision",
  "minimumCitationRecall",
  "minimumCitationGroundedness",
  "minimumAnswerCompleteness",
  "maximumHallucinationRate",
] as const;

const nonNegativeThresholdKeys = [
  "maximumRetrievalP95Ms",
  "maximumGenerationP95Ms",
  "maximumIndexingP95Ms",
  "maximumTotalCostUsd",
] as const;

export function parseEvaluationThresholds(value: unknown): EvaluationThresholds {
  const thresholds = readRecord(value, "thresholds");
  assertKnownKeys(thresholds, "thresholds", [
    ...rateThresholdKeys,
    ...nonNegativeThresholdKeys,
  ]);
  const parsed: Record<string, number> = {};
  for (const key of rateThresholdKeys) {
    const candidate = thresholds[key];
    if (candidate === undefined) {
      continue;
    }
    const rate = readFiniteNonNegativeNumber(candidate, `thresholds.${key}`);
    if (rate > 1) {
      throw new EvaluationValidationError(
        `thresholds.${key} must be between 0 and 1`,
      );
    }
    parsed[key] = rate;
  }
  for (const key of nonNegativeThresholdKeys) {
    const candidate = thresholds[key];
    if (candidate !== undefined) {
      parsed[key] = readFiniteNonNegativeNumber(
        candidate,
        `thresholds.${key}`,
      );
    }
  }
  return parsed;
}

export function parseEvaluationPricing(value: unknown): EvaluationPricing {
  const pricing = readRecord(value, "pricing");
  assertKnownKeys(pricing, "pricing", [
    "embeddingUsdPerMillionTokens",
    "inputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
  ]);
  return {
    ...(pricing.embeddingUsdPerMillionTokens === undefined
      ? {}
      : {
          embeddingUsdPerMillionTokens: readFiniteNonNegativeNumber(
            pricing.embeddingUsdPerMillionTokens,
            "pricing.embeddingUsdPerMillionTokens",
          ),
        }),
    ...(pricing.inputUsdPerMillionTokens === undefined
      ? {}
      : {
          inputUsdPerMillionTokens: readFiniteNonNegativeNumber(
            pricing.inputUsdPerMillionTokens,
            "pricing.inputUsdPerMillionTokens",
          ),
        }),
    ...(pricing.outputUsdPerMillionTokens === undefined
      ? {}
      : {
          outputUsdPerMillionTokens: readFiniteNonNegativeNumber(
            pricing.outputUsdPerMillionTokens,
            "pricing.outputUsdPerMillionTokens",
          ),
        }),
  };
}
