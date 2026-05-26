import { supabase } from "../../../../config/db.config.js";

// Refresh proactively 5 min before expiry — avoids tokens expiring mid-flight.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Simpro token refresh.
 *
 * Key difference from ServiceM8:
 *   Simpro refresh tokens do NOT rotate — the same refresh_token is reused on
 *   every call. No sibling-user sync is needed. The refresh_token only becomes
 *   invalid when the user manually revokes access inside Simpro or calls
 *   our /disconnect endpoint.
 *
 *   ServiceM8 in contrast rotates the refresh token on every use, which
 *   requires syncing the new token across all users sharing the same account.
 */
export const refreshSimproAccessToken = async (
  userId: string,
  refreshToken: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> => {
  console.log(`[Simpro:refresh] 🔄 Starting token refresh for user=${userId}`);

  if (!refreshToken) {
    console.error(`[Simpro:refresh] ❌ No refresh token for user=${userId} — manual reconnect required`);
    throw new Error(`No refresh token for user ${userId}`);
  }

  // Re-read the current DB row before calling Simpro.
  // Another concurrent request for the same user may have already refreshed —
  // if the stored token is still fresh, skip the API call entirely.
  const { data: currentRow } = await supabase
    .from("simpro_integrations")
    .select("access_token, refresh_token, expires_at, base_url")
    .eq("user_id", userId)
    .maybeSingle();

  if (
    currentRow &&
    new Date(currentRow.expires_at).getTime() > Date.now() + REFRESH_BUFFER_MS
  ) {
    console.log(`[Simpro:refresh] ✅ Token already fresh (refreshed by concurrent request) — skipping API call for user=${userId}`);
    return {
      access_token:  currentRow.access_token,
      refresh_token: currentRow.refresh_token ?? refreshToken,
      expires_in:    Math.floor((new Date(currentRow.expires_at).getTime() - Date.now()) / 1000),
    };
  }

  const baseUrl = currentRow?.base_url ?? "";
  const tokenUrl = `${baseUrl.replace(/\/+$/, "")}/oauth2/token`;

  console.log(`[Simpro:refresh] 📡 Calling ${tokenUrl} for user=${userId}`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: currentRow?.refresh_token ?? refreshToken,
      client_id:     process.env.SIMPRO_CLIENT_ID!,
      client_secret: process.env.SIMPRO_CLIENT_SECRET!,
    }),
  });

  const body: any = await res.json();
  console.log(`[Simpro:refresh] 📬 Simpro response status=${res.status}`);

  if (!res.ok) {
    const reason = body?.error_description || body?.error || "unknown";
    console.error(`[Simpro:refresh] ❌ Simpro rejected refresh for user=${userId}: ${reason}`);

    // Mark needs_reauth so the frontend can prompt the user to reconnect.
    await supabase
      .from("simpro_integrations")
      .update({ needs_reauth: true })
      .eq("user_id", userId);

    console.warn(`[Simpro:refresh] 🔒 Marked user=${userId} needs_reauth — user must reconnect Simpro`);
    throw new Error(`Simpro token refresh failed for user ${userId}: ${reason}`);
  }

  const newExpiry = new Date();
  newExpiry.setSeconds(newExpiry.getSeconds() + (body.expires_in || 3600));

  // Simpro does NOT rotate the refresh_token — keep the existing one.
  // body.refresh_token is usually absent; fall back to what we already have.
  const keptRefreshToken = body.refresh_token || currentRow?.refresh_token || refreshToken;

  console.log(`[Simpro:refresh] ⏱  New access token expires_in=${body.expires_in ?? "3600 (default)"}`);

  const { error } = await supabase
    .from("simpro_integrations")
    .update({
      access_token:  body.access_token,
      refresh_token: keptRefreshToken,
      expires_at:    newExpiry.toISOString(),
      needs_reauth:  false,
    })
    .eq("user_id", userId);

  if (error) {
    console.error(`[Simpro:refresh] ❌ DB update failed for user=${userId}:`, error);
    throw new Error(`DB update failed for user ${userId}: ${error.message}`);
  }

  console.log(`[Simpro:refresh] ✅ Token refresh complete for user=${userId}`);
  return {
    access_token:  body.access_token,
    refresh_token: keptRefreshToken,
    expires_in:    body.expires_in || 3600,
  };
};
