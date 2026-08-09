# API

Express API for authentication, repository operations, conversations, retrieval, chat, webhooks, and health checks.

## Commands

Run these commands from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/api
npm run test --workspace @codebase-explainer/api
npm run build --workspace @codebase-explainer/api
```

Build the production API image from the repository root with `npm run containers:build:api`. It runs as a non-root user, includes an `/api/health` container check, and receives graceful `SIGTERM` shutdown through Tini. Production additionally requires TLS-managed MongoDB and Redis, HTTPS Qdrant with an API key, and credentials for the selected Google, OpenAI, or optional Ollama provider. See the [deployment guide](../../docs/deployment.md).

## Current endpoints

```text
GET /api/health
GET /api/health/database
GET /api/health/qdrant
GET /api/health/redis
GET /api/auth/github
GET /api/auth/github/callback
POST /api/auth/logout
GET /api/auth/me
GET /api/github/installations
GET /api/github/repositories?installationId=:installationId
GET /api/github/repositories/:owner/:repository/branches?installationId=:installationId
POST /api/github/repositories/:owner/:repository/import
POST /api/github/webhook
POST /api/repositories/import
POST /api/repositories/:id/index
GET /api/repositories/:id/status
POST /api/repositories/:id/index/cancel
POST /api/repositories/:id/chat
```

Public repository imports accept a canonical GitHub URL and optional branch. Private imports use only metadata returned through a user-authorized GitHub App installation. Both persist a tenant-owned repository record, enqueue a deduplicated BullMQ job, and return `202 Accepted` immediately. Active imports return their existing job instead of creating duplicate work. Private reindexing revalidates GitHub access before enqueueing.

```json
{
  "repositoryUrl": "https://github.com/owner/repository",
  "branch": "main"
}
```

Private import request:

```json
{
  "installationId": 501,
  "branch": "main"
}
```

GitHub access and refresh tokens are encrypted with AES-256-GCM and excluded from normal user queries. The browser receives only a signed HttpOnly session cookie. OAuth callback state is stored in a short-lived HttpOnly cookie and compared in constant time. See the root [GitHub App setup guide](../../docs/github-app-setup.md) for permissions and environment variables.

The webhook endpoint is mounted before the normal JSON parser so `X-Hub-Signature-256` is checked against the exact raw UTF-8 body. It accepts only `application/json`, bounds payload size, validates GitHub delivery headers, and reduces supported events to strict queue data. `X-GitHub-Delivery` becomes the BullMQ job ID for replay protection; completed and failed deliveries are retained for 30 days. The API enforces an enqueue deadline below GitHub's ten-second response limit. Unsupported actions and events are safely acknowledged and ignored.

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

All repository routes use the same fail-closed server-authenticated identity contract as chat. Client-supplied identity headers and body fields are ignored. GitHub installation access is validated server-side for repository discovery, branch discovery, imports, and private reindexing. The API foundation also includes validated environment configuration, security headers, an explicit CORS allowlist, request IDs, credential-redacted structured logging, rate limiting, JSON body limits, consistent error responses, and graceful shutdown.
