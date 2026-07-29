# Vector Store

Shared Qdrant collection lifecycle and code-chunk persistence used by the API and indexing worker.

This package owns connectivity, health reporting, collection compatibility checks, payload indexes, validated batched upserts, and tenant-scoped repository deletion.

The shared `code_chunks` collection uses cosine distance. Call `ensureCollection()` once during service startup before accepting writes. Every point uses its deterministic chunk UUID, so retrying an upsert replaces the same point instead of creating a duplicate.

Payloads contain repository identity, branch and commit identity, file/line citation metadata, source content and hashes, symbol metadata, imports/exports, and embedding provenance. Keyword indexes cover `userId`, `repositoryId`, `branch`, `commitSha`, `filePath`, `language`, `symbolName`, `symbolType`, and `contentHash`.

`deleteRepositoryChunks()` always requires both `userId` and `repositoryId`; optional branch and commit filters can narrow cleanup further. Upserts default to 100 points per batch, two concurrent writes, medium write ordering, and `wait: true` completion semantics.

Start Qdrant and run the real integration test from the repository root:

```powershell
docker compose up -d qdrant
$env:QDRANT_TEST_URL="http://127.0.0.1:6333"
npm run test --workspace @codebase-explainer/vector-store
```

Without `QDRANT_TEST_URL`, deterministic unit tests still run and the real Qdrant tests are skipped.
