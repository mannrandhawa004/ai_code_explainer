# Observability Guide

The API and worker retain their structured, credential-redacted Pino logs and expose separate Prometheus registries. Metrics use bounded operational labels only: repository IDs, user IDs, file paths, questions, commits, and job IDs are deliberately excluded.

## Endpoints

| Service | Health | Metrics | Default address |
|---|---|---|---|
| API | `GET /api/health` | `GET /api/metrics` | `http://127.0.0.1:5000` |
| Worker | `GET /health` | `GET /metrics` | `http://127.0.0.1:9464` |

Local development permits an empty metrics token. Set one whenever other users or hosts can reach the service. Production validation requires a token of at least 32 characters while the relevant metrics endpoint is enabled.

```powershell
$headers = @{ Authorization = "Bearer $env:METRICS_BEARER_TOKEN" }
Invoke-WebRequest http://127.0.0.1:5000/api/metrics -Headers $headers
Invoke-WebRequest http://127.0.0.1:9464/metrics -Headers $headers
```

Store the token in the monitoring system's secret store. Do not place it in a Prometheus file committed to source control. The endpoints return `Cache-Control: no-store`.

## Metric catalog

| Signal | Metrics |
|---|---|
| API traffic and errors | `codebase_explainer_api_http_requests_total`, `codebase_explainer_api_http_request_duration_seconds`, `codebase_explainer_api_http_requests_in_flight`, `codebase_explainer_api_errors_total` |
| Queue length | `codebase_explainer_api_queue_jobs` with `queue` and `state` labels |
| MongoDB, Redis, and Qdrant latency | `codebase_explainer_api_dependency_duration_seconds` |
| Chat embedding/generation calls and tokens | `codebase_explainer_api_ai_requests_total`, `codebase_explainer_api_ai_request_duration_seconds`, `codebase_explainer_api_ai_tokens_total` |
| Indexing and webhook success/failure/duration | `codebase_explainer_worker_jobs_total`, `codebase_explainer_worker_job_duration_seconds` |
| Active, stalled, and failed worker events | `codebase_explainer_worker_active_jobs`, `codebase_explainer_worker_stalled_jobs_total`, `codebase_explainer_worker_errors_total` |
| Indexed volume | `codebase_explainer_worker_indexed_files_total`, `codebase_explainer_worker_indexed_chunks_total` |
| Worker Qdrant latency | `codebase_explainer_worker_dependency_duration_seconds` |
| Embedding requests and tokens | `codebase_explainer_worker_ai_requests_total`, `codebase_explainer_worker_ai_request_duration_seconds`, `codebase_explainer_worker_ai_tokens_total` |
| Runtime health | `codebase_explainer_api_process_*`, `codebase_explainer_worker_process_*` |

Queue collection is fail-open: a Redis/BullMQ collection failure increments `codebase_explainer_api_metric_collection_errors_total{collector="bullmq"}` and does not fail the scrape or an application request. Dependency and AI instrumentation also cannot change the result of the operation being measured.

## Initial alerts

Tune thresholds after observing real staging traffic. These expressions are useful starting points:

```promql
# More than 5% API 5xx responses for 10 minutes.
sum(rate(codebase_explainer_api_http_requests_total{status_class="5xx"}[10m]))
/
clamp_min(sum(rate(codebase_explainer_api_http_requests_total[10m])), 0.001) > 0.05

# Waiting indexing work is building up.
codebase_explainer_api_queue_jobs{queue="indexing",state="waiting"} > 20

# An indexing attempt failed in the last 15 minutes.
increase(codebase_explainer_worker_jobs_total{queue="indexing",outcome="failure"}[15m]) > 0

# A GitHub webhook job failed in the last 15 minutes.
increase(codebase_explainer_worker_jobs_total{queue="github_webhook",outcome="failure"}[15m]) > 0

# Qdrant p95 latency is above two seconds.
histogram_quantile(0.95,
  sum by (le) (rate(codebase_explainer_worker_dependency_duration_seconds_bucket{dependency="qdrant",outcome="success"}[10m]))) > 2

# Metrics queue collection has failed.
increase(codebase_explainer_api_metric_collection_errors_total{collector="bullmq"}[10m]) > 0
```

Use provider dashboards alongside these application metrics for account-wide quota, billing, and rate-limit visibility. Pino logs remain the source for individual request/job investigations through `requestId`, repository/job context, and normalized error details; those identifiers stay out of Prometheus labels to prevent unbounded cardinality.
