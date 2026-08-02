import { Redis } from "ioredis";

export function createWorkerRedisConnection(
  redisUrl: string,
  connectionName = "codebase-explainer-indexing-worker",
): Redis {
  return new Redis(redisUrl, {
    connectionName,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    lazyConnect: true,
  });
}
