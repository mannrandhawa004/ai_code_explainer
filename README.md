# AI Codebase Explainer

A production-oriented GenAI application for importing GitHub repositories, indexing source code, and answering natural-language questions with accurate file and line citations.

The implementation follows `AI-Codebase-Explainer-Complete-Project-Guide.md` in its stated development order. Each numbered step is implemented and reviewed separately before work begins on the next one.

## Architecture

```text
apps/web       Next.js frontend
apps/api       Express REST API
apps/worker    BullMQ indexing worker
packages/shared    Shared schemas, types, and constants
packages/ai        OpenAI embedding and generation services
packages/evaluation Deterministic RAG evaluation and CI quality gates
packages/database  MongoDB models and database helpers
packages/vector-store  Qdrant client and collection lifecycle
packages/repository  Safe cloning and repository processing
packages/eslint-config  Shared lint configuration
docker         Container definitions
```

The two principal runtime workflows remain separated:

```text
Repository import -> queue -> worker -> parse/chunk -> embeddings -> Qdrant
Question -> hybrid retrieval -> grounded generation -> streamed cited answer
```

## Implementation progress

- [x] 1. Create monorepo
- [x] 2. Configure TypeScript
- [x] 3. Create Express API
- [x] 4. Connect MongoDB
- [x] 5. Start Qdrant
- [x] 6. Build public repository clone service
- [x] 7. Build file scanner
- [x] 8. Build file filtering
- [x] 9. Build line-based chunker
- [x] 10. Generate embeddings
- [x] 11. Store vectors
- [x] 12. Build repository question endpoint
- [x] 13. Add source citations
- [x] 14. Build Next.js chat interface
- [x] 15. Add BullMQ worker
- [x] 16. Add Tree-sitter
- [x] 17. Add GitHub App
- [x] 18. Add webhooks
- [x] 19. Add incremental indexing
- [x] 20. Add evaluations

## Current state

Step 20 adds a versioned, repository-specific evaluation suite with file/symbol/line retrieval metrics, citation correctness and grounding, deterministic completeness and hallucination proxies, latency percentiles, configurable token cost, bounded live-adapter execution, reproducible recorded-observation scoring, and CI quality gates. The baseline dataset is pinned to the Step 19 commit so line expectations cannot drift silently. See the [evaluation guide](packages/evaluation/README.md).

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git
- Docker Desktop (required beginning with the database/vector-storage steps)

Copy `.env.example` to `.env` when configuration is introduced. Never commit `.env` or credentials.

Start local infrastructure with `docker compose up -d`, then run the API and worker in separate terminals with `npm run dev --workspace @codebase-explainer/api` and `npm run dev --workspace @codebase-explainer/worker`. The Redis container is for local development; production should use a managed Redis service over `rediss://`.
