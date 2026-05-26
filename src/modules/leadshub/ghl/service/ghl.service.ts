import axios from "axios";
import { Request } from "express";
import { supabase } from "../../../../config/db.config.js";
import { getUserId } from "../../../../common/function.js";

export async function ghlInstallService(req: Request): Promise<string> {
  const baseUrl = process.env.BASE_MARKETPLACE_URL;

  const userId = await getUserId(req);

  const { data: existing } = await supabase
    .from("leadshub_integrations")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (existing) {
    throw Object.assign(new Error("Already connected to LeadsHub"), { statusCode: 409 });
  }

  const statePayload = Buffer.from(JSON.stringify({ userId })).toString("base64url");

  const scope = process.env.GHL_SCOPES!.split(/\s+/).filter(Boolean).join(' ');

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.GHL_CLIENT_ID!,
    redirect_uri: process.env.GHL_REDIRECT_URI!,
    scope,
    state: statePayload,
  });

  return `${baseUrl}?${params.toString()}`;
}

export async function ghlCallbackService(req: Request) {
  const { code, state } = req.query;

  if (!code) {
    throw new Error("Authorization code missing");
  }

  if (!state) {
    throw new Error("State parameter missing");
  }

  let userId: string;
  try {
    const decoded = JSON.parse(Buffer.from(state as string, "base64url").toString("utf8"));
    userId = decoded.userId;
  } catch {
    throw new Error("Invalid state parameter");
  }

  if (!userId) throw new Error("User ID missing in state");

  const params = new URLSearchParams();
  params.append("client_id", process.env.GHL_CLIENT_ID!);
  params.append("client_secret", process.env.GHL_CLIENT_SECRET!);
  params.append("grant_type", "authorization_code");
  params.append("code", code as string);
  params.append("redirect_uri", process.env.GHL_REDIRECT_URI!);

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
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  const { error } = await supabase.from("leadshub_integrations").upsert({
    user_id: userId,
    company_id: tokenData.companyId,
    location_id: tokenData.locationId,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    user_type: tokenData.userType,
    expires_at: expiresAt,
    is_active: true,
  });

  if (error) {
    throw new Error(error.message);
  }

  return true;
}


export async function ghlDisconnectService(userId: string) {
  const { error } = await supabase
    .from("leadshub_integrations")
    .delete()
    .eq("user_id", userId);

  if (error) throw new Error(error.message);

  return true;
}




export async function ghlStatusService(userId: string) {
  const { data, error } = await supabase
    .from("leadshub_integrations")
    .select("company_id, location_id, user_type, is_active, updated_at")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name, email, company_name")
    .eq("id", userId)
    .maybeSingle();

  const ownerName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim();

  return {
    connected: !!data,
    account: data
      ? {
          ownerName: ownerName || profile?.email || null,
          companyName: profile?.company_name ?? null,
          companyId: data.company_id ?? null,
          locationId: data.location_id ?? null,
          userType: data.user_type ?? null,
          connectedAt: data.updated_at ?? null,
        }
      : null,
  };
}
