import "dotenv/config";

/**
 * Connection URL for the Redis-protocol store (KeyDB, Valkey, Redis, etc.).
 * Prefer KEYDB_URL; REDIS_URL is accepted as a temporary fallback.
 */
export function getKeydbUrl(): string {
  const url = process.env.KEYDB_URL ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error("KEYDB_URL is not set");
  }
  return url;
}

/** Connection options for BullMQ (ioredis). */
export function getKeydbConnection() {
  return { url: getKeydbUrl() };
}
