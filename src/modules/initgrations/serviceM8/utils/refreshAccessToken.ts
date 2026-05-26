import { supabase } from "../../../../config/db.config.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const refreshAccessToken = async (userId: string, refreshToken: string) => {
  console.log(`[ServiceM8 Refresh] 🔄 Starting token refresh for user: ${userId}`);

  if (!refreshToken) {
    console.error(`[ServiceM8 Refresh] ❌ No refresh token found for user ${userId} — manual re-login required`);
    throw new Error(`No refresh token available for user ${userId}`);
  }

  // Re-read the CURRENT row from DB before calling ServiceM8.
  // A sibling user sharing this SM8 account may have already rotated the
  // refresh token — if so, the token passed in is stale and would be rejected.
  const { data: currentRow } = await supabase
    .from("servicem8_integrations")
    .select("access_token, refresh_token, expires_at, sm8_account_uuid")
    .eq("user_id", userId)
    .maybeSingle();

  const sm8AccountUuid: string | null = currentRow?.sm8_account_uuid ?? null;

  if (currentRow && new Date(currentRow.expires_at).getTime() > Date.now() + REFRESH_BUFFER_MS) {
    console.log(`[ServiceM8 Refresh] ✅ Token already refreshed by sibling — skipping API call for user ${userId}`);
    return {
      access_token:  currentRow.access_token,
      refresh_token: currentRow.refresh_token,
      expires_in:    Math.floor((new Date(currentRow.expires_at).getTime() - Date.now()) / 1000),
    };
  }

  // Use the freshest refresh_token from DB, not the (potentially stale) one passed in
  const activeRefreshToken = currentRow?.refresh_token ?? refreshToken;

  console.log(`[ServiceM8 Refresh] 📡 Calling ServiceM8 token endpoint...`);

  const refreshRes = await fetch("https://go.servicem8.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: activeRefreshToken,
      client_id:     process.env.SERVICEM8_CLIENT_ID!,
      client_secret: process.env.SERVICEM8_CLIENT_SECRET!,
    }),
  });

  const refreshData = await refreshRes.json();

  console.log(`[ServiceM8 Refresh] 📬 ServiceM8 response status: ${refreshRes.status}`);

  if (!refreshRes.ok) {
    const reason = refreshData?.error_description || refreshData?.error || "Unknown error";
    console.error(`[ServiceM8 Refresh] ❌ ServiceM8 rejected refresh for user ${userId}: ${reason}`);
    console.error(`[ServiceM8 Refresh] ⚠️  Full error response:`, JSON.stringify(refreshData));

    // Before marking needs_reauth, check if a sibling user refreshed the token
    // while our request was in-flight — that would explain the rejection.
    const { data: recheck } = await supabase
      .from("servicem8_integrations")
      .select("access_token, refresh_token, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (recheck && new Date(recheck.expires_at).getTime() > Date.now() + REFRESH_BUFFER_MS) {
      console.log(`[ServiceM8 Refresh] ✅ Sibling refreshed while we were in-flight — using fresh token for user ${userId}`);
      return {
        access_token:  recheck.access_token,
        refresh_token: recheck.refresh_token,
        expires_in:    Math.floor((new Date(recheck.expires_at).getTime() - Date.now()) / 1000),
      };
    }

    await supabase
      .from("servicem8_integrations")
      .update({ needs_reauth: true })
      .eq("user_id", userId);

    console.warn(`[ServiceM8 Refresh] 🔒 Marked user ${userId} as needs_reauth — they must reconnect ServiceM8`);
    throw new Error(`Token refresh failed for user ${userId}: ${reason}`);
  }

  const newRefreshToken = refreshData.refresh_token || refreshToken;
  const isRotated = !!refreshData.refresh_token;
  console.log(`[ServiceM8 Refresh] 🔑 Refresh token rotated: ${isRotated}`);
  console.log(`[ServiceM8 Refresh] ⏱  New access token expires_in: ${refreshData.expires_in ?? "not provided (defaulting to 3600s)"}`);

  const newAccessExpiry = new Date();
  newAccessExpiry.setSeconds(newAccessExpiry.getSeconds() + (refreshData.expires_in || 3600));

  const tokenUpdate = {
    access_token:  refreshData.access_token,
    refresh_token: newRefreshToken,
    expires_at:    newAccessExpiry.toISOString(),
    needs_reauth:  false,
  };

  // Update this user's row
  const { error } = await supabase
    .from("servicem8_integrations")
    .update(tokenUpdate)
    .eq("user_id", userId);

  if (error) {
    console.error(`[ServiceM8 Refresh] ❌ DB update failed for user ${userId}:`, error);
    throw new Error(`DB update failed for user ${userId}`);
  }

  // Sync the new tokens to every other user connected to the same ServiceM8 account.
  // ServiceM8 rotates refresh tokens — when one user refreshes, all shared-account
  // users must receive the new token or their next refresh attempt will fail.
  if (sm8AccountUuid) {
    const { error: syncError } = await supabase
      .from("servicem8_integrations")
      .update(tokenUpdate)
      .eq("sm8_account_uuid", sm8AccountUuid)
      .neq("user_id", userId);

    if (syncError) {
      console.warn(`[ServiceM8 Refresh] ⚠️  Failed to sync tokens to sibling users for account ${sm8AccountUuid}:`, syncError.message);
    } else {
      console.log(`[ServiceM8 Refresh] 🔄 Synced new tokens to all users sharing sm8_account: ${sm8AccountUuid}`);
    }
  }

  console.log(`[ServiceM8 Refresh] ✅ Token refresh complete for user ${userId}`);
  return refreshData;
};
