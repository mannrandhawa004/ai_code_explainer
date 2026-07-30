# Docker

`docker-compose.yml` provides MongoDB, Qdrant, and Redis for local development. Every port is bound to loopback so the services are not exposed to the LAN. Named volumes preserve local database, vector, and queue data between container restarts.

```powershell
docker compose up -d
docker compose ps
docker compose down
```

The Redis container uses append-only persistence so queued jobs survive ordinary container restarts. It is not the production topology: deploy the API and worker separately and use managed MongoDB, Qdrant, and Redis services. The worker enforces `rediss://` for Redis when `NODE_ENV=production`.
