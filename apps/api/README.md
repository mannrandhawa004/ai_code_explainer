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
GET /api/repositories/:id/import-graph
GET /api/repositories/:id/symbol-graph
GET /api/repositories/:id/symbol-references?symbol=:symbolName
GET /api/repositories/:id/application-flow?route=:routeName
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

The import-graph endpoint is available only after indexing is complete. It loads file metadata for the authenticated user's repository, selected branch, and exact indexed commit, then returns deterministic file nodes, resolved internal relative-import edges, unresolved internal imports, incoming/outgoing degrees, and strongly connected cycle groups. Third-party packages and imported binding names are intentionally excluded because they are not repository-file edges. Graph construction is bounded to 5,000 files and 50,000 internal import declarations.

The symbol-graph endpoint uses those same ownership, branch, and commit boundaries, then resolves identifiers recorded inside indexed symbols to matching repository definitions. Duplicate names remain explicit: an ambiguous reference links to every matching definition and increments `ambiguousReferences` rather than silently choosing one. The symbol-reference endpoint powers "Where is this used?" queries with definition and usage-site lists. Usage line ranges identify the enclosing function, class, method, route, or other indexed symbol; exact identifier-token positions are not stored. Symbol graphs are bounded to 5,000 files, 10,000 symbols, 100,000 inspected reference names, and 50,000 resolved edges, while a lookup is bounded to 1,000 usage sites.

The application-flow endpoint derives route-controller-service-model paths from the indexed symbol types, file naming conventions, and resolved references. Direct callable handlers referenced by Express routes are promoted to the controller layer when they are not already classified. Edges move only forward through architectural layers, duplicate definitions remain explicitly ambiguous, and `complete` flow paths are those that reach a model. Pass the exact indexed route name, such as `GET /users/:id`, to return only that route's reachable subgraph. Output is bounded to 5,000 files, 10,000 symbols, 100,000 inspected reference names, 50,000 edges, and 1,000 enumerated paths; `flowsTruncated` reports path truncation.

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
