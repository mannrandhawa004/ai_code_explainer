# Evaluation Suite

Deterministic, repository-specific regression evaluation for the AI Codebase Explainer. The package validates versioned datasets and untrusted adapter output, scores retrieval and cited answers, measures latency and token usage, calculates configurable cost, and applies CI quality gates.

The default test suite makes no network calls and needs no model API key. A live adapter owns provider, Qdrant, database, and authentication setup; the evaluator only receives source metadata and the final answer.

## What is measured

- File-level `Recall@5`, `Recall@10`, `Precision@5`, `Precision@10`, and mean reciprocal rank. Repeated chunks from one file occupy one rank. Precision keeps the full `k` denominator, so returning fewer than `k` files does not inflate the score.
- Exact expected-file and expected-symbol hit rates.
- Overlap with expected file/line ranges.
- Citation precision, expected-source recall, F1, and grounding against retrieved source ranges.
- Deterministic answer completeness using versioned concept aliases.
- A deterministic hallucination proxy: the larger of forbidden-claim rate and unsupported-citation rate. This is useful for regressions but is not a semantic truth judge; human review or a separately versioned judge should supplement it.
- Average and p95 retrieval, generation, and optional indexing latency.
- Embedding, input, and output token totals. USD cost is `null` unless per-million-token pricing is explicitly supplied, so changing provider prices cannot silently change an old evaluation.

Failed or timed-out cases receive zero quality scores and reduce the case success rate. Optional metrics remain `null` when their ground truth is absent, and a configured gate on a `null` metric fails.

## Dataset

The first dataset is [`evaluations/datasets/ai-codebase-explainer.v1.json`](../../evaluations/datasets/ai-codebase-explainer.v1.json). It is pinned to the Step 19 commit because line expectations are commit-specific. Create a new dataset version when questions, expected files, symbols, concepts, or line ranges change; do not rewrite old baselines after a regression.

Every case requires an ID, question, and expected files. It can also define expected symbols, expected line ranges, answer concept aliases, forbidden terms, and tags. Paths must be safe repository-relative paths. Inputs have explicit size limits and unknown fields are rejected.

## Live adapter

Export an object named `evaluationTarget`, or make it the default export. The module is trusted local code and can configure the existing retrieval/generation pipeline from environment variables.

```ts
import type { EvaluationTarget } from "@codebase-explainer/evaluation";

export const evaluationTarget: EvaluationTarget = {
  async evaluate(evaluationCase, { dataset, signal }) {
    const result = await runRepositoryQuestion({
      repository: dataset.repository,
      question: evaluationCase.question,
      signal,
    });

    return {
      answer: result.answer,
      retrievedSources: result.retrievedSources,
      citations: result.citations,
      timings: {
        retrievalMs: result.retrievalMs,
        generationMs: result.generationMs,
        indexingMs: result.indexingMs,
      },
      usage: result.usage,
      metadata: { model: result.model },
    };
  },
};
```

Run it from the repository root:

```powershell
npm run evaluate -- --dataset evaluations/datasets/ai-codebase-explainer.v1.json --adapter path/to/trusted-adapter.ts --thresholds evaluations/thresholds/production.v1.json --output evaluations/reports/latest.json --pretty
```

Live runs default to one case at a time and a 120-second case timeout. `--concurrency` is bounded at 16 and `--timeout-ms` at one hour. The adapter receives an `AbortSignal` for cancellation.

## Recorded observations

Expensive observations can be captured once and rescored offline. A recording must name the exact dataset and map every case ID to an observation:

```json
{
  "schemaVersion": 1,
  "datasetName": "ai-codebase-explainer-v1",
  "observations": {
    "repository-question-pipeline": {
      "answer": "...",
      "retrievedSources": [
        {
          "filePath": "apps/api/src/services/repository-question.service.ts",
          "symbolName": "RepositoryQuestionService",
          "startLine": 245,
          "endLine": 430,
          "score": 0.91
        }
      ],
      "citations": [
        {
          "filePath": "apps/api/src/services/repository-question.service.ts",
          "startLine": 245,
          "endLine": 430
        }
      ],
      "timings": { "retrievalMs": 40, "generationMs": 1200 },
      "usage": { "embeddingTokens": 18, "inputTokens": 2200, "outputTokens": 300 }
    }
  }
}
```

```powershell
npm run evaluate -- --dataset evaluations/datasets/ai-codebase-explainer.v1.json --recording path/to/observations.json --thresholds evaluations/thresholds/production.v1.json --output evaluations/reports/latest.json --pretty
```

Exit code `0` means all cases and gates passed, `1` means a regression, and `2` means configuration or input was invalid. Reports include answer text; do not commit reports produced from private repositories.

## Development

```powershell
npm run test --workspace @codebase-explainer/evaluation
npm run typecheck --workspace @codebase-explainer/evaluation
npm run build --workspace @codebase-explainer/evaluation
```
