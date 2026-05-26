import { Queue } from "bullmq";
import { bullMQConnection } from "../config/redis.config.js";
import { isSyncOnCooldown } from "../lib/sync/api-to-db.stream.js";

export type SyncJobData = {
  userId: string;
  integration: "commusoft" | "servicem8";
  entity?: string;
  batchSize?: number | undefined;
  force?: boolean;
};

export type EnqueueResult =
  | { queued: true;  jobId: string }
  | { queued: false; reason: "cooldown"; remainingMs: number; lastSyncedAt: string };

export const syncQueue = new Queue<SyncJobData>("sync", {
  connection: bullMQConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: { count: 100 },
    removeOnFail:    { count: 200 },
  },
});

export async function enqueueSyncJob(data: SyncJobData): Promise<EnqueueResult> {
  const jobId = `sync_${data.integration}_${data.userId}_${data.entity ?? "all"}`;

  // ── Cooldown check (skip when force=true) ────────────────────────────────────
  if (!data.force) {
    const cooldown = await isSyncOnCooldown(
      data.userId,
      data.integration,
      data.entity ?? "all"
    );

    if (cooldown.blocked) {
      const mins = Math.ceil(cooldown.remainingMs / 60_000);
      console.log(
        `[SYNC:queue] cooldown active user=${data.userId} integration=${data.integration} remaining=${mins} min`
      );
      return {
        queued: false,
        reason: "cooldown",
        remainingMs: cooldown.remainingMs,
        lastSyncedAt: cooldown.lastSyncedAt,
      };
    }
  }

  // ── Remove any stalled/stuck job with same jobId before re-adding ─────────────
  // This prevents a job stuck in "active" state (from a server crash) from
  // blocking new sync triggers forever.
  try {
    const existing = await syncQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      // Remove if stuck — waiting jobs are fine (dedup), active may be stalled
      if (state === "active" || state === "failed" || state === "unknown") {
        await existing.remove();
        console.log(`[SYNC:queue] removed stuck job state=${state} jobId=${jobId}`);
      }
    }
  } catch {
    // Non-fatal — proceed with add
  }

  const job = await syncQueue.add("sync-job", data, { jobId });

  console.log(`[SYNC:queue] enqueued jobId=${jobId} userId=${data.userId}`);
  return { queued: true, jobId: job.id ?? jobId };
}

export async function getQueueHealth() {
  const [waiting, active, failed, completed] = await Promise.all([
    syncQueue.getWaitingCount(),
    syncQueue.getActiveCount(),
    syncQueue.getFailedCount(),
    syncQueue.getCompletedCount(),
  ]);
  return { waiting, active, failed, completed };
}
