import { refreshAccessToken } from "../utils/refreshAccessToken.js";
import { supabase } from "../../../../config/db.config.js";





const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export async function getServiceM8Token(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("servicem8_integrations")
    .select("access_token, refresh_token, expires_at, needs_reauth")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("ServiceM8 not connected. Please connect first.");
  }

  const now = Date.now();
  const expiresAt = new Date(data.expires_at).getTime();

  // Token is fresh and healthy — use it as-is
  if (!data.needs_reauth && now < expiresAt - REFRESH_BUFFER_MS) {
    return data.access_token;
  }

  // Token expired — delegate to the shared refresh utility so there is only
  // one refresh implementation and the DB update logic stays in one place.
  console.log("Token expired, refreshing...");
  const refreshed = await refreshAccessToken(userId, data.refresh_token);
  return refreshed.access_token;
}