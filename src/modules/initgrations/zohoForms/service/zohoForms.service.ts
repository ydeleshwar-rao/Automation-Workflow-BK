import axios, { AxiosInstance } from "axios";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { refreshZohoFormsAccessToken } from "../utils/refreshAccessToken.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ZOHO_FORMS_BASE = "https://forms.zoho.com/api/v1";
const ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com";
const ZOHO_FORMS_TIMEOUT_MS = 30_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<any>>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZohoFormsIntegrationRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  needs_reauth: boolean;
}

export interface ZohoForm {
  form_id: string;
  form_name: string;
  form_link_name: string;
  report_link_name: string;
  description: string;
  status: string;
  created_time: string;
  modified_time: string;
}

export interface ZohoFormSubmission {
  submission_id: string;
  form_id: string;
  submitted_at: string;
  data: Record<string, any>;
}

// ─── Integration row helpers ──────────────────────────────────────────────────

const getIntegrationRaw = async (userId: string): Promise<ZohoFormsIntegrationRow> => {
  const { data, error } = await supabase
    .from("zoho_forms_integrations")
    .select("user_id, access_token, refresh_token, expires_at, needs_reauth")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(
      404,
      "Zoho Forms integration not found. Please connect your account first."
    );
  }
  return data as ZohoFormsIntegrationRow;
};

export const getIntegration = async (
  userId: string,
  forceRefresh = false
): Promise<ZohoFormsIntegrationRow> => {
  const row = await getIntegrationRaw(userId);

  if (row.needs_reauth) {
    throw new ApiError(401, "Zoho Forms requires re-authentication. Please reconnect.");
  }

  const isExpiringSoon =
    new Date(row.expires_at).getTime() <= Date.now() + REFRESH_BUFFER_MS;

  if (!isExpiringSoon && !forceRefresh) return row;

  const lockKey = `zohoforms:refresh:${userId}`;
  if (refreshLocks.has(lockKey)) {
    await refreshLocks.get(lockKey);
    return await getIntegrationRaw(userId);
  }

  const refreshPromise = refreshZohoFormsAccessToken(userId, row.refresh_token)
    .then(() => getIntegrationRaw(userId))
    .finally(() => refreshLocks.delete(lockKey));

  refreshLocks.set(lockKey, refreshPromise);
  return await refreshPromise;
};

// ─── Axios client ─────────────────────────────────────────────────────────────

const getAxiosClient = (token: string): AxiosInstance =>
  axios.create({
    baseURL: ZOHO_FORMS_BASE,
    timeout: ZOHO_FORMS_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

async function formsRequest<T>(
  userId: string,
  fn: (client: AxiosInstance) => Promise<T>
): Promise<T> {
  let integration = await getIntegration(userId);
  let client = getAxiosClient(integration.access_token);

  try {
    return await fn(client);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      console.warn(`[ZohoForms] 401 for user=${userId} — forcing token refresh`);
      integration = await getIntegration(userId, true);
      client = getAxiosClient(integration.access_token);
      return await fn(client);
    }
    throw err;
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ZohoFormsService {
  // ─── OAuth ──────────────────────────────────────────────────────────────

  static getConnectUrl(userId: string): string {
    const clientId = process.env.ZOHO_CLIENT_ID;
    const redirectUri = process.env.ZOHO_FORMS_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new ApiError(500, "Zoho Forms config missing (ZOHO_CLIENT_ID / ZOHO_FORMS_REDIRECT_URI)");
    }

    const scopes = [
      "ZohoForms.form.READ",
      "ZohoForms.form.CREATE",
      "ZohoForms.submission.READ",
      "ZohoForms.submission.CREATE",
    ].join(",");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      access_type: "offline",
      state: Buffer.from(JSON.stringify({ userId, app: "zoho_forms" })).toString("base64url"),
    });

    return `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?${params.toString()}`;
  }

  static async exchangeCodeForTokens(userId: string, code: string): Promise<void> {
    const redirectUri = process.env.ZOHO_FORMS_REDIRECT_URI!;

    const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ZOHO_CLIENT_ID!,
        client_secret: process.env.ZOHO_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const body: any = await res.json();
    if (!res.ok || body.error) {
      throw new ApiError(400, `Zoho Forms OAuth failed: ${body.error || body.message}`);
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (body.expires_in || 3600));

    const { error } = await supabase.from("zoho_forms_integrations").upsert({
      user_id: userId,
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: expiresAt.toISOString(),
      needs_reauth: false,
    });

    if (error) throw new ApiError(500, `Failed to save Zoho Forms tokens: ${error.message}`);
    console.log(`[ZohoForms] ✅ Connected user=${userId}`);
  }

  static async getConnectionStatus(userId: string) {
    const { data } = await supabase
      .from("zoho_forms_integrations")
      .select("user_id, needs_reauth, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) return { connected: false };
    return { connected: true, needs_reauth: data.needs_reauth, expires_at: data.expires_at };
  }

  static async disconnect(userId: string) {
    const { error } = await supabase
      .from("zoho_forms_integrations")
      .delete()
      .eq("user_id", userId);

    if (error) throw new ApiError(500, `Failed to disconnect: ${error.message}`);

    // Also clean up synced data
    await Promise.allSettled([
      supabase.from("zoho_forms_list").delete().eq("user_id", userId),
      supabase.from("zoho_form_submissions").delete().eq("user_id", userId),
      supabase.from("zoho_form_webhooks").delete().eq("user_id", userId),
    ]);

    return { disconnected: true };
  }

  // ─── Forms API ───────────────────────────────────────────────────────────

  static async listForms(userId: string): Promise<ZohoForm[]> {
    const data = await formsRequest(userId, (client) =>
      client.get(`/forms`).then((r) => r.data)
    );

    const forms: ZohoForm[] = (data.forms ?? data ?? []).map((f: any) => ({
      form_id: String(f.form_id ?? f.id),
      form_name: f.form_name ?? f.name,
      form_link_name: f.form_link_name ?? "",
      report_link_name: f.report_link_name ?? "",
      description: f.description ?? "",
      status: f.status ?? "Active",
      created_time: f.created_time ?? "",
      modified_time: f.modified_time ?? "",
    }));

    // Sync to Supabase
    if (forms.length) {
      await supabase.from("zoho_forms_list").upsert(
        forms.map((f) => ({ ...f, user_id: userId, zoho_id: f.form_id })),
        { onConflict: "user_id,zoho_id" }
      );
    }

    return forms;
  }

  static async getFormDetails(userId: string, formId: string) {
    const data = await formsRequest(userId, (client) =>
      client.get(`/forms/${formId}`).then((r) => r.data)
    );
    return data.form ?? data;
  }

  static async getFormFields(userId: string, formId: string) {
    const details = await ZohoFormsService.getFormDetails(userId, formId);
    return details.fields ?? details.form_fields ?? [];
  }

  // ─── Submissions ─────────────────────────────────────────────────────────

  static async getSubmissions(
    userId: string,
    formId: string,
    page = 1,
    perPage = 100
  ): Promise<ZohoFormSubmission[]> {
    const data = await formsRequest(userId, (client) =>
      client
        .get(`/forms/${formId}/submissions`, { params: { page, per_page: perPage } })
        .then((r) => r.data)
    );

    const submissions: ZohoFormSubmission[] = (data.submissions ?? []).map((s: any) => ({
      submission_id: String(s.submission_id ?? s.id),
      form_id: formId,
      submitted_at: s.submitted_time ?? s.created_time ?? new Date().toISOString(),
      data: s.data ?? s,
    }));

    if (submissions.length) {
      await supabase.from("zoho_form_submissions").upsert(
        submissions.map((s) => ({
          user_id: userId,
          zoho_id: s.submission_id,
          form_id: s.form_id,
          submitted_at: s.submitted_at,
          submission_data: s.data,
        })),
        { onConflict: "user_id,zoho_id" }
      );
    }

    return submissions;
  }

  static async syncAllSubmissions(userId: string) {
    const forms = await ZohoFormsService.listForms(userId);
    const results: Record<string, any> = {};

    for (const form of forms) {
      try {
        const subs = await ZohoFormsService.getSubmissions(userId, form.form_id);
        results[form.form_id] = { form_name: form.form_name, count: subs.length };
      } catch (err: any) {
        results[form.form_id] = { form_name: form.form_name, error: err.message };
      }
    }

    return results;
  }

  // ─── Webhook Setup ───────────────────────────────────────────────────────
  // Registers our backend URL as the webhook receiver on a Zoho form
  // so we get notified on every new submission.

  static async setupWebhook(userId: string, formId: string) {
    const receiverUrl = `${process.env.BACKEND_URL}/zoho-forms/webhook/${userId}/${formId}`;

    const data = await formsRequest(userId, (client) =>
      client
        .post(`/forms/${formId}/webhooks`, {
          url: receiverUrl,
          content_type: "application/json",
        })
        .then((r) => r.data)
    );

    // Persist webhook record
    await supabase.from("zoho_form_webhooks").upsert(
      {
        user_id: userId,
        form_id: formId,
        webhook_url: receiverUrl,
        zoho_webhook_id: String(data.webhook_id ?? ""),
        active: true,
      },
      { onConflict: "user_id,form_id" }
    );

    return { webhook_url: receiverUrl, zoho_response: data };
  }

  static async removeWebhook(userId: string, formId: string) {
    const { data: row } = await supabase
      .from("zoho_form_webhooks")
      .select("zoho_webhook_id")
      .eq("user_id", userId)
      .eq("form_id", formId)
      .maybeSingle();

    if (row?.zoho_webhook_id) {
      await formsRequest(userId, (client) =>
        client.delete(`/forms/${formId}/webhooks/${row.zoho_webhook_id}`)
      ).catch(() => {});
    }

    await supabase
      .from("zoho_form_webhooks")
      .delete()
      .eq("user_id", userId)
      .eq("form_id", formId);

    return { removed: true };
  }

  static async listWebhooks(userId: string) {
    const { data } = await supabase
      .from("zoho_form_webhooks")
      .select("*")
      .eq("user_id", userId);
    return data ?? [];
  }

  // ─── Incoming Webhook Handler ────────────────────────────────────────────
  // Called by our webhook receiver route when Zoho posts a submission

  static async handleIncomingSubmission(
    userId: string,
    formId: string,
    payload: Record<string, any>
  ) {
    const submissionId = String(
      payload.submission_id ?? payload.id ?? Date.now()
    );

    await supabase.from("zoho_form_submissions").upsert(
      {
        user_id: userId,
        zoho_id: submissionId,
        form_id: formId,
        submitted_at: payload.submitted_time ?? new Date().toISOString(),
        submission_data: payload,
      },
      { onConflict: "user_id,zoho_id" }
    );

    console.log(`[ZohoForms] 📥 Incoming submission saved form=${formId} user=${userId}`);
    return { received: true, submission_id: submissionId };
  }

  // ─── DB reads ────────────────────────────────────────────────────────────

  static async getFormsFromDb(userId: string) {
    const { data, error } = await supabase
      .from("zoho_forms_list")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getSubmissionsFromDb(userId: string, formId?: string) {
    let query = supabase
      .from("zoho_form_submissions")
      .select("*")
      .eq("user_id", userId)
      .order("submitted_at", { ascending: false });

    if (formId) query = query.eq("form_id", formId);

    const { data, error } = await query;
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }
}
