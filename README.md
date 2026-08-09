# AI Codebase Explainer

A production-oriented GenAI application for importing GitHub repositories, indexing source code, and answering natural-language questions with accurate file and line citations.

The implementation follows `AI-Codebase-Explainer-Complete-Project-Guide.md` in its stated development order. Each numbered step is implemented and reviewed separately before work begins on the next one.

## Architecture

```text
apps/web       Next.js frontend
apps/api       Express REST API
apps/worker    BullMQ indexing worker
packages/shared    Shared schemas, types, and constants
packages/ai        Selectable Google/OpenAI/Ollama embedding and generation services
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

## Production readiness

- [x] P1. Containerize and harden the API and worker
- [ ] P2. Add production observability and operational metrics
- [ ] P3. Add CI release, image scanning, and deployment automation
- [ ] P4. Run staging load, failure-recovery, and live evaluation gates

## Current state

Production step P1 adds separate multi-stage API and worker container targets, non-root Tini runtimes, an API health check, worker-only Git, a hardened local application Compose profile, and fail-fast production TLS/provider validation. See the [deployment guide](docs/deployment.md).

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Git
- Docker Desktop (required beginning with the database/vector-storage steps)
- A [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key) for hosted embeddings and chat

Copy `.env.example` to `.env` when configuration is introduced. Never commit `.env` or credentials.

Start local infrastructure with `docker compose up -d`, then run the API and worker in separate terminals with `npm run dev --workspace @codebase-explainer/api` and `npm run dev --workspace @codebase-explainer/worker`. To run both backend processes in containers, use `docker compose --profile application up --build`. The Compose databases are for local development only; production uses managed TLS services.

## Lightweight AI with Google Gemini

OpenAI API billing is separate from ChatGPT Plus. For learning and testing on a low-resource computer, this project uses Google Gemini's hosted free tier by default. No local model or OpenAI credit is required. Create a key in [Google AI Studio](https://aistudio.google.com/app/apikey), then use these matching values in `.env`:

```dotenv
AI_PROVIDER=google
GOOGLE_API_KEY=your_key_here
GOOGLE_EMBEDDING_MODEL=gemini-embedding-2
GOOGLE_EMBEDDING_DIMENSIONS=768
GOOGLE_CHAT_MODEL=gemini-2.5-flash-lite
QDRANT_COLLECTION=code_chunks_google_768
QDRANT_VECTOR_SIZE=768
INDEXING_MAX_ATTEMPTS=1
```

The embedding model and Qdrant dimensions must match. A separate collection name prevents older OpenAI or Ollama collections with different vector sizes from conflicting with the 768-dimension Google vectors. The key remains in the backend environment and is never sent to the browser.

Google currently offers free-tier text embedding and Flash-Lite usage, subject to account and rate limits. Google states that free-tier content may be used to improve its products, so use public/sample repositories for learning unless that data policy is acceptable. For private or sensitive code, use an appropriate paid account and review its current data-use terms.

The repository page polls its `/status` endpoint while indexing, so repeated status requests in browser DevTools are expected and do not start new indexing runs. Queue attempts are set to one in the local example; the Retry Indexing button remains available. Provider quota and credential failures do not automatically restart the clone pipeline.
