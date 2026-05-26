// src/jobs/autoRefreshJob.ts
import cron from "node-cron";
import { supabase } from "../config/db.config.js";
import { refreshAccessToken } from "../modules/initgrations/serviceM8/utils/refreshAccessToken.js";

const runJob = async () => {
  const jobStart = new Date();
  console.log(`\n[ServiceM8 Job] ====== Auto-refresh sweep started at ${jobStart.toISOString()} ======`);

  // ── 1. Find tokens that need refreshing ────────────────────────────────────
  // Refresh when access token has expired or expires within 10 minutes
  const accessThreshold = new Date();
  accessThreshold.setMinutes(accessThreshold.getMinutes() + 10);

  console.log(`[ServiceM8 Job] 🔍 Querying for tokens expiring before: ${accessThreshold.toISOString()}`);

  // Fetch all users with a refresh_token (active connections)
  const { data: allUsers, error } = await supabase
    .from("servicem8_integrations")
    .select("user_id, refresh_token, expires_at, needs_reauth, sm8_account_uuid")
    .not("refresh_token", "is", null);

  if (error) {
    console.error("[ServiceM8 Job] ❌ DB query failed:", error);
    return;
  }

  if (!allUsers || allUsers.length === 0) {
    console.log("[ServiceM8 Job] ℹ️  No active ServiceM8 connections found.");
    console.log(`[ServiceM8 Job] ====== Sweep complete (0 users) ======\n`);
    return;
  }

  console.log(`[ServiceM8 Job] 📋 Total active connections: ${allUsers.length}`);

  // Filter to only those whose access token is expired or about to expire.
  // For users sharing the same ServiceM8 account (sm8_account_uuid), only
  // refresh ONE — refreshAccessToken syncs new tokens to all siblings automatically.
  // Refreshing multiple users on the same account causes a race: ServiceM8
  // rotates the refresh token on first use, so the second attempt fails and
  // incorrectly sets needs_reauth on the sibling.
  const seenAccounts = new Set<string>();
  const usersToRefresh = allUsers.filter((u) => {
    if (u.needs_reauth) return false;
    if (u.expires_at && new Date(u.expires_at) > accessThreshold) return false;

    const accountKey = u.sm8_account_uuid ?? u.user_id;
    if (seenAccounts.has(accountKey)) {
      console.log(`[ServiceM8 Job] ⏭️  Skipping sibling user ${u.user_id} (account ${accountKey} already queued)`);
      return false;
    }
    seenAccounts.add(accountKey);
    return true;
  });

  const skippedReauth = allUsers.filter((u) => u.needs_reauth);

  console.log(`[ServiceM8 Job] 🔄 Tokens needing refresh     : ${usersToRefresh.length}`);
  console.log(`[ServiceM8 Job] ⏭️  Skipped (needs_reauth flag): ${skippedReauth.length}`);

  if (skippedReauth.length > 0) {
    console.warn(`[ServiceM8 Job] ⚠️  Users awaiting manual reconnect: ${skippedReauth.map((u) => u.user_id).join(", ")}`);
  }

  if (usersToRefresh.length === 0) {
    console.log("[ServiceM8 Job] ✅ All tokens are fresh — nothing to do.");
    console.log(`[ServiceM8 Job] ====== Sweep complete ======\n`);
    return;
  }

  // ── Refresh each token ──────────────────────────────────────────────────────
  let successCount = 0;
  let failCount = 0;

  for (const user of usersToRefresh) {
    console.log(`\n[ServiceM8 Job] ── Processing user: ${user.user_id}`);
    console.log(`[ServiceM8 Job]    access_token expires_at: ${user.expires_at ?? "never set"}`);

    try {
      await refreshAccessToken(user.user_id, user.refresh_token);
      successCount++;
      console.log(`[ServiceM8 Job] ✅ Success for user ${user.user_id} (${successCount}/${usersToRefresh.length})`);
    } catch (err: any) {
      failCount++;
      console.error(`[ServiceM8 Job] ❌ Failed for user ${user.user_id}: ${err?.message ?? err}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const duration = Date.now() - jobStart.getTime();
  console.log(`\n[ServiceM8 Job] ====== Sweep complete ======`);
  console.log(`[ServiceM8 Job] ✅ Refreshed : ${successCount}`);
  console.log(`[ServiceM8 Job] ❌ Failed    : ${failCount}`);
  console.log(`[ServiceM8 Job] ⏱  Duration  : ${duration}ms`);
  console.log(`[ServiceM8 Job] ================================\n`);
};

// Runs every 30 minutes — silently refreshes access tokens before they expire
export const startAutoRefreshJob = () => {
  cron.schedule("*/30 * * * *", async () => {
    await runJob();
  });

  console.log("[ServiceM8 Job] ✅ Auto-refresh cron registered — runs every 30 minutes");

  // Also run immediately on startup to catch any stale tokens right away
  runJob().catch((err) => console.error("[ServiceM8 Job] Startup run failed:", err));
};
