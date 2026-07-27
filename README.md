# AI Codebase Explainer

A production-oriented GenAI application for importing GitHub repositories, indexing source code, and answering natural-language questions with accurate file and line citations.

The implementation follows `AI-Codebase-Explainer-Complete-Project-Guide.md` in its stated development order. Each numbered step is implemented and reviewed separately before work begins on the next one.

## Architecture

```text
apps/web       Next.js frontend
apps/api       Express REST API
apps/worker    BullMQ indexing worker
packages/shared    Shared schemas, types, and constants
packages/database  MongoDB models and database helpers
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
- [ ] 3. Create Express API
- [ ] 4. Connect MongoDB
- [ ] 5. Start Qdrant
- [ ] 6. Build public repository clone service
- [ ] 7. Build file scanner
- [ ] 8. Build file filtering
- [ ] 9. Build line-based chunker
- [ ] 10. Generate embeddings
- [ ] 11. Store vectors
- [ ] 12. Build repository question endpoint
- [ ] 13. Add source citations
- [ ] 14. Build Next.js chat interface
- [ ] 15. Add BullMQ worker
- [ ] 16. Add Tree-sitter
- [ ] 17. Add GitHub App
- [ ] 18. Add webhooks
- [ ] 19. Add incremental indexing
- [ ] 20. Add evaluations

## Current state

Step 2 establishes strict shared TypeScript defaults and environment-specific compiler configurations for the web, API, worker, and reusable packages. Runtime dependencies, application code, infrastructure, and tests are intentionally added in their corresponding later steps.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git
- Docker Desktop (required beginning with the database/vector-storage steps)

Copy `.env.example` to `.env` when configuration is introduced. Never commit `.env` or credentials.
