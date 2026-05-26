import axios from "axios";
import { randomUUID, createHash } from "crypto";
// import pLimit from "p-limit";
import { ApiError } from "../../../../utils/ApiError.js";
import {
  COMMUSOFT_OPPORTUNITY_ARRAY_KEYS,
  extractCommusoftArray,
} from "../../../../utils/commusoft-helpers.js";
import { supabase } from "../../../../config/db.config.js";
import { syncViaStream } from "../../../../lib/sync/api-to-db.stream.js";

// const limit = pLimit(5);
const COMMUSOFT_API_BASE = "https://app.commusoft.co.uk/webservice_dev.php/api/v1";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CUSTOMER_DETAILS_BATCH_SIZE = 15;
const CUSTOMER_DETAILS_BATCH_DELAY_MS = 200;

export interface EngineerUserDetails {
  name: string;
  email: string;
  phone: string;
  mobile: string;
}

export interface AssignedEngineer {
  engineerId: number;
  engineerName: string;
  email: string;
  phone: string;
  mobile: string;
}

export interface CustomerJob {
  jobId: number;
  jobNumber: string;
  description: string;
  status: string;
  createdDate: string;
  completedDate: string;
  assignedEngineers: AssignedEngineer[];
}

export interface CustomerContact {
  contactId: number;
  name: string;
  email: string;
  phone: string;
  role: string;
}

export interface CustomerDetailRecord {
  customerId: number;
  customerName: string;
  email: string;
  phone: string;
  mobile: string;
  addressLine1: string;
  addressLine2: string;
  town: string;
  postcode: string;
  country: string;
  customerType: string;
  contacts: CustomerContact[];
  totalJobCount: number;
  jobs: CustomerJob[];
}

export interface FormattedCustomerJob {
  job: {
    job_id: string;
    status: string;
    start_date: string;
    end_date: string;
    description: string;
    completion_date: string;
  };
  engineer: {
    name: string;
    email: string;
    phone: string;
    mobile: string;
  };
}

export interface FormattedCustomerDetail {
  contact: {
    name: string;
    email: string;
    phone: string;
    mobile: string;
    type: string;
  };
  site: {
    name: string;
    address: string;
    address_city: string;
    address_postcode: string;
    address_country: string;
  };
  job_count: number;
  jobs: FormattedCustomerJob[];
}

export interface CustomerDetailsSyncResponse {
  success: boolean;
  message: string;
  syncedCount: number;
  syncedAt: string;
  duration: number;
}

function pickString(record: any, ...keys: string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function pickNumber(record: any, ...keys: string[]): number {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

/** Map a Commusoft /users record to contact fields used on job engineer objects. */
function mapUserToDetails(user: any): EngineerUserDetails {
  const name =
    pickString(user, "name", "full_name", "fullName", "display_name") ||
    [pickString(user, "firstname", "first_name"), pickString(user, "surname", "last_name")]
      .filter(Boolean)
      .join(" ");
  return {
    name,
    email: pickString(user, "email", "Email", "emailaddress"),
    phone: pickString(
      user,
      "telephonenumber",
      "phone",
      "landline",
      "company_landline",
      "contact_landline"
    ),
    mobile: pickString(user, "mobile", "company_mobile", "contact_mobile"),
  };
}

type UsersLookupMaps = {
  byId: Map<number, EngineerUserDetails>;
  byEmail: Map<string, EngineerUserDetails>;
};

/** Build userId and email indexes from GET /api/v1/users staff records. */
function buildUsersLookupMap(users: any[]): UsersLookupMaps {
  const byId = new Map<number, EngineerUserDetails>();
  const byEmail = new Map<string, EngineerUserDetails>();

  for (const user of users) {
    const details = mapUserToDetails(user);
    const userId = pickNumber(user, "id", "commusoft_id", "user_id", "userId");
    if (userId > 0) byId.set(userId, details);
    const emailKey = details.email.trim().toLowerCase();
    if (emailKey) byEmail.set(emailKey, details);
  }

  return { byId, byEmail };
}

function resolveUserPhones(
  engineerId: number,
  email: string,
  lookup: UsersLookupMaps
): { phone: string; mobile: string } {
  let details: EngineerUserDetails | undefined;
  if (engineerId > 0) details = lookup.byId.get(engineerId);
  if (!details && email) {
    details = lookup.byEmail.get(email.trim().toLowerCase());
  }
  return {
    phone: details?.phone ?? "",
    mobile: details?.mobile ?? "",
  };
}

function applyUserPhonesToEngineer(
  engineer: AssignedEngineer,
  lookup: UsersLookupMaps
): AssignedEngineer {
  const { phone, mobile } = resolveUserPhones(engineer.engineerId, engineer.email, lookup);
  return {
    ...engineer,
    phone: engineer.phone || phone,
    mobile: engineer.mobile || mobile,
  };
}

function resolveCustomerApiId(customer: any): string | null {
  const raw =
    customer?.customer_id ??
    customer?.customerId ??
    customer?.id ??
    customer?.commusoft_id ??
    customer?.["Customer ID"] ??
    customer?.["Customer Id"];

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  return String(raw).trim();
}

/** Parse leading DD/MM/YY from Commusoft export fields for row comparison. */
function parseCommusoftShortDate(value: string | null | undefined): number {
  if (!value) return 0;
  const match = String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!match) return 0;
  let year = Number(match[3]);
  if (year < 100) year += year >= 50 ? 1900 : 2000;
  return year * 10000 + Number(match[2]) * 100 + Number(match[1]);
}

/** When commusoft_jobs has duplicate jobId rows, keep the most recently completed. */
function pickBestCommusoftJobRow(rows: any[]): any | null {
  if (!rows.length) return null;
  return rows.reduce((best, row) => {
    if (!best) return row;
    const bestCompleted = parseCommusoftShortDate(best["Completed Date"]);
    const rowCompleted = parseCommusoftShortDate(row["Completed Date"]);
    if (rowCompleted !== bestCompleted) {
      return rowCompleted > bestCompleted ? row : best;
    }
    const bestJobDate = parseCommusoftShortDate(best["Job Date"]);
    const rowJobDate = parseCommusoftShortDate(row["Job Date"]);
    return rowJobDate > bestJobDate ? row : best;
  }, null as any);
}

/** e.g. "21/04/26 30 mins(11:30 am to 12:00 pm)" -> "21/04/26" */
function scheduledDateFromLastDiaryEvent(value: string | null | undefined): string {
  if (!value) return "";
  const match = String(value).trim().match(/^(\d{2}\/\d{2}\/\d{2})/);
  return match?.[1] ?? "";
}

function formatDiaryEventStartDate(start: string | null | undefined): string {
  if (!start) return "";
  const match = String(start).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match?.[1] || !match[2] || !match[3]) return "";
  const yy = match[1].slice(-2);
  return `${match[3]}/${match[2]}/${yy}`;
}

/**
 * Commusoft uses Symfony forms — bracketed keys like `customertype[contacts][name]`
 * must be sent as application/x-www-form-urlencoded so PHP parses them into a
 * nested array. Sending JSON makes Symfony see literal-bracket string keys and
 * fail validation on every required field.
 */
function toFormBody(payload: Record<string, any>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    body.append(key, String(value));
  }
  return body;
}



const COMMUSOFT_API_BATCH_SIZE = 300; // Reduced from 500 for better stability
const COMMUSOFT_API_TIMEOUT_MS = 30_000;
const COMMUSOFT_API_PAGE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCommusoftBatchSize(batchSize?: number): number {
  if (batchSize == null || !Number.isFinite(batchSize)) {
    return COMMUSOFT_API_BATCH_SIZE;
  }
  return Math.min(Math.max(Math.floor(batchSize), 1), 10_000);
}


async function fetchAllCommusoftCustomers(
  authParams: Record<string, unknown>
): Promise<any[]> {
  const response = await axios.get(`${COMMUSOFT_API_BASE}/customers`, {
    params: authParams,
    timeout: COMMUSOFT_API_TIMEOUT_MS,
  });
  const records = extractCommusoftArray(response.data, ["Customers", "customers", "Customer"]);
  console.log(`[Commusoft:customers] fetched=${records.length}`);
  return records;
}


function opportunityIdOf(record: any): string | null {
  const raw =
    record?.opportunityId ??
    record?.opportunity_id ??
    record?.["Opportunity Id"] ??
    record?.["Opportunity ID"] ??
    record?.id ??
    record?.ID;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }

  return String(raw).trim();
}


const getIntegration = async (userId: string) => {
  const { data, error } = await supabase
    .from("commusoft_intigrations")
    .select("user_id, access_token")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    if (error) {
      throw error;
    }
    throw new ApiError(
      404,
      "Commusoft integration not found. Please connect your account first."
    );
  }

  return data;
};

/**
 * Auth params (token) for Commusoft requests
 */
export const getParams = async (userId: string) => {
  const integrations = await getIntegration(userId);
  return {
    token: integrations.access_token,
  };
};



/**
 * Upsert commusoft_jobs — DB unique key is ("Job Uuid", user_id), but PostgREST
 * cannot target that composite via onConflict. Resolve existing row `id` by Job Uuid first.
 */
const upsertCommusoftJobs = async (records: any[], userId: string) => {
  if (!records?.length) {
    console.log("No records to insert");
    return;
  }

  const jobUuids = [
    ...new Set(
      records
        .map((r) => String(r["Job Uuid"] ?? "").trim())
        .filter(Boolean)
    ),
  ];

  const idByJobUuid = new Map<string, string>();

  if (jobUuids.length > 0) {
    const { data: existing, error: lookupError } = await supabase
      .from("commusoft_jobs")
      .select('id, "Job Uuid"')
      .eq("user_id", userId)
      .in("Job Uuid", jobUuids);

    if (lookupError) {
      console.error("[Commusoft] commusoft_jobs lookup failed:", lookupError.message);
      throw lookupError;
    }

    for (const row of existing ?? []) {
      const uuid = String(row["Job Uuid"] ?? "").trim();
      if (uuid && row.id) idByJobUuid.set(uuid, String(row.id));
    }
  }

  const rows = records.map((r: any) => {
    const row = { ...r, user_id: userId };
    const jobUuid = String(row["Job Uuid"] ?? "").trim();
    const existingId = jobUuid ? idByJobUuid.get(jobUuid) : undefined;

    if (existingId) {
      row.id = existingId;
    } else if (row.id != null && !UUID_RE.test(String(row.id))) {
      delete row.id;
    } else if (!row.id) {
      row.id = randomUUID();
    }

    return row;
  });

  console.log(`Total rows to insert in commusoft_jobs:`, rows.length);

  const stripWorkflowStatusFields = (row: Record<string, unknown>) => {
    const copy = { ...row };
    delete copy["Job Status"];
    delete copy.status;
    return copy;
  };

  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    console.log(`Syncing commusoft_jobs rows ${i + 1} - ${i + chunk.length} (onConflict=id)`);

    let payload = chunk as Record<string, unknown>[];
    let { data, error } = await supabase
      .from("commusoft_jobs")
      .upsert(payload, { onConflict: "id" })
      .select();

    // Column may not exist until migration 003_commusoft_jobs_job_status.sql is applied.
    if (
      error?.code === "PGRST204" &&
      String(error.message ?? "").includes("Job Status")
    ) {
      console.warn(
        "[Commusoft] commusoft_jobs has no Job Status column yet — upserting without workflow status field"
      );
      payload = chunk.map((row) => stripWorkflowStatusFields(row as Record<string, unknown>));
      ({ data, error } = await supabase
        .from("commusoft_jobs")
        .upsert(payload, { onConflict: "id" })
        .select());
    }

    if (error) {
      console.error("❌ Supabase upsert error (commusoft_jobs)", error);
      throw error;
    }

    console.log(`✅ ${data?.length ?? chunk.length} rows synced to commusoft_jobs`);
  }

  console.log(`🎉 All ${rows.length} rows synced to commusoft_jobs`);
};

const upsertToSupabase = async (
  table: string,
  records: any[],
  userId: string
) => {

  if (!records || records.length === 0) {
    console.log("No records to insert");
    return;
  }

  if (table === "commusoft_jobs") {
    return upsertCommusoftJobs(records, userId);
  }

  const rows = records.map((r: any) => ({
    ...r,
    user_id: userId,
  }));

  const onConflict = "id";

  console.log(`Total rows to insert in ${table}:`, rows.length);

  const chunkSize = 500;

  for (let i = 0; i < rows.length; i += chunkSize) {

    const chunk = rows.slice(i, i + chunkSize);

    console.log(`Syncing ${table} rows ${i + 1} - ${i + chunk.length}`);

    const { data, error } = await supabase
      .from(table)
      .upsert(chunk, { onConflict })
      .select();

    if (error) {
      console.error(`❌ Supabase upsert error (${table})`, error);
      throw error;
    }

    console.log(
      `✅ ${data?.length ?? chunk.length} rows synced to ${table}`
    );
   //  break; // 🔴 yaha process stop ho jayega

  }
  
  console.log(`🎉 All ${rows.length} rows synced to ${table}`);
};

/**
 * Axios GET with retry
 */
export async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  retries = 2
): Promise<any> {
  try {
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error: any) {
    const status = error?.response?.status;

    if (retries > 0 && [429, 500, 503].includes(status)) {
      const delay = status === 429 ? 2000 : 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWithRetry(url, headers, retries - 1);
    }

    throw error;
  }
}

/**
 * Commusoft Business Service
 */
export class CommusoftService {

  /**
   * Generate Access Token
   */
  static async generateAccessToken(
  userId: string,
  clientId: string,
  username: string,
  password: string,
  applicationId: string
) {

  try {
    const response = await axios.post(
      `${COMMUSOFT_API_BASE}/getToken`,
      {
        clientId,
        username,
        password,
        applicationId
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    const tokenData = response.data;

    if (!tokenData?.token) {
      throw new ApiError(400, "Commusoft token not returned");
    }

    const { error: upsertError } = await supabase
      .from("commusoft_intigrations")
      .upsert(
        {
          user_id: userId,
          access_token: tokenData.token,
          clientid: clientId,
          applicationid: applicationId,
          username,
          password,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      console.error("SUPABASE UPSERT ERROR", upsertError);
      throw upsertError;
    }

 

  } catch (error: any) {

    if (error?.response) {
      throw new ApiError(
        error.response.status,
        error.response.data?.error_description ||
          "Commusoft API request failed"
      );
    }
    throw error;
  }
  }


static async getCustomers(userId: string) {
    const authParams = await getParams(userId);
    const records = await fetchAllCommusoftCustomers(authParams);

    if (records.length > 0) {
      await upsertToSupabase("commusoft_customers", records, userId);
    }

    return records;
}

  /**
   * Stream-based customer sync — paginated until API returns empty page.
   * Used by syncAll instead of the old array-accumulate approach.
   * Stores every raw customer record in commusoft_customers with hash dedup
   * so unchanged records never cause a DB write on re-sync.
   */
  /**
   * Fetch all customers in ONE API call (no pagination — Commusoft /customers
   * returns the full list regardless of params), then stream into DB in
   * 500-row batches with hash dedup so unchanged records never hit the DB.
   */
  static async syncCustomersViaStream(userId: string) {
    const authParams = await getParams(userId);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/customers`, {
      params: authParams,
      timeout: COMMUSOFT_API_TIMEOUT_MS,
    });
    const allCustomers = extractCommusoftArray(response.data, ["Customers", "customers", "Customer"]);

    console.log(`[Commusoft:customers] fetched=${allCustomers.length}`);
    if (allCustomers.length === 0) {
      return { total: 0, synced: 0, skipped: 0, failed: 0, durationMs: 0, resumed: false };
    }

    let fetched = false;
    return syncViaStream({
      userId,
      integration: "commusoft",
      entity:      "customers",
      table:       "commusoft_customers",
      onConflict:  "id",
      pageSize:    allCustomers.length,
      chunkSize:   500,
      fetchPage:   async () => {
        if (fetched) return [];
        fetched = true;
        return allCustomers;
      },
      normalise:   (raw: any, uid: string) => ({ ...raw, user_id: uid }),
      onProgress:  ({ synced, skipped }) =>
        console.log(`[Commusoft:customers] synced=${synced} skipped=${skipped}`),
    });
  }

  /** Count unique jobs per customer account from commusoft_jobs (deduped by jobId). */
  static async getJobCountsByCustomerKey(userId: string): Promise<Map<string, number>> {
    const { data, error } = await supabase
      .from("commusoft_jobs")
      .select('"Customer.Account.Number", jobId')
      .eq("user_id", userId);

    if (error) {
      console.error("[Commusoft:getJobCountsByCustomerKey] failed:", error.message);
      throw error;
    }

    const counts = new Map<string, number>();
    const seenJobIds = new Map<string, Set<string>>();

    for (const row of data ?? []) {
      const accountKey = String(row["Customer.Account.Number"] ?? "").trim();
      if (!accountKey) continue;

      const jobId = String(row.jobId ?? "").trim();
      if (!seenJobIds.has(accountKey)) seenJobIds.set(accountKey, new Set());
      const bucket = seenJobIds.get(accountKey)!;

      if (jobId) {
        if (bucket.has(jobId)) continue;
        bucket.add(jobId);
      }

      counts.set(accountKey, (counts.get(accountKey) ?? 0) + 1);
    }

    return counts;
  }

  static mapCustomerToDbRow(
    userId: string,
    customer: any,
    jobCount: number
  ): Record<string, unknown> | null {
    const commusoftCustomerId = resolveCustomerApiId(customer);
    if (!commusoftCustomerId) return null;

    const abnNumber =
      pickString(
        customer,
        "customeraccountnumber",
        "account_number",
        "abn_number",
        "Customer.Account.Number",
        "customer_account_number"
      ) || commusoftCustomerId;

    return {
      user_id: userId,
      commusoft_customer_id: commusoftCustomerId,
      name:
        pickString(
          customer,
          "name",
          "customer_name",
          "company_name",
          "contact_name",
          "Customer Name"
        ) || "Unknown",
      email: pickString(customer, "emailaddress", "email", "company_email", "Customer Email") || null,
      phone:
        pickString(customer, "telephonenumber", "phone", "landline", "company_landline", "Customer Landline") ||
        null,
      mobile: pickString(customer, "mobile", "company_mobile", "contact_mobile", "Customer Mobile") || null,
      address: pickString(customer, "addressline1", "address", "Customer Address Line 1") || null,
      address_line_2: pickString(customer, "addressline2", "Customer Address Line 2") || null,
      address_city: pickString(customer, "town", "city", "Customer Address Town") || null,
      address_state: pickString(customer, "county", "state", "Customer Address County") || null,
      address_postcode: pickString(customer, "postcode", "Customer Address Postcode") || null,
      address_country: pickString(customer, "countrycode", "country", "Customer Address Country") || null,
      billing_address:
        pickString(customer, "billing_address", "customer_address", "Customer Address Line 1") || null,
      website: pickString(customer, "website") || null,
      fax_number: pickString(customer, "faxnumber", "fax_number") || null,
      abn_number: abnNumber,
      job_count: jobCount,
      has_jobs: jobCount > 0,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Sync customers to local database.
   *
   * @param source `api` — fetch all customers from Commusoft API (slow, includes customers without jobs)
   *               `jobs` — extract from commusoft_jobs (fast, only customers with jobs)
   */
  static async syncCustomers(
    userId: string,
    options: {
      source: "api" | "jobs";
      batchSize?: number;
    }
  ): Promise<{
    synced: number;
    failed: number;
    total: number;
  }> {
    console.log(
      `[Commusoft:syncCustomers] start user=${userId} source=${options.source}`
    );

    const jobCounts = await CommusoftService.getJobCountsByCustomerKey(userId);
    let customerRecords: Record<string, unknown>[];

    if (options.source === "api") {
      const authParams = await getParams(userId);
      const apiRecords = await fetchAllCommusoftCustomers(authParams);

      if (apiRecords.length > 0) {
        await upsertToSupabase("commusoft_customers", apiRecords, userId);
      }

      customerRecords = apiRecords as Record<string, unknown>[];
    } else {
      const { data: jobs, error: jobsError } = await supabase
        .from("commusoft_jobs")
        .select("*")
        .eq("user_id", userId);

      if (jobsError) {
        console.error("[Commusoft:syncCustomers] read jobs failed:", jobsError.message);
        throw jobsError;
      }

      if (!jobs || jobs.length === 0) {
        console.log("[Commusoft:syncCustomers] no jobs in DB, skipping");
        return { synced: 0, failed: 0, total: 0 };
      }

      const byAccount = new Map<string, Record<string, unknown>>();
      for (const row of jobs) {
        const abn = String(row["Customer.Account.Number"] ?? "").trim();
        if (!abn) continue;
        if (!byAccount.has(abn)) {
          byAccount.set(abn, row as Record<string, unknown>);
        }
      }

      customerRecords = Array.from(byAccount.entries()).map(([abn, jobRow]) => ({
        ...jobRow,
        id: pickString(jobRow, "propertyId", "Job Customer Id", "customer_id") || abn,
        customeraccountnumber: abn,
      }));
    }

    let synced = 0;
    let failed = 0;
    const syncedAt = new Date().toISOString();

    for (const customer of customerRecords) {
      try {
        const commusoftCustomerId = resolveCustomerApiId(customer);
        if (!commusoftCustomerId) {
          failed++;
          continue;
        }

        const abnNumber =
          pickString(
            customer,
            "customeraccountnumber",
            "account_number",
            "abn_number",
            "Customer.Account.Number"
          ) || commusoftCustomerId;

        const jobCount =
          jobCounts.get(abnNumber) ??
          jobCounts.get(commusoftCustomerId) ??
          0;

        const row = CommusoftService.mapCustomerToDbRow(userId, customer, jobCount);
        if (!row) {
          failed++;
          continue;
        }

        if (!row.commusoft_customer_id) {
          row.commusoft_customer_id = abnNumber;
        }

        const { error: upsertError } = await supabase.from("customers").upsert(
          { ...row, synced_at: syncedAt },
          { onConflict: "user_id,commusoft_customer_id" }
        );

        if (upsertError) {
          console.error(
            `[Commusoft:syncCustomers] upsert failed customer=${commusoftCustomerId}:`,
            upsertError.message
          );
          failed++;
        } else {
          synced++;
        }
      } catch (e: any) {
        console.error("[Commusoft:syncCustomers] row error:", e?.message);
        failed++;
      }
    }

    console.log(
      `[Commusoft:syncCustomers] complete source=${options.source} total=${customerRecords.length} synced=${synced} failed=${failed}`
    );

    return { synced, failed, total: customerRecords.length };
  }

  static async getCustomerDetails(
    userId: string,
    limit?: number,
    offset: number = 0
  ): Promise<FormattedCustomerDetail[]> {
    const startTime = Date.now();
    console.log("[getCustomerDetails] Reading from DB only");

    try {
      const { data: snaps, error: readError } = await supabase
        .from("commusoft_customer_snapshots")
        .select("customer_api_id, payload, synced_at")
        .eq("user_id", userId)
        .order("synced_at", { ascending: false });

      if (readError) {
        console.log("[getCustomerDetails] DB read failed:", readError.message);
        throw new Error(`Database read failed: ${readError.message}`);
      }

      if (!snaps || snaps.length === 0) {
        console.log("[getCustomerDetails] No data in DB. Run /sync first.");
        return [];
      }

      const seen = new Set<string>();
      const latest: CustomerDetailRecord[] = [];

      for (const row of snaps) {
        if (!seen.has(row.customer_api_id)) {
          seen.add(row.customer_api_id);
          latest.push(row.payload as CustomerDetailRecord);
        }
      }

      const formatted: FormattedCustomerDetail[] = latest.map((customer) => ({
        contact: {
          name: customer.customerName || "",
          email: customer.email || "",
          phone: customer.phone || "",
          mobile: customer.mobile || "",
          type: "customer",
        },
        site: {
          name: customer.customerName || "",
          address: customer.addressLine1 || "",
          address_city: customer.town || "",
          address_postcode: customer.postcode || "",
          address_country: customer.country || "",
        },
        job_count: customer.totalJobCount || 0,
        jobs: (customer.jobs || []).map((job) => ({
          job: {
            job_id: String(job.jobId || ""),
            status: job.status || "",
            start_date: job.createdDate || "",
            end_date: job.completedDate || "",
            description: job.description || "",
            completion_date: job.completedDate || "",
          },
          engineer: {
            name: job.assignedEngineers?.[0]?.engineerName || "",
            email: job.assignedEngineers?.[0]?.email || "",
            phone: job.assignedEngineers?.[0]?.phone || "",
            mobile: job.assignedEngineers?.[0]?.mobile || "",
          },
        })),
      }));

      let finalData = formatted;
      if (limit !== undefined) {
        finalData = formatted.slice(offset, offset + limit);
      }

      console.log(
        `[getCustomerDetails] Returned ${finalData.length} customers from DB in ${Date.now() - startTime}ms`
      );

      return finalData;
    } catch (e: any) {
      console.log("[getCustomerDetails] Error:", e?.message);
      throw e instanceof Error ? e : new Error(e?.message || "Failed to fetch customer details");
    }
  }

  static async syncCustomerDetails(userId: string): Promise<CustomerDetailsSyncResponse> {
    const startTime = Date.now();
    console.log("[syncCustomerDetails] Starting live sync from Commusoft");
    console.log(`[Commusoft:syncCustomerDetails] ▶ start  user=${userId}`);

    const params = await getParams(userId);
    const customers = await CommusoftService.getCustomers(userId);
    const total = customers.length;

    console.log(`[Commusoft:syncCustomerDetails] fetched ${total} customers`);
    if (customers.length > 0) {
      console.log("[DEBUG] Raw customer data:", JSON.stringify(customers[0], null, 2));
    }

    let staffRecords: any[] = [];
    try {
      staffRecords = await CommusoftService.getStaffMembers(userId);
      console.log(
        `[Commusoft:syncCustomerDetails] fetched ${staffRecords.length} users from /users for engineer phone lookup`
      );
    } catch (err: any) {
      console.warn(
        `[Commusoft:syncCustomerDetails] users lookup failed (engineer phone/mobile may be empty): ${err?.message ?? err}`
      );
    }

    const usersLookup = buildUsersLookupMap(staffRecords);
    const staffById = new Map<number, any>();
    for (const staff of staffRecords) {
      const staffId = pickNumber(staff, "id", "commusoft_id", "user_id", "userId");
      if (staffId > 0) staffById.set(staffId, staff);
    }

    const mapContact = (raw: any): CustomerContact => {
      const contactFirstName = pickString(raw, "name");
      const contactSurname = pickString(raw, "surname");
      const contactName =
        contactFirstName && contactSurname
          ? `${contactFirstName} ${contactSurname}`.trim()
          : contactFirstName ||
            contactSurname ||
            pickString(
              raw,
              "contact_name",
              "fullName",
              "full_name",
              "Contact Name",
              "first_name",
              "firstname"
            );

      return {
        contactId: pickNumber(raw, "id", "contactId", "contact_id", "commusoft_id"),
        name: contactName,
        email: pickString(raw, "emailaddress", "email", "contactemail", "contact_email", "Email"),
        phone: "",
        role: pickString(raw, "position", "role", "type", "contact_type", "job_title", "title"),
      };
    };

    const mapEngineer = (
      raw: any,
      staffMap: Map<number, any>,
      lookup: UsersLookupMaps
    ): AssignedEngineer => {
      const engineerId = pickNumber(
        raw,
        "engineerId",
        "engineer_id",
        "resource_id",
        "resourceId",
        "user_id",
        "userId",
        "id"
      );
      const staff = engineerId > 0 ? staffMap.get(engineerId) : undefined;
      const nameFromStaff = staff
        ? pickString(
            staff,
            "name",
            "full_name",
            "fullName",
            "display_name",
            "firstname",
            "first_name"
          ) ||
          [pickString(staff, "firstname", "first_name"), pickString(staff, "surname", "last_name")]
            .filter(Boolean)
            .join(" ")
        : "";

      const email =
        pickString(raw, "email", "Email") || pickString(staff, "email", "Email");

      const base: AssignedEngineer = {
        engineerId,
        engineerName: pickString(
          raw,
          "engineerName",
          "engineer_name",
          "name",
          "resource_name",
          "Resource Name",
          "Engineer Name"
        ) || nameFromStaff,
        email,
        phone: "",
        mobile: "",
      };

      return applyUserPhonesToEngineer(base, lookup);
    };

    const extractAssignedEngineers = (
      job: any,
      staffMap: Map<number, any>,
      lookup: UsersLookupMaps
    ): AssignedEngineer[] => {
      const embeddedLists = [
        job?.assignedEngineers,
        job?.engineers,
        job?.resources,
        job?.assigned_engineers,
        job?.["Assigned Engineers"],
      ].filter(Array.isArray);

      if (embeddedLists.length > 0 && embeddedLists[0]) {
        return embeddedLists[0].map((entry: any) => mapEngineer(entry, staffMap, lookup));
      }

      const singleId = pickNumber(
        job,
        "resource_id",
        "resourceId",
        "engineer_id",
        "engineerId",
        "assigned_engineer_id",
        "user_id"
      );
      if (singleId > 0) {
        return [mapEngineer({ id: singleId, engineerId: singleId }, staffMap, lookup)];
      }

      const singleName = pickString(
        job,
        "engineer_name",
        "Engineer Name",
        "resource_name",
        "Resource Name",
        "assigned_engineer"
      );
      if (singleName) {
        return [
          applyUserPhonesToEngineer(
            {
              engineerId: singleId,
              engineerName: singleName,
              email: pickString(job, "engineer_email", "Engineer Email"),
              phone: "",
              mobile: "",
            },
            lookup
          ),
        ];
      }

      return [];
    };

    const mapJob = (
      raw: any,
      staffMap: Map<number, any>,
      lookup: UsersLookupMaps
    ): CustomerJob => ({
      jobId: pickNumber(raw, "id", "jobId", "job_id", "Job ID", "Job Id"),
      jobNumber: "",
      description: pickString(
        raw,
        "description",
        "job_description",
        "Job Description",
        "work_description"
      ),
      status: pickString(raw, "status", "job_status", "Job Status", "stage"),
      createdDate: pickString(
        raw,
        "createdondatetime",
        "created_date",
        "createdDate",
        "date",
        "job_created_date",
        "Job Created Date",
        "created_at"
      ),
      completedDate: pickString(
        raw,
        "completedon",
        "completed_date",
        "completedDate",
        "completion_date",
        "Job Completed Date",
        "date_completed"
      ),
      assignedEngineers: extractAssignedEngineers(raw, staffMap, lookup),
    });

    const mapCustomerShell = (customer: any): CustomerDetailRecord => ({
      customerId: pickNumber(
        customer,
        "customer_id",
        "customerId",
        "id",
        "commusoft_id",
        "Customer ID"
      ),
      customerName: pickString(
        customer,
        "customer_name",
        "customerName",
        "name",
        "company_name",
        "contact_name",
        "Customer Name"
      ),
      email: pickString(
        customer,
        "emailaddress",
        "email",
        "company_email",
        "contactemail",
        "contact_email",
        "Customer Email"
      ),
      phone: pickString(
        customer,
        "telephonenumber",
        "phone",
        "landline",
        "company_landline",
        "contact_landline",
        "Customer Landline"
      ),
      mobile: pickString(
        customer,
        "mobile",
        "company_mobile",
        "contact_mobile",
        "Customer Mobile"
      ),
      addressLine1: pickString(
        customer,
        "addressline1",
        "address_line_1",
        "addressLine1",
        "address",
        "Customer Address Line 1",
        "address_street"
      ),
      addressLine2: pickString(
        customer,
        "addressline2",
        "address_line_2",
        "addressLine2",
        "Customer Address Line 2"
      ),
      town: pickString(customer, "town", "city", "Customer Address Town", "address_city"),
      postcode: pickString(
        customer,
        "postcode",
        "zip",
        "Customer Address Postcode",
        "address_postcode"
      ),
      country: pickString(customer, "countrycode", "country", "Customer Address Country", "address_country"),
      // TODO: resolve customertypesid to name via customer-type cache when loaded in this method
      customerType: "",
      contacts: [],
      totalJobCount: 0,
      jobs: [],
    });

    const enrichCustomer = async (customer: any): Promise<CustomerDetailRecord> => {
      const shell = mapCustomerShell(customer);
      const customerApiId = resolveCustomerApiId(customer);

      if (!customerApiId) {
        console.warn(
          `[Commusoft:syncCustomerDetails] skipping enrichment — missing customer id  name=${shell.customerName}`
        );
        return shell;
      }

      let contacts: CustomerContact[] = [];
      let jobs: CustomerJob[] = [];

      const [contactsResult, jobsResult] = await Promise.allSettled([
        axios.get(`${COMMUSOFT_API_BASE}/customers/${customerApiId}/contacts`, { params }),
        axios.get(`${COMMUSOFT_API_BASE}/customers/${customerApiId}/jobs`, { params }),
      ]);

      if (contactsResult.status === "fulfilled") {
        const contactsData = contactsResult.value.data;
        if (customerApiId === "1000") {
          console.log("[DEBUG] Raw contacts:", JSON.stringify(contactsData, null, 2));
        }
        const contactRows = extractCommusoftArray(contactsData, [
          "Contacts",
          "contacts",
          "Contact",
          "contact",
        ]);
        contacts = contactRows.map(mapContact);
      } else {
        const contactErr = contactsResult.reason as any;
        console.error(
          `[Commusoft:syncCustomerDetails] contacts failed  customerId=${customerApiId}  error=${contactErr?.message ?? contactErr}`
        );
      }

      if (jobsResult.status === "fulfilled") {
        const jobsData = extractCommusoftArray(jobsResult.value.data, ["Jobs", "jobs", "Job"]);
        if (customerApiId === "1000") {
          console.log(
            "[DEBUG] Raw jobs[0]:",
            JSON.stringify(jobsData[0] ?? jobsResult.value.data, null, 2)
          );
        }
        jobs = jobsData.map((job) => mapJob(job, staffById, usersLookup));
      } else {
        const jobErr = jobsResult.reason as any;
        console.error(
          `[Commusoft:syncCustomerDetails] jobs failed  customerId=${customerApiId}  error=${jobErr?.message ?? jobErr}`
        );
      }

      return {
        ...shell,
        customerId: shell.customerId || pickNumber({ id: customerApiId }, "id"),
        contacts,
        jobs,
        totalJobCount: jobs.length,
      };
    };

    const enriched: CustomerDetailRecord[] = [];

    for (let i = 0; i < customers.length; i += CUSTOMER_DETAILS_BATCH_SIZE) {
      const batch = customers.slice(i, i + CUSTOMER_DETAILS_BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((customer) => enrichCustomer(customer)));
      enriched.push(...batchResults);

      const processed = Math.min(i + batch.length, total);
      console.log(`[Commusoft:syncCustomerDetails] processed ${processed}/${total} customers`);

      if (i + CUSTOMER_DETAILS_BATCH_SIZE < customers.length) {
        await sleep(CUSTOMER_DETAILS_BATCH_DELAY_MS);
      }
    }

    // Enrich jobs: diary events (who worked) + commusoft_jobs cache (dates / fallback)
    try {
      const allJobIds = enriched
        .flatMap((c) => c.jobs?.map((j) => String(j.jobId)) || [])
        .filter(Boolean);

      const engineersByJobId = new Map<number, AssignedEngineer[]>();
      const scheduledDateByJobId = new Map<number, string>();

      try {
        const diaryRes = await axios.get(`${COMMUSOFT_API_BASE}/diaryevents`, {
          params: {
            ...params,
            fromdate: "2020-01-01",
            todate: "2026-12-31",
          },
        });
        const diaryEvents = extractCommusoftArray(diaryRes.data, ["events", "Events"]);

        for (const event of diaryEvents as any[]) {
          const jobId = pickNumber(event?.redirectDetails ?? event, "jobId", "job_id", "id");
          if (jobId <= 0) continue;

          const resourceId = pickNumber(event, "resourceId", "resource_id");
          const engineerName = pickString(event, "userName", "user_name", "engineerName");
          if (!engineerName && resourceId <= 0) continue;

          const staff = resourceId > 0 ? staffById.get(resourceId) : undefined;
          const email = pickString(staff, "email", "Email");
          const entry = applyUserPhonesToEngineer(
            {
              engineerId: resourceId > 0 ? resourceId : 0,
              engineerName:
                engineerName ||
                [pickString(staff, "firstname", "first_name"), pickString(staff, "surname", "last_name")]
                  .filter(Boolean)
                  .join(" ") ||
                pickString(staff, "name", "full_name"),
              email,
              phone: "",
              mobile: "",
            },
            usersLookup
          );
          if (!entry.engineerName) continue;

          const existing = engineersByJobId.get(jobId) ?? [];
          const already = existing.some(
            (e) =>
              e.engineerId === entry.engineerId &&
              e.engineerName.toLowerCase() === entry.engineerName.toLowerCase()
          );
          if (!already) existing.push(entry);
          engineersByJobId.set(jobId, existing);

          const eventDate = formatDiaryEventStartDate(event.start);
          if (eventDate && !scheduledDateByJobId.has(jobId)) {
            scheduledDateByJobId.set(jobId, eventDate);
          }
        }

        if (engineersByJobId.size > 0) {
          console.log(
            `[Commusoft:syncCustomerDetails:DB] diary events mapped for ${engineersByJobId.size} jobs`
          );
        }
      } catch (diaryErr: any) {
        console.log(
          "[Commusoft:syncCustomerDetails:DB] diary lookup failed:",
          diaryErr?.message ?? diaryErr
        );
      }

      if (allJobIds.length > 0) {
        const { data: cachedJobs, error: jobLookupError } = await supabase
          .from("commusoft_jobs")
          .select(`
        jobId,
        "Job Date",
        "Completed Date",
        "Engineer Name",
        "Last Engineer Name On Site",
        "Last Diary Event",
        "Job Address Email"
      `)
          .eq("user_id", userId)
          .in("jobId", allJobIds);

        if (jobLookupError) {
          console.log(
            "[Commusoft:syncCustomerDetails:DB] job lookup failed:",
            jobLookupError.message
          );
        } else if (cachedJobs && cachedJobs.length > 0) {
          const rowsByJobId = new Map<string, any[]>();
          for (const row of cachedJobs) {
            const key = String(row.jobId);
            const bucket = rowsByJobId.get(key) ?? [];
            bucket.push(row);
            rowsByJobId.set(key, bucket);
          }

          const jobMap = new Map<string, any>();
          for (const [jobId, rows] of rowsByJobId) {
            const best = pickBestCommusoftJobRow(rows);
            if (best) jobMap.set(jobId, best);
          }

          console.log(
            `[Commusoft:syncCustomerDetails:DB] job cache ${cachedJobs.length} rows → ${jobMap.size} unique jobIds`
          );

          for (const customer of enriched) {
            if (!customer.jobs) continue;
            for (const job of customer.jobs) {
              const cached = jobMap.get(String(job.jobId));
              if (!cached) continue;

              if (!job.createdDate) {
                job.createdDate =
                  scheduledDateFromLastDiaryEvent(cached["Last Diary Event"]) ||
                  cached["Job Date"] ||
                  "";
              }

              if (job.assignedEngineers.length === 0) {
                const engineerName =
                  cached["Last Engineer Name On Site"] || cached["Engineer Name"];
                const engineerEmail = cached["Job Address Email"];
                if (engineerName) {
                  job.assignedEngineers.push(
                    applyUserPhonesToEngineer(
                      {
                        engineerId: 0,
                        engineerName,
                        email: engineerEmail || "",
                        phone: "",
                        mobile: "",
                      },
                      usersLookup
                    )
                  );
                }
              }
            }
          }
        }
      }

      for (const customer of enriched) {
        if (!customer.jobs) continue;
        for (const job of customer.jobs) {
          const diaryEngineers = engineersByJobId.get(job.jobId);
          if (diaryEngineers && diaryEngineers.length > 0) {
            job.assignedEngineers = diaryEngineers;
          }
          const diaryDate = scheduledDateByJobId.get(job.jobId);
          if (diaryDate) {
            job.createdDate = diaryDate;
          }
        }
      }

      for (const customer of enriched) {
        if (!customer.jobs) continue;
        for (const job of customer.jobs) {
          job.assignedEngineers = job.assignedEngineers.map((engineer) =>
            applyUserPhonesToEngineer(engineer, usersLookup)
          );
        }
      }
    } catch (e: any) {
      console.log("[Commusoft:syncCustomerDetails:DB] enrichment threw:", e?.message);
    }

    try {
      const rows = enriched.map((c) => ({
        user_id: userId,
        customer_api_id: String(c.customerId ?? ""),
        payload: c,
      }));
      if (rows.length > 0) {
        const { error: insertError } = await supabase
          .from("commusoft_customer_snapshots")
          .insert(rows);
        if (insertError) {
          console.log("[Commusoft:syncCustomerDetails:DB] insert failed:", insertError.message);
        } else {
          console.log(`[Commusoft:syncCustomerDetails:DB] inserted ${rows.length} snapshots`);
        }
      }
    } catch (e: any) {
      console.log("[Commusoft:syncCustomerDetails:DB] insert threw:", e?.message);
    }

    const syncedAt = new Date().toISOString();
    const duration = Date.now() - startTime;
    console.log(
      `[syncCustomerDetails] Complete syncedCount=${enriched.length} duration=${duration}ms`
    );

    return {
      success: true,
      message: "Customer details synced successfully",
      syncedCount: enriched.length,
      syncedAt,
      duration,
    };
  }

  
static async getJobs(userId: string, _batchSize?: number) {
    const authParams = await getParams(userId);

    // ── Single-stream, no status filter ──────────────────────────────────────
    // /jobs returns ALL jobs when no status is supplied. Always use 20 000 per
    // page regardless of the batchSize arg (which was meant for DB chunk size,
    // not API page size). 20k keeps each API call under 60s and minimises the
    // number of round-trips for large datasets.
    const PAGE_SIZE = 20_000;

    const result = await syncViaStream({
      userId,
      integration: "commusoft",
      entity:      "jobs",
      table:       "commusoft_jobs",
      onConflict:  "id",
      pageSize:    PAGE_SIZE,
      delayBetweenPages: COMMUSOFT_API_PAGE_DELAY_MS,
      chunkSize:   500,
      fetchPage: async ({ startingRecord, pageSize: ps, pageNumber }) => {
        const response = await axios.get(`${COMMUSOFT_API_BASE}/jobs`, {
          params: {
            ...authParams,
            "number of records": ps,
            "starting record":   startingRecord,
          },
          timeout: 60_000,
        });
        const batch = extractCommusoftArray(response.data, ["Jobs", "jobs", "Job"]);
        console.log(
          `[SYNC:jobs] API ← page=${pageNumber} starting=${startingRecord} limit=${ps} returned=${batch.length}${batch.length < ps ? " (last page)" : ""}`
        );
        return batch;
      },
      normalise: (raw: any, uid: string) => {
        const row = { ...raw, user_id: uid };

        // "Job Uuid" drives the stable row id. Commusoft sometimes returns
        // non-RFC-4122 values (e.g. "-9xKrPbkMxcbad6MFcJxX1k"). Convert to a
        // deterministic MD5-based UUID so the same job always maps to the same id.
        const rawJobUuid = String(row["Job Uuid"] ?? "").trim();
        const stableId = (() => {
          if (rawJobUuid && UUID_RE.test(rawJobUuid)) return rawJobUuid;
          if (rawJobUuid) {
            const h = createHash("md5").update(`${uid}:${rawJobUuid}`).digest("hex");
            return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
          }
          return randomUUID();
        })();

        row.id = stableId;

        // Commusoft has many "*Uuid" fields (Job Property Uuid, Customer Uuid, etc.)
        // that also contain non-UUID strings. Sanitize every key ending in "uuid"
        // (case-insensitive) so no uuid-typed DB column receives an invalid value.
        for (const key of Object.keys(row)) {
          if (!key.toLowerCase().includes("uuid")) continue;
          const val = String(row[key] ?? "").trim();
          if (!val || UUID_RE.test(val)) continue;
          const h = createHash("md5").update(`${uid}:${key}:${val}`).digest("hex");
          row[key] = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
        }

        return row;
      },
      onProgress: ({ page, synced, skipped }) =>
        console.log(`[SYNC:jobs] DB ← page=${page} synced=${synced} skipped=${skipped}`),
    });

    console.log(
      `[SYNC:jobs] ✅ done total=${result.total} synced=${result.synced} skipped=${result.skipped} failed=${result.failed} duration=${result.durationMs}ms`
    );
    return result;
  }

static async getStaffMembers(userId: string) {
  const params = await getParams(userId);

  const response = await axios.get(`${COMMUSOFT_API_BASE}/users`, {
    params,
  });

  console.log("getStaffMembers response keys:", Object.keys(response.data));

  const records: any[] =
    response.data.users ?? response.data.Users ?? response.data;

  if (!Array.isArray(records)) {
    throw new ApiError(502, "Commusoft users response invalid format");
  }

  if (records.length === 0) {
    console.log("No staff records found");
    return [];
  }

  // 🔥 Transform data correctly
  const rows = records.map((r: any) => ({
    ...r,
    commusoft_id: r.id,   // ✅ IMPORTANT (unique column)
    user_id: userId,
  }));

  const chunkSize = 500;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    console.log(
      `Syncing commusoft_staff rows ${i + 1} - ${i + chunk.length}`
    );

    const { data, error } = await supabase
      .from("commusoft_staff")
      .upsert(chunk, { onConflict: "uuid" }) // ✅ FIXED
      .select();

    if (error) {
      console.warn(
        "Commusoft staff cache upsert skipped; returning live staff records instead.",
        error.message
      );
      return records;
    }

    console.log(
      `✅ ${data?.length ?? chunk.length} staff rows synced`
    );
  }

  console.log(`🎉 All ${rows.length} staff synced`);

  return records;
}


static async getCustomerTypeRecords(userId: string) {
    const params = await getParams(userId);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/customertypes`, {
      params,
    });

    const records = response.data.customertypes;
    console.log("Fetched customer types from Commusoft:", records);
    if (!Array.isArray(records)) {
      throw new ApiError(502, "Commusoft customertypes response invalid format");
    }

    const { error } = await supabase
      .from("commusoft_customertype")
      .upsert(
        records.map((r: any) => ({ ...r, user_id: userId })),
        { onConflict: "uuid" }
      );

    if (error) {
      // Non-fatal: customer creation below uses the fresh API response, not the
      // cache. This prevents a stale/duplicate local row from blocking tests.
      console.warn("⚠️ Supabase upsert warning (commusoft_customertype)", error);
    }

    return records;
}


static async getCustomerTypes(userId: string) {
    const records = await CommusoftService.getCustomerTypeRecords(userId);
    return records.map((r: any) => r.description);
}


static async getUserPreference(userId: string) {
    const params = await getParams(userId);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/diary/userpreference`, {
      params,
      timeout: COMMUSOFT_API_TIMEOUT_MS,
    });

    const Resdata = response.data?.data?.users ?? response.data?.users;

    if (!Array.isArray(Resdata)) {
      throw new ApiError(502, "Commusoft user preference response invalid format");
    }

    if (Resdata.length > 0) {
      await upsertToSupabase("commusoft_userpreference", Resdata, userId);
    }

    return Resdata;
}

static async getDiaryEvents(
  userId: string,
  filters: Record<string, string | undefined> = {}
) {
    const params = await getParams(userId);
    const requestParams = Object.fromEntries(
      Object.entries({ ...params, ...filters }).filter(([, value]) => value)
    );

    const response = await axios.get(`${COMMUSOFT_API_BASE}/diaryevents`, {
      params: requestParams,
    });

    return response.data;
}

static async getJobDescriptions(userId: string) {
    const params = await getParams(userId);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/jobdescriptions`, {
      params,
    });

    return response.data;
}

static async getOpportunityPipelines(
  userId: string,
  filters: Record<string, string | undefined> = {}
) {
    const params = await getParams(userId);
    const requestParams = Object.fromEntries(
      Object.entries({ ...params, ...filters }).filter(([, value]) => value)
    );

    const response = await axios.get(`${COMMUSOFT_API_BASE}/pipelines`, {
      params: requestParams,
    });

    return response.data;
}

static async getOpportunityPipelineStages(userId: string, pipelineId: string) {
    const params = await getParams(userId);

    try {
      const response = await axios.get(`${COMMUSOFT_API_BASE}/pipelines/${pipelineId}`, {
        params,
      });

      const stages = extractCommusoftArray(response.data, [
        ...COMMUSOFT_OPPORTUNITY_ARRAY_KEYS,
      ]);
      if (stages.length > 0) {
        return response.data;
      }
    } catch (err: any) {
      console.warn(
        `[Commusoft] /pipelines/${pipelineId} did not return usable stages; falling back to stage scan: ${err?.response?.status ?? err?.message}`
      );
    }

    const scan = await CommusoftService.scanStageOpportunities(userId, {
      from: 1,
      to: 50,
      limit: "5",
    });

    return {
      pipelineId,
      stages: scan.matches.map((match) => {
        const sample = match.sample ?? {};
        const sampleTitle =
          sample.Title ??
          sample.title ??
          sample.opportunityName ??
          sample.fullContactName ??
          sample.customerName;

        return {
          id: match.stageId,
          stageId: match.stageId,
          description: sampleTitle
            ? `Stage ${match.stageId} (${match.count} opportunit${match.count === 1 ? "y" : "ies"} - ${sampleTitle})`
            : `Stage ${match.stageId} (${match.count} opportunit${match.count === 1 ? "y" : "ies"})`,
          count: match.count,
          source: "stageopportunities-scan",
        };
      }),
      scan,
    };
}

static async getStageOpportunities(
  userId: string,
  stageId: string,
  filters: Record<string, string | undefined> = {}
) {
    const params = await getParams(userId);
    const requestParams = Object.fromEntries(
      Object.entries({ ...params, ...filters }).filter(([, value]) => value)
    );

    const response = await axios.get(`${COMMUSOFT_API_BASE}/sales/${stageId}/stageopportunities`, {
      params: requestParams,
    });

    return response.data;
}

static async getOpportunityDetails(userId: string, opportunityId: string) {
    const params = await getParams(userId);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/opportunitydetails/${opportunityId}`, {
      params,
    });

    return response.data;
}

static async getCustomerOpportunityStages(
  userId: string,
  customerId: string,
  opportunityId: string
) {
    const params = await getParams(userId);

    const response = await axios.get(
      `${COMMUSOFT_API_BASE}/customers/${customerId}/opportunities/${opportunityId}/stages`,
      { params }
    );

    return response.data;
}

static async getOpportunityTemplates(userId: string) {
    const params = await getParams(userId);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/opportunitytemplates`, {
      params,
    });

    return response.data;
}

static async getOutstandingJobsAndEstimates(
  userId: string,
  filters: Record<string, string | undefined> = {}
) {
    const params = await getParams(userId);
    const requestParams = Object.fromEntries(
      Object.entries({ ...params, ...filters }).filter(([, value]) => value)
    );

    const response = await axios.get(`${COMMUSOFT_API_BASE}/alloutstandingjobsandestimate`, {
      params: requestParams,
    });

    return response.data;
}

static async scanStageOpportunities(
  userId: string,
  options: {
    from?: number;
    to?: number;
    limit?: string;
    enrich?: boolean;
    searchText?: string;
    salesPersonId?: string;
    lowValue?: string;
    highValue?: string;
  } = {}
) {
    const from = Math.max(1, options.from ?? 1);
    const to = Math.min(Math.max(from, options.to ?? 50), 200);
    const results: Array<{
      stageId: number;
      count: number;
      hasRecords: boolean;
      sample?: any;
      error?: string;
    }> = [];

    for (let stageId = from; stageId <= to; stageId += 1) {
      try {
        const body = await CommusoftService.getStageOpportunities(userId, String(stageId), {
          limit: options.limit,
          searchText: options.searchText,
          salesPersonId: options.salesPersonId,
          lowValue: options.lowValue,
          highValue: options.highValue,
        });
        const records = extractCommusoftArray(body, [...COMMUSOFT_OPPORTUNITY_ARRAY_KEYS]);
        let sample = records[0] as Record<string, unknown> | undefined;
        const sampleId = opportunityIdOf(sample);
        if (options.enrich && sampleId) {
          try {
            sample = {
              ...sample,
              opportunityDetails: await CommusoftService.getOpportunityDetails(userId, sampleId),
            };
          } catch (detailErr: any) {
            sample = {
              ...sample,
              opportunityDetailsError: detailErr?.response?.status
                ? `HTTP ${detailErr.response.status}`
                : detailErr?.message ?? "Unknown error",
            };
          }
        }
        results.push({
          stageId,
          count: records.length,
          hasRecords: records.length > 0,
          ...(sample ? { sample } : {}),
        });
      } catch (err: any) {
        results.push({
          stageId,
          count: 0,
          hasRecords: false,
          error: err?.response?.status
            ? `HTTP ${err.response.status}`
            : err?.message ?? "Unknown error",
        });
      }
    }

    return {
      from,
      to,
      matches: results.filter((r) => r.hasRecords),
      results,
    };
}

// static async getEngineers(userId: string) {
//   try {

//     const { data: userPref, error } = await supabase
//       .from("commusoft_userpreference")
//       .select("id")
//       .eq("user_id", userId);

//     if (error) {
//       console.error("Supabase fetch error:", error);
//       return [];
//     }

//     if (!userPref || userPref.length === 0) {
//       return [];
//     }

//     const params = await getParams(userId);

//     const responses = await Promise.all(
//       userPref.map((row) =>
//         axios.get(`${COMMUSOFT_API_BASE}/users/${row.id}/personaldetails`, {
//           params,
//         })
//       )
//     );

//     const users = responses.map((res) => res.data.user);
//     upsertToSupabase("commusoft_engineers", users, userId);
//     console.log("Mapped user preferences:", users );

//     return users;

//   } catch (error: any) {
//     errorFunction(error);
//   }
// }

  /**
   * Get connection status for a user
   */
  static async getConnectionStatus(userId: string) {
    const { data, error } = await supabase
      .from("commusoft_intigrations")
      .select("user_id, username, clientid, applicationid, created_at, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

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
            username: data.username ?? null,
            clientId: data.clientid ?? null,
            applicationId: data.applicationid ?? null,
            connectedAt: data.updated_at ?? data.created_at ?? null,
          }
        : null,
    };
  }

  /**
   * Disconnect (remove stored credentials) for a user
   */
  static async disconnect(userId: string) {
    const { error, count } = await supabase
      .from("commusoft_intigrations")
      .delete({ count: "exact" })
      .eq("user_id", userId);

    if (error) throw error;

    if (!count || count === 0) {
      throw new ApiError(404, "No active Commusoft connection found for this user");
    }

    return { disconnected: true };
  }

  /**
   * Create a new customer in Commusoft.
   *
   * Flow:
   *  1. Refresh commusoft_customertype from Commusoft so a type added in
   *     Commusoft UI since last sync is resolvable without manual resync.
   *  2. Resolve { id, uuid } from commusoft_customertype by the description
   *     the UI sent. Both come from Commusoft's own /customertypes response —
   *     id drives the URL path, uuid goes into customertype[uuid] body field.
   *  3. Generate a fresh uuid for customertype[contacts][uuid]. That field
   *     identifies the new contact record (per-record), not the type.
   */
  static async createCustomer(
    userId: string,
    customerData: Record<string, any>
  ) {
    const params = await getParams(userId);
    const customerTypeDescription = customerData.customer_type;

    if (!customerTypeDescription) {
      throw new ApiError(400, "customer_type is required");
    }

    const customerTypes = await CommusoftService.getCustomerTypeRecords(userId);
    const customerType = customerTypes.find(
      (r: any) =>
        String(r.description ?? "").trim().toLowerCase() ===
        String(customerTypeDescription).trim().toLowerCase()
    );

    if (!customerType) {
      throw new ApiError(
        404,
        `Customer type "${customerTypeDescription}" not found after refresh`
      );
    }

    const { id: customerTypeId, uuid: customerTypeUuid } = customerType;

    const { customer_type, ...restData } = customerData;
    const payload: Record<string, any> = {};

    // Customer-level simple fields (flat mapping)
    const customerFieldMap: Record<string, string> = {
      address_line_1: "customertype[addressline1]",
      address_line_2: "customertype[addressline2]",
      address_line_3: "customertype[addressline3]",
      town: "customertype[town]",
      county: "customertype[county]",
      postcode: "customertype[postcode]",
    };

    for (const [key, value] of Object.entries(restData)) {
      if (value === undefined || value === null || value === "") continue;
      const apiKey = customerFieldMap[key];
      if (apiKey) payload[apiKey] = value;
    }

    // Contact name — company_name takes precedence over name for commercial types
    const contactName = restData.company_name || restData.name;
    if (contactName) payload["customertype[contacts][name]"] = contactName;

    if (restData.surname) {
      payload["customertype[contacts][surname]"] = restData.surname;
    }

    // Title: API expects numeric settingsTitlesid. Send only if the UI
    // provided an id-like value; skip raw strings like "Mr" so the POST
    // isn't rejected wholesale for one optional field.
    if (restData.title && !Number.isNaN(Number(restData.title))) {
      payload["customertype[contacts][settingsTitlesid]"] = restData.title;
    }

    // Email — company_email wins over email (commercial types fill the
    // company field; individuals fill the regular one). Both collapse to the
    // same Commusoft field since the API has no separate "company email".
    const contactEmail = restData.company_email || restData.email;
    if (contactEmail) {
      payload["customertype[contacts][contactsemail][emailaddress]"] =
        contactEmail;
    }

    // Phone numbers: Commusoft uses indexed slots under contactstelephone.
    // Slot 0 = landline, slot 1 = mobile. Country code is sent per-slot.
    // company_landline wins over landline on the same priority logic as email.
    const contactLandline = restData.company_landline || restData.landline;
    if (contactLandline) {
      payload[
        "customertype[contacts][contactstelephone][0][telephonenumber]"
      ] = contactLandline;
      if (restData.country_code) {
        payload[
          "customertype[contacts][contactstelephone][0][countrycode]"
        ] = restData.country_code;
      }
    }

    if (restData.mobile) {
      payload[
        "customertype[contacts][contactstelephone][1][telephonenumber]"
      ] = restData.mobile;
      if (restData.country_code) {
        payload[
          "customertype[contacts][contactstelephone][1][countrycode]"
        ] = restData.country_code;
      }
    }

    // Fresh UUIDs per request — Commusoft treats customertype[uuid] as the new
    // customer's primary key and rejects duplicate values with a 500.
    const freshCustomerUuid = randomUUID();
    const freshContactUuid  = randomUUID();

    console.log(`[Commusoft:createCustomer] 🆕 fresh UUIDs generated  customer=${freshCustomerUuid}  contact=${freshContactUuid}`);

    payload["customertype[uuid]"]           = freshCustomerUuid;
    payload["customertype[contacts][uuid]"] = freshContactUuid;

    const formBody = toFormBody(payload);
    const targetUrl = `${COMMUSOFT_API_BASE}/customers/${customerTypeId}`;

    console.log("=====================================");
    console.log("📤 [Commusoft:createCustomer] FINAL REQUEST");
    console.log("→ URL:    ", targetUrl);
    console.log("→ Method: POST");
    console.log("→ customer_type:", {
      description: customerTypeDescription,
      id: customerTypeId,
      typeUuid: customerTypeUuid,
      freshCustomerUuid,
      freshContactUuid,
    });
    console.log("→ payload (object):", JSON.stringify(payload, null, 2));
    console.log("→ payload (form-urlencoded):", formBody.toString());
    console.log("=====================================");

    try {
      const response = await axios.post(targetUrl, formBody, {
        params,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      console.log(
        `✅ [Commusoft:createCustomer] success  status=${response.status}  uuid=${freshCustomerUuid}  response=${JSON.stringify(response.data)?.slice(0, 400)}`
      );

      // Refresh the customer cache from Commusoft immediately. This keeps the
      // dashboard/API in sync even when a customer is created from a workflow.
      // A previous fallback attempted to write app-shaped fields (email, phone,
      // commusoft_id) into the Commusoft-shaped table and silently failed.
      try {
        const customers = await CommusoftService.getCustomers(userId);
        console.log(`[Commusoft:createCustomer] ✅ customer cache refreshed  count=${customers.length}`);
      } catch (syncErr: any) {
        console.warn(
          `[Commusoft:createCustomer] ⚠ customer cache refresh failed (non-fatal): ${syncErr?.message}`
        );
      }

      return {
        ...response.data,
        customer_uuid: freshCustomerUuid,
        contact_uuid: freshContactUuid,
      };
    } catch (err: any) {
      console.error("=====================================");
      console.error("❌ [Commusoft:createCustomer] FAILED");
      console.error("  status:        ", err?.response?.status);
      console.error("  statusText:    ", err?.response?.statusText);
      console.error("  response body: ", JSON.stringify(err?.response?.data, null, 2));
      console.error("  sent payload:  ", JSON.stringify(payload, null, 2));
      console.error("=====================================");
      throw err;
    }
  }

  /**
   * Resolve a Commusoft customer_id from a direct id/uuid, name, or email.
   * Always fetches live data from Commusoft (GET /customers) so lookups are
   * never stale. The fetch side-effect upserts the fresh list into
   * commusoft_customers for downstream consumers.
   */
  static async resolveCustomerId(
    userId: string,
    lookup: {
      customer_id?: string | number;
      uuid?: string;
      customer_name?: string;
      email?: string;
    }
  ): Promise<string> {
    const hasCriteria =
      lookup.customer_id || lookup.uuid || lookup.customer_name || lookup.email;
    if (!hasCriteria) {
      throw new ApiError(
        400,
        "customer_id, uuid, customer_name, or email is required to identify the customer"
      );
    }

    if (lookup.customer_id) {
      return String(lookup.customer_id);
    }

    // Refresh DB from live API and use the in-memory response for lookup.
    const records: any[] = await CommusoftService.getCustomers(userId);

    const norm = (v: any) => String(v ?? "").trim().toLowerCase();
    const target = {
      id: lookup.customer_id ? String(lookup.customer_id) : "",
      uuid: norm(lookup.uuid),
      name: norm(lookup.customer_name),
      email: norm(lookup.email),
    };

    const match = records.find((r: any) => {
      if (
        target.id &&
        (String(r.customer_id) === target.id || String(r.id) === target.id)
      )
        return true;
      if (target.uuid && norm(r.uuid) === target.uuid) return true;
      if (
        target.email &&
        (norm(r.email) === target.email ||
          norm(r.emailaddress) === target.email ||
          norm(r.company_email) === target.email ||
          norm(r.contactemail) === target.email)
      )
        return true;
      if (target.name) {
        const candidates = [
          r.customer_name,
          r.name,
          [r.name, r.surname].filter(Boolean).join(" "),
          r.company_name,
          r.companyname,
          r.contact_name,
        ].map(norm);
        if (candidates.some((c) => c && c.includes(target.name))) return true;
      }
      return false;
    });

    const resolved = match?.customer_id ?? match?.id ?? match?.uuid;
    if (!resolved) {
      throw new ApiError(
        404,
        `Commusoft customer not found for lookup ${JSON.stringify(lookup)}`
      );
    }
    return String(resolved);
  }

  /**
   * Create a new job in Commusoft under a customer.
   * POST /api/v1/customers/{customerId}/jobs with job[...] form params.
   */
  static async createJob(userId: string, jobData: Record<string, any>) {
    const params = await getParams(userId);

    const customerId = await CommusoftService.resolveCustomerId(userId, {
      customer_id: jobData.customer_id,
      uuid: jobData.customer_uuid,
      customer_name: jobData.customer_name,
      email: jobData.email,
    });

    if (!jobData.description && !jobData.job_description) {
      throw new ApiError(400, "description (or job_description) is required");
    }

    const fieldMap: Record<string, string> = {
      description: "job[description]",
      job_description: "job[description]",
      engineer_notes: "job[engineernotes]",
      po_number: "job[ponumber]",
      priority: "job[priority]",
      quoted_amount: "job[quotedamount]",
      invoice_category_id: "job[invoicecategoryid]",
      user_group_id: "job[usergroupsid]",
      access_notes: "job[accessnotes]",
      access_method: "job[workaddressaccessmethod]",
      contact_id: "job[contactid]",
      additional_contact_id: "job[additionalcontactid]",
      settings_job_description_id: "job[settingsjobdescriptionid]",
      is_service_job: "job[isservicejob]",
      uuid: "job[uuid]",
      selected_skill: "job[selectedSkill]",
    };

    const skipKeys = new Set([
      "customer_id",
      "customer_uuid",
      "customer_name",
      "email",
    ]);
    const payload: Record<string, any> = {};
    for (const [key, value] of Object.entries(jobData)) {
      if (skipKeys.has(key)) continue;
      if (value === undefined || value === null || value === "") continue;
      const apiKey = fieldMap[key] ?? key;
      payload[apiKey] = value;
    }

    if (!payload["job[uuid]"]) {
      payload["job[uuid]"] = randomUUID();
    }

    const response = await axios.post(
      `${COMMUSOFT_API_BASE}/customers/${customerId}/jobs`,
      toFormBody(payload),
      {
        params,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    return response.data;
  }

  /**
   * Create a Commusoft diary event. For survey bookings we normally create a
   * job first, then book a diary event against that job with eventType=job.
   */
  static async createDiaryEvent(
    userId: string,
    diaryData: Record<string, any>
  ) {
    const params = await getParams(userId);

    const fieldMap: Record<string, string> = {
      event_type: "data[eventType]",
      eventType: "data[eventType]",
      description: "data[description]",
      engineer_notes: "data[engineer_notes]",
      event_start: "data[event_start]",
      event_end: "data[event_end]",
      all_day: "data[allDay]",
      allDay: "data[allDay]",
      resource_id: "data[resourceId]",
      resourceId: "data[resourceId]",
      estimate_id: "data[estimateid]",
      estimateid: "data[estimateid]",
      job_id: "data[jobid]",
      jobid: "data[jobid]",
      milestone_id: "data[milestoneId]",
      milestoneId: "data[milestoneId]",
      is_recurring_event: "data[is_recurring_event]",
      repeat_type: "data[repeat_type]",
      repeats_every: "data[repeats_every]",
      repeats_on: "data[repeats_on]",
      occurrences: "data[occurrences]",
      uuid: "data[uuid]",
      access_method: "data[accessmethod]",
      accessmethod: "data[accessmethod]",
      access_notes: "data[accessnotes]",
      accessnotes: "data[accessnotes]",
    };

    const payload: Record<string, any> = {};
    for (const [key, value] of Object.entries(diaryData)) {
      if (value === undefined || value === null || value === "") continue;
      const apiKey = fieldMap[key] ?? key;
      payload[apiKey] = value;
    }

    if (!payload["data[uuid]"]) {
      payload["data[uuid]"] = randomUUID();
    }

    const response = await axios.post(
      `${COMMUSOFT_API_BASE}/diaryevents`,
      toFormBody(payload),
      {
        params,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    return response.data;
  }

  /**
   * Create a Commusoft sales opportunity for an existing customer.
   *
   * Commusoft's public Zapier action exposes this as "Create Opportunity" and
   * requires an opportunity template. The API shape follows the customer/job
   * pattern: POST under the customer with Symfony form-encoded opportunity data.
   */
  static async createOpportunity(
    userId: string,
    opportunityData: Record<string, any>
  ) {
    const params = await getParams(userId);

    const customerId = await CommusoftService.resolveCustomerId(userId, {
      customer_id: opportunityData.customer_id,
      uuid: opportunityData.customer_uuid,
      customer_name: opportunityData.customer_name,
      email: opportunityData.email,
    });

    let templateId =
      opportunityData.opportunity_template_id ?? opportunityData.template_id;

    if (!templateId) {
      const templates = extractCommusoftArray(
        await CommusoftService.getOpportunityTemplates(userId),
        [...COMMUSOFT_OPPORTUNITY_ARRAY_KEYS]
      );
      const firstTemplate = templates[0] as Record<string, any> | undefined;
      templateId =
        firstTemplate?.id ??
        firstTemplate?.ID ??
        firstTemplate?.templateId ??
        firstTemplate?.template_id ??
        firstTemplate?.["Template Id"] ??
        firstTemplate?.["Template ID"];
      if (!templateId) {
        throw new ApiError(400, "opportunity_template_id is required and no default Commusoft opportunity template was found");
      }
      console.log(`[Commusoft:createOpportunity] no template supplied — using first available template id=${templateId}`);
    }

    const skipKeys = new Set([
      "customer_id",
      "customer_uuid",
      "customer_name",
      "email",
      "template_id",
      "opportunity_template_id",
    ]);

    const fieldMap: Record<string, string> = {
      opportunity_name: "opportunity[name]",
      name: "opportunity[name]",
      opportunity_notes: "opportunity[notes]",
      notes: "opportunity[notes]",
      description: "opportunity[description]",
      sales_person_id: "opportunity[salesPersonId]",
      salesperson_id: "opportunity[salesPersonId]",
      value: "opportunity[value]",
      estimated_value: "opportunity[value]",
      uuid: "opportunity[uuid]",
    };

    const basePayload: Record<string, any> = {};
    for (const [key, value] of Object.entries(opportunityData)) {
      if (skipKeys.has(key)) continue;
      if (value === undefined || value === null || value === "") continue;
      const apiKey = fieldMap[key] ?? key;
      basePayload[apiKey] = value;
    }

    if (!basePayload["opportunity[uuid]"]) {
      basePayload["opportunity[uuid]"] = randomUUID();
    }

    const templateKeys = [
      "opportunity[opportunityTemplateId]",
      "opportunity[opportunitytemplateid]",
      "opportunity[templateId]",
      "opportunity[templateid]",
      "opportunity[opportunitytemplatesid]",
    ];

    let lastError: any = null;
    for (const templateKey of templateKeys) {
      const payload = {
        ...basePayload,
        [templateKey]: templateId,
      };

      try {
        console.log(
          `[Commusoft:createOpportunity] → POST /customers/${customerId}/opportunities  templateKey=${templateKey}  fields=[${Object.keys(payload).join(", ")}]`
        );
        const response = await axios.post(
          `${COMMUSOFT_API_BASE}/customers/${customerId}/opportunities`,
          toFormBody(payload),
          {
            params,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }
        );

        return {
          ...response.data,
          customer_id: customerId,
          opportunity_template_id: templateId,
        };
      } catch (err: any) {
        lastError = err;
        const status = err?.response?.status;
        const body = err?.response?.data;
        console.warn(
          `[Commusoft:createOpportunity] attempt failed templateKey=${templateKey} status=${status} body=${JSON.stringify(body)?.slice(0, 300)}`
        );
        if (status && status >= 500) break;
      }
    }

    throw lastError;
  }

  /**
   * Fetch jobs from the live Commusoft API with optional filters.
   * Mapped from the same filter keys the UI sends for ServiceM8 so the
   * frontend needs no changes.
   *
   * Commusoft equivalents:
   *   status      → status        (ongoing|reserved|on_hold|waiting_for_customer|completed)
   *   dateFrom    → jobCreatedStartDate  (YYYY-MM-DD)
   *   dateTo      → jobCreatedEndDate    (YYYY-MM-DD)
   *   customerID  → customerID    (numeric Commusoft customer id)
   *
   * staffUuid / categoryUuid / queueUuid have no Commusoft jobs-API equivalent
   * and are silently ignored here.
   */
  static async listJobsFiltered(
    userId: string,
    filters: {
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      customerID?: string | number;
    }
  ): Promise<Record<string, unknown>[]> {
    const authParams = await getParams(userId);

    const params: Record<string, any> = {
      ...authParams,
      "number of records": COMMUSOFT_API_BATCH_SIZE,
      "starting record": 1,
    };

    if (filters.status)      params["status"]               = filters.status;
    if (filters.dateFrom)    params["jobCreatedStartDate"]  = filters.dateFrom;
    if (filters.dateTo)      params["jobCreatedEndDate"]    = filters.dateTo;
    if (filters.customerID)  params["customerID"]           = filters.customerID;

    const response = await axios.get(`${COMMUSOFT_API_BASE}/jobs`, {
      params,
      timeout: COMMUSOFT_API_TIMEOUT_MS,
    });

    const jobs = extractCommusoftArray(response.data, ["Jobs", "jobs", "Job"]) as Record<
      string,
      unknown
    >[];

    console.log(
      `[Commusoft:listJobsFiltered] filters=${JSON.stringify(filters)}  returned=${jobs.length} jobs`
    );
    return jobs;
  }

  /**
   * Sync all Commusoft data from external API to DB.
   *
   * Strategy: fetch everything in bulk paginated loops → store in DB →
   * build all relations from DB when needed. Never call per-customer endpoints.
   *
   * Before (1006+ calls for 500 customers):
   *   getJobs (N pages) + syncCustomerDetails (500×2 per-customer calls) + staff + prefs
   *
   * After (~15 calls regardless of customer count):
   *   Phase 1 [parallel]: getJobs (N pages) + getCustomers (N pages)
   *   Phase 2 [parallel]: getStaffMembers (1 call) + getUserPreference (1 call)
   *   Relations: built from DB by summary.service.ts — zero extra API calls
   */
  /**
   * Sync diary events to commusoft_diaryevents table.
   * Uses incremental date filter (last sync - 1h) to avoid re-fetching all
   * events from 2020 on every sync. Falls back to "2020-01-01" on first run.
   * toDate is set 1 year ahead so upcoming scheduled events are included.
   */
  static async syncDiaryEventsViaStream(userId: string): Promise<{ synced: number; skipped: number }> {
    const authParams = await getParams(userId);

    // Incremental: read last completed sync for diaryevents.
    // First run defaults to 2 years back (not 2020) to avoid timeout on large datasets.
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    let fromDate = twoYearsAgo.toISOString().split("T")[0]!;
    try {
      const { data } = await supabase
        .from("sync_checkpoints")
        .select("last_synced_at")
        .eq("user_id", userId)
        .eq("integration", "commusoft")
        .eq("entity", "diaryevents")
        .eq("status", "completed")
        .maybeSingle();

      if (data?.last_synced_at) {
        const from = new Date(data.last_synced_at);
        from.setHours(from.getHours() - 1);
        fromDate = from.toISOString().split("T")[0]!;
      }
    } catch {
      // non-fatal — use default 2020-01-01
    }

    const toDate = new Date();
    toDate.setFullYear(toDate.getFullYear() + 1);
    const toDateStr = toDate.toISOString().split("T")[0]!;

    console.log(`[Commusoft:diaryevents] fetching from=${fromDate} to=${toDateStr}`);

    const response = await axios.get(`${COMMUSOFT_API_BASE}/diaryevents`, {
      params: { ...authParams, fromdate: fromDate, todate: toDateStr },
      timeout: 60_000, // diary events span years — needs more time than standard calls
    });

    const events = extractCommusoftArray(response.data, [
      "events", "Events", "diaryEvents", "DiaryEvents",
    ]);

    if (events.length === 0) {
      console.log("[Commusoft:diaryevents] no events in date range");
      return { synced: 0, skipped: 0 };
    }

    const rows = (events as any[]).map((event) => {
      const rawId = event?.id ?? event?.event_id ?? event?.eventId;
      const commusoftEventId = rawId != null && String(rawId).trim()
        ? String(rawId).trim()
        : `${pickNumber(event?.redirectDetails ?? event, "jobId", "job_id")}_${event.start ?? ""}_${pickNumber(event, "resourceId", "resource_id")}`;

      const jobId = pickNumber(event?.redirectDetails ?? event, "jobId", "job_id", "id");

      return {
        user_id:             userId,
        commusoft_event_id:  commusoftEventId,
        start_date:          event.start   ?? null,
        end_date:            event.end     ?? null,
        resource_id:         pickNumber(event, "resourceId", "resource_id") || null,
        user_name:           pickString(event, "userName", "user_name", "engineerName") || null,
        job_id:              jobId > 0 ? jobId : null,
        payload:             event,
        updated_at:          new Date().toISOString(),
      };
    });

    const chunkSize = 500;
    let synced = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from("commusoft_diaryevents")
        .upsert(chunk, { onConflict: "user_id,commusoft_event_id" })
        .select("id");

      if (error) {
        console.error(`[Commusoft:diaryevents] upsert error:`, error.message);
      } else {
        synced += data?.length ?? chunk.length;
      }
    }

    console.log(
      `[Commusoft:diaryevents] ✅ done total=${events.length} synced=${synced}`
    );
    return { synced, skipped: events.length - synced };
  }

  static async syncAll(userId: string, batchSize?: number) {
    const effectiveBatchSize = resolveCommusoftBatchSize(batchSize);
    console.log(`[Commusoft:syncAll] batchSize=${effectiveBatchSize}`);

    const results: Record<string, string> = {};

    // ── Phase 1: Bulk data — jobs + customers in parallel ─────────────────────
    // Both are independent — no foreign-key dependency between them at API level.
    // Each runs its own paginated stream until the API returns an empty page.
    const [jobsResult, customersResult] = await Promise.allSettled([
      CommusoftService.getJobs(userId, effectiveBatchSize),
      CommusoftService.syncCustomersViaStream(userId),
    ]);

    if (jobsResult.status === "fulfilled") {
      const { total, synced, skipped, failed } = jobsResult.value;
      results.jobs = `synced (total=${total} written=${synced} unchanged=${skipped}${failed ? ` failed=${failed}` : ""})`;
    } else {
      results.jobs = `failed: ${jobsResult.reason?.message ?? jobsResult.reason}`;
      console.error("[Commusoft:syncAll] jobs failed:", jobsResult.reason?.message);
    }

    if (customersResult.status === "fulfilled") {
      results.customers = `synced (${customersResult.value.synced} written, ${customersResult.value.skipped} unchanged)`;
    } else {
      results.customers = `failed: ${customersResult.reason?.message ?? customersResult.reason}`;
      console.error("[Commusoft:syncAll] customers failed:", customersResult.reason?.message);
    }

    // ── Phase 2: Small lookups — staff + user preferences + diary events ────────
    // Staff is fetched once here — NOT again inside syncCustomerDetails.
    // Diary events use incremental date filter so only new/changed events are fetched.
    const [staffResult, prefResult, diaryResult] = await Promise.allSettled([
      CommusoftService.getStaffMembers(userId),
      CommusoftService.getUserPreference(userId),
      CommusoftService.syncDiaryEventsViaStream(userId),
    ]);

    results.staffMembers   = staffResult.status  === "fulfilled" ? "synced"                                                            : `failed: ${staffResult.reason?.message}`;
    results.userPreference = prefResult.status    === "fulfilled" ? "synced"                                                            : `failed: ${prefResult.reason?.message}`;
    results.diaryEvents    = diaryResult.status   === "fulfilled" ? `synced (${diaryResult.value.synced} written)` : `failed: ${diaryResult.reason?.message}`;

    // ── No syncCustomerDetails here ───────────────────────────────────────────
    // Previously this called /customers/{id}/contacts and /customers/{id}/jobs
    // for every single customer (N×2 API calls).
    //
    // All that data is already in DB after Phase 1:
    //   commusoft_jobs     → has Contact Name, Customer Email, Customer Mobile,
    //                        Job Address, Engineer Name, Diary Events, etc.
    //   commusoft_customers → has full customer record
    //
    // summary.service.ts builds the full customer+jobs view with a DB join —
    // see groupBlocksAndCustomersByCustomer() — no API call needed at query time.

    console.log("[Commusoft:syncAll] ✅ complete", results);
    return results;
  }
}
