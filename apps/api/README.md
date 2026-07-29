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
POST /api/repositories/:id/chat
```

The chat endpoint validates a server-authenticated user, checks repository ownership and indexing status before provider calls, retrieves only the repository's current tenant/branch/commit vectors, generates a grounded response, and persists the exchange with model, usage, and latency metadata. Authentication is fail-closed until an authentication middleware supplies `response.locals.authenticatedUserId`; request body fields and unverified headers are never accepted as identity.

Request body:

```json
{
  "question": "How does authentication work?",
  "conversationId": "optional MongoDB ObjectId"
}
```

Source citations are intentionally added in Step 13.

The API foundation also includes validated environment configuration, security headers, an explicit CORS allowlist, request IDs, structured logging, rate limiting, JSON body limits, consistent error responses, and graceful shutdown.
