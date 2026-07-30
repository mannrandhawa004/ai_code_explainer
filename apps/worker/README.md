# Worker

The BullMQ worker consumes `index-repository` jobs from the `repository-indexing` queue and runs the public-repository MVP pipeline:

```text
clone -> scan/filter -> line chunks -> OpenAI embeddings -> Qdrant -> MongoDB ready state
```

The worker never executes repository code. Clone data lives in a bounded temporary directory and is deleted after success, failure, or cancellation. Every job validates repository ownership and URL identity before cloning, reports structured progress, retries transient dependency failures up to three times, treats unsafe input and repository-limit failures as unrecoverable, and supports cancellation between phases.

## Commands

Run from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/worker
npm run test --workspace @codebase-explainer/worker
npm run build --workspace @codebase-explainer/worker
```

Local development requires MongoDB, Qdrant, and Redis from `docker compose up -d`, plus `OPENAI_API_KEY`. `INDEXING_CONCURRENCY` is bounded to 1-32. Production requires `REDIS_URL` to use `rediss://`.

On `SIGINT` or `SIGTERM`, the worker stops taking new jobs, waits for active jobs to finish, closes Redis, and disconnects MongoDB. `WORKER_SHUTDOWN_TIMEOUT_MS` controls the forced-shutdown safety limit.
