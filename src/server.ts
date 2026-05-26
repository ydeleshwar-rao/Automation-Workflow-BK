import "./config/env.config.js";
import { EventEmitter } from "events";
EventEmitter.defaultMaxListeners = 30; // prevent MaxListenersExceededWarning from TLS/HTTPS pools
import app from "./app.js";
import { startAutoRefreshJob } from "./jobs/autoRefreshJob.js";
import { startPollingJob } from "./modules/polling-engine/polling.job.js";
import { backfillSm8AccountUuids } from "./jobs/backfillSm8AccountUuid.js";
import { restoreAllSessions } from "./modules/initgrations/whatsapp/session/session.manager.js";
import "./workers/sync.worker.js"; // registers BullMQ sync worker

const PORT = process.env.PORT;

async function startServer() {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Start background jobs
    startAutoRefreshJob();
    startPollingJob();

    // One-time migration: populate sm8_account_uuid for existing users
    backfillSm8AccountUuids().catch((e) =>
      console.error("[Backfill] sm8_account_uuid migration failed:", e?.message)
    );

    // Restore WhatsApp sessions for users who were connected before restart
    restoreAllSessions().catch((e) =>
      console.error("[WA Engine] Session restore failed:", e?.message)
    );
  });
}
//http://localhost:5000/auth/leadhub/install
startServer();
