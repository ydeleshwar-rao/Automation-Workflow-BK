
import axios from "axios";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { logger } from "../../../../utils/logger.js";
import { withFallback } from "../utils/externalApiTracker.js";
import { refreshAccessToken } from "../utils/refreshAccessToken.js";
import {
  mapServiceM8DiaryEventHttpError,
  sleep,
} from "../utils/serviceM8DiaryEvent.util.js";

const SERVICEM8_BASE_URL = "https://api.servicem8.com/api_1.0";
const SERVICEM8_AUTH_URL = "https://go.servicem8.com/oauth/access_token";
const checkDev = process.env.NODE_ENV !== "production";

// Prevents concurrent token refreshes for the same user from racing each other
const refreshLocks = new Map<string, Promise<any>>();

// Refresh proactively when <5 min remain — avoids tokens expiring mid-flight
const REFRESH_BUFFER_MS = 5 * 60 * 1000;



const getIntegration = async (userId: string, forceRefresh = false) => {
  const { data, error } = await supabase
    .from("servicem8_integrations")
    .select("user_id, access_token, expires_at, refresh_token, needs_reauth")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(
      404,
      "ServiceM8 integration not found. Please connect your account first."
    );
  }

  const now = Date.now();
  const expiry = new Date(data.expires_at).getTime();

  // Token is fresh and no reconnection is needed — use it as-is
  if (!forceRefresh && !data.needs_reauth && now < expiry - REFRESH_BUFFER_MS) {
    return data;
  }

  // 🔄 Token expired / expiring soon / force-refreshed → deduplicated refresh
  if (!refreshLocks.has(userId)) {
    const refreshPromise = (async () => {
      const refreshed = await refreshAccessToken(userId, data.refresh_token);
      const newExpiry = new Date();
      newExpiry.setSeconds(newExpiry.getSeconds() + (refreshed.expires_in || 3600));
      return {
        ...data,
        access_token:  refreshed.access_token,
        refresh_token: refreshed.refresh_token || data.refresh_token,
        expires_at:    newExpiry.toISOString(),
      };
    })().finally(() => refreshLocks.delete(userId));

    refreshLocks.set(userId, refreshPromise);
  }

  return refreshLocks.get(userId)!;
};

const getHeaders = async (userId: string, forceRefresh = false) => {
  const integration = await getIntegration(userId, forceRefresh);
  return {
    Authorization: `Bearer ${integration.access_token}`,
    Accept: "application/json",
  };
};

/**
 * Exported version of getHeaders for use by the polling engine adapter.
 * Handles token refresh automatically via getIntegration().
 */
export const getServiceM8Headers = getHeaders;

/**
 * Wraps a ServiceM8 live-API call so that a 401 (token silently revoked by
 * ServiceM8 — e.g. another user reconnected the same account) triggers an
 * immediate force-refresh and a single retry before propagating the error.
 * Use this as the first argument to withFallback() for every live SM8 call.
 */
const sm8Live = <T>(
  userId: string,
  fn: (headers: Record<string, string>) => Promise<T>
) => async (): Promise<T> => {
  const headers = await getHeaders(userId);
  try {
    return await fn(headers);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      console.warn(`[SM8] 401 for user ${userId} — token may have been revoked externally, force-refreshing and retrying`);
      const freshHeaders = await getHeaders(userId, true);
      return await fn(freshHeaders);
    }
    throw err;
  }
};

// Convenience wrapper: withFallback + sm8Live combined so every call site
// gets 401-retry for free without repeating the boilerplate.
const withSm8Fallback = <T>(
  userId: string,
  liveFn: (headers: Record<string, string>) => Promise<T>,
  cacheFn: () => Promise<T>
) => withFallback(sm8Live(userId, liveFn), cacheFn);


const upsertToSupabase = async (table: string, records: any[], userId: string) => {

  if (!records || records.length === 0) {
    console.log("No records to insert");
    return;
  }

  const sanitizeRow = (r: any) => {
    const row: any = { user_id: userId };
    for (const [key, value] of Object.entries(r)) {
      if ((key === 'uuid' || key.endsWith('_uuid')) && value === '') {
        row[key] = null;
      } else {
        row[key] = value;
      }
    }
    return row;
  };

  const rows = records.map(sanitizeRow);

  console.log("Rows to insert:", rows.length);

  const { data, error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: "uuid" })
    .select();

  if (error) {
    console.error(`❌ Supabase upsert error (${table})`, error);
    throw error;
  }

  console.log(`✅ ${data?.length} records synced to ${table}`);
};

export class ServiceM8Service {

  // ─── 1. Companies (Clients) ───────────────────────────────────────────────


  static async listClients(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/company.json`, { headers });
        const data = response.data;
        const filtered = data.map((r: any) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('customfield_')))
        );
        await upsertToSupabase("servicem8_site_details", filtered, userId);
        return data;
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_site_details").select("*").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }


  static async createClient(userId: string, clientData: any) {
    const t0 = Date.now();
    console.log(
      `[SM8:createClient] ▶ user=${userId}  fields=[${Object.keys(clientData || {}).join(", ")}]`
    );
    const headers = await getHeaders(userId);
    // ServiceM8's REST endpoint for clients is /company.json — the prior /client.json was wrong.
    const response = await axios.post(
      `${SERVICEM8_BASE_URL}/company.json`,
      clientData,
      { headers }
    );
    // ServiceM8 returns the new uuid in the x-record-uuid header (body is often empty).
    const uuid =
      response.headers?.["x-record-uuid"] ??
      response.headers?.["X-Record-UUID"] ??
      response.data?.uuid ??
      null;
    console.log(
      `[SM8:createClient] ◀ uuid=${uuid ?? "(none)"}  http=${response.status}  duration=${Date.now() - t0}ms`
    );
    return { uuid, ...(response.data || {}) };
  }

  // Creates a companycontact row linked to an existing company.
  static async createCompanyContact(
    userId: string,
    companyUuid: string,
    contact: Record<string, any>
  ) {
    const t0 = Date.now();
    console.log(
      `[SM8:createCompanyContact] ▶ user=${userId}  company=${companyUuid}  fields=[${Object.keys(contact || {}).join(", ")}]`
    );
    const headers = await getHeaders(userId);
    const payload = { ...contact, company_uuid: companyUuid };
    const response = await axios.post(
      `${SERVICEM8_BASE_URL}/companycontact.json`,
      payload,
      { headers }
    );
    const uuid =
      response.headers?.["x-record-uuid"] ??
      response.headers?.["X-Record-UUID"] ??
      response.data?.uuid ??
      null;
    console.log(
      `[SM8:createCompanyContact] ◀ uuid=${uuid ?? "(none)"}  http=${response.status}  duration=${Date.now() - t0}ms`
    );
    return { uuid, ...(response.data || {}) };
  }

  static async updateClient(userId: string, clientId: string, clientData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(`${SERVICEM8_BASE_URL}/client/${clientId}.json`, clientData, { headers });
    return response.data;
  }

  // ─── 2. Contacts ──────────────────────────────────────────────────────────

  static async listContacts(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/companycontact.json`, { headers });
        const data = response.data;
        await upsertToSupabase("servicem8_contacts", data, userId);
        return data.map((c: any) => ({
          first: c.first || null, last: c.last || null,
          email: c.email || null, phone: c.phone || null,
          mobile: c.mobile || null, type: c.type || null,
        }));
      },
      async () => {
        const { data, error } = await supabase
          .from("servicem8_contacts")
          .select("first, last, email, phone, mobile, type")
          .eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  // ─── 3. Locations ─────────────────────────────────────────────────────────
  static async listLocations(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/location.json`, { headers });
        const data = response.data;
        await upsertToSupabase("servicem8_locations", data, userId);
        return data;
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_locations").select("*").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  static async createLocation(userId: string, locationData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(`${SERVICEM8_BASE_URL}/location.json`, locationData, { headers });
    return response.data;
  }

  // ─── 4. Jobs ──────────────────────────────────────────────────────────────


static async listJobs(userId: string) {
  return withSm8Fallback(
    userId,
    async (headers) => {
      const response = await axios.get(`${SERVICEM8_BASE_URL}/job.json`, { headers });
      const data = response.data;

      const clean = (v: any) => (!v || v === "" || v === "0000-00-00 00:00:00" ? null : v);
      const safeFK = (uuid: any, validSet: Set<string>): string | null => {
        const val = clean(uuid);
        return val && validSet.has(val) ? val : null;
      };

      const [{ data: companies }, { data: staffList }, { data: categories }, { data: queues }] =
        await Promise.all([
          supabase.from("servicem8_site_details").select("uuid"),
          supabase.from("servicem8_staff").select("uuid"),
          supabase.from("servicem8_categories").select("uuid"),
          supabase.from("servicem8_queues").select("uuid"),
        ]);

      const validCompanyUUIDs  = new Set(companies?.map((c: any) => c.uuid) ?? []);
      const validStaffUUIDs    = new Set(staffList?.map((s: any) => s.uuid) ?? []);
      const validCategoryUUIDs = new Set(categories?.map((c: any) => c.uuid) ?? []);
      const validQueueUUIDs    = new Set(queues?.map((q: any) => q.uuid) ?? []);

      data.forEach((job: any) => {
        Object.keys(job).forEach((key) => { job[key] = clean(job[key]); });
        job.company_uuid                = safeFK(job.company_uuid, validCompanyUUIDs);
        job.completion_actioned_by_uuid = safeFK(job.completion_actioned_by_uuid, validStaffUUIDs);
        job.created_by_staff_uuid       = safeFK(job.created_by_staff_uuid, validStaffUUIDs);
        job.payment_actioned_by_uuid    = safeFK(job.payment_actioned_by_uuid, validStaffUUIDs);
        job.queue_assigned_staff_uuid   = safeFK(job.queue_assigned_staff_uuid, validStaffUUIDs);
        job.category_uuid               = safeFK(job.category_uuid, validCategoryUUIDs);
        job.queue_uuid                  = safeFK(job.queue_uuid, validQueueUUIDs);
      });

      await upsertToSupabase("servicem8_jobs", data, userId);
      return data;
    },
    async () => {
      const { data, error } = await supabase.from("servicem8_jobs").select("*").eq("user_id", userId);
      if (error) throw error;
      return data ?? [];
    }
  );
}

// Fetch jobs from live ServiceM8 API with $filter applied.
// Supports queue, category, status, staff, company, active and date range filters.
// ServiceM8 only supports eq/ne/gt/lt/and (no ge/le/or) and max 10 conditions per $filter.
// Upserts the returned rows into servicem8_jobs so local data stays in sync.
static async listJobsFiltered(
  userId: string,
  filters: {
    queueUuid?: string;
    categoryUuid?: string;
    status?: string;
    dateFrom?: string;   // YYYY-MM-DD inclusive
    dateTo?: string;     // YYYY-MM-DD inclusive
    staffUuid?: string;  // matched against completion_actioned_by_uuid
    companyUuid?: string;
    active?: 0 | 1;
  }
) {
  return withSm8Fallback(
    userId,
    async (headers) => {
      const startedAt = Date.now();
      console.log(`[SM8:listJobsFiltered] ▶ user=${userId}  filters=${JSON.stringify(filters)}`);

      const fmtDateTime = (d: Date) => {
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      };
      const escapeStr = (s: string) => s.replace(/'/g, "''");

      const filterParts: string[] = [];
      if (filters.queueUuid)    filterParts.push(`queue_uuid eq '${escapeStr(filters.queueUuid)}'`);
      if (filters.categoryUuid) filterParts.push(`category_uuid eq '${escapeStr(filters.categoryUuid)}'`);
      if (filters.status)       filterParts.push(`status eq '${escapeStr(filters.status)}'`);
      if (filters.staffUuid)    filterParts.push(`completion_actioned_by_uuid eq '${escapeStr(filters.staffUuid)}'`);
      if (filters.companyUuid)  filterParts.push(`company_uuid eq '${escapeStr(filters.companyUuid)}'`);
      if (filters.active !== undefined) filterParts.push(`active eq ${filters.active}`);

      if (filters.dateFrom) {
        const from = new Date(`${filters.dateFrom}T00:00:00`);
        if (!isNaN(from.getTime())) { from.setSeconds(from.getSeconds() - 1); filterParts.push(`date gt '${fmtDateTime(from)}'`); }
      }
      if (filters.dateTo) {
        const to = new Date(`${filters.dateTo}T00:00:00`);
        if (!isNaN(to.getTime())) { to.setDate(to.getDate() + 1); filterParts.push(`date lt '${fmtDateTime(to)}'`); }
      }

      if (filterParts.length > 10) throw new ApiError(400, "Too many filter conditions (ServiceM8 supports a maximum of 10 per request)");

      const filterStr = filterParts.join(" and ");
      const params = filterParts.length ? { $filter: filterStr } : undefined;
      const url = `${SERVICEM8_BASE_URL}/job.json`;
      console.log(`[SM8:listJobsFiltered] → GET ${url}  $filter=${filterStr || "(none)"}`);

      const response = await axios.get(url, { headers, params });
      const data = response.data;

      if (Array.isArray(data) && data.length > 0) {
        const sample = data[0];
        console.log(`[SM8:listJobsFiltered] sample[0]  uuid=${sample?.uuid}  status=${sample?.status}`);
      }

      const clean = (v: any) => (!v || v === "" || v === "0000-00-00 00:00:00" ? null : v);
      const safeFK = (uuid: any, set: Set<string>) => { const v = clean(uuid); return v && set.has(v) ? v : null; };

      const [{ data: companies }, { data: staffList }, { data: categories }, { data: queues }] =
        await Promise.all([
          supabase.from("servicem8_site_details").select("uuid"),
          supabase.from("servicem8_staff").select("uuid"),
          supabase.from("servicem8_categories").select("uuid"),
          supabase.from("servicem8_queues").select("uuid"),
        ]);

      const validCompanyUUIDs  = new Set(companies?.map((c: any) => c.uuid) ?? []);
      const validStaffUUIDs    = new Set(staffList?.map((s: any) => s.uuid) ?? []);
      const validCategoryUUIDs = new Set(categories?.map((c: any) => c.uuid) ?? []);
      const validQueueUUIDs    = new Set(queues?.map((q: any) => q.uuid) ?? []);

      data.forEach((job: any) => {
        Object.keys(job).forEach((key) => { job[key] = clean(job[key]); });
        job.company_uuid                = safeFK(job.company_uuid, validCompanyUUIDs);
        job.completion_actioned_by_uuid = safeFK(job.completion_actioned_by_uuid, validStaffUUIDs);
        job.created_by_staff_uuid       = safeFK(job.created_by_staff_uuid, validStaffUUIDs);
        job.payment_actioned_by_uuid    = safeFK(job.payment_actioned_by_uuid, validStaffUUIDs);
        job.queue_assigned_staff_uuid   = safeFK(job.queue_assigned_staff_uuid, validStaffUUIDs);
        job.category_uuid               = safeFK(job.category_uuid, validCategoryUUIDs);
        job.queue_uuid                  = safeFK(job.queue_uuid, validQueueUUIDs);
      });

      if (data.length > 0) await upsertToSupabase("servicem8_jobs", data, userId);

      console.log(`[SM8:listJobsFiltered] ◀ complete  returned=${data.length}  duration=${Date.now() - startedAt}ms`);
      return data;
    },
    async () => {
      let query = supabase.from("servicem8_jobs").select("*").eq("user_id", userId);
      if (filters.queueUuid)    query = query.eq("queue_uuid", filters.queueUuid);
      if (filters.categoryUuid) query = query.eq("category_uuid", filters.categoryUuid);
      if (filters.status)       query = query.eq("status", filters.status);
      if (filters.companyUuid)  query = query.eq("company_uuid", filters.companyUuid);
      if (filters.staffUuid)    query = query.eq("completion_actioned_by_uuid", filters.staffUuid);
      if (filters.dateFrom)     query = query.gte("date", filters.dateFrom);
      if (filters.dateTo)       query = query.lte("date", filters.dateTo);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    }
  );
}


  static async createJob(userId: string, jobData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(
      `${SERVICEM8_BASE_URL}/job.json`,
      jobData,
      { headers }
    );
    const uuid =
      response.headers?.["x-record-uuid"] ??
      response.headers?.["X-Record-UUID"] ??
      response.data?.uuid ??
      null;
    return { uuid, ...(response.data || {}) };
  }

  static async updateJob(userId: string, jobId: string, jobData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(`${SERVICEM8_BASE_URL}/job/${jobId}.json`, jobData, { headers });
    return response.data;
  }

  // ─── 5. Staff Members ─────────────────────────────────────────────────────
  /** Active staff for workflow dropdowns (uuid + display label). */
  static async listActiveStaffForSelect(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/staff.json`, { headers });
        const data = response.data ?? [];
        data.forEach((staff: any) => {
          Object.keys(staff).forEach((key) => {
            if (staff[key] === "0000-00-00 00:00:00") staff[key] = null;
          });
        });
        await upsertToSupabase("servicem8_staff", data, userId);
        return data
          .filter(
            (s: any) => s.active === 1 || s.active === "1" || s.active === true
          )
          .map((s: any) => ({
            uuid: s.uuid,
            label:
              [s.first, s.last].filter(Boolean).join(" ").trim() ||
              s.email ||
              s.uuid,
          }));
      },
      async () => {
        const { data, error } = await supabase
          .from("servicem8_staff")
          .select("uuid, first, last, email, active")
          .eq("user_id", userId)
          .eq("active", 1);
        if (error) throw error;
        return (data ?? []).map((s: any) => ({
          uuid: s.uuid,
          label:
            [s.first, s.last].filter(Boolean).join(" ").trim() ||
            s.email ||
            s.uuid,
        }));
      }
    );
  }

  static async listStaffMembers(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/staff.json`, { headers });
        const data = response.data;
        data.forEach((staff: any) => {
          Object.keys(staff).forEach((key) => { if (staff[key] === "0000-00-00 00:00:00") staff[key] = null; });
        });
        await upsertToSupabase("servicem8_staff", data, userId);
        return data.map((s: any) => ({
          first: s.first || null, last: s.last || null,
          email: s.email || null, mobile: s.mobile || null, job_title: s.job_title || null,
        }));
      },
      async () => {
        const { data, error } = await supabase
          .from("servicem8_staff")
          .select("first, last, email, mobile, job_title")
          .eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  // ─── 6. Categories ────────────────────────────────────────────────────────
  static async listCategories(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/category.json`, { headers });
        const data = response.data;
        const mapped = data.map((r: any) => ({ uuid: r.uuid, name: r.name, colour: r.colour, active: r.active, edit_date: r.edit_date || null }));
        await upsertToSupabase("servicem8_categories", mapped, userId);
        return data.map((q: any) => ({ uuid: q.uuid, name: q.name }));
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_categories").select("uuid, name").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  // ─── 7. Queues ────────────────────────────────────────────────────────────
  static async listQueues(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/jobqueue.json`, { headers });
        // Filter to active queues only — SM8 returns inactive/deleted queues too,
        // which causes the dropdown to show entries that don't exist in the SM8 UI.
        const active = (response.data ?? []).filter(
          (q: any) => q.active === 1 || q.active === "1" || q.active === true
        );

        if (active.length > 0) {
          const uuids = active.map((r: any) => r.uuid);
          const { data: existing } = await supabase.from("servicem8_queues").select("uuid").in("uuid", uuids);
          const existingUuids = new Set((existing || []).map((r: any) => r.uuid));
          const newRecords = active.filter((r: any) => !existingUuids.has(r.uuid));
          if (newRecords.length > 0) {
            const { error } = await supabase.from("servicem8_queues").insert(newRecords.map((r: any) => ({ ...r, user_id: userId })));
            if (error) { console.error("❌ Supabase insert error (servicem8_queues)", error); throw error; }
          }
        }

        return active.map((q: any) => ({ uuid: q.uuid, name: q.name }));
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_queues").select("uuid, name").eq("user_id", userId).eq("active", 1);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  // ─── 8. Job Allocations ───────────────────────────────────────────────────
static async listJobAllocations(userId: string) {
  return withSm8Fallback(
    userId,
    async (headers) => {
      const response = await axios.get(`${SERVICEM8_BASE_URL}/jobactivity.json`, { headers });
      const data = response.data;
      const clean = (v: any) => (v === null || v === undefined || v === "" || v === "0000-00-00 00:00:00" ? null : v);
      data.forEach((a: any) => { Object.keys(a).forEach((k) => { a[k] = clean(a[k]); }); });
      await upsertToSupabase("servicem8_job_activities", data, userId);
      return data;
    },
    async () => {
      const { data, error } = await supabase.from("servicem8_job_activities").select("*").eq("user_id", userId);
      if (error) throw error;
      return data ?? [];
    }
  );
}

  static async createJobAllocation(userId: string, allocationData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(`${SERVICEM8_BASE_URL}/jobactivity.json`, allocationData, { headers });
    return response.data;
  }

  /**
   * Creates a dispatch-board diary event (jobactivity).
   * Uses OAuth via getHeaders / sm8Live (401 → refresh + retry once).
   * Retries 5xx with exponential backoff (max 3 attempts).
   */
  static async createDiaryEvent(userId: string, payload: Record<string, string | number>) {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await sm8Live(userId, async (headers) => {
          const response = await axios.post(
            `${SERVICEM8_BASE_URL}/jobactivity.json`,
            payload,
            { headers }
          );
          const uuid =
            response.headers?.["x-record-uuid"] ??
            response.headers?.["X-Record-UUID"] ??
            response.data?.uuid ??
            null;
          return { uuid, ...(response.data || {}) };
        })();
      } catch (err: any) {
        lastError = err;
        const status: number | undefined = err?.response?.status;

        if (status !== undefined && status >= 400 && status < 500) {
          throw mapServiceM8DiaryEventHttpError(status, err?.response?.data);
        }

        if (status !== undefined && status >= 500 && attempt < maxAttempts) {
          const delayMs = 500 * 2 ** (attempt - 1);
          console.warn(
            `[SM8:createDiaryEvent] ${status} on attempt ${attempt}/${maxAttempts} — retrying in ${delayMs}ms`
          );
          await sleep(delayMs);
          continue;
        }

        if (status !== undefined) {
          throw mapServiceM8DiaryEventHttpError(status, err?.response?.data);
        }
        throw err;
      }
    }

    throw lastError;
  }

  // ─── 9. Job Materials ─────────────────────────────────────────────────────
  static async listMaterials(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/material.json`, { headers });
        const data = response.data;
        await upsertToSupabase("servicem8_materials", data, userId);
        return data;
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_materials").select("*").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  static async createJobMaterial(userId: string, materialData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(`${SERVICEM8_BASE_URL}/jobmaterial.json`, materialData, { headers });
    return response.data;
  }


  static async listJobMaterials(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/jobmaterial.json`, { headers });
        const data = response.data;
        await upsertToSupabase("servicem8_job_materials", data, userId);
        return data;
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_job_materials").select("*").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  // ─── 10. Notes ────────────────────────────────────────────────────────────
  static async listNotes(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/note.json`, { headers });
        const data = response.data;
        await upsertToSupabase("servicem8_notes", data, userId);
        return data;
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_notes").select("*").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  static async createNote(userId: string, noteData: any) {
    const headers = await getHeaders(userId);
    const response = await axios.post(`${SERVICEM8_BASE_URL}/note.json`, noteData, { headers });
    return response.data;
  }

  // ─── 11. Sync All (one-shot full sync) ────────────────────────────────────
  static async syncAll(userId: string) {
    const toResult = (r: PromiseSettledResult<any>) =>
      r.status === "fulfilled"
        ? { status: "synced" as const, count: Array.isArray(r.value?.data) ? r.value.data.length : null, source: r.value?.sm8?.source ?? "live" }
        : { status: "failed" as const, error: r.reason?.message ?? String(r.reason) };

    // Phase 1: sync FK-dependency tables first
    const [companies, contacts, locations, staff, categories, queues] =
      await Promise.allSettled([
        ServiceM8Service.listClients(userId),
        ServiceM8Service.listContacts(userId),
        ServiceM8Service.listLocations(userId),
        ServiceM8Service.listStaffMembers(userId),
        ServiceM8Service.listCategories(userId),
        ServiceM8Service.listQueues(userId),
      ]);

    // Phase 2: jobs depend on companies/staff/categories/queues being synced first
    const [jobs, jobAllocations, materials, notes, jobMaterials] =
      await Promise.allSettled([
        ServiceM8Service.listJobs(userId),
        ServiceM8Service.listJobAllocations(userId),
        ServiceM8Service.listMaterials(userId),
        ServiceM8Service.listNotes(userId),
        ServiceM8Service.listJobMaterials(userId),
      ]);

    const results = {
      companies:      toResult(companies),
      contacts:       toResult(contacts),
      locations:      toResult(locations),
      staff:          toResult(staff),
      categories:     toResult(categories),
      queues:         toResult(queues),
      jobs:           toResult(jobs),
      jobAllocations: toResult(jobAllocations),
      materials:      toResult(materials),
      notes:          toResult(notes),
      jobMaterials:   toResult(jobMaterials),
    };

    const failed = Object.entries(results)
      .filter(([, v]) => v.status === "failed")
      .map(([k]) => k);

    return {
      overall: failed.length === 0 ? "success" : failed.length === Object.keys(results).length ? "failed" : "partial",
      failedEntities: failed,
      results,
    };
  }

  // ─── 12. Custom: Job Full Details from Supabase ───────────────────────────
//then fix working but for future use 
  // Returns job + company + engineer details for a user (from our DB)
  // static async getJobFullDetails(userId: string, filters?: {
  //   companyUuid?: string;
  //   status?: string;
  //   jobUuid?: string;
  // }) {
  //   let query = supabase
  //     .from("servicem8_job_full_details")
  //     .select("*")
  //     .eq("user_id", userId);

  //   if (filters?.companyUuid) query = query.eq("company_uuid", filters.companyUuid);
  //   if (filters?.status)      query = query.eq("status", filters.status);
  //   if (filters?.jobUuid)     query = query.eq("job_uuid", filters.jobUuid);

  //   const { data, error } = await query;

  //   if (error) throw new Error(`Failed to fetch job details: ${error.message}`);

  //   return data;
  // }

  // ─── 11. Job Payments ─────────────────────────────────────────────────────
  static async listJobPayments(userId: string) {
    return withSm8Fallback(
      userId,
      async (headers) => {
        const response = await axios.get(`${SERVICEM8_BASE_URL}/jobpayment.json`, { headers });
        const data = response.data;

        const { data: jobs } = await supabase.from("serviceM8_jobs").select("uuid").eq("user_id", userId);
        const validJobUUIDs = new Set(jobs?.map((j: any) => j.uuid));
        const clean = (v: any) => (!v || v === "" || v === "0000-00-00 00:00:00" ? null : v);

        const cleaned = data
          .map((p: any) => { const row: any = {}; Object.keys(p).forEach((k) => { row[k] = clean(p[k]); }); return row; })
          .filter((p: any) => p.job_uuid && validJobUUIDs.has(p.job_uuid));

        await upsertToSupabase("servicem8_job_payments", cleaned, userId);
        return cleaned;
      },
      async () => {
        const { data, error } = await supabase.from("servicem8_job_payments").select("*").eq("user_id", userId);
        if (error) throw error;
        return data ?? [];
      }
    );
  }

  // ─── 13. Job Statuses ──────────────────────────────────────────────────────
  static async getJobStatuses(userId: string) {
    const headers = await getHeaders(userId);
    const response = await axios.get(`${SERVICEM8_BASE_URL}/job.json`, { headers });
      console.log("getJobStatuses called for userId:", response);
    const jobs = response.data;

    if (!Array.isArray(jobs)) {
      throw new ApiError(502, "ServiceM8 job response invalid format");
    }

    // Extract unique statuses from jobs
    const statusSet = new Set<string>();
    jobs.forEach((job: any) => {
      if (job.status && typeof job.status === "string") {
        statusSet.add(job.status);
      }
    });
    const statuses = Array.from(statusSet).map((s) => ({ status: s }));

    // Fetch existing statuses from DB to compare
    const { data: existing, error: fetchError } = await supabase
      .from("servicem8_job_statuses")
      .select("status");

    if (fetchError) {
      console.error("❌ Supabase fetch error (servicem8_job_statuses)", fetchError);
      throw fetchError;
    }

    // Build a set of existing statuses for quick lookup
    const existingSet = new Set(
      (existing ?? []).map((r: any) => r.status)
    );

    // Filter to only new statuses
    const toUpsert = statuses.filter((r) => !existingSet.has(r.status));

    if (toUpsert.length > 0) {
      const { error } = await supabase
        .from("servicem8_job_statuses")
        .upsert(toUpsert, { onConflict: "status" });
      if (error) {
        console.error("❌ Supabase upsert error (servicem8_job_statuses)", error);
        throw error;
      }
    }

    return statuses.map((r) => r.status);
  }

  // ─── OAuth / Credential Auth (unchanged) ─────────────────────────────────
  static async authenticateWithCredentials(
    userId: string,
    username: string,
    password: string
  ) {
    if (!process.env.SERVICEM8_CLIENT_ID || !process.env.SERVICEM8_CLIENT_SECRET) {
      throw new ApiError(500, "ServiceM8 client credentials are not configured");
    }

    const tokenResponse = await axios.post(
      SERVICEM8_AUTH_URL,
      new URLSearchParams({
        grant_type: "password",
        username,
        password,
        client_id: process.env.SERVICEM8_CLIENT_ID,
        client_secret: process.env.SERVICEM8_CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }
    );

    const tokenData = tokenResponse.data;
    if (!tokenData.access_token) {
      throw new ApiError(502, "Failed to obtain access token from ServiceM8");
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (tokenData.expires_in || 3600));

    const { error } = await supabase
      .from("servicem8_integrations")
      .upsert(
        {
          user_id: userId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || null,
          expires_at: expiresAt.toISOString(),
          scopes: tokenData.scope || null,
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (error) throw error;

    return {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      user_id: tokenData.user_id || userId,
      expires_at: expiresAt.toISOString(),
      expires_in: tokenData.expires_in || 3600,
      scope: tokenData.scope,
    };
  }
}