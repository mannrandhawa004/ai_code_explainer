# Worker

The BullMQ worker consumes `index-repository` jobs from the `repository-indexing` queue and runs the repository ingestion pipeline:

```text
clone -> scan/filter -> Tree-sitter symbol chunks (line fallback) -> OpenAI embeddings -> Qdrant -> MongoDB ready state
```

The worker never executes repository code. Clone data lives in a bounded temporary directory and is deleted after success, failure, or cancellation. Every job validates repository ownership and URL identity before cloning. For private repositories it also requires persisted GitHub installation/repository IDs, then creates a short-lived installation token scoped to that repository and read-only contents access. The token is never placed in BullMQ data, a clone URL, command arguments, logs, or an error response; it is used from a restricted temporary Git config that cleanup removes with the clone.

The worker reports structured progress, retries transient dependency failures up to three times, treats unsafe input, revoked private access, and repository-limit failures as unrecoverable, and supports cancellation between phases. Completed indexing persists file imports/exports and normalized symbol/reference records in MongoDB.

The same process runs a separate `github-webhooks` worker. Push deliveries first mint a repository-scoped installation token to verify that access still exists, then queue full reindex jobs only for local repositories tracking the pushed branch. Installation suspension/deletion and `installation_repositories.removed` deliveries mark affected repositories revoked and cancel waiting or active indexing jobs. A persisted revocation timestamp prevents an in-flight worker from later marking the repository ready. Webhook concurrency defaults to one to preserve delivery order; configure it with `GITHUB_WEBHOOK_CONCURRENCY` only after considering event ordering.

## Commands

Run from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/worker
npm run test --workspace @codebase-explainer/worker
npm run build --workspace @codebase-explainer/worker
```

Local development requires MongoDB, Qdrant, and Redis from `docker compose up -d`, plus `OPENAI_API_KEY`. Private indexing and push-webhook processing additionally require `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY`. `INDEXING_CONCURRENCY` is bounded to 1-32 and `GITHUB_WEBHOOK_CONCURRENCY` to 1-8. Production requires `REDIS_URL` to use `rediss://` and requires the GitHub App credentials.

On `SIGINT` or `SIGTERM`, the worker stops taking new jobs, waits for active jobs to finish, closes Redis, and disconnects MongoDB. `WORKER_SHUTDOWN_TIMEOUT_MS` controls the forced-shutdown safety limit.
