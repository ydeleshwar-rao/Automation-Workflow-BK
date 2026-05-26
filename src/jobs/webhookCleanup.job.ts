// import cron from "node-cron";
// import { supabase } from "../config/db.config.js";

// // 🟢 1️⃣ Expired Test Webhooks
// async function cleanupExpiredTestWebhooks() {
//   console.log("Running expired test webhook cleanup...");

//   const now = new Date().toISOString();

//   const { data, error } = await supabase
//     .from("webhooks")
//     .update({
//       status: "expired",
//       updated_at: now,
//     })
//     .eq("mode", "test")
//     .eq("status", "active")
//     .lt("expires_at", now)
//     .select();

//   if (error) {
//     console.error("Expired cleanup error:", error.message);
//   } else {
//     console.log(`Expired test webhooks disabled: ${data?.length || 0}`);
//   }
// }

// // 🟢 2️⃣ Unused Live Webhooks (30 days)
// async function cleanupUnusedWebhooks() {
//   console.log("Running unused webhook cleanup...");

//   const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
//   const thresholdDate = new Date(Date.now() - THIRTY_DAYS).toISOString();

//   const { data, error } = await supabase
//     .from("webhooks")
//     .update({
//       status: "disabled",
//       updated_at: new Date().toISOString(),
//     })
//     .eq("mode", "live")
//     .eq("status", "active")
//     .lt("last_triggered_at", thresholdDate)
//     .select();

//   if (error) {
//     console.error("Unused cleanup error:", error.message);
//   } else {
//     console.log(`Unused webhooks disabled: ${data?.length || 0}`);
//   }
// }

// // 🔥 Schedule Jobs

// export function startWebhookCleanupJobs() {

// //   // Every hour
// //   cron.schedule("0 * * * *", async () => {
// //     await cleanupExpiredTestWebhooks();
// //   });

// //   // Daily at 2 AM
// //   cron.schedule("0 2 * * *", async () => {
// //     await cleanupUnusedWebhooks();
// //   });

// // 🔥 Every 1 minute (testing purpose)
// cron.schedule("* * * * *", async () => {
//   await cleanupExpiredTestWebhooks();
//   await cleanupUnusedWebhooks();
// });

//   console.log("Webhook cleanup cron jobs started.");
// }