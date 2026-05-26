import { supabase } from "../../../../config/db.config.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const refreshGoogleFormsAccessToken = async (
  userId: string,
  refreshToken: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> => {
  console.log(`[GoogleForms:refresh] 🔄 Starting token refresh for user=${userId}`);

  if (!refreshToken) {
    throw new Error(`No refresh token for user ${userId}`);
  }

  const { data: currentRow } = await supabase
    .from("google_forms_integrations")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (
    currentRow?.expires_at &&
    new Date(currentRow.expires_at).getTime() > Date.now() + REFRESH_BUFFER_MS
  ) {
    console.log(`[GoogleForms:refresh] ✅ Token already fresh for user=${userId}`);
    return {
      access_token: currentRow.access_token,
      refresh_token: currentRow.refresh_token ?? refreshToken,
      expires_in: Math.floor(
        (new Date(currentRow.expires_at).getTime() - Date.now()) / 1000
      ),
    };
  }

  // Google token refresh endpoint
  const res = await fetch(`https://oauth2.googleapis.com/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRow?.refresh_token ?? refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  });

  const body: any = await res.json();

  if (!res.ok || body.error) {
    const reason = body?.error_description || body?.error || "unknown";
    console.error(`[GoogleForms:refresh] ❌ Refresh failed for user=${userId}: ${reason}`);

    await supabase
      .from("google_forms_integrations")
      .update({ needs_reauth: true })
      .eq("user_id", userId);

    throw new Error(`Google token refresh failed: ${reason}`);
  }

  const newExpiry = new Date();
  newExpiry.setSeconds(newExpiry.getSeconds() + (body.expires_in || 3600));

  // Google does NOT rotate refresh tokens — keep existing one
  const keptRefreshToken = currentRow?.refresh_token || refreshToken;

  const { error } = await supabase
    .from("google_forms_integrations")
    .update({
      access_token: body.access_token,
      refresh_token: keptRefreshToken,
      expires_at: newExpiry.toISOString(),
      needs_reauth: false,
    })
    .eq("user_id", userId);

  if (error) throw new Error(`DB update failed: ${error.message}`);

  console.log(`[GoogleForms:refresh] ✅ Token refresh complete for user=${userId}`);
  return {
    access_token: body.access_token,
    refresh_token: keptRefreshToken,
    expires_in: body.expires_in || 3600,
  };
};
