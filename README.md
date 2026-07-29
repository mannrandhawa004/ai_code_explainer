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
- [ ] 14. Build Next.js chat interface
- [ ] 15. Add BullMQ worker
- [ ] 16. Add Tree-sitter
- [ ] 17. Add GitHub App
- [ ] 18. Add webhooks
- [ ] 19. Add incremental indexing
- [ ] 20. Add evaluations

## Current state

Step 13 adds strict structured answer output with retrieved-source IDs, server-side citation validation and rendering, API source metadata, and citation persistence on assistant messages. Each answer segment must cite retrieved evidence, and model-invented source IDs or malformed citation output fail closed.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git
- Docker Desktop (required beginning with the database/vector-storage steps)

Copy `.env.example` to `.env` when configuration is introduced. Never commit `.env` or credentials.
