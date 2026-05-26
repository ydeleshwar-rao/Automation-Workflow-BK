import { supabase } from "../../../../config/db.config.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const refreshZohoAccessToken = async (
  userId: string,
  refreshToken: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> => {
  console.log(`[Zoho:refresh] 🔄 Starting token refresh for user=${userId}`);

  if (!refreshToken) {
    console.error(`[Zoho:refresh] ❌ No refresh token for user=${userId}`);
    throw new Error(`No refresh token for user ${userId}`);
  }

  const { data: currentRow } = await supabase
    .from("zoho_inventory_integrations")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (
    currentRow?.expires_at &&
    new Date(currentRow.expires_at).getTime() > Date.now() + REFRESH_BUFFER_MS
  ) {
    console.log(`[Zoho:refresh] ✅ Token already fresh for user=${userId}`);
    return {
      access_token: currentRow.access_token,
      refresh_token: currentRow.refresh_token ?? refreshToken,
      expires_in: Math.floor(
        (new Date(currentRow.expires_at).getTime() - Date.now()) / 1000
      ),
    };
  }

  const tokenUrl = `https://accounts.zoho.com/oauth/v2/token`;

  console.log(`[Zoho:refresh] 📡 Calling Zoho token endpoint for user=${userId}`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRow?.refresh_token ?? refreshToken,
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
    }),
  });

  const body: any = await res.json();
  console.log(`[Zoho:refresh] 📬 Zoho response status=${res.status}`);

  if (!res.ok || body.error) {
    const reason = body?.error_description || body?.error || "unknown";
    console.error(`[Zoho:refresh] ❌ Zoho rejected refresh for user=${userId}: ${reason}`);

    await supabase
      .from("zoho_inventory_integrations")
      .update({ needs_reauth: true })
      .eq("user_id", userId);

    throw new Error(`Zoho token refresh failed for user ${userId}: ${reason}`);
  }

  const newExpiry = new Date();
  newExpiry.setSeconds(newExpiry.getSeconds() + (body.expires_in || 3600));

  // Zoho does NOT rotate refresh tokens on standard auth code flow
  const keptRefreshToken =
    body.refresh_token || currentRow?.refresh_token || refreshToken;

  const { error } = await supabase
    .from("zoho_inventory_integrations")
    .update({
      access_token: body.access_token,
      refresh_token: keptRefreshToken,
      expires_at: newExpiry.toISOString(),
      needs_reauth: false,
    })
    .eq("user_id", userId);

  if (error) {
    throw new Error(`DB update failed for user ${userId}: ${error.message}`);
  }

  console.log(`[Zoho:refresh] ✅ Token refresh complete for user=${userId}`);
  return {
    access_token: body.access_token,
    refresh_token: keptRefreshToken,
    expires_in: body.expires_in || 3600,
  };
};
