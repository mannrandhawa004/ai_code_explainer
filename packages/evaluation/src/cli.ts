#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  readEvaluationJsonFile,
  writeEvaluationReportFile,
} from "./io.js";
import { EvaluationRunner, evaluateRecording } from "./runner.js";
import type {
  EvaluationReport,
  EvaluationTarget,
} from "./types.js";
import {
  parseEvaluationDataset,
  parseEvaluationPricing,
  parseEvaluationRecording,
  parseEvaluationThresholds,
} from "./validation.js";

const helpText = `AI Codebase Explainer evaluation CLI

Usage:
  codebase-eval --dataset <file> --adapter <module> [options]
  codebase-eval --dataset <file> --recording <file> [options]

Inputs:
  --dataset <file>      Versioned evaluation dataset JSON
  --adapter <module>    Trusted module exporting default/evaluationTarget
  --recording <file>    Previously captured observations JSON
  --thresholds <file>   Optional quality-gate JSON
  --pricing <file>      Optional per-million-token USD pricing JSON

Execution:
  --concurrency <n>     Live adapter concurrency (default: 1, maximum: 16)
  --timeout-ms <n>      Per-case timeout (default: 120000)
  --output <file>       Write the complete machine-readable report
  --pretty              Pretty-print the output report
  --help                Show this message

Exactly one of --adapter or --recording is required.`;

function readPositiveInteger(value: string | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function asEvaluationTarget(value: unknown): EvaluationTarget | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { evaluate?: unknown }).evaluate === "function"
  ) {
    return value as EvaluationTarget;
  }
  return undefined;
}

async function loadEvaluationTarget(modulePath: string): Promise<EvaluationTarget> {
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    default?: unknown;
    evaluationTarget?: unknown;
    evaluate?: unknown;
  };
  const target =
    asEvaluationTarget(loaded.default) ??
    asEvaluationTarget(loaded.evaluationTarget) ??
    asEvaluationTarget(loaded);
  if (target === undefined) {
    throw new Error(
      "Adapter module must export an EvaluationTarget as default or evaluationTarget",
    );
  }
  return target;
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function printSummary(report: EvaluationReport, outputPath: string | undefined): void {
  const { aggregate } = report;
  console.log(`Evaluation ${report.passed ? "PASSED" : "FAILED"}: ${report.datasetName}`);
  console.log(
    `Cases ${aggregate.successfulCaseCount}/${aggregate.caseCount} | Recall@5 ${formatRate(aggregate.retrieval.recallAt5)} | MRR ${aggregate.retrieval.meanReciprocalRank.toFixed(3)}`,
  );
  console.log(
    `Citations ${formatRate(aggregate.citations.precision)} precision / ${formatRate(aggregate.citations.groundedness)} grounded | Completeness ${formatRate(aggregate.answer.completeness)} | Hallucination proxy ${formatRate(aggregate.answer.hallucinationRate)}`,
  );
  console.log(
    `Retrieval p95 ${aggregate.latency.retrieval.p95Ms?.toFixed(1) ?? "n/a"}ms | Generation p95 ${aggregate.latency.generation.p95Ms?.toFixed(1) ?? "n/a"}ms | Cost ${aggregate.cost.totalUsd === null ? "n/a" : `$${aggregate.cost.totalUsd.toFixed(6)}`}`,
  );
  for (const violation of report.violations) {
    console.error(
      `Gate failed: ${violation.metric} ${violation.operator} ${violation.threshold}; actual ${violation.actual ?? "n/a"}`,
    );
  }
  if (outputPath !== undefined) {
    console.log(`Report: ${resolve(outputPath)}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      adapter: { type: "string" },
      recording: { type: "string" },
      thresholds: { type: "string" },
      pricing: { type: "string" },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      output: { type: "string" },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    console.log(helpText);
    return;
  }
  if (values.dataset === undefined) {
    throw new Error("--dataset is required");
  }
  if ((values.adapter === undefined) === (values.recording === undefined)) {
    throw new Error("Exactly one of --adapter or --recording is required");
  }

  const dataset = parseEvaluationDataset(
    await readEvaluationJsonFile(resolve(values.dataset)),
  );
  const thresholds =
    values.thresholds === undefined
      ? {}
      : parseEvaluationThresholds(
          await readEvaluationJsonFile(resolve(values.thresholds)),
        );
  const pricing =
    values.pricing === undefined
      ? {}
      : parseEvaluationPricing(
          await readEvaluationJsonFile(resolve(values.pricing)),
        );

  let report: EvaluationReport;
  if (values.recording !== undefined) {
    const recording = parseEvaluationRecording(
      await readEvaluationJsonFile(resolve(values.recording)),
    );
    report = evaluateRecording(dataset, recording, { thresholds, pricing });
  } else {
    const target = await loadEvaluationTarget(values.adapter!);
    const concurrency = readPositiveInteger(values.concurrency, "--concurrency");
    const caseTimeoutMs = readPositiveInteger(values["timeout-ms"], "--timeout-ms");
    const runner = new EvaluationRunner({
      target,
      thresholds,
      pricing,
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(caseTimeoutMs === undefined ? {} : { caseTimeoutMs }),
    });
    report = await runner.run(dataset);
  }

  if (values.output !== undefined) {
    await writeEvaluationReportFile(
      resolve(values.output),
      report,
      values.pretty,
    );
  }
  printSummary(report, values.output);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Evaluation failed unexpectedly";
  console.error(`Evaluation error: ${message}`);
  process.exitCode = 2;
});
