import "dotenv/config";

/**
 * Connection URL for the Redis-protocol store (Valkey, Redis, etc.).
 * Prefer VALKEY_URL; REDIS_URL is accepted as a fallback.
 */
export function getValkeyUrl(): string {
  const url = process.env.VALKEY_URL ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error("VALKEY_URL is not set");
  }
  return url;
}

/** Connection options for BullMQ (ioredis). */
export function getValkeyConnection() {
  return { url: getValkeyUrl() };
}
