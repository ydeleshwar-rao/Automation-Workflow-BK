import { Request } from "express";
import axios from "axios";
import { ApiError } from "../utils/ApiError.js";
import { supabase } from "../config/db.config.js";
import { verifyAccessToken } from "../modules/auth/jwt.js";

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function redactIntegration(row: any) {
  if (!row || typeof row !== "object") return row;
  return {
    ...row,
    access_token: row.access_token ? "[redacted]" : row.access_token,
    refresh_token: row.refresh_token ? "[redacted]" : row.refresh_token,
  };
}

export const getUserId = async (req: Request): Promise<string> => {
  const jwtUserId = (req as any).user?.id;
  if (jwtUserId && typeof jwtUserId === "string") {
    return jwtUserId;
  }

  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.replace(/^Bearer\s+/i, "").trim()
    : null;
  const cookieToken = readCookie(req.headers.cookie, "jm_access_token");
  const token = cookieToken || headerToken;
  if (token) {
    return verifyAccessToken(token).sub;
  }

  const clientkey = req.headers["clientkey"] || req.query.clientkey;
  if (!clientkey) throw new ApiError(401, "Unauthorized: User ID not found");

  const { data, error } = await supabase.from("profiles")
    .select("id")
    .eq("clientkey", clientkey)
    .single();

  // Distinguish a real "no row found" (PGRST116) from a transport / connection
  // failure. The previous code collapsed both into "profile not found" which
  // sent users on a wild goose chase reconnecting integrations whenever
  // Supabase had a transient outage.
  if (error) {
    if (error.code === "PGRST116") {
      throw new ApiError(404, "Profile not found. Please connect your account first.");
    }
    throw new ApiError(503, `Database temporarily unavailable: ${error.message}`);
  }

  const userId = data?.id;
  if (!userId) {
    throw new ApiError(404, "Profile not found. Please connect your account first.");
  }
  return userId as string;
};

/**
 * Get location_id from leadshub_integrations table using user_id
 * @param userId - UUID of the user
 * @returns location_id string
 */
export const getLocationIdByUserId = async (userId: string): Promise<string> => {
  if (!userId || typeof userId !== "string") {
    throw new ApiError(400, "Invalid or missing user ID");
  }

  const { data, error } = await supabase
    .from("leadshub_integrations")
    .select("location_id")
    .eq("user_id", userId)
   // .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("🟡 [getLocationIdByUserId] userId:", userId, "→ row:", data, "error:", error);

  if (error || !data?.location_id) {
    throw new ApiError(404, "LeadHub integration not found for this user");
  }

  return data.location_id as string;
};


/**
 * Get full LeadHub integration details by location_id
 * @param locationId - Location ID from GHL
 * @returns Full integration record from leadshub_integrations
 */
export const getLeadsHubIntegrationByLocationId = async (locationId: string) => {
  if (!locationId || typeof locationId !== "string") {
    throw new ApiError(400, "Invalid or missing location ID");
  }

  console.log("🔎 [getLeadsHubIntegrationByLocationId] Looking up integration for locationId:", locationId);

  const { data, error } = await supabase
    .from("leadshub_integrations")
    .select("*")
    .eq("location_id", locationId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("🔎 [getLeadsHubIntegrationByLocationId] Supabase result:", {
    data: redactIntegration(data),
    error,
  });

  if (error || !data) {
    const { data: anyRow } = await supabase
      .from("leadshub_integrations")
      .select("location_id, is_active")
      .eq("location_id", locationId);
    console.log("🔎 [getLeadsHubIntegrationByLocationId] Rows for locationId (ignoring is_active):", anyRow);

    throw new ApiError(404, "LeadHub integration not found for this location");
  }

  return data;
};


/**
 * Refresh access token if expired and return valid access token
 * Checks if token is expired and automatically refreshes using refresh_token
 * @param locationId - Location ID from GHL
 * @returns Valid access token string
 */
export const getValidAccessToken = async (locationId: string): Promise<string> => {
  if (!locationId || typeof locationId !== "string") {
    throw new ApiError(400, "Invalid or missing location ID");
  }

  // 1️⃣ Get current integration record
  const integration = await getLeadsHubIntegrationByLocationId(locationId);

  // 2️⃣ Check if token is expired
  const now = new Date();
  const expiresAt = integration.expires_at ? new Date(integration.expires_at) : null;

  if (expiresAt && now < expiresAt) {
    // Token is still valid
    console.log("✅ Access token is still valid for location:", locationId);
    return integration.access_token as string;
  }

  // 3️⃣ Token is expired, refresh it
  console.log("🔄 Access token expired for location:", locationId, "- Refreshing...");

  if (!integration.refresh_token) {
    throw new ApiError(401, "Refresh token not available. Please reconnect your GHL account.");
  }

  try {
    const params = new URLSearchParams();
    params.append("client_id", process.env.GHL_CLIENT_ID!);
    params.append("client_secret", process.env.GHL_CLIENT_SECRET!);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", integration.refresh_token);

    const response = await axios.post(
      "https://services.leadconnectorhq.com/oauth/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const tokenData = response.data;
    const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    // 4️⃣ Update database with new token
    const { error: updateError } = await supabase
      .from("leadshub_integrations")
      .update({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("location_id", locationId);

    if (updateError) {
      throw new ApiError(500, `Failed to update access token: ${updateError.message}`);
    }

    console.log("✅ Access token refreshed successfully for location:", locationId);
    return tokenData.access_token as string;
  } catch (error: any) {
    console.error("❌ Token refresh error:", error.message);

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      401,
      error.response?.data?.error || "Failed to refresh access token"
    );
  }
};

/**
 * Get valid access token by user_id (convenience wrapper)
 * Automatically refreshes if expired
 * @param userId - UUID of the user
 * @returns Valid access token string
 */
export const getValidAccessTokenByUserId = async (userId: string): Promise<string> => {
  const locationId = await getLocationIdByUserId(userId);
  return getValidAccessToken(locationId);
};
