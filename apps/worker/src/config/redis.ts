import { Redis } from "ioredis";

export function createWorkerRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    connectionName: "codebase-explainer-indexing-worker",
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    lazyConnect: true,
  });
}
