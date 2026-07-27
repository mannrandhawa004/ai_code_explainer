# Vector Store

Shared Qdrant client and collection lifecycle used by the API and indexing worker.

This package owns connectivity, health reporting, collection compatibility checks, and payload indexes. Embedding generation and vector operations are introduced in later development steps.

The shared `code_chunks` collection uses cosine distance and keyword indexes for tenant/repository filtering.

Start Qdrant and run the real integration test from the repository root:

```powershell
docker compose up -d qdrant
$env:QDRANT_TEST_URL="http://127.0.0.1:6333"
npm run test --workspace @codebase-explainer/vector-store
```
