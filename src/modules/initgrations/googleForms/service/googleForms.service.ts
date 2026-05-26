import axios, { AxiosInstance } from "axios";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { refreshGoogleFormsAccessToken } from "../utils/refreshAccessToken.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_FORMS_BASE = "https://forms.googleapis.com/v1";
const GOOGLE_DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_API_TIMEOUT_MS = 30_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// OAuth scopes required
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

const refreshLocks = new Map<string, Promise<any>>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoogleFormsIntegrationRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  needs_reauth: boolean;
}

export interface GoogleForm {
  form_id: string;
  title: string;
  description: string;
  responder_uri: string;
  linked_sheet_id: string | null;
}

export interface GoogleFormResponse {
  response_id: string;
  form_id: string;
  create_time: string;
  last_submitted_time: string;
  answers: Record<string, any>;
}

// ─── Integration row helpers ──────────────────────────────────────────────────

const getIntegrationRaw = async (userId: string): Promise<GoogleFormsIntegrationRow> => {
  const { data, error } = await supabase
    .from("google_forms_integrations")
    .select("user_id, access_token, refresh_token, expires_at, needs_reauth")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(
      404,
      "Google Forms integration not found. Please connect your account first."
    );
  }
  return data as GoogleFormsIntegrationRow;
};

export const getIntegration = async (
  userId: string,
  forceRefresh = false
): Promise<GoogleFormsIntegrationRow> => {
  const row = await getIntegrationRaw(userId);

  if (row.needs_reauth) {
    throw new ApiError(401, "Google Forms requires re-authentication. Please reconnect.");
  }

  const isExpiringSoon =
    new Date(row.expires_at).getTime() <= Date.now() + REFRESH_BUFFER_MS;

  if (!isExpiringSoon && !forceRefresh) return row;

  const lockKey = `googleforms:refresh:${userId}`;
  if (refreshLocks.has(lockKey)) {
    await refreshLocks.get(lockKey);
    return await getIntegrationRaw(userId);
  }

  const refreshPromise = refreshGoogleFormsAccessToken(userId, row.refresh_token)
    .then(() => getIntegrationRaw(userId))
    .finally(() => refreshLocks.delete(lockKey));

  refreshLocks.set(lockKey, refreshPromise);
  return await refreshPromise;
};

// ─── Axios clients ────────────────────────────────────────────────────────────

const getFormsClient = (token: string): AxiosInstance =>
  axios.create({
    baseURL: GOOGLE_FORMS_BASE,
    timeout: GOOGLE_API_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${token}` },
  });

const getDriveClient = (token: string): AxiosInstance =>
  axios.create({
    baseURL: GOOGLE_DRIVE_BASE,
    timeout: GOOGLE_API_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${token}` },
  });

async function gFormsRequest<T>(
  userId: string,
  fn: (formsClient: AxiosInstance, driveClient: AxiosInstance) => Promise<T>
): Promise<T> {
  let integration = await getIntegration(userId);
  let formsClient = getFormsClient(integration.access_token);
  let driveClient = getDriveClient(integration.access_token);

  try {
    return await fn(formsClient, driveClient);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      console.warn(`[GoogleForms] 401 for user=${userId} — forcing token refresh`);
      integration = await getIntegration(userId, true);
      formsClient = getFormsClient(integration.access_token);
      driveClient = getDriveClient(integration.access_token);
      return await fn(formsClient, driveClient);
    }
    throw err;
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class GoogleFormsService {
  // ─── OAuth ──────────────────────────────────────────────────────────────

  static getConnectUrl(userId: string): string {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_FORMS_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new ApiError(500, "Google Forms config missing (GOOGLE_CLIENT_ID / GOOGLE_FORMS_REDIRECT_URI)");
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",  // forces refresh_token to be returned
      state: Buffer.from(JSON.stringify({ userId, app: "google_forms" })).toString("base64url"),
    });

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  static async exchangeCodeForTokens(userId: string, code: string): Promise<void> {
    const redirectUri = process.env.GOOGLE_FORMS_REDIRECT_URI!;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const body: any = await res.json();
    if (!res.ok || body.error) {
      throw new ApiError(400, `Google OAuth failed: ${body.error_description || body.error}`);
    }

    if (!body.refresh_token) {
      throw new ApiError(
        400,
        "Google did not return a refresh_token. Revoke access at myaccount.google.com/permissions and reconnect."
      );
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (body.expires_in || 3600));

    const { error } = await supabase.from("google_forms_integrations").upsert({
      user_id: userId,
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: expiresAt.toISOString(),
      needs_reauth: false,
    });

    if (error) throw new ApiError(500, `Failed to save Google tokens: ${error.message}`);
    console.log(`[GoogleForms] ✅ Connected user=${userId}`);
  }

  static async getConnectionStatus(userId: string) {
    const { data } = await supabase
      .from("google_forms_integrations")
      .select("user_id, needs_reauth, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) return { connected: false };
    return { connected: true, needs_reauth: data.needs_reauth, expires_at: data.expires_at };
  }

  static async disconnect(userId: string) {
    const { data: row } = await supabase
      .from("google_forms_integrations")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle();

    // Revoke token at Google
    if (row?.access_token) {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${row.access_token}`,
        { method: "POST" }
      ).catch(() => {});
    }

    await supabase.from("google_forms_integrations").delete().eq("user_id", userId);

    await Promise.allSettled([
      supabase.from("google_forms_list").delete().eq("user_id", userId),
      supabase.from("google_form_responses").delete().eq("user_id", userId),
      supabase.from("google_form_watches").delete().eq("user_id", userId),
    ]);

    return { disconnected: true };
  }

  // ─── List Forms (via Google Drive API) ───────────────────────────────────
  // Google Forms API has no "list forms" endpoint — Drive API lists them instead.

  static async listForms(userId: string): Promise<GoogleForm[]> {
    const forms: GoogleForm[] = [];
    let pageToken: string | undefined;

    await gFormsRequest(userId, async (_, driveClient) => {
      do {
        const { data } = await driveClient.get(`/files`, {
          params: {
            q: "mimeType='application/vnd.google-apps.form' and trashed=false",
            fields: "nextPageToken, files(id, name, description)",
            pageSize: 100,
            ...(pageToken ? { pageToken } : {}),
          },
        });

        for (const f of data.files ?? []) {
          forms.push({
            form_id: f.id,
            title: f.name ?? "",
            description: f.description ?? "",
            responder_uri: "",
            linked_sheet_id: null,
          });
        }

        pageToken = data.nextPageToken;
      } while (pageToken);
    });

    // Upsert to DB
    if (forms.length) {
      await supabase.from("google_forms_list").upsert(
        forms.map((f) => ({ ...f, user_id: userId, google_id: f.form_id })),
        { onConflict: "user_id,google_id" }
      );
    }

    return forms;
  }

  // ─── Get Form Details ────────────────────────────────────────────────────

  static async getFormDetails(userId: string, formId: string) {
    return gFormsRequest(userId, async (formsClient) => {
      const { data } = await formsClient.get(`/forms/${formId}`);
      return data;
    });
  }

  // ─── Get Responses ───────────────────────────────────────────────────────

  static async getResponses(
    userId: string,
    formId: string,
    sinceTimestamp?: string
  ): Promise<GoogleFormResponse[]> {
    const responses: GoogleFormResponse[] = [];
    let pageToken: string | undefined;

    await gFormsRequest(userId, async (formsClient) => {
      do {
        const params: Record<string, string> = { pageSize: "100" };
        if (pageToken) params.pageToken = pageToken;
        if (sinceTimestamp) params.filter = `timestamp > ${sinceTimestamp}`;

        const { data } = await formsClient.get(`/forms/${formId}/responses`, { params });

        for (const r of data.responses ?? []) {
          responses.push({
            response_id: r.responseId,
            form_id: formId,
            create_time: r.createTime,
            last_submitted_time: r.lastSubmittedTime ?? r.createTime,
            answers: r.answers ?? {},
          });
        }

        pageToken = data.nextPageToken;
      } while (pageToken);
    });

    // Upsert to DB
    if (responses.length) {
      await supabase.from("google_form_responses").upsert(
        responses.map((r) => ({
          user_id: userId,
          google_id: r.response_id,
          form_id: r.form_id,
          create_time: r.create_time,
          last_submitted_time: r.last_submitted_time,
          answers: r.answers,
        })),
        { onConflict: "user_id,google_id" }
      );

      // Update last_synced_at for this form's watch
      await supabase
        .from("google_form_watches")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("form_id", formId);
    }

    return responses;
  }

  // ─── Sync All (Trigger: New Form Response) ───────────────────────────────
  // Polls all watched forms for new responses since last sync.

  static async syncNewResponses(userId: string) {
    const { data: watches } = await supabase
      .from("google_form_watches")
      .select("form_id, last_synced_at")
      .eq("user_id", userId);

    if (!watches?.length) return { message: "No watched forms", results: {} };

    const results: Record<string, any> = {};

    for (const watch of watches) {
      try {
        const newResponses = await GoogleFormsService.getResponses(
          userId,
          watch.form_id,
          watch.last_synced_at ?? undefined
        );
        results[watch.form_id] = { new_responses: newResponses.length };
      } catch (err: any) {
        results[watch.form_id] = { error: err.message };
      }
    }

    return results;
  }

  // ─── Watch Management (polling-based) ───────────────────────────────────
  // "Watch" a form = store it in DB so syncNewResponses polls it each time.

  static async watchForm(userId: string, formId: string) {
    const { error } = await supabase.from("google_form_watches").upsert(
      { user_id: userId, form_id: formId, last_synced_at: null, active: true },
      { onConflict: "user_id,form_id" }
    );
    if (error) throw new ApiError(500, error.message);
    return { watched: true, form_id: formId };
  }

  static async unwatchForm(userId: string, formId: string) {
    await supabase
      .from("google_form_watches")
      .delete()
      .eq("user_id", userId)
      .eq("form_id", formId);
    return { unwatched: true, form_id: formId };
  }

  static async listWatches(userId: string) {
    const { data, error } = await supabase
      .from("google_form_watches")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  // ─── DB reads ────────────────────────────────────────────────────────────

  static async getFormsFromDb(userId: string) {
    const { data, error } = await supabase
      .from("google_forms_list")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getResponsesFromDb(userId: string, formId?: string) {
    let query = supabase
      .from("google_form_responses")
      .select("*")
      .eq("user_id", userId)
      .order("create_time", { ascending: false });

    if (formId) query = query.eq("form_id", formId);

    const { data, error } = await query;
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }
}
