# Worker

The BullMQ worker consumes `index-repository` jobs from the `repository-indexing` queue and runs the repository ingestion pipeline:

```text
clone -> scan/filter/hash -> changed-file chunks -> OpenAI embeddings -> selective Qdrant update -> MongoDB ready state
```

The worker never executes repository code. Clone data lives in a bounded temporary directory and is deleted after success, failure, or cancellation. Every job validates repository ownership and URL identity before cloning. For private repositories it also requires persisted GitHub installation/repository IDs, then creates a short-lived installation token scoped to that repository and read-only contents access. The token is never placed in BullMQ data, a clone URL, command arguments, logs, or an error response; it is used from a restricted temporary Git config that cleanup removes with the clone.

The worker reports structured progress, retries transient dependency failures up to three times, treats unsafe input, revoked private access, and repository-limit failures as unrecoverable, and supports cancellation between phases. Completed indexing persists file imports/exports and normalized symbol/reference records in MongoDB.

The same process runs a separate `github-webhooks` worker. Push deliveries first mint a repository-scoped installation token to verify that access still exists, then persist the latest desired commit and queue matching local repositories. Additional pushes received during an active job update that marker instead of being lost; the active job coalesces and processes the newest branch state before becoming ready. Installation suspension/deletion and `installation_repositories.removed` deliveries mark affected repositories revoked and cancel waiting or active indexing jobs. A persisted revocation timestamp prevents an in-flight worker from later marking the repository ready. Webhook concurrency defaults to one to preserve delivery order; configure it with `GITHUB_WEBHOOK_CONCURRENCY` only after considering event ordering.

Incremental change detection uses content hashes from a fresh safe clone. Existing metadata without per-file chunk counts triggers one complete rebuild. Otherwise only added or modified files reach Tree-sitter and OpenAI. Deleted paths are removed, unchanged vector payloads are promoted to the new commit, and repository statistics and `lastIndexedCommit` are finalized only after synchronous Qdrant writes complete. Repository status is non-ready throughout the update, preventing partially updated search results from being served.

## Commands

Run from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/worker
npm run test --workspace @codebase-explainer/worker
npm run build --workspace @codebase-explainer/worker
```

Build the production worker image with `npm run containers:build:worker`. Git exists only in this image, the process runs as a non-root user under Tini, and clone data belongs on ephemeral storage such as `/tmp/codebase-explainer`. See the [deployment guide](../../docs/deployment.md).

Local development requires MongoDB, Qdrant, and Redis from `docker compose up -d`, plus `OPENAI_API_KEY`. Private indexing and push-webhook processing additionally require `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY`. `INDEXING_CONCURRENCY` is bounded to 1-32 and `GITHUB_WEBHOOK_CONCURRENCY` to 1-8. Production requires TLS-managed MongoDB and Redis, HTTPS Qdrant with an API key, OpenAI credentials, and the GitHub App credentials.

On `SIGINT` or `SIGTERM`, the worker stops taking new jobs, waits for active jobs to finish, closes Redis, and disconnects MongoDB. `WORKER_SHUTDOWN_TIMEOUT_MS` controls the forced-shutdown safety limit.
