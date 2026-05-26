import axios from "axios";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { stripHtml } from "../../../../utils/sanitize.js";
import { refreshSimproAccessToken } from "../utils/refreshAccessToken.js";

/**
 * Simpro API integration.
 *
 * Two URLs are involved per tenant:
 *   • OAuth + API base = `https://{build}.simprosuite.com`
 *     - OAuth authorize:  /oauth2/authorize
 *     - OAuth token:      /oauth2/token
 *     - REST API:         /api/v1.0/companies/{companyId}/...
 *
 * Each Simpro tenant is a "build" with its own subdomain. The tenant build name
 * is captured at OAuth connect time (user enters it before being redirected to
 * authorize) and persisted on the `simpro_integrations` row alongside tokens.
 *
 * companyId on each request: most Simpro builds have a single company with id=0,
 * but multi-company builds expose more. We default to the value stored on the
 * integration row (set during /sync after listing /companies/).
 */

// Concurrency-safe token refresh (one in-flight refresh per user).
const refreshLocks = new Map<string, Promise<any>>();

// Refresh proactively 5 min before expiry — matches ServiceM8 adapter behaviour.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const SIMPRO_CUSTOMER_COLUMNS =
  "ID,Type,CompanyName,GivenName,FamilyName,Email,Phone,AltPhone,Address,BillingAddress,AmountOwing,Archived,DateModified";
const SIMPRO_CUSTOMERS_PAGE_SIZE = 250;
const SIMPRO_CUSTOMERS_PAGE_DELAY_MS = 1100;

const SIMPRO_JOB_COLUMNS =
  "ID,Type,Customer,Site,SiteContact,OrderNo,RequestNo,Name,Description,Notes,Status,Stage,DateIssued,DueDate,Total,Tags,Technicians,DateModified";
const SIMPRO_JOBS_PAGE_SIZE = 250;
const SIMPRO_JOBS_PAGE_DELAY_MS = 150;

const SIMPRO_SITE_COLUMNS =
  "ID,Name,Address,Customers,Archived,DateModified";
const SIMPRO_SITES_PAGE_SIZE = 250;
const SIMPRO_SITES_PAGE_DELAY_MS = 150;

const SIMPRO_SCHEDULES_PAGE_SIZE = 250;
const SIMPRO_SCHEDULES_PAGE_DELAY_MS = 150;
const SIMPRO_SCHEDULES_TYPE_FILTER = "job";

/** List endpoint only accepts these columns (others return 422). */
const SIMPRO_EMPLOYEE_LIST_COLUMNS = "ID,Name,Archived";
const SIMPRO_EMPLOYEES_DETAIL_DELAY_MS = 200;

const SIMPRO_API_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SimproResourceKey =
  | "customers"
  | "sites"
  | "employees"
  | "jobs"
  | "schedules";

export type SimproResourceSyncResult = {
  status: "synced" | "failed";
  totalRecords?: number;
  totalPages?: number;
  syncedCount?: number;
  failedCount?: number;
  failedIds?: string[];
  durationMs?: number;
  error?: string;
};

export type SimproSyncAllResult = {
  overall: "success" | "partial" | "failed";
  failedEntities: SimproResourceKey[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
  results: {
    customers?: SimproResourceSyncResult;
    sites?: SimproResourceSyncResult;
    employees?: SimproResourceSyncResult;
    jobs?: SimproResourceSyncResult;
    schedules?: SimproResourceSyncResult;
  };
};

/** Return shape from syncCustomers / syncJobs / syncSites / syncEmployees / syncSchedules */
type SimproResourceSyncPayload = {
  totalRecords: number;
  totalPages?: number;
  syncedCount: number;
  failedCount: number;
  durationMs: number;
  failedIds?: string[];
  error?: string;
};

export interface SimproIntegrationRow {
  user_id:        string;
  build_name:     string;       // e.g. "acme" → host = acme.simprosuite.com
  base_url:       string;       // full host, e.g. "https://acme.simprosuite.com"
  company_id:     number | null;
  access_token:   string;
  refresh_token:  string | null;
  expires_at:     string | null; // null = API key (never expires)
  scopes:         string | null;
  needs_reauth:   boolean;      // TRUE = refresh token revoked, user must reconnect
}

const getIntegrationRaw = async (
  userId: string
): Promise<SimproIntegrationRow> => {
  const { data, error } = await supabase
    .from("simpro_integrations")
    .select("user_id, build_name, base_url, company_id, access_token, refresh_token, expires_at, scopes, needs_reauth")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(
      404,
      "Simpro integration not found. Please connect your account first."
    );
  }
  return data as SimproIntegrationRow;
};

/**
 * Returns a row guaranteed to have a valid access_token.
 * Refreshes 5 min before expiry; deduplicates concurrent refreshes per user.
 *
 * forceRefresh=true → skip the expiry check and refresh immediately.
 * Used by getSimproContext after a 401 to recover from externally-revoked tokens.
 */
export const getIntegration = async (
  userId: string,
  forceRefresh = false
): Promise<SimproIntegrationRow> => {
  const row = await getIntegrationRaw(userId);

  if (row.needs_reauth) {
    throw new ApiError(
      401,
      "Simpro connection requires re-authentication. Please reconnect your Simpro account."
    );
  }

  // expires_at = null means API key auth — never expires, never refresh
  if (!row.expires_at) return row;

  const expiry = new Date(row.expires_at).getTime();
  const tokenFresh = !forceRefresh && Date.now() < expiry - REFRESH_BUFFER_MS;

  if (tokenFresh) {
    return row;
  }

  if (!row.refresh_token) {
    throw new ApiError(401, "Simpro refresh token missing — user must reconnect");
  }

  if (!refreshLocks.has(userId)) {
    const refreshPromise = (async () => {
      const refreshed = await refreshSimproAccessToken(userId, row.refresh_token!);
      return {
        ...row,
        access_token:  refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at:    new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        needs_reauth:  false,
      };
    })().finally(() => refreshLocks.delete(userId));

    refreshLocks.set(userId, refreshPromise);
  }

  return refreshLocks.get(userId)!;
};

type SimproContext = { headers: Record<string, string>; baseUrl: string; companyId: number };

const buildContext = (row: SimproIntegrationRow): SimproContext => ({
  headers: {
    Authorization:  `Bearer ${row.access_token}`,
    Accept:         "application/json",
    "Content-Type": "application/json",
  },
  baseUrl:   row.base_url.replace(/\/+$/, ""),
  companyId: row.company_id ?? 0,
});

/**
 * Convenience: bearer headers + tenant base URL + company id, all in one call.
 * Wraps a live call so a 401 triggers a force-refresh + single retry before
 * propagating the error (handles tokens revoked externally in Simpro admin).
 */
export const getSimproContext = async (userId: string): Promise<SimproContext> => {
  const row = await getIntegration(userId);
  return buildContext(row);
};

/**
 * Execute a Simpro API call with automatic 401 recovery.
 * On a 401 response the access token is force-refreshed once and the call is
 * retried. Use this wrapper for all outbound Simpro REST calls.
 */
export const withSimproRetry = async <T>(
  userId: string,
  fn: (ctx: SimproContext) => Promise<T>
): Promise<T> => {
  const ctx = await getSimproContext(userId);
  try {
    return await fn(ctx);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      console.warn(`[Simpro] 401 for user=${userId} — force-refreshing token and retrying`);
      const freshRow = await getIntegration(userId, true);
      return await fn(buildContext(freshRow));
    }
    throw err;
  }
};

/**
 * Just the bearer headers. Webhook adapter uses this without needing baseUrl.
 */
export const getSimproHeaders = async (
  userId: string
): Promise<Record<string, string>> => {
  const { headers } = await getSimproContext(userId);
  return headers;
};

// ─── Service class (mirrors ServiceM8Service / CommusoftService) ───────────
export class SimproService {
  /**
   * Exchange the OAuth authorization code for tokens and persist the row.
   * Called from the OAuth callback after the user picks their tenant (build).
   */
  static async exchangeCodeForTokens(
    userId: string,
    buildName: string,
    code: string,
    redirectUri: string
  ) {
    const baseUrl = `https://${buildName}.simprosuite.com`;
    const tokenUrl = `${baseUrl}/oauth2/token`;

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        redirect_uri:  redirectUri,
        client_id:     process.env.SIMPRO_CLIENT_ID!,
        client_secret: process.env.SIMPRO_CLIENT_SECRET!,
      }),
    });

    const tokenData: any = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new ApiError(
        tokenRes.status,
        tokenData?.error_description || tokenData?.error || "Simpro token exchange failed"
      );
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (tokenData.expires_in || 3600));

    // Try to resolve the first companyId so subsequent calls don't have to.
    let companyId: number | null = null;
    try {
      const companies = await axios.get(`${baseUrl}/api/v1.0/companies/`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (Array.isArray(companies.data) && companies.data.length > 0) {
        companyId = Number(companies.data[0].ID ?? companies.data[0].id ?? 0);
      } else {
        companyId = 0;
      }
    } catch (err: any) {
      console.warn(`[Simpro] companies lookup failed during connect — defaulting to 0: ${err?.message}`);
      companyId = 0;
    }

    const { error: upsertErr } = await supabase
      .from("simpro_integrations")
      .upsert(
        {
          user_id:       userId,
          build_name:    buildName,
          base_url:      baseUrl,
          company_id:    companyId,
          access_token:  tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at:    expiresAt.toISOString(),
          scopes:        tokenData.scope,
        },
        { onConflict: "user_id" }
      );

    if (upsertErr) {
      throw new ApiError(500, `Failed to persist Simpro tokens: ${upsertErr.message}`);
    }

    return { build_name: buildName, company_id: companyId, expires_at: expiresAt.toISOString() };
  }

  // ─── Customers (global list + DB sync) ───────────────────────────────────

  private static mapCustomerToDbRow(userId: string, customer: Record<string, unknown>) {
    const address = customer.Address as Record<string, unknown> | undefined;
    const billing = customer.BillingAddress as Record<string, unknown> | undefined;

    return {
      user_id: userId,
      customer_api_id: String(customer.ID),
      type: (customer.Type as string) || null,
      company_name: (customer.CompanyName as string) || null,
      given_name: (customer.GivenName as string) || null,
      family_name: (customer.FamilyName as string) || null,
      email: (customer.Email as string) || null,
      phone: (customer.Phone as string) || null,
      alt_phone: (customer.AltPhone as string) || null,
      address_line: (address?.Address as string) || null,
      city: (address?.City as string) || null,
      state: (address?.State as string) || null,
      postal_code: (address?.PostalCode as string) || null,
      country: (address?.Country as string) || null,
      billing_address_line: (billing?.Address as string) || null,
      billing_city: (billing?.City as string) || null,
      billing_state: (billing?.State as string) || null,
      billing_postal_code: (billing?.PostalCode as string) || null,
      billing_country: (billing?.Country as string) || null,
      amount_owing: customer.AmountOwing ?? 0,
      archived: customer.Archived ?? false,
      simpro_date_modified: (customer.DateModified as string) || null,
      payload: customer,
      synced_at: new Date().toISOString(),
    };
  }

  private static async fetchCustomersPage(
    userId: string,
    page: number
  ): Promise<{ batch: Record<string, unknown>[]; totalRecords: number }> {
    return withSimproRetry(userId, async (ctx) => {
      const url = `${ctx.baseUrl}/api/v1.0/companies/${ctx.companyId}/customers/`;
      const res = await axios.get(url, {
        headers: ctx.headers,
        params: {
          pageSize: SIMPRO_CUSTOMERS_PAGE_SIZE,
          page,
          columns: SIMPRO_CUSTOMER_COLUMNS,
        },
      });

      const batch = Array.isArray(res.data) ? res.data : [];
      const totalHeader =
        res.headers["result-total"] ??
        res.headers["Result-Total"] ??
        "0";
      const totalRecords = parseInt(String(totalHeader), 10) || 0;

      return { batch, totalRecords };
    });
  }

  /**
   * simPRO tables use UPDATE triggers that reference NEW.updated_at, but those
   * columns are not on the table yet — upsert on conflict fails every re-sync.
   * Delete-by-api-id then insert avoids the broken UPDATE path.
   * Long-term: run supabase/migrations/20260522120000_simpro_tables_updated_at.sql
   */
  private static async replaceSimproRows(
    table: string,
    userId: string,
    apiIdColumn: string,
    rows: Record<string, unknown>[]
  ): Promise<{ synced: number; failed: number }> {
    if (rows.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const apiIds = rows
      .map((r) => r[apiIdColumn])
      .filter((id): id is string => id != null && id !== "");

    if (apiIds.length > 0) {
      const { error: delError } = await supabase
        .from(table)
        .delete()
        .eq("user_id", userId)
        .in(apiIdColumn, apiIds);

      if (delError) {
        console.error(`[simPRO ${table}] delete failed:`, delError.message);
        return { synced: 0, failed: rows.length };
      }
    }

    const { error } = await supabase.from(table).insert(rows);

    if (error) {
      console.error(`[simPRO ${table}] insert failed:`, error.message);
      return { synced: 0, failed: rows.length };
    }

    return { synced: rows.length, failed: 0 };
  }

  private static async upsertCustomerRows(
    userId: string,
    customers: Record<string, unknown>[]
  ): Promise<{ synced: number; failed: number }> {
    if (customers.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const rows = customers.map((c) => SimproService.mapCustomerToDbRow(userId, c));
    return SimproService.replaceSimproRows(
      "simpro_customers",
      userId,
      "customer_api_id",
      rows
    );
  }

  /**
   * Main sync: paginate through ALL customers and upsert to simpro_customers.
   */
  static async syncCustomers(userId: string) {
    const startTime = Date.now();
    let syncedCount = 0;
    let failedCount = 0;

    const { batch: firstBatch, totalRecords } = await SimproService.fetchCustomersPage(userId, 1);
    const totalPages =
      totalRecords > 0
        ? Math.ceil(totalRecords / SIMPRO_CUSTOMERS_PAGE_SIZE)
        : firstBatch.length < SIMPRO_CUSTOMERS_PAGE_SIZE
          ? 1
          : 50;

    console.log(
      `[simPRO Customers Sync] Total: ${totalRecords || "unknown"} customers across ~${totalPages} pages`
    );

    const processPage = async (page: number, batch: Record<string, unknown>[]) => {
      const { synced, failed } = await SimproService.upsertCustomerRows(userId, batch);
      syncedCount += synced;
      failedCount += failed;
      console.log(
        `[simPRO Customers Sync] Page ${page}/${totalPages} done — ${synced} synced, ${failed} failed`
      );
    };

    await processPage(1, firstBatch);

    for (let page = 2; page <= totalPages; page++) {
      await sleep(SIMPRO_CUSTOMERS_PAGE_DELAY_MS);

      try {
        const { batch } = await SimproService.fetchCustomersPage(userId, page);
        if (batch.length === 0) break;

        await processPage(page, batch);

        if (totalRecords === 0 && batch.length < SIMPRO_CUSTOMERS_PAGE_SIZE) {
          break;
        }
      } catch (err: any) {
        console.error(`[simPRO Customers Sync] Page ${page} error:`, err?.message ?? err);
        failedCount += SIMPRO_CUSTOMERS_PAGE_SIZE;
      }
    }

    const durationMs = Date.now() - startTime;
    return {
      totalRecords: totalRecords || syncedCount + failedCount,
      totalPages,
      syncedCount,
      failedCount,
      durationMs,
    };
  }

  /**
   * Live API — first page only — upsert to simpro_customers.
   */
  /** GET /simpro/customers — read from simpro_customers (sync via POST /sync). */
  static async getCustomers(userId: string) {
    const { data, error } = await supabase
      .from("simpro_customers")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false });

    if (error) {
      throw new ApiError(500, `Database error: ${error.message}`);
    }

    return data ?? [];
  }

  // ─── Jobs (global list + DB sync) ────────────────────────────────────────

  private static transformJobToRow(job: Record<string, unknown>, userId: string) {
    const customer = job.Customer as Record<string, unknown> | undefined;
    const site = job.Site as Record<string, unknown> | undefined;
    const siteContact = job.SiteContact as Record<string, unknown> | undefined;
    const status = job.Status as Record<string, unknown> | undefined;
    const total = job.Total as Record<string, unknown> | undefined;

    return {
      user_id: userId,
      job_api_id: String(job.ID),
      type: (job.Type as string) || null,
      name: (job.Name as string) || null,
      description: stripHtml(job.Description as string),
      notes: stripHtml(job.Notes as string),
      order_no: (job.OrderNo as string) || null,
      request_no: (job.RequestNo as string) || null,
      customer_api_id: customer?.ID != null ? String(customer.ID) : null,
      customer_type: (customer?.Type as string) || null,
      customer_company_name: (customer?.CompanyName as string) || null,
      customer_given_name: (customer?.GivenName as string) || null,
      customer_family_name: (customer?.FamilyName as string) || null,
      site_api_id: site?.ID != null ? String(site.ID) : null,
      site_name: (site?.Name as string) || null,
      site_contact_api_id: siteContact?.ID != null ? String(siteContact.ID) : null,
      site_contact_given_name: (siteContact?.GivenName as string) || null,
      site_contact_family_name: (siteContact?.FamilyName as string) || null,
      status_id: (status?.ID as number) ?? null,
      status_name: (status?.Name as string) || null,
      status_color: (status?.Color as string) || null,
      stage: (job.Stage as string) || null,
      date_issued: (job.DateIssued as string) || null,
      due_date: (job.DueDate as string) || null,
      simpro_date_modified: (job.DateModified as string) || null,
      total_ex_tax: total?.ExTax ?? null,
      total_tax: total?.Tax ?? null,
      total_inc_tax: total?.IncTax ?? null,
      technicians: job.Technicians ?? [],
      tags: job.Tags ?? [],
      payload: job,
      synced_at: new Date().toISOString(),
    };
  }

  private static async fetchJobsPage(
    userId: string,
    page: number
  ): Promise<{ batch: Record<string, unknown>[]; totalRecords: number }> {
    return withSimproRetry(userId, async (ctx) => {
      const url = `${ctx.baseUrl}/api/v1.0/companies/${ctx.companyId}/jobs/`;
      const res = await axios.get(url, {
        headers: ctx.headers,
        timeout: SIMPRO_API_TIMEOUT_MS,
        params: {
          pageSize: SIMPRO_JOBS_PAGE_SIZE,
          page,
          columns: SIMPRO_JOB_COLUMNS,
        },
      });

      const batch = Array.isArray(res.data) ? res.data : [];
      const totalHeader =
        res.headers["result-total"] ??
        res.headers["Result-Total"] ??
        "0";
      const totalRecords = parseInt(String(totalHeader), 10) || 0;

      return { batch, totalRecords };
    });
  }

  private static async upsertJobRows(
    userId: string,
    jobs: Record<string, unknown>[]
  ): Promise<{ synced: number; failed: number }> {
    if (jobs.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const rows = jobs.map((j) => SimproService.transformJobToRow(j, userId));
    return SimproService.replaceSimproRows(
      "simpro_jobs",
      userId,
      "job_api_id",
      rows
    );
  }

  /**
   * Main sync: paginate through ALL jobs and upsert to simpro_jobs.
   */
  static async syncJobs(userId: string) {
    const startTime = Date.now();
    let syncedCount = 0;
    let failedCount = 0;

    console.log(`[simPRO Jobs Sync] Starting for user ${userId}`);

    const { batch: firstBatch, totalRecords } = await SimproService.fetchJobsPage(userId, 1);
    const totalPages =
      totalRecords > 0
        ? Math.ceil(totalRecords / SIMPRO_JOBS_PAGE_SIZE)
        : firstBatch.length < SIMPRO_JOBS_PAGE_SIZE
          ? 1
          : 50;

    console.log(
      `[simPRO Jobs Sync] Total: ${totalRecords || "unknown"} jobs across ~${totalPages} pages`
    );

    const processPage = async (page: number, batch: Record<string, unknown>[]) => {
      const { synced, failed } = await SimproService.upsertJobRows(userId, batch);
      syncedCount += synced;
      failedCount += failed;
      console.log(
        `[simPRO Jobs Sync] Page ${page}/${totalPages} done — ${synced} synced, ${failed} failed`
      );
    };

    await processPage(1, firstBatch);

    for (let page = 2; page <= totalPages; page++) {
      await sleep(SIMPRO_JOBS_PAGE_DELAY_MS);

      try {
        const { batch } = await SimproService.fetchJobsPage(userId, page);
        if (batch.length === 0) break;

        await processPage(page, batch);

        if (totalRecords === 0 && batch.length < SIMPRO_JOBS_PAGE_SIZE) {
          break;
        }
      } catch (err: any) {
        console.error(`[simPRO Jobs Sync] Page ${page} error:`, err?.message ?? err);
        failedCount += SIMPRO_JOBS_PAGE_SIZE;
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[simPRO Jobs Sync] DONE — synced=${syncedCount} failed=${failedCount} in ${durationMs}ms`
    );

    return {
      totalRecords: totalRecords || syncedCount + failedCount,
      totalPages,
      syncedCount,
      failedCount,
      durationMs,
    };
  }

  /** GET /simpro/jobs — read from simpro_jobs (sync via POST /sync). */
  static async getJobs(userId: string) {
    const { data, error } = await supabase
      .from("simpro_jobs")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false });

    if (error) {
      throw new ApiError(500, `Database error: ${error.message}`);
    }

    return data ?? [];
  }

  // ─── Sites (global list + DB sync) ───────────────────────────────────────

  private static transformSiteToRow(site: Record<string, unknown>, userId: string) {
    const address = site.Address as Record<string, unknown> | undefined;
    const customers = Array.isArray(site.Customers) ? site.Customers : [];
    const primaryCustomer = (customers[0] ?? {}) as Record<string, unknown>;

    return {
      user_id: userId,
      site_api_id: String(site.ID),
      name: (site.Name as string) || null,
      address_line: (address?.Address as string) || null,
      city: (address?.City as string) || null,
      state: (address?.State as string) || null,
      postal_code: (address?.PostalCode as string) || null,
      country: (address?.Country as string) || null,
      primary_customer_api_id:
        primaryCustomer.ID != null ? String(primaryCustomer.ID) : null,
      primary_customer_type: (primaryCustomer.Type as string) || null,
      primary_customer_company_name:
        (primaryCustomer.CompanyName as string) || null,
      primary_customer_given_name: (primaryCustomer.GivenName as string) || null,
      primary_customer_family_name:
        (primaryCustomer.FamilyName as string) || null,
      customers,
      customers_count: customers.length,
      archived: site.Archived ?? false,
      simpro_date_modified: (site.DateModified as string) || null,
      payload: site,
      synced_at: new Date().toISOString(),
    };
  }

  private static async fetchSitesPage(
    userId: string,
    page: number
  ): Promise<{ batch: Record<string, unknown>[]; totalRecords: number }> {
    return withSimproRetry(userId, async (ctx) => {
      const url = `${ctx.baseUrl}/api/v1.0/companies/${ctx.companyId}/sites/`;
      const res = await axios.get(url, {
        headers: ctx.headers,
        timeout: SIMPRO_API_TIMEOUT_MS,
        params: {
          pageSize: SIMPRO_SITES_PAGE_SIZE,
          page,
          columns: SIMPRO_SITE_COLUMNS,
        },
      });

      const batch = Array.isArray(res.data) ? res.data : [];
      const totalHeader =
        res.headers["result-total"] ??
        res.headers["Result-Total"] ??
        "0";
      const totalRecords = parseInt(String(totalHeader), 10) || 0;

      return { batch, totalRecords };
    });
  }

  private static async upsertSiteRows(
    userId: string,
    sites: Record<string, unknown>[]
  ): Promise<{ synced: number; failed: number }> {
    if (sites.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const rows = sites.map((s) => SimproService.transformSiteToRow(s, userId));
    return SimproService.replaceSimproRows(
      "simpro_sites",
      userId,
      "site_api_id",
      rows
    );
  }

  /**
   * Main sync: paginate through ALL sites and upsert to simpro_sites.
   */
  static async syncSites(userId: string) {
    const startTime = Date.now();
    let syncedCount = 0;
    let failedCount = 0;

    console.log(`[simPRO Sites Sync] Starting for user ${userId}`);

    const { batch: firstBatch, totalRecords } = await SimproService.fetchSitesPage(userId, 1);
    const totalPages =
      totalRecords > 0
        ? Math.ceil(totalRecords / SIMPRO_SITES_PAGE_SIZE)
        : firstBatch.length < SIMPRO_SITES_PAGE_SIZE
          ? 1
          : 50;

    console.log(
      `[simPRO Sites Sync] Total: ${totalRecords || "unknown"} sites across ~${totalPages} pages`
    );

    const processPage = async (page: number, batch: Record<string, unknown>[]) => {
      const { synced, failed } = await SimproService.upsertSiteRows(userId, batch);
      syncedCount += synced;
      failedCount += failed;
      console.log(
        `[simPRO Sites Sync] Page ${page}/${totalPages} done — ${synced} synced, ${failed} failed`
      );
    };

    await processPage(1, firstBatch);

    for (let page = 2; page <= totalPages; page++) {
      await sleep(SIMPRO_SITES_PAGE_DELAY_MS);

      try {
        const { batch } = await SimproService.fetchSitesPage(userId, page);
        if (batch.length === 0) break;

        await processPage(page, batch);

        if (totalRecords === 0 && batch.length < SIMPRO_SITES_PAGE_SIZE) {
          break;
        }
      } catch (err: any) {
        console.error(`[simPRO Sites Sync] Page ${page} error:`, err?.message ?? err);
        failedCount += SIMPRO_SITES_PAGE_SIZE;
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[simPRO Sites Sync] DONE — synced=${syncedCount} failed=${failedCount} in ${durationMs}ms`
    );

    return {
      totalRecords: totalRecords || syncedCount + failedCount,
      totalPages,
      syncedCount,
      failedCount,
      durationMs,
    };
  }

  /** GET /simpro/sites — read from simpro_sites (sync via POST /sync). */
  static async getSites(userId: string) {
    const { data, error } = await supabase
      .from("simpro_sites")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false });

    if (error) {
      throw new ApiError(500, `Database error: ${error.message}`);
    }

    return data ?? [];
  }

  // ─── Employees (list + per-id detail) ────────────────────────────────────

  private static transformEmployeeToRow(
    employee: Record<string, unknown>,
    userId: string
  ) {
    const primaryContact = (employee.PrimaryContact ?? {}) as Record<string, unknown>;
    const address = (employee.Address ?? {}) as Record<string, unknown>;
    const accountSetup = (employee.AccountSetup ?? {}) as Record<string, unknown>;
    const userProfile = (employee.UserProfile ?? {}) as Record<string, unknown>;
    const payRates = (employee.PayRates ?? {}) as Record<string, unknown>;
    const storageDevice = (userProfile.StorageDevice ?? {}) as Record<string, unknown>;

    return {
      user_id: userId,
      employee_api_id: String(employee.ID),
      name: (employee.Name as string) || null,
      position: (employee.Position as string) || null,
      email: (primaryContact.Email as string) || null,
      secondary_email: (primaryContact.SecondaryEmail as string) || null,
      work_phone: (primaryContact.WorkPhone as string) || null,
      cell_phone: (primaryContact.CellPhone as string) || null,
      extension: (primaryContact.Extension as string) || null,
      address_line: (address.Address as string) || null,
      city: (address.City as string) || null,
      state: (address.State as string) || null,
      postal_code: (address.PostalCode as string) || null,
      country: (address.Country as string) || null,
      date_of_hire: (employee.DateOfHire as string) || null,
      pay_rate: payRates.PayRate ?? null,
      employment_cost: payRates.EmploymentCost ?? null,
      overhead: payRates.Overhead ?? null,
      username: (accountSetup.Username as string) || null,
      is_salesperson: userProfile.IsSalesperson ?? false,
      is_project_manager: userProfile.IsProjectManager ?? false,
      storage_device: (storageDevice.Name as string) || null,
      availability: employee.Availability ?? [],
      assigned_cost_centers: employee.AssignedCostCenters ?? [],
      zones: employee.Zones ?? [],
      custom_fields: employee.CustomFields ?? [],
      archived: employee.Archived ?? false,
      simpro_date_created: (employee.DateCreated as string) || null,
      simpro_date_modified: (employee.DateModified as string) || null,
      payload: employee,
      synced_at: new Date().toISOString(),
    };
  }

  /** Minimal employee list (ID, Name, Archived only). */
  private static async fetchEmployeesList(
    userId: string
  ): Promise<Record<string, unknown>[]> {
    return withSimproRetry(userId, async (ctx) => {
      const url = `${ctx.baseUrl}/api/v1.0/companies/${ctx.companyId}/employees/`;
      const res = await axios.get(url, {
        headers: ctx.headers,
        timeout: SIMPRO_API_TIMEOUT_MS,
        params: { columns: SIMPRO_EMPLOYEE_LIST_COLUMNS },
      });
      return Array.isArray(res.data) ? res.data : [];
    });
  }

  /** Full employee record from detail endpoint. */
  private static async fetchEmployeeDetail(
    userId: string,
    employeeId: string
  ): Promise<Record<string, unknown>> {
    return withSimproRetry(userId, async (ctx) => {
      const url = `${ctx.baseUrl}/api/v1.0/companies/${ctx.companyId}/employees/${employeeId}`;
      const res = await axios.get(url, {
        headers: ctx.headers,
        timeout: SIMPRO_API_TIMEOUT_MS,
      });
      return (res.data ?? {}) as Record<string, unknown>;
    });
  }

  private static async upsertEmployeeRows(
    userId: string,
    employees: Record<string, unknown>[]
  ): Promise<{ synced: number; failed: number }> {
    if (employees.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const rows = employees.map((e) =>
      SimproService.transformEmployeeToRow(e, userId)
    );
    return SimproService.replaceSimproRows(
      "simpro_employees",
      userId,
      "employee_api_id",
      rows
    );
  }

  /**
   * Main sync: GET list (minimal columns) then GET /employees/{id}/ per row.
   */
  static async syncEmployees(userId: string) {
    const startTime = Date.now();
    let syncedCount = 0;
    let failedCount = 0;
    const failedIds: string[] = [];

    console.log(`[simPRO Employees Sync] Starting for user ${userId}`);

    let employeesList: Record<string, unknown>[];
    try {
      employeesList = await SimproService.fetchEmployeesList(userId);
    } catch (err: any) {
      console.error(
        `[simPRO Employees Sync] List fetch failed:`,
        err?.message ?? err
      );
      return {
        totalRecords: 0,
        syncedCount: 0,
        failedCount: 0,
        failedIds: [] as string[],
        durationMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      };
    }

    const totalRecords = employeesList.length;
    console.log(
      `[simPRO Employees Sync] Found ${totalRecords} employees, fetching details...`
    );

    for (const employeeBasic of employeesList) {
      const employeeId = String(employeeBasic.ID ?? "");
      if (!employeeId) {
        failedCount++;
        continue;
      }

      try {
        const employeeDetail = await SimproService.fetchEmployeeDetail(
          userId,
          employeeId
        );

        const { synced, failed } = await SimproService.upsertEmployeeRows(
          userId,
          [employeeDetail]
        );

        if (failed > 0) {
          failedCount++;
          failedIds.push(employeeId);
          console.error(
            `[simPRO Employees Sync] Employee ${employeeId} upsert failed`
          );
        } else {
          syncedCount += synced;
          console.log(
            `[simPRO Employees Sync] ${employeeDetail.Name ?? employeeId} (ID ${employeeId}) ✓`
          );
        }

        await sleep(SIMPRO_EMPLOYEES_DETAIL_DELAY_MS);
      } catch (err: any) {
        console.error(
          `[simPRO Employees Sync] Employee ${employeeId} fetch failed:`,
          err?.message ?? err
        );
        failedCount++;
        failedIds.push(employeeId);
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[simPRO Employees Sync] DONE — synced=${syncedCount} failed=${failedCount} in ${durationMs}ms`
    );

    return {
      totalRecords,
      syncedCount,
      failedCount,
      failedIds,
      durationMs,
    };
  }

  /** GET /simpro/employees — read from simpro_employees (sync via POST /sync). */
  static async getEmployees(userId: string) {
    const { data, error } = await supabase
      .from("simpro_employees")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false });

    if (error) {
      throw new ApiError(500, `Database error: ${error.message}`);
    }

    return data ?? [];
  }

  // ─── Schedules (Type=job only) ───────────────────────────────────────────

  private static transformScheduleToRow(schedule: Record<string, unknown>, userId: string) {
    const staff = (schedule.Staff ?? {}) as Record<string, unknown>;
    const project = (schedule.Project ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(schedule.Blocks) ? schedule.Blocks : [];
    const firstBlock = (blocks[0] ?? {}) as Record<string, unknown>;
    const scheduleRate = (firstBlock.ScheduleRate ?? {}) as Record<string, unknown>;

    return {
      user_id: userId,
      schedule_api_id: String(schedule.ID),
      type: (schedule.Type as string) || null,
      reference: (schedule.Reference as string) || null,
      total_hours: schedule.TotalHours ?? null,
      schedule_date: (schedule.Date as string) || null,

      staff_api_id: staff.ID != null ? String(staff.ID) : null,
      staff_name: (staff.Name as string) || null,
      staff_type: (staff.Type as string) || null,

      project_id: project.ProjectID != null ? String(project.ProjectID) : null,
      section_id: project.SectionID != null ? String(project.SectionID) : null,
      cost_center_id:
        project.CostCenterID != null ? String(project.CostCenterID) : null,

      blocks,

      schedule_rate_id: (scheduleRate.ID as number) ?? null,
      schedule_rate_name: (scheduleRate.Name as string) || null,
      start_time: (firstBlock.ISO8601StartTime as string) || null,
      end_time: (firstBlock.ISO8601EndTime as string) || null,

      payload: schedule,
      synced_at: new Date().toISOString(),
    };
  }

  private static async fetchSchedulesPage(
    userId: string,
    page: number
  ): Promise<{ batch: Record<string, unknown>[]; totalRecords: number }> {
    return withSimproRetry(userId, async (ctx) => {
      const url = `${ctx.baseUrl}/api/v1.0/companies/${ctx.companyId}/schedules/`;
      const res = await axios.get(url, {
        headers: ctx.headers,
        timeout: SIMPRO_API_TIMEOUT_MS,
        params: {
          Type: SIMPRO_SCHEDULES_TYPE_FILTER,
          pageSize: SIMPRO_SCHEDULES_PAGE_SIZE,
          page,
        },
      });

      const batch = Array.isArray(res.data) ? res.data : [];
      const totalHeader =
        res.headers["result-total"] ??
        res.headers["Result-Total"] ??
        "0";
      const totalRecords = parseInt(String(totalHeader), 10) || 0;

      return { batch, totalRecords };
    });
  }

  private static async upsertScheduleRows(
    userId: string,
    schedules: Record<string, unknown>[]
  ): Promise<{ synced: number; failed: number }> {
    if (schedules.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const rows = schedules.map((s) =>
      SimproService.transformScheduleToRow(s, userId)
    );
    return SimproService.replaceSimproRows(
      "simpro_schedules",
      userId,
      "schedule_api_id",
      rows
    );
  }

  /**
   * Main sync — paginate job schedules only (Type=job).
   */
  static async syncSchedules(userId: string) {
    const startTime = Date.now();
    let syncedCount = 0;
    let failedCount = 0;

    console.log(`[simPRO Schedules Sync] Starting for user ${userId} (Type=job)`);

    const { batch: firstBatch, totalRecords } =
      await SimproService.fetchSchedulesPage(userId, 1);
    const totalPages =
      totalRecords > 0
        ? Math.ceil(totalRecords / SIMPRO_SCHEDULES_PAGE_SIZE)
        : firstBatch.length < SIMPRO_SCHEDULES_PAGE_SIZE
          ? 1
          : 50;

    console.log(
      `[simPRO Schedules Sync] Total: ${totalRecords || "unknown"} job schedules across ~${totalPages} pages`
    );

    const processPage = async (
      page: number,
      batch: Record<string, unknown>[]
    ) => {
      const { synced, failed } = await SimproService.upsertScheduleRows(
        userId,
        batch
      );
      syncedCount += synced;
      failedCount += failed;
      console.log(
        `[simPRO Schedules Sync] Page ${page}/${totalPages} ✓ (${synced} synced, ${failed} failed)`
      );
    };

    await processPage(1, firstBatch);

    for (let page = 2; page <= totalPages; page++) {
      await sleep(SIMPRO_SCHEDULES_PAGE_DELAY_MS);

      try {
        const { batch } = await SimproService.fetchSchedulesPage(userId, page);
        if (batch.length === 0) break;

        await processPage(page, batch);

        if (totalRecords === 0 && batch.length < SIMPRO_SCHEDULES_PAGE_SIZE) {
          break;
        }
      } catch (err: any) {
        console.error(
          `[simPRO Schedules Sync] Page ${page} fetch failed:`,
          err?.message ?? err
        );
        failedCount += SIMPRO_SCHEDULES_PAGE_SIZE;
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[simPRO Schedules Sync] DONE — synced=${syncedCount} failed=${failedCount} in ${durationMs}ms`
    );

    return {
      totalRecords: totalRecords || syncedCount + failedCount,
      totalPages,
      syncedCount,
      failedCount,
      durationMs,
    };
  }

  /** GET /simpro/schedules — read from simpro_schedules (sync via POST /sync). */
  static async getSchedules(userId: string) {
    const { data, error } = await supabase
      .from("simpro_schedules")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false });

    if (error) {
      throw new ApiError(500, `Database error: ${error.message}`);
    }

    return data ?? [];
  }

  /**
   * Create a customer in Simpro. Type is decided by `customer_type` input:
   *   "company"    → POST /customers/companies/
   *   "individual" → POST /customers/individuals/
   * Defaults to "individual" since most lead-capture flows produce a person.
   */
  static async createCustomer(
    userId: string,
    customerData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);

    const kind = String(customerData.customer_type || "individual").toLowerCase();
    const endpoint =
      kind === "company"
        ? `customers/companies`
        : `customers/individuals`;

    const url = `${baseUrl}/api/v1.0/companies/${companyId}/${endpoint}/`;

    // Build payload — drop empty/null values, drop our control field, then
    // alias frontend-friendly keys to Simpro's PascalCase fields.
    const { customer_type, ...rest } = customerData;
    const aliasMap: Record<string, string> = {
      // snake_case convenience aliases
      first_name:    "GivenName",
      last_name:     "FamilyName",
      name:          "CompanyName",
      company_name:  "CompanyName",
      email:         "Email",
      phone:         "Phone",
      mobile:        "CellPhone",
      alt_phone:     "AltPhone",
      website:       "Website",
      fax:           "Fax",
      ein:           "EIN",
      company_number:"CompanyNumber",
      do_not_call:   "DoNotCall",
      archived:      "Archived",
      // Address aliases (snake_case → dot-path)
      address:       "Address.Address",
      city:          "Address.City",
      state:         "Address.State",
      postcode:      "Address.PostalCode",
      country:       "Address.Country",
      // Banking aliases (snake_case → dot-path)
      on_stop:                  "Banking.OnStop",
      vendor_order_no_required: "Banking.VendorOrderNoRequired",
      credit_limit:             "Banking.CreditLimit",
      bank_account_name:        "Banking.AccountName",
      bank_routing_no:          "Banking.RoutingNo",
      bank_account_no:          "Banking.AccountNo",
      bank_payment_method:      "Banking.PaymentMethod",
      // Rates aliases
      discount_fee: "Rates.DiscountFee",
      // Profile aliases
      notes:            "Profile.Notes",
      account_manager:  "Profile.AccountManager",
      currency:         "Profile.Currency",
      sites:            "Sites",
    };

    const payload: Record<string, any> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        dropped.push(k);
        continue;
      }
      // Skip section-header pseudo-fields (prefixed with _section_)
      if (k.startsWith("_section_")) continue;

      const apiKey = aliasMap[k] || k; // PascalCase keys pass through unchanged
      // Coerce boolean strings to actual booleans
      const coerced = v === "true" ? true : v === "false" ? false : v;
      // Sites must be an array of integer IDs
      if (apiKey === "Sites") {
        payload["Sites"] = [Number(v)];
      } else if (apiKey.includes(".")) {
        // Support dot-paths: Address.Address → { Address: { Address: v } }
        const [parent, child] = apiKey.split(".") as [string, string];
        // ID sub-fields (AccountManager, Currency, CustomerProfile, CustomerGroup, PaymentMethod) must be integers
        const ID_SUBFIELDS = new Set(["AccountManager", "Currency", "CustomerProfile", "CustomerGroup", "PaymentMethod"]);
        const finalVal = ID_SUBFIELDS.has(child) ? Number(coerced) : coerced;
        payload[parent] = { ...(payload[parent] || {}), [child]: finalVal };
      } else {
        payload[apiKey] = coerced;
      }
    }

    console.log(
      `[Simpro:createCustomer] → POST ${url}  kind=${kind}  fields=[${Object.keys(payload).join(", ")}]  dropped=[${dropped.join(", ") || "(none)"}]`
    );

    try {
      const res = await axios.post(url, payload, { headers });
      console.log(
        `[Simpro:createCustomer] ✓ status=${res.status}  id=${res.data?.ID ?? res.data?.id ?? "(none)"}  body=${JSON.stringify(res.data)?.slice(0, 300)}`
      );
      return res.data;
    } catch (err: any) {
      console.error(
        `[Simpro:createCustomer] ✖ failed  status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}  message=${err?.message}`
      );
      throw err;
    }
  }

  static async createJob(
    userId: string,
    jobData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/jobs/`;

    const aliasMap: Record<string, string> = {
      // snake_case convenience aliases
      customer_id:        "Customer",
      customer_uuid:      "Customer",
      customer:           "Customer",
      site_id:            "Site",
      site:               "Site",
      customer_contact:   "CustomerContact",
      site_contact:       "SiteContact",
      order_no:           "OrderNo",
      name:               "Name",
      description:        "Description",
      job_description:    "Description",
      notes:              "Notes",
      date_issued:        "DateIssued",
      due_date:           "DueDate",
      due_time:           "DueTime",
      tags:               "Tags",
      salesperson:        "Salesperson",
      project_manager:    "ProjectManager",
      technician:         "Technician",
      stage:              "Stage",
      job_status:         "Status",
      status:             "Status",
      response_time:      "ResponseTime",
      auto_adjust_status: "AutoAdjustStatus",
    };

    const payload: Record<string, any> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(jobData)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        dropped.push(k);
        continue;
      }
      if (k.startsWith("_section_")) continue;
      const apiKey = aliasMap[k] || k;
      const coerced = v === "true" ? true : v === "false" ? false : v;
      if (apiKey.includes(".")) {
        const [parent, child] = apiKey.split(".") as [string, string];
        payload[parent] = { ...(payload[parent] || {}), [child]: coerced };
      } else {
        payload[apiKey] = coerced;
      }
    }

    console.log(
      `[Simpro:createJob] → POST ${url}  fields=[${Object.keys(payload).join(", ")}]  dropped=[${dropped.join(", ") || "(none)"}]`
    );

    try {
      const res = await axios.post(url, payload, { headers });
      console.log(`[Simpro:createJob] ✓ status=${res.status}  id=${res.data?.ID ?? "(none)"}`);
      return res.data;
    } catch (err: any) {
      console.error(
        `[Simpro:createJob] ✖ failed  status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}  message=${err?.message}`
      );
      throw err;
    }
  }

  // ─── API Key connect (Grant Type = "API Key" in Simpro Setup → API) ────────
  // The API key is a permanent non-expiring access_token. We store it with a
  // far-future expires_at so the refresh logic never triggers for it.
  static async connectWithApiKey(
    userId: string,
    buildName: string,
    apiKey: string
  ) {
    const baseUrl = `https://${buildName}.simprosuite.com`;

    // Verify the key works and resolve company id in one shot.
    let companyId = 0;
    try {
      const res = await axios.get(`${baseUrl}/api/v1.0/companies/`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (Array.isArray(res.data) && res.data.length > 0) {
        companyId = Number(res.data[0].ID ?? res.data[0].id ?? 0);
      }
      console.log(`[Simpro:apiKey] ✓ key valid  build=${buildName}  company_id=${companyId}`);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        throw new ApiError(401, "Invalid Simpro API key — check the key and try again.");
      }
      console.warn(`[Simpro:apiKey] companies lookup failed (${status}) — defaulting to 0`);
    }

    const { error } = await supabase
      .from("simpro_integrations")
      .upsert(
        {
          user_id:       userId,
          build_name:    buildName,
          base_url:      baseUrl,
          company_id:    companyId,
          access_token:  apiKey,
          refresh_token: null,   // API keys have no refresh token
          expires_at:    null,   // null = never expires, refresh logic skipped
          scopes:        "api_key",
          needs_reauth:  false,
        },
        { onConflict: "user_id" }
      );

    if (error) {
      throw new ApiError(500, `Failed to store Simpro API key: ${error.message}`);
    }

    return { build_name: buildName, company_id: companyId, auth_type: "api_key" };
  }

  // ─── Contacts ──────────────────────────────────────────────────────────
  static async createContact(
    userId: string,
    customerId: string | number,
    contactData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/customers/${customerId}/contacts/`;

    const aliasMap: Record<string, string> = {
      first_name:  "GivenName",
      last_name:   "FamilyName",
      email:       "Email",
      phone:       "WorkPhone",   // simPRO uses WorkPhone not Phone for contacts
      work_phone:  "WorkPhone",
      mobile:      "CellPhone",
      position:    "Position",
      role:        "Position",
      title:       "Title",
      fax:         "Fax",
      department:  "Department",
      notes:       "Notes",
      alt_phone:   "AltPhone",
    };

    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(contactData)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      if (k.startsWith("_section_")) continue;
      payload[aliasMap[k] || k] = v;
    }

    console.log(`[Simpro:createContact] → POST ${url}  fields=[${Object.keys(payload).join(", ")}]`);
    try {
      const res = await axios.post(url, payload, { headers });
      console.log(`[Simpro:createContact] ✓ status=${res.status}  id=${res.data?.ID ?? "(none)"}`);
      return res.data;
    } catch (err: any) {
      console.error(`[Simpro:createContact] ✖ status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`);
      throw err;
    }
  }

  // ─── Leads ─────────────────────────────────────────────────────────────
  static async createLead(
    userId: string,
    leadData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/leads/`;

    const aliasMap: Record<string, string> = {
      // snake_case convenience aliases
      name:             "LeadName",
      lead_name:        "LeadName",
      description:      "Description",
      notes:            "Notes",
      follow_up_date:   "FollowUpDate",
      tags:             "Tags",
      customer:         "Customer",
      customer_id:      "Customer",
      site:             "Site",
      site_id:          "Site",
      customer_contact: "CustomerContact",
      sales_person:     "Salesperson",
      salesperson:      "Salesperson",
      project_manager:  "ProjectManager",
      status_id:        "Status",
      status:           "Status",
      cost_center:      "CostCenter",
      auto_adjust_status: "AutoAdjustStatus",
    };

    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(leadData)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      if (k.startsWith("_section_")) continue;
      const apiKey = aliasMap[k] || k; // PascalCase keys pass through unchanged
      const coerced = v === "true" ? true : v === "false" ? false : v;
      if (apiKey.includes(".")) {
        const [parent, child] = apiKey.split(".") as [string, string];
        payload[parent] = { ...(payload[parent] || {}), [child]: coerced };
      } else {
        payload[apiKey] = coerced;
      }
    }

    console.log(`[Simpro:createLead] → POST ${url}  fields=[${Object.keys(payload).join(", ")}]`);
    try {
      const res = await axios.post(url, payload, { headers });
      console.log(`[Simpro:createLead] ✓ status=${res.status}  id=${res.data?.ID ?? "(none)"}`);
      return res.data;
    } catch (err: any) {
      console.error(`[Simpro:createLead] ✖ status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`);
      throw err;
    }
  }

  // ─── Schedules ─────────────────────────────────────────────────────────
  static async createScheduleBlock(
    userId: string,
    scheduleData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/activitySchedules/`;

    // Block-level fields are assembled into a Blocks array
    const blockFields: Record<string, any> = {};
    const topLevel: Record<string, any> = {};

    const blockKeyMap: Record<string, string> = {
      start_time:    "StartTime",
      end_time:      "EndTime",
      schedule_rate: "ScheduleRate",
      StartTime:     "StartTime",
      EndTime:       "EndTime",
      ScheduleRate:  "ScheduleRate",
    };
    const topKeyMap: Record<string, string> = {
      staff_id:   "Staff",
      staff:      "Staff",
      date:       "Date",
      activity:   "Activity",
      notes:      "Notes",
      locked:     "IsLocked",
      is_locked:  "IsLocked",
      Staff:      "Staff",
      Date:       "Date",
      Activity:   "Activity",
      Notes:      "Notes",
      IsLocked:   "IsLocked",
    };

    for (const [k, v] of Object.entries(scheduleData)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      if (k.startsWith("_section_")) continue;
      const coerced = v === "true" ? true : v === "false" ? false : v;
      if (blockKeyMap[k]) {
        blockFields[blockKeyMap[k]] = coerced;
      } else if (topKeyMap[k]) {
        topLevel[topKeyMap[k]] = coerced;
      }
    }

    const payload: Record<string, any> = {
      ...topLevel,
      Blocks: [blockFields],
    };

    console.log(`[Simpro:createScheduleBlock] → POST ${url}  fields=[${Object.keys(payload).join(", ")}]  block=${JSON.stringify(blockFields)}`);
    try {
      const res = await axios.post(url, payload, { headers });
      console.log(`[Simpro:createScheduleBlock] ✓ status=${res.status}  id=${res.data?.ID ?? "(none)"}`);
      return res.data;
    } catch (err: any) {
      console.error(`[Simpro:createScheduleBlock] ✖ status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`);
      throw err;
    }
  }

  // ─── Sites ─────────────────────────────────────────────────────────────
  static async createSite(
    userId: string,
    siteData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/sites/`;

    const aliasMap: Record<string, string> = {
      // snake_case convenience aliases
      name:       "Name",
      customer_id:"Customers",
      address:    "Address.Address",
      city:       "Address.City",
      state:      "Address.State",
      postcode:   "Address.PostalCode",
      country:    "Address.Country",
      phone:      "Phone",
    };

    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(siteData)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      if (k.startsWith("_section_")) continue;
      const apiKey = aliasMap[k] || k;
      const coerced = v === "true" ? true : v === "false" ? false : v;
      // Customers must be an array of IDs
      if (apiKey === "Customers") {
        payload["Customers"] = [Number(v)];
      } else if (apiKey.includes(".")) {
        const [parent, child] = apiKey.split(".") as [string, string];
        payload[parent] = { ...(payload[parent] || {}), [child]: coerced };
      } else {
        payload[apiKey] = coerced;
      }
    }

    console.log(`[Simpro:createSite] → POST ${url}  fields=[${Object.keys(payload).join(", ")}]`);
    try {
      const res = await axios.post(url, payload, { headers });
      console.log(`[Simpro:createSite] ✓ status=${res.status}  id=${res.data?.ID ?? "(none)"}`);
      return res.data;
    } catch (err: any) {
      console.error(`[Simpro:createSite] ✖ status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`);
      throw err;
    }
  }

  // ─── Quotes ────────────────────────────────────────────────────────────
  static async createQuote(
    userId: string,
    quoteData: Record<string, any>
  ): Promise<any> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/quotes/`;

    const aliasMap: Record<string, string> = {
      // snake_case convenience aliases
      customer_id:      "Customer",
      site_id:          "Site",
      description:      "Description",
      name:             "Name",
      due_date:         "DueDate",
      date_issued:      "DateIssued",
      order_no:         "OrderNo",
      salesperson:      "Salesperson",
      project_manager:  "ProjectManager",
      auto_adjust_status: "AutoAdjustStatus",
    };

    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(quoteData)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      if (k.startsWith("_section_")) continue;
      const apiKey = aliasMap[k] || k;
      const coerced = v === "true" ? true : v === "false" ? false : v;
      if (apiKey.includes(".")) {
        const [parent, child] = apiKey.split(".") as [string, string];
        payload[parent] = { ...(payload[parent] || {}), [child]: coerced };
      } else {
        payload[apiKey] = coerced;
      }
    }

    console.log(`[Simpro:createQuote] → POST ${url}  fields=[${Object.keys(payload).join(", ")}]`);
    try {
      const res = await axios.post(url, payload, { headers });
      console.log(`[Simpro:createQuote] ✓ status=${res.status}  id=${res.data?.ID ?? "(none)"}`);
      return res.data;
    } catch (err: any) {
      console.error(`[Simpro:createQuote] ✖ status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`);
      throw err;
    }
  }

  // ─── Generic search helper ──────────────────────────────────────────────
  static async findRecords(
    userId: string,
    endpoint: string,
    searchParams: Record<string, any>
  ): Promise<any[]> {
    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/${endpoint}`;

    const params: Record<string, any> = { pageSize: 10, page: 1 };
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined && v !== null && String(v).trim() !== "") params[k] = v;
    }

    console.log(`[Simpro:findRecords] → GET ${url}  params=${JSON.stringify(params)}`);
    try {
      const res = await axios.get(url, { headers, params });
      const results = Array.isArray(res.data) ? res.data : [];
      console.log(`[Simpro:findRecords] ← ${results.length} result(s)`);
      return results;
    } catch (err: any) {
      console.error(`[Simpro:findRecords] ✖ status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`);
      throw err;
    }
  }

  // ─── UI Dashboard (Commusoft-shape getalljobs) ───────────────────────────

  private static formatDateDDMMYY(d: string | null | undefined): string | null {
    if (!d) return null;
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return null;
    return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(2)}`;
  }

  private static timeFromIso(iso: string | null | undefined): string {
    if (!iso || iso.length < 16) return "";
    return iso.substring(11, 16);
  }

  /**
   * Build Commusoft-shape getalljobs response from synced DB data.
   *
   * Paginates by distinct customers that have jobs (not all customers), so the
   * first page always returns groups with at least one job when data exists.
   */
  static async getAllJobsCommusoftShape(
    userId: string,
    limit: number = 50,
    cursor?: string
  ): Promise<{
    data: Record<string, unknown>[];
    meta: {
      has_more: boolean;
      next_cursor: string | null;
      total_returned: number;
    };
  }> {
    let customerIdsQuery = supabase
      .from("simpro_jobs")
      .select("customer_api_id")
      .eq("user_id", userId)
      .not("customer_api_id", "is", null);

    if (cursor) {
      customerIdsQuery = customerIdsQuery.gt("customer_api_id", cursor);
    }

    const { data: jobsCustomerIds, error: idsErr } = await customerIdsQuery.order(
      "customer_api_id",
      { ascending: true }
    );

    if (idsErr) {
      throw new ApiError(500, `Customer IDs fetch failed: ${idsErr.message}`);
    }

    const uniqueCustomerIds = [
      ...new Set(
        (jobsCustomerIds ?? [])
          .map((r) => r.customer_api_id as string)
          .filter(Boolean)
      ),
    ].slice(0, limit);

    if (uniqueCustomerIds.length === 0) {
      return {
        data: [],
        meta: { has_more: false, next_cursor: null, total_returned: 0 },
      };
    }

    const { data: customers, error: custErr } = await supabase
      .from("simpro_customers")
      .select("*")
      .eq("user_id", userId)
      .in("customer_api_id", uniqueCustomerIds);

    if (custErr) {
      throw new ApiError(500, `Customer fetch failed: ${custErr.message}`);
    }

    const { data: jobs, error: jobsErr } = await supabase
      .from("simpro_jobs")
      .select("*")
      .eq("user_id", userId)
      .in("customer_api_id", uniqueCustomerIds)
      .order("date_issued", { ascending: false });

    if (jobsErr) {
      throw new ApiError(500, `Jobs fetch failed: ${jobsErr.message}`);
    }

    const jobRows = jobs ?? [];
    const jobIds = jobRows.map((j) => j.job_api_id);
    const siteIds = [
      ...new Set(
        jobRows.map((j) => j.site_api_id).filter((id): id is string => Boolean(id))
      ),
    ];

    const sites =
      siteIds.length > 0
        ? (
            await supabase
              .from("simpro_sites")
              .select("*")
              .eq("user_id", userId)
              .in("site_api_id", siteIds)
          ).data ?? []
        : [];

    const schedules =
      jobIds.length > 0
        ? (
            await supabase
              .from("simpro_schedules")
              .select("*")
              .eq("user_id", userId)
              .eq("type", "job")
              .in("project_id", jobIds)
              .order("start_time", { ascending: false })
          ).data ?? []
        : [];

    const { data: employees } = await supabase
      .from("simpro_employees")
      .select("*")
      .eq("user_id", userId);

    const sitesById = new Map(sites.map((s) => [s.site_api_id, s]));
    const employeesById = new Map(
      (employees ?? []).map((e) => [e.employee_api_id, e])
    );
    const employeesByName = new Map(
      (employees ?? []).map((e) => [e.name, e])
    );

    const schedulesByJobId = new Map<string, typeof schedules>();
    for (const sch of schedules) {
      const jobId = sch.project_id as string;
      if (!jobId) continue;
      if (!schedulesByJobId.has(jobId)) {
        schedulesByJobId.set(jobId, []);
      }
      schedulesByJobId.get(jobId)!.push(sch);
    }

    const jobsByCustomerId = new Map<string, typeof jobRows>();
    for (const j of jobRows) {
      const custId = j.customer_api_id as string;
      if (!custId) continue;
      if (!jobsByCustomerId.has(custId)) {
        jobsByCustomerId.set(custId, []);
      }
      jobsByCustomerId.get(custId)!.push(j);
    }

    const customersMap = new Map(
      (customers ?? []).map((c) => [c.customer_api_id, c])
    );

    const orderedCustomers = uniqueCustomerIds
      .map((id) => {
        const row = customersMap.get(id);
        if (row) return row;
        const firstJob = jobsByCustomerId.get(id)?.[0];
        if (!firstJob) return null;
        return {
          customer_api_id: id,
          company_name: firstJob.customer_company_name,
          given_name: firstJob.customer_given_name,
          family_name: firstJob.customer_family_name,
          type: firstJob.customer_type,
          email: null,
          phone: null,
          alt_phone: null,
          billing_address_line: null,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const result = orderedCustomers.map((customer) => {
        const customerJobs = jobsByCustomerId.get(customer.customer_api_id) ?? [];
        const firstJob = customerJobs[0];
        const primarySite = firstJob
          ? sitesById.get(firstJob.site_api_id)
          : null;

        const customerName =
          customer.company_name ||
          `${customer.given_name || ""} ${customer.family_name || ""}`.trim() ||
          "Unknown";

        const customerAddress = customer.billing_address_line || "";

        return {
          contact: {
            name: customerName,
            email: customer.email || null,
            phone: customer.phone || null,
            mobile: customer.alt_phone || null,
            type: customer.type === "Company" ? "company" : "customer",
            is_primary_contact: null,
          },
          site: {
            name: primarySite?.name || customerName,
            website: null,
            abn_number: null,
            address: primarySite?.address_line || customerAddress,
            address_street: null,
            address_city: primarySite?.city || null,
            address_state: primarySite?.state || null,
            address_postcode: primarySite?.postal_code || null,
            address_country: primarySite?.country || null,
            billing_address: customerAddress,
            fax_number: null,
          },
          head_office: {
            name: customerName,
            address: customerAddress,
          },
          job_count: customerJobs.length,
          jobs: customerJobs.map((job) => {
            const jobSchedules = schedulesByJobId.get(job.job_api_id) ?? [];
            const latestSchedule = jobSchedules[0];

            const engineerEmployee = latestSchedule?.staff_api_id
              ? employeesById.get(latestSchedule.staff_api_id)
              : latestSchedule?.staff_name
                ? employeesByName.get(latestSchedule.staff_name)
                : null;

            const jobSite = job.site_api_id
              ? sitesById.get(job.site_api_id)
              : null;
            const jobAddressParts = [
              jobSite?.address_line,
              jobSite?.city,
              jobSite?.postal_code,
            ].filter(Boolean);

            const formatDiaryEvent = (sch: (typeof schedules)[0]) => {
              const start = SimproService.timeFromIso(sch.start_time);
              const end = SimproService.timeFromIso(sch.end_time);
              const date = SimproService.formatDateDDMMYY(sch.schedule_date);
              const hrs = sch.total_hours ?? "";
              return `${date} ${hrs} hr(${start} to ${end})`;
            };

            return {
              job: {
                generated_job_id: job.job_api_id,
                status: job.status_name || job.stage || "pending",
                date: SimproService.formatDateDDMMYY(job.date_issued),
                job_address: jobAddressParts.join(", "),
                job_description: job.description || job.name || "",
                work_done_description: "",
                total_invoice_amount: job.total_inc_tax?.toString() || "0",
                purchase_order_number: job.order_no || null,
                category: null,
                quote_date: null,
                completion_date:
                  job.stage === "Complete"
                    ? SimproService.formatDateDDMMYY(job.date_issued)
                    : null,
                job_uuid: job.job_api_id,
                job_property_type: "customer",
                job_property_uuid: job.customer_api_id,
                is_recall: "No",
                number_of_certificates: null,
                job_stage: job.stage || null,
                created_from: "simPRO",
                job_on_hold_reasons: null,
                customer_contract: null,
                job_contract: null,
                priority: null,
              },
              engineer: {
                name: latestSchedule?.staff_name || null,
                email: engineerEmployee?.email || null,
                mobile: engineerEmployee?.cell_phone || null,
                job_title: engineerEmployee?.position || null,
                status_message: null,
                last_engineer_on_site: latestSchedule?.staff_name || null,
                next_engineer_on_site: null,
              },
              payment: {
                status: "0",
                amount: job.total_inc_tax?.toString() || "0",
                method: null,
                date: SimproService.formatDateDDMMYY(job.date_issued),
                total_invoice: job.total_inc_tax?.toString() || null,
                ready_to_invoice: job.stage === "Complete",
                payments: [],
              },
              activities:
                jobSchedules.length > 0
                  ? jobSchedules.map((sch) => ({
                      start_date: formatDiaryEvent(sch),
                      end_date: "",
                      scheduled: String(jobSchedules.length),
                      last_diary_event: latestSchedule
                        ? formatDiaryEvent(latestSchedule)
                        : "",
                      next_diary_event: "",
                      number_of_diary_events: String(jobSchedules.length),
                    }))
                  : [
                      {
                        start_date: "",
                        end_date: "",
                        scheduled: null,
                        last_diary_event: "",
                        next_diary_event: "",
                        number_of_diary_events: null,
                      },
                    ],
              jobmaterials: [],
            };
          }),
        };
    });

    const lastCustomerId =
      uniqueCustomerIds[uniqueCustomerIds.length - 1] ?? null;

    const { data: moreCheck } = lastCustomerId
      ? await supabase
          .from("simpro_jobs")
          .select("customer_api_id")
          .eq("user_id", userId)
          .not("customer_api_id", "is", null)
          .gt("customer_api_id", lastCustomerId)
          .limit(1)
      : { data: [] };

    const hasMore = (moreCheck ?? []).length > 0;

    return {
      data: result,
      meta: {
        has_more: hasMore,
        next_cursor: hasMore && lastCustomerId ? lastCustomerId : null,
        total_returned: result.length,
      },
    };
  }

  // ─── Connect / disconnect helpers ──────────────────────────────────────
  static async getConnectionStatus(userId: string) {
    const { data } = await supabase
      .from("simpro_integrations")
      .select("build_name, base_url, company_id, expires_at, scopes")
      .eq("user_id", userId)
      .maybeSingle();

    return { connected: !!data, ...(data || {}) };
  }

  static async disconnect(userId: string) {
    const { error } = await supabase
      .from("simpro_integrations")
      .delete()
      .eq("user_id", userId);
    if (error) throw new ApiError(500, `Failed to disconnect Simpro: ${error.message}`);
    return { disconnected: true };
  }

  /**
   * Master sync — orchestrates all resource syncs in dependency order.
   *
   * Pattern: Commusoft sequential + try/catch per step + ServiceM8 return shape.
   *
   * Order: customers → sites → employees → jobs → schedules
   */
  static async syncAll(userId: string): Promise<SimproSyncAllResult> {
    const masterStartTime = Date.now();
    const startedAt = new Date(masterStartTime).toISOString();

    console.log(`[simPRO:syncAll] ▶ START user=${userId}`);

    const steps: Array<{
      key: SimproResourceKey;
      run: () => Promise<SimproResourceSyncPayload>;
    }> = [
      { key: "customers", run: () => SimproService.syncCustomers(userId) },
      { key: "sites", run: () => SimproService.syncSites(userId) },
      { key: "employees", run: () => SimproService.syncEmployees(userId) },
      { key: "jobs", run: () => SimproService.syncJobs(userId) },
      { key: "schedules", run: () => SimproService.syncSchedules(userId) },
    ];

    const results: SimproSyncAllResult["results"] = {};
    const failedEntities: SimproResourceKey[] = [];

    for (const step of steps) {
      const stepStart = Date.now();
      console.log(`[simPRO:syncAll] ▶ ${step.key}...`);

      try {
        const data = await step.run();
        results[step.key] = {
          status: "synced",
          ...data,
        };

        if (data.failedCount > 0) {
          console.warn(
            `[simPRO:syncAll] ⚠ ${step.key} had ${data.failedCount} failures`
          );
        }

        console.log(
          `[simPRO:syncAll] ✓ ${step.key} synced=${data.syncedCount}/${data.totalRecords} in ${data.durationMs}ms`
        );
      } catch (err: any) {
        const stepDuration = Date.now() - stepStart;
        const errorMessage = err?.message ?? String(err);

        results[step.key] = {
          status: "failed",
          error: errorMessage,
          durationMs: stepDuration,
        };
        failedEntities.push(step.key);

        console.error(`[simPRO:syncAll] ✖ ${step.key} FAILED: ${errorMessage}`);
      }
    }

    const totalDurationMs = Date.now() - masterStartTime;

    const overall: SimproSyncAllResult["overall"] =
      failedEntities.length === 0
        ? "success"
        : failedEntities.length === steps.length
          ? "failed"
          : "partial";

    const completedAt = new Date().toISOString();

    console.log(
      `[simPRO:syncAll] ◀ DONE overall=${overall} durationMs=${totalDurationMs}` +
        (failedEntities.length > 0 ? ` failed=[${failedEntities.join(",")}]` : "")
    );

    return {
      overall,
      failedEntities,
      durationMs: totalDurationMs,
      startedAt,
      completedAt,
      results,
    };
  }
}
