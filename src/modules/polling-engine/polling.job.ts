import cron from "node-cron";
import { runPollingTick, getDefaultPollInterval } from "./polling.runner.js";

/**
 * Registers the polling engine cron job.
 * Runs every 60 seconds — checks for due subscriptions and polls external APIs.
 *
 * Set POLLING_ENABLED=false in .env to disable the cron entirely
 * (manual poll-now via POST /polling/subscriptions/:id/poll-now still works).
 */
export const startPollingJob = () => {
  if (process.env.POLLING_ENABLED === "false") {
    console.log(
      "[PollingJob] ⏸  POLLING_ENABLED=false — cron NOT registered.  " +
      "Use POST /polling/subscriptions/:id/poll-now to test manually."
    );
    return;
  }

  cron.schedule("* * * * *", async () => {
    try {
      await runPollingTick();
    } catch (err: any) {
      console.error("[PollingJob] Tick failed:", err.message);
    }
  });

  const quietStart = process.env.POLL_QUIET_START ?? "—";
  const quietEnd   = process.env.POLL_QUIET_END   ?? "—";
  const interval   = getDefaultPollInterval();
  console.log(
    `[PollingJob] ✅ Polling engine cron registered — tick=60s  default_poll_interval=${interval}s  quiet_hours=${quietStart}h–${quietEnd}h`
  );

  // Run immediately on startup to catch any pending polls
  runPollingTick().catch((err) =>
    console.error("[PollingJob] Startup tick failed:", err.message)
  );
};
