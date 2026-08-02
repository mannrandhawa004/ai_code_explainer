import {
  createEvaluationReport,
  createFailedCaseMetrics,
  scoreEvaluationCase,
} from "./metrics.js";
import {
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationDataset,
  type EvaluationFailure,
  type EvaluationPricing,
  type EvaluationRecording,
  type EvaluationReport,
  type EvaluationTarget,
  type EvaluationThresholds,
} from "./types.js";
import {
  EvaluationValidationError,
  parseEvaluationDataset,
  parseEvaluationObservation,
  parseEvaluationRecording,
} from "./validation.js";

export const defaultEvaluationConcurrency = 1;
export const maximumEvaluationConcurrency = 16;
export const defaultEvaluationCaseTimeoutMs = 120_000;
export const maximumEvaluationCaseTimeoutMs = 3_600_000;

export type EvaluationRunnerConfig = {
  target: EvaluationTarget;
  concurrency?: number;
  caseTimeoutMs?: number;
  thresholds?: EvaluationThresholds;
  pricing?: EvaluationPricing;
  now?: () => Date;
};

export type EvaluationRunOptions = {
  signal?: AbortSignal;
};

export class EvaluationRunnerConfigError extends Error {
  override readonly name = "EvaluationRunnerConfigError";
}

class EvaluationCaseTimeoutError extends Error {
  override readonly name = "EvaluationCaseTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Evaluation case exceeded its ${timeoutMs}ms timeout`);
  }
}

class EvaluationCaseAbortedError extends Error {
  override readonly name = "EvaluationCaseAbortedError";

  constructor() {
    super("Evaluation case was cancelled");
  }
}

function assertIntegerWithinRange(
  value: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvaluationRunnerConfigError(
      `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function sanitizeFailure(error: unknown): EvaluationFailure {
  if (error instanceof EvaluationCaseTimeoutError) {
    return { code: "CASE_TIMEOUT", message: error.message };
  }
  if (error instanceof EvaluationCaseAbortedError) {
    return { code: "CASE_ABORTED", message: error.message };
  }
  if (error instanceof EvaluationValidationError) {
    return { code: "INVALID_OBSERVATION", message: error.message };
  }

  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  const code =
    typeof candidate.code === "string" && candidate.code.trim()
      ? candidate.code.trim().slice(0, 100)
      : typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim().slice(0, 100)
        : "TARGET_ERROR";
  const message =
    typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message.replaceAll("\0", "").trim().slice(0, 2_000)
      : "The evaluation target failed";
  return { code, message };
}

function createFailureResult(
  evaluationCase: EvaluationCase,
  failure: EvaluationFailure,
): EvaluationCaseResult {
  return {
    caseId: evaluationCase.id,
    question: evaluationCase.question,
    success: false,
    metrics: createFailedCaseMetrics(evaluationCase),
    failure,
  };
}

async function evaluateWithTimeout(
  target: EvaluationTarget,
  dataset: EvaluationDataset,
  evaluationCase: EvaluationCase,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new EvaluationCaseTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  const cancellation = new Promise<never>((_resolve, reject) => {
    if (parentSignal === undefined) {
      return;
    }
    const abort = (): void => {
      const error = new EvaluationCaseAbortedError();
      controller.abort(parentSignal.reason ?? error);
      reject(error);
    };
    if (parentSignal.aborted) {
      abort();
      return;
    }
    parentSignal.addEventListener("abort", abort, { once: true });
    removeParentListener = () => parentSignal.removeEventListener("abort", abort);
  });

  try {
    return await Promise.race([
      target.evaluate(evaluationCase, {
        dataset,
        signal: controller.signal,
      }),
      timeout,
      cancellation,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    removeParentListener?.();
  }
}

export class EvaluationRunner {
  private readonly concurrency: number;
  private readonly caseTimeoutMs: number;
  private readonly thresholds: EvaluationThresholds;
  private readonly pricing: EvaluationPricing;
  private readonly now: () => Date;

  constructor(private readonly config: EvaluationRunnerConfig) {
    if (
      typeof config.target !== "object" ||
      config.target === null ||
      typeof config.target.evaluate !== "function"
    ) {
      throw new EvaluationRunnerConfigError(
        "target must expose an evaluate function",
      );
    }
    this.concurrency = config.concurrency ?? defaultEvaluationConcurrency;
    this.caseTimeoutMs = config.caseTimeoutMs ?? defaultEvaluationCaseTimeoutMs;
    this.thresholds = config.thresholds ?? {};
    this.pricing = config.pricing ?? {};
    this.now = config.now ?? (() => new Date());
    assertIntegerWithinRange(
      this.concurrency,
      1,
      maximumEvaluationConcurrency,
      "concurrency",
    );
    assertIntegerWithinRange(
      this.caseTimeoutMs,
      1,
      maximumEvaluationCaseTimeoutMs,
      "caseTimeoutMs",
    );
  }

  async run(
    dataset: EvaluationDataset,
    options: EvaluationRunOptions = {},
  ): Promise<EvaluationReport> {
    const validatedDataset = parseEvaluationDataset(dataset);
    const startedAt = this.now();
    const results = new Array<EvaluationCaseResult>(
      validatedDataset.cases.length,
    );
    let nextCaseIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (nextCaseIndex < validatedDataset.cases.length) {
        const caseIndex = nextCaseIndex;
        nextCaseIndex += 1;
        const evaluationCase = validatedDataset.cases[caseIndex];
        if (evaluationCase === undefined) {
          continue;
        }
        try {
          const rawObservation = await evaluateWithTimeout(
            this.config.target,
            validatedDataset,
            evaluationCase,
            this.caseTimeoutMs,
            options.signal,
          );
          const observation = parseEvaluationObservation(
            rawObservation,
            `target observation for ${evaluationCase.id}`,
          );
          results[caseIndex] = {
            caseId: evaluationCase.id,
            question: evaluationCase.question,
            success: true,
            observation,
            metrics: scoreEvaluationCase(
              evaluationCase,
              observation,
              this.pricing,
            ),
          };
        } catch (error) {
          results[caseIndex] = createFailureResult(
            evaluationCase,
            sanitizeFailure(error),
          );
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrency, validatedDataset.cases.length) },
        runWorker,
      ),
    );
    const completedAt = this.now();
    return createEvaluationReport({
      dataset: validatedDataset,
      results,
      thresholds: this.thresholds,
      startedAt,
      completedAt,
    });
  }
}

export type EvaluateRecordingOptions = {
  thresholds?: EvaluationThresholds;
  pricing?: EvaluationPricing;
  now?: () => Date;
};

export function evaluateRecording(
  dataset: EvaluationDataset,
  recording: EvaluationRecording,
  options: EvaluateRecordingOptions = {},
): EvaluationReport {
  const validatedDataset = parseEvaluationDataset(dataset);
  const validatedRecording = parseEvaluationRecording(recording);
  if (validatedRecording.datasetName !== validatedDataset.name) {
    throw new EvaluationValidationError(
      `Recording dataset ${validatedRecording.datasetName} does not match ${validatedDataset.name}`,
    );
  }
  const knownCaseIds = new Set(validatedDataset.cases.map(({ id }) => id));
  const unknownCaseId = Object.keys(validatedRecording.observations).find(
    (caseId) => !knownCaseIds.has(caseId),
  );
  if (unknownCaseId !== undefined) {
    throw new EvaluationValidationError(
      `Recording contains an unknown case id: ${unknownCaseId}`,
    );
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const results = validatedDataset.cases.map(
    (evaluationCase): EvaluationCaseResult => {
      const observation = validatedRecording.observations[evaluationCase.id];
      if (observation === undefined) {
        return createFailureResult(evaluationCase, {
          code: "MISSING_OBSERVATION",
          message: `Recording does not contain case ${evaluationCase.id}`,
        });
      }
      return {
        caseId: evaluationCase.id,
        question: evaluationCase.question,
        success: true,
        observation,
        metrics: scoreEvaluationCase(
          evaluationCase,
          observation,
          options.pricing,
        ),
      };
    },
  );
  const completedAt = now();
  return createEvaluationReport({
    dataset: validatedDataset,
    results,
    ...(options.thresholds === undefined
      ? {}
      : { thresholds: options.thresholds }),
    startedAt,
    completedAt,
  });
}
