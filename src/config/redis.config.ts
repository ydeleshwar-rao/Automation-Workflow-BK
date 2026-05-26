import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Plain config object — pass this to BullMQ Queue and Worker.
// BullMQ creates and manages its own internal Redis connections from this config,
// preventing any connection sharing between the queue producer and worker consumer.
export const bullMQConnection: ConnectionOptions = {
  url: REDIS_URL,
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
};

// Separate IORedis instance for app-level use (health checks, etc.)
export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redisConnection.on("error", (err: Error) => {
  console.error("[Redis] connection error:", err.message);
});

redisConnection.on("connect", () => {
  console.log("[Redis] connected");
});
