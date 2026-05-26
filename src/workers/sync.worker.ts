/**
 * BullMQ worker — processes sync jobs from the "sync" queue.
 *
 * Each job runs the full stream-based paginated sync for the requested
 * integration + entity.  On failure BullMQ retries automatically
 * (exponential backoff: 15s → 30s → 60s, max 3 attempts).
 *
 * Because syncViaStream writes checkpoints after every committed chunk,
 * a retry resumes from the last committed page — not from scratch.
 *
 * Start this worker alongside the API server:
 *   import "./workers/sync.worker.js";   ← add to server.ts
 */

import { Worker, Job } from "bullmq";
import { bullMQConnection } from "../config/redis.config.js";
import type { SyncJobData } from "../queues/sync.queue.js";
import { getQueueHealth } from "../queues/sync.queue.js";

// Lazy imports — avoid loading the heavy service classes at module level so
// the worker doesn't pull in all integration code until a job actually runs.
async function runSync(job: Job<SyncJobData>) {
  const { userId, integration, batchSize } = job.data;

  await job.updateProgress(5);

  if (integration === "commusoft") {
    const { CommusoftService } = await import(
      "../modules/initgrations/commusoft/service/commusoft.service.js"
    );
    await job.updateProgress(10);
    const result = await CommusoftService.syncAll(userId, batchSize);
    await job.updateProgress(100);
    return result;
  }

  if (integration === "servicem8") {
    const { ServiceM8Service } = await import(
      "../modules/initgrations/serviceM8/service/serviceM8.service.js"
    );
    await job.updateProgress(10);
    const result = await ServiceM8Service.syncAll(userId);
    await job.updateProgress(100);
    return result;
  }

  throw new Error(`Unknown integration: ${integration}`);
}

export const syncWorker = new Worker<SyncJobData>(
  "sync",
  async (job: Job<SyncJobData>) => {
    console.log(
      `[SYNC:worker] ▶ start jobId=${job.id} integration=${job.data.integration} user=${job.data.userId} attempt=${job.attemptsMade + 1}`
    );

    try {
      const result = await runSync(job);
      console.log(`[SYNC:worker] ✅ done jobId=${job.id}`, result);
      return result;
    } catch (err: any) {
      console.error(
        `[SYNC:worker] ❌ failed jobId=${job.id} attempt=${job.attemptsMade + 1}:`,
        err?.message ?? err
      );
      throw err; // rethrow so BullMQ marks job as failed and schedules retry
    }
  },
  {
    connection: bullMQConnection,
    concurrency: 3,
    lockDuration: 5 * 60 * 1000,
    stalledInterval: 15_000,   // check for stalled jobs every 15s (default 30s)
    maxStalledCount: 1,        // move stalled job back to waiting after 1 check
  }
);

syncWorker.on("completed", (job, result) => {
  console.log("─────────────────────────────────────────");
  console.log(`[SYNC:worker] ✅ JOB COMPLETED  jobId=${job.id}`);
  console.log(`[SYNC:worker]    integration=${job.data.integration}  user=${job.data.userId}`);
  console.log(`[SYNC:worker]    result=`, JSON.stringify(result, null, 2));
  console.log("─────────────────────────────────────────");
});

syncWorker.on("failed", (job, err) => {
  console.error("─────────────────────────────────────────");
  console.error(`[SYNC:worker] ❌ JOB FAILED  jobId=${job?.id}  attempts=${job?.attemptsMade}`);
  console.error(`[SYNC:worker]    error=${err.message}`);
  console.error("─────────────────────────────────────────");
});

syncWorker.on("progress", (job, progress) => {
  console.log(`[SYNC:worker] ⏳ progress jobId=${job.id} progress=${progress}%`);
});

syncWorker.on("stalled", (jobId) => {
  console.warn(`[SYNC:worker] ⚠ stalled jobId=${jobId} — will be retried`);
});

syncWorker.on("error", (err) => {
  console.error("[SYNC:worker] ❌ worker error:", err.message);
});

// Log when worker is ready + show current queue depth
syncWorker.on("ready", () => {
  console.log("[SYNC:worker] ✅ worker connected to Redis and ready");
  getQueueHealth()
    .then((h) =>
      console.log(
        `[SYNC:worker] queue depth — waiting=${h.waiting} active=${h.active} failed=${h.failed} completed=${h.completed}`
      )
    )
    .catch(() => {});
});
