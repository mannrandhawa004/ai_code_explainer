# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS manifests
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/ai/package.json ./packages/ai/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/evaluation/package.json ./packages/evaluation/package.json
COPY packages/repository/package.json ./packages/repository/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/vector-store/package.json ./packages/vector-store/package.json

FROM manifests AS dependency-base
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

FROM dependency-base AS production-dependencies
RUN npm ci --omit=dev --no-audit --no-fund \
    --include-workspace-root=false \
    --workspace @codebase-explainer/api \
    --workspace @codebase-explainer/worker \
    --workspace @codebase-explainer/ai \
    --workspace @codebase-explainer/database \
    --workspace @codebase-explainer/repository \
    --workspace @codebase-explainer/shared \
    --workspace @codebase-explainer/vector-store
RUN node -e "const fs = require('node:fs'); for (const path of ['/workspace/node_modules/typescript', '/workspace/node_modules/.bin/tsc', '/workspace/node_modules/.bin/tsserver']) fs.rmSync(path, { recursive: true, force: true });"

FROM dependency-base AS build
RUN npm ci --no-audit --no-fund

COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY packages/ai ./packages/ai
COPY packages/database ./packages/database
COPY packages/repository ./packages/repository
COPY packages/shared ./packages/shared
COPY packages/vector-store ./packages/vector-store
COPY scripts/verify-built-backend.mjs ./scripts/verify-built-backend.mjs

RUN npm run build --workspace @codebase-explainer/api
RUN npm run build --workspace @codebase-explainer/worker
RUN npm run verify:backend-runtime

FROM ${NODE_IMAGE} AS runtime
WORKDIR /workspace

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build /workspace/packages/ai/package.json ./packages/ai/package.json
COPY --from=build /workspace/packages/ai/dist ./packages/ai/dist
COPY --from=build /workspace/packages/database/package.json ./packages/database/package.json
COPY --from=build /workspace/packages/database/dist ./packages/database/dist
COPY --from=build /workspace/packages/repository/package.json ./packages/repository/package.json
COPY --from=build /workspace/packages/repository/dist ./packages/repository/dist
COPY --from=build /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /workspace/packages/shared/dist ./packages/shared/dist
COPY --from=build /workspace/packages/vector-store/package.json ./packages/vector-store/package.json
COPY --from=build /workspace/packages/vector-store/dist ./packages/vector-store/dist

LABEL org.opencontainers.image.source="https://github.com/mannrandhawa004/ai_code_explainer" \
      org.opencontainers.image.licenses="UNLICENSED"

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime AS api
LABEL org.opencontainers.image.title="AI Codebase Explainer API" \
      org.opencontainers.image.description="Express API for repository import and grounded codebase questions"

ENV API_PORT=5000
EXPOSE 5000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.API_PORT || '5000') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
LABEL org.opencontainers.image.title="AI Codebase Explainer Worker" \
      org.opencontainers.image.description="BullMQ repository indexing and GitHub webhook worker"

USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

ENV TEMP_REPOSITORY_DIR=/tmp/codebase-explainer \
    WORKER_METRICS_HOST=0.0.0.0 \
    WORKER_METRICS_PORT=9464
EXPOSE 9464
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "if (process.env.WORKER_METRICS_ENABLED === 'false') process.exit(0); fetch('http://127.0.0.1:' + (process.env.WORKER_METRICS_PORT || '9464') + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "apps/worker/dist/index.js"]
