# Deployment Guide

The frontend, API, and worker are separate deployment units. Deploy the Next.js frontend to Vercel or an equivalent platform, the API as an HTTP container service, and the worker as a separately scalable background container. Production databases are managed services; do not deploy MongoDB, Redis, or Qdrant from the local Compose file.

## Backend images

One multi-stage Dockerfile produces two independent runtime targets from the same commit:

```powershell
npm run containers:build:api
npm run containers:build:worker
```

Equivalent release commands with registry tags are:

```powershell
docker build --file docker/backend.Dockerfile --target api --tag registry.example.com/codebase-explainer-api:COMMIT_SHA .
docker build --file docker/backend.Dockerfile --target worker --tag registry.example.com/codebase-explainer-worker:COMMIT_SHA .
```

Build and deploy both targets from the same Git commit. The default base follows the supported Node 22 Debian slim line so security rebuilds receive patched OS and Node layers. For a reproducible release, pass a registry digest captured by CI:

```powershell
docker build --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:APPROVED_DIGEST --file docker/backend.Dockerfile --target api --tag registry.example.com/codebase-explainer-api:COMMIT_SHA .
```

The build context excludes Git history, environment files, npm configuration, tests, reports, local data, and build output. The runtime images contain compiled JavaScript and production dependencies, run as the unprivileged `node` user under Tini, use exec-form commands, and stop on `SIGTERM`. Git is installed only in the worker image because only the worker clones repositories.

## Local application containers

The default Compose command still starts only MongoDB, Redis, and Qdrant:

```powershell
docker compose up -d
```

To exercise the containerized API and worker, copy `.env.example` to `.env`, set `GOOGLE_API_KEY` (or select another provider), and configure GitHub values when testing private repositories or webhooks. Then run:

```powershell
docker compose --profile application up --build
```

Start the web application on the host with `npm run dev --workspace @codebase-explainer/web`. It reaches the containerized API at `http://localhost:5000`. The application profile waits for all three data services, exposes only the API on loopback, uses read-only application filesystems, drops Linux capabilities, prevents privilege escalation, bounds process counts, rotates logs, and gives the worker ephemeral non-executable clone storage.

If a locally installed service already uses a default host port, change the matching `CODEBASE_EXPLAINER_*_PORT` value in `.env`. These variables change only the loopback host binding; services inside the Compose network continue to use their standard ports.

Validate Compose without starting services:

```powershell
npm run containers:config
```

## Production services

Use one service per concern:

| Component | Runtime | Scaling signal |
|---|---|---|
| Web | Vercel or equivalent Next.js platform | HTTP traffic |
| API | `api` container target | request latency, chat concurrency, error rate |
| Worker | `worker` container target | BullMQ queue depth, oldest-job age, indexing latency |
| MongoDB | MongoDB Atlas or equivalent | connections, query latency, storage |
| Redis | Redis Cloud, Upstash, or equivalent | queue depth, memory, command latency |
| Qdrant | Qdrant Cloud or equivalent | search/write latency, vector count |

Never use the Compose database ports or named volumes in production. Give the API and worker separate service identities and only the secrets each process needs.

## Required production configuration

Both backend services fail fast unless MongoDB uses `mongodb+srv://` or explicit `tls=true`, Redis uses `rediss://`, Qdrant uses `https://` with an API key, and the selected AI provider is configured. Google accepts `GOOGLE_API_KEY` or `GEMINI_API_KEY`; an OpenAI key is required only when `AI_PROVIDER=openai`.

| Variable | API | Worker | Notes |
|---|:---:|:---:|---|
| `NODE_ENV=production` | Yes | Yes | Enables production validation and secure cookies. |
| `MONGODB_URI` | Yes | Yes | Managed TLS connection string. |
| `REDIS_URL` | Yes | Yes | Must use `rediss://`. |
| `QDRANT_URL` / `QDRANT_API_KEY` | Yes | Yes | HTTPS cloud endpoint and secret. |
| `QDRANT_COLLECTION` / `QDRANT_VECTOR_SIZE` | Yes | Yes | Must match across services. |
| `AI_PROVIDER` | Yes | Yes | Select `google`, `openai`, or `ollama`. |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Conditional | Conditional | One is required for Google; store it only in the platform secret manager. |
| `OPENAI_API_KEY` | Conditional | Conditional | Required for OpenAI; store only in the platform secret manager. |
| Provider model and limit variables | Yes | Yes | Keep embedding model, Qdrant collection, and dimensions aligned. |
| `FRONTEND_URL` | Yes | No | Exact HTTPS origin; this is the CORS allowlist. |
| `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` | Yes | Yes | Worker needs repository-scoped installation tokens. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Yes | No | OAuth is handled by the API. |
| `GITHUB_WEBHOOK_SECRET` | Yes | No | Must match the GitHub App setting. |
| `GITHUB_CALLBACK_URL` | Yes | No | Exact HTTPS API callback URL. |
| `JWT_SECRET` / `ENCRYPTION_KEY` | Yes | No | Session signing and stored-token encryption. |
| `TEMP_REPOSITORY_DIR` | No | Yes | Use ephemeral storage; default is `/tmp/codebase-explainer`. |

The platform must preserve literal newlines in `GITHUB_PRIVATE_KEY`, or store them as `\n` sequences as documented in `.env.example`. Never place secrets in Docker build arguments, image layers, repository files, frontend variables, or logs.

For Vercel, set `NEXT_PUBLIC_API_URL` to the public HTTPS API origin before building the frontend. This value is browser-visible and must never contain credentials.

## Health and shutdown

The API image exposes port `5000` by default and includes a liveness check for `GET /api/health`. Configure the hosting platform to use the same endpoint. Dependency diagnostics are available separately:

```text
GET /api/health/database
GET /api/health/redis
GET /api/health/qdrant
```

Use the lightweight liveness endpoint for automatic restarts; a temporary managed-service outage should not create an API restart loop. Alert on the dependency endpoints instead.

The worker has no public port. Its container process staying alive is the liveness signal; queue depth, completed/failed job events, and log alerts provide readiness and workload health. Set the platform termination grace period above `WORKER_SHUTDOWN_TIMEOUT_MS` so an active indexing phase can stop safely. The API needs at least 15 seconds; the worker default should receive at least 45 seconds.

## Release order and smoke checks

1. Build both backend images from one immutable commit and scan them in CI.
2. Deploy the worker with zero replicas or paused consumption when a data migration requires it. This project currently has no separate migration command; MongoDB validation and Qdrant collection checks happen at runtime.
3. Deploy the API and confirm `/api/health` plus all three dependency endpoints.
4. Start or resume worker replicas and confirm they connect to both BullMQ queues.
5. Deploy the frontend with the final API origin.
6. Update the GitHub App callback and webhook URLs, then verify one signed delivery.
7. Import a small test repository, wait for indexing, ask a known evaluation question, and confirm its file/line citation.

Rollback API and worker to the previous matching image pair. Do not roll back only one service after a schema-affecting release unless that version combination was explicitly tested.
