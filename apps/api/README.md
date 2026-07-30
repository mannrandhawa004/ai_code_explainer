# API

Express API for authentication, repository operations, conversations, retrieval, chat, webhooks, and health checks.

## Commands

Run these commands from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/api
npm run test --workspace @codebase-explainer/api
npm run build --workspace @codebase-explainer/api
```

## Current endpoints

```text
GET /api/health
GET /api/health/database
GET /api/health/qdrant
GET /api/health/redis
POST /api/repositories/import
POST /api/repositories/:id/index
GET /api/repositories/:id/status
POST /api/repositories/:id/index/cancel
POST /api/repositories/:id/chat
```

Repository imports accept a canonical public GitHub URL and optional branch, persist a tenant-owned repository record, enqueue a deduplicated BullMQ job, and return `202 Accepted` immediately. Active imports return their existing job instead of creating duplicate work. Status responses expose the persisted phase and percentage; cancellation removes queued jobs or records a cancellation request that an active worker observes between phases.

```json
{
  "repositoryUrl": "https://github.com/owner/repository",
  "branch": "main"
}
```

The chat endpoint validates a server-authenticated user, checks repository ownership and indexing status before provider calls, retrieves only the repository's current tenant/branch/commit vectors, generates a grounded response, and persists the exchange with model, usage, and latency metadata. Authentication is fail-closed until an authentication middleware supplies `response.locals.authenticatedUserId`; request body fields and unverified headers are never accepted as identity.

Request body:

```json
{
  "question": "How does authentication work?",
  "conversationId": "optional MongoDB ObjectId"
}
```

Successful responses include the cited sources next to the rendered answer:

```json
{
  "data": {
    "answer": "Authentication is handled by middleware. [src/auth.ts:L10-L20]",
    "sources": [
      {
        "filePath": "src/auth.ts",
        "startLine": 10,
        "endLine": 20,
        "symbolName": "authenticate"
      }
    ]
  }
}
```

Only sources validated against the retrieved repository chunks are returned and persisted. The deterministic insufficient-context response has an empty `sources` array.

All repository routes use the same fail-closed server-authenticated identity contract as chat. Client-supplied identity headers and body fields are ignored. The API foundation also includes validated environment configuration, security headers, an explicit CORS allowlist, request IDs, structured logging, rate limiting, JSON body limits, consistent error responses, and graceful shutdown.
