# API

Express API for authentication, repository operations, conversations, retrieval, chat, webhooks, and health checks.

## Commands

Run these commands from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/api
npm run test --workspace @codebase-explainer/api
npm run build --workspace @codebase-explainer/api
```

## Current endpoint

```text
GET /api/health
GET /api/health/database
GET /api/health/qdrant
```

The API foundation includes validated environment configuration, security headers, an explicit CORS allowlist, request IDs, structured logging, rate limiting, JSON body limits, consistent error responses, and graceful shutdown.
