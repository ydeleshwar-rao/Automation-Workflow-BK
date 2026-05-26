import { supabase } from "../../../../config/db.config.js";
import { normalizeDatabaseError } from "../../../../lib/errors/normalize-database-error.js";
import { toApiError } from "../../../../lib/errors/to-api-error.js";
import { ServiceM8Service } from "./serviceM8.service.js";

/** Same shape as getJobDetails `data` (contact, site, head_office, job, engineer, payment, activities, materials). */
export type JobDetailDataBlock = {
  contact: {
    name: string;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    type: string | null;
    is_primary_contact: string | null;
  } | null;
  site: {
    name: string | null;
    website: string | null;
    abn_number: string | null;
    address: string | null;
    address_street: string | null;
    address_city: string | null;
    address_state: string | null;
    address_postcode: string | null;
    address_country: string | null;
    billing_address: string | null;
    fax_number: string | null;
  } | null;
  head_office: { name: string | null; address: string | null } | null;
  job: {
    generated_job_id: string | null;
    status: string | null;
    date: string | null;
    job_address: string | null;
    job_description: string | null;
    work_done_description: string | null;
    total_invoice_amount: string | null;
    purchase_order_number: string | null;
    category: string | null;
    quote_date: string | null;
    completion_date: string | null;
    job_count: number;
  };
  engineer: {
    name: string;
    email: string | null;
    mobile: string | null;
    job_title: string | null;
    status_message: string | null;
  } | null;
  payment: {
    status: string;
    amount: string | null;
    method: string | null;
    date: string | null;
    total_invoice: string | null;
    ready_to_invoice: boolean;
    payments: unknown[];
  };
  activities: { start_date: unknown; end_date: unknown; scheduled: unknown }[];
  jobmaterials: {
    name: string | null;
    quantity: unknown;
    price: unknown;
    total: unknown;
    displayed_amount: unknown;
    cost: unknown;
    displayed_cost: unknown;
  }[];
  notes: {
    uuid: string;
    note: string | null;
    action_required: string | null;
    create_date: string | null;
    edit_date: string | null;
    active: number | null;
  }[];
};

/** One job's details without the customer-level fields (those live on the group). */
export type CustomerJobEntry = {
  job: {
    generated_job_id: string | null;
    status: string | null;
    date: string | null;
    job_address: string | null;
    job_description: string | null;
    work_done_description: string | null;
    total_invoice_amount: string | null;
    purchase_order_number: string | null;
    category: string | null;
    quote_date: string | null;
    completion_date: string | null;
  };
  engineer: JobDetailDataBlock["engineer"];
  payment: JobDetailDataBlock["payment"];
  activities: JobDetailDataBlock["activities"];
  jobmaterials: JobDetailDataBlock["jobmaterials"];
  notes: JobDetailDataBlock["notes"];
};

/** All jobs for one customer, with shared contact/site info hoisted to the top. */
export type CustomerJobGroup = {
  contact: JobDetailDataBlock["contact"];
  site: JobDetailDataBlock["site"];
  head_office: JobDetailDataBlock["head_office"];
  job_count: number;
  jobs: CustomerJobEntry[];
};

//
type Row = Record<string, unknown>;

/**
 * Pre-loaded lookup tables for the bulk-block path.
 * Built once per request by `preloadJobLookups`, then handed to every
 * `buildJobDetailBlock` call so they can resolve foreign-key data via
 * Map.get() instead of firing 5–8 Supabase queries each. For 588 jobs this
 * cuts ~3500 round-trips down to ~8.
 */
export interface JobLookupMaps {
  activitiesByJob: Map<string, Row[]>;
  paymentsByJob: Map<string, Row[]>;
  materialsByJob: Map<string, Row[]>;
  notesByJob: Map<string, Row[]>;
  jobCountByCompany: Map<string, number>;
  companyByUuid: Map<string, Row>;
  headOfficeByUuid: Map<string, Row>;
  primaryContactByCompany: Map<string, Row>;
  staffByUuid: Map<string, Row>;
  categoryByUuid: Map<string, Row>;
}

/**
 * PostgREST encodes `.in()` filters into the URL query string
 * (`?col=in.(uuid1,uuid2,…)`). With ~36-char UUIDs the URL crosses the 8KB
 * gateway limit somewhere around 150–200 values and the request silently
 * comes back with an empty body. To stay safe we split the list into
 * fixed-size chunks and fan the queries out in parallel.
 */
const IN_CHUNK_SIZE = 100;

const chunkArray = <T>(arr: T[], size: number): T[][] => {
  if (arr.length <= size) return arr.length ? [arr] : [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

type SupabaseSelectResult = { data: Row[] | null; error: { message?: string } | null };

const fetchInChunks = async (
  values: string[],
  build: (chunk: string[]) => PromiseLike<SupabaseSelectResult>,
  label: string,
): Promise<Row[]> => {
  if (values.length === 0) return [];
  const chunks = chunkArray(values, IN_CHUNK_SIZE);
  const results = await Promise.all(chunks.map((c) => build(c)));
  const merged: Row[] = [];
  for (const r of results) {
    if (r.error) {
      console.error(`[fetchInChunks:${label}] chunk failed:`, r.error.message);
      continue;
    }
    if (r.data) merged.push(...r.data);
  }
  return merged;
};

const groupRows = (rows: Row[], key: string): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r?.[key] as string | undefined;
    if (!k) continue;
    const cur = out.get(k);
    if (cur) cur.push(r);
    else out.set(k, [r]);
  }
  return out;
};

const indexRows = (rows: Row[], key: string): Map<string, Row> => {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const k = r?.[key] as string | undefined;
    if (!k || out.has(k)) continue;
    out.set(k, r);
  }
  return out;
};

export class SummaryService {
  /**
   * Eager-load every related row a job set will need.
   * Two-phase (companies first, then their parents) — total round-trips: 2.
   */
  static async preloadJobLookups(
    userId: string,
    jobs: Row[]
  ): Promise<JobLookupMaps> {
    const jobUuids = jobs.map((j) => j.uuid).filter(Boolean) as string[];
    const companyUuids = [
      ...new Set(jobs.map((j) => j.company_uuid).filter(Boolean) as string[]),
    ];
    const staffUuids = [
      ...new Set(
        jobs.map((j) => j.completion_actioned_by_uuid).filter(Boolean) as string[]
      ),
    ];
    const categoryUuids = [
      ...new Set(jobs.map((j) => j.category_uuid).filter(Boolean) as string[]),
    ];

    // Phase 1 — every lookup is chunked to stay under PostgREST's URL cap.
    // NOTE: companies/contacts/staff are looked up WITHOUT a `user_id` filter.
    // ServiceM8 generates globally-unique UUIDs and the upsert path
    // (`onConflict: "uuid"`) doesn't reliably keep `user_id` aligned across
    // multi-user dev environments — so a strict `eq("user_id", ...)` here
    // gave a 100% miss rate even when the rows existed (matches the
    // `safeFK` validation path in serviceM8.service which also ignores user_id
    // when checking FKs). Knowing the UUID already implies authorization
    // since it came from this user's own job rows.
    const [activities, payments, materials, notes, companies, contacts, staff, categories] =
      await Promise.all([
        fetchInChunks(jobUuids, (chunk) =>
          supabase
            .from("servicem8_job_activities")
            .select("*")
            .eq("user_id", userId)
            .in("job_uuid", chunk),
          "activities",
        ),
        fetchInChunks(jobUuids, (chunk) =>
          supabase
            .from("servicem8_job_payments")
            .select("*")
            .eq("user_id", userId)
            .in("job_uuid", chunk),
          "payments",
        ),
        fetchInChunks(jobUuids, (chunk) =>
          supabase
            .from("servicem8_job_materials")
            .select("*")
            .eq("user_id", userId)
            .in("job_uuid", chunk),
          "materials",
        ),
        fetchInChunks(jobUuids, (chunk) =>
          supabase
            .from("servicem8_notes")
            .select("*")
            .eq("user_id", userId)
            .eq("active", 1)
            .eq("related_object", "Job")
            .in("related_object_uuid", chunk),
          "notes",
        ),
        fetchInChunks(companyUuids, (chunk) =>
          supabase.from("servicem8_site_details").select("*").in("uuid", chunk),
          "companies",
        ),
        // Fetch ALL contacts for these companies (not just primary). The map
        // builder below prefers `is_primary_contact='1'` but falls back to any
        // contact so jobs whose company has only non-primary contacts still
        // surface a name/email/phone in the UI.
        fetchInChunks(companyUuids, (chunk) =>
          supabase.from("servicem8_contacts").select("*").in("company_uuid", chunk),
          "contacts",
        ),
        fetchInChunks(staffUuids, (chunk) =>
          supabase.from("servicem8_staff").select("*").in("uuid", chunk),
          "staff",
        ),
        fetchInChunks(categoryUuids, (chunk) =>
          supabase.from("servicem8_categories").select("*").in("uuid", chunk),
          "categories",
        ),
      ]);

    const companyByUuid = indexRows(companies, "uuid");

    // Phase 2: head offices = parents of any company that has parent_company_uuid.
    const parentUuids = [
      ...new Set(
        [...companyByUuid.values()]
          .map((c) => c.parent_company_uuid)
          .filter(Boolean) as string[]
      ),
    ];
    const parents = await fetchInChunks(parentUuids, (chunk) =>
      supabase.from("servicem8_site_details").select("*").in("uuid", chunk),
      "parents",
    );

    // Build the contact map in two passes so primaries always win.
    // Pass 1: only is_primary_contact='1' rows.
    // Pass 2: any remaining company that still has no contact gets the
    // first non-primary as a fallback. This way the UI shows *some* contact
    // for companies that exist in ServiceM8 but never marked one primary.
    const contactByCompany = new Map<string, Row>();
    for (const c of contacts) {
      const cu = c?.company_uuid as string | undefined;
      if (cu && c.is_primary_contact === "1" && !contactByCompany.has(cu)) {
        contactByCompany.set(cu, c);
      }
    }
    for (const c of contacts) {
      const cu = c?.company_uuid as string | undefined;
      if (cu && !contactByCompany.has(cu)) {
        contactByCompany.set(cu, c);
      }
    }

    const jobCountByCompany = new Map<string, number>();
    for (const j of jobs) {
      const cu = j.company_uuid as string | undefined;
      if (cu) jobCountByCompany.set(cu, (jobCountByCompany.get(cu) ?? 0) + 1);
    }

    // Diagnostic — surfaces *why* the UI sees nulls.
    const jobsWithoutCompany = jobs.filter((j) => !j.company_uuid).length;
    const missingCompanies = companyUuids.filter((u) => !companyByUuid.has(u)).length;
    const companiesWithoutContact = companyUuids.filter((u) => !contactByCompany.has(u)).length;
    console.log(
      `[preloadJobLookups] jobs=${jobs.length}  jobsWithoutCompany=${jobsWithoutCompany}  ` +
      `companyUuids=${companyUuids.length}  companiesLoaded=${companies.length}  missingCompanies=${missingCompanies}  ` +
      `companiesWithoutContact=${companiesWithoutContact}  contactsLoaded=${contacts.length}`
    );

    return {
      activitiesByJob: groupRows(activities, "job_uuid"),
      paymentsByJob: groupRows(payments, "job_uuid"),
      materialsByJob: groupRows(materials, "job_uuid"),
      notesByJob: groupRows(notes, "related_object_uuid"),
      jobCountByCompany,
      companyByUuid,
      headOfficeByUuid: indexRows(parents, "uuid"),
      primaryContactByCompany: contactByCompany,
      staffByUuid: indexRows(staff, "uuid"),
      categoryByUuid: indexRows(categories, "uuid"),
    };
  }

  /**
   * Build one job-details payload.
   * Pass `maps` (from `preloadJobLookups`) in the bulk path to avoid firing
   * a per-job query storm. Without `maps` the function falls back to its
   * original per-job Supabase queries — kept for single-job callers.
   */
  static async buildJobDetailBlock(
    userId: string,
    job: Record<string, unknown>,
    contactOverride?: Record<string, unknown> | null,
    maps?: JobLookupMaps
  ): Promise<JobDetailDataBlock> {
    const jobUuid = job.uuid as string;

    let activities: Row[] | null;
    let payments: Row[] | null;
    let jobmaterials: Row[] | null;
    let jobnotes: Row[] | null;

    if (maps) {
      activities = maps.activitiesByJob.get(jobUuid) ?? [];
      payments = maps.paymentsByJob.get(jobUuid) ?? [];
      jobmaterials = maps.materialsByJob.get(jobUuid) ?? [];
      jobnotes = maps.notesByJob.get(jobUuid) ?? [];
    } else {
      const [
        { data: a },
        { data: p },
        { data: m },
        { data: n },
      ] = await Promise.all([
        supabase.from("servicem8_job_activities").select("*").eq("user_id", userId).eq("job_uuid", jobUuid),
        supabase.from("servicem8_job_payments").select("*").eq("user_id", userId).eq("job_uuid", jobUuid),
        supabase.from("servicem8_job_materials").select("*").eq("user_id", userId).eq("job_uuid", jobUuid),
        supabase.from("servicem8_notes").select("*").eq("user_id", userId).eq("active", 1).eq("related_object", "Job").eq("related_object_uuid", jobUuid),
      ]);
      activities = a;
      payments = p;
      jobmaterials = m;
      jobnotes = n;
    }

    // See note in preloadJobLookups — companies/contacts/staff are intentionally
    // looked up without a `user_id` filter to match the FK-validation path in
    // listJobsFiltered. The UUID is the source of authorization here.
    const companyUuid = job.company_uuid as string | null | undefined;
    let company: Row | null = null;
    if (companyUuid) {
      if (maps) {
        company = maps.companyByUuid.get(companyUuid) ?? null;
      } else {
        const r = await supabase
          .from("servicem8_site_details")
          .select("*")
          .eq("uuid", companyUuid)
          .maybeSingle();
        company = r.data;
      }
    }

    let headOffice: Row | null = null;
    const parentUuid = company?.parent_company_uuid as string | undefined;
    if (parentUuid) {
      if (maps) {
        headOffice = maps.headOfficeByUuid.get(parentUuid) ?? null;
      } else {
        const r = await supabase
          .from("servicem8_site_details")
          .select("*")
          .eq("uuid", parentUuid)
          .maybeSingle();
        headOffice = r.data;
      }
    }

    let contact: Record<string, unknown> | null = contactOverride ?? null;
    if (!contact && companyUuid) {
      if (maps) {
        contact = maps.primaryContactByCompany.get(companyUuid) ?? null;
      } else {
        // Try the primary contact first; if none is marked primary, fall
        // back to any contact at this company so the UI still shows some
        // name/email/phone.
        const primaryRes = await supabase
          .from("servicem8_contacts")
          .select("*")
          .eq("company_uuid", companyUuid)
          .eq("is_primary_contact", "1")
          .maybeSingle();
        if (primaryRes.data) {
          contact = primaryRes.data;
        } else {
          const fallbackRes = await supabase
            .from("servicem8_contacts")
            .select("*")
            .eq("company_uuid", companyUuid)
            .limit(1)
            .maybeSingle();
          contact = fallbackRes.data ?? null;
        }
      }
    }

    let engineer: Row | null = null;
    const staffUuid = job.completion_actioned_by_uuid as string | undefined;
    if (staffUuid) {
      if (maps) {
        engineer = maps.staffByUuid.get(staffUuid) ?? null;
      } else {
        const r = await supabase
          .from("servicem8_staff")
          .select("*")
          .eq("uuid", staffUuid)
          .maybeSingle();
        engineer = r.data;
      }
    }

    let category: Row | null = null;
    const categoryUuid = job.category_uuid as string | undefined;
    if (categoryUuid) {
      if (maps) {
        category = maps.categoryByUuid.get(categoryUuid) ?? null;
      } else {
        const r = await supabase
          .from("servicem8_categories")
          .select("*")
          .eq("uuid", categoryUuid)
          .single();
        category = r.data;
      }
    }

    const c = contact;
    return {
      contact: c
        ? {
            name: `${c.first ?? ""} ${c.last ?? ""}`.trim(),
            email: (c.email as string) ?? null,
            phone: (c.phone as string) ?? null,
            mobile: (c.mobile as string) ?? null,
            type: (c.type as string) ?? null,
            is_primary_contact: (c.is_primary_contact as string) ?? null,
          }
        : null,
      site: company
        ? {
            name: (company.name as string) ?? null,
            website: (company.website as string) ?? null,
            abn_number: (company.abn_number as string) ?? null,
            address: (company.address as string) ?? null,
            address_street: (company.address_street as string) ?? null,
            address_city: (company.address_city as string) ?? null,
            address_state: (company.address_state as string) ?? null,
            address_postcode: (company.address_postcode as string) ?? null,
            address_country: (company.address_country as string) ?? null,
            billing_address: (company.billing_address as string) ?? null,
            fax_number: (company.fax_number as string) ?? null,
          }
        : null,
      head_office: headOffice
        ? {
            name: (headOffice.name as string) ?? null,
            address: (headOffice.address as string) ?? null,
          }
        : null,
      job: {
        generated_job_id: job.generated_job_id as string | null,
        status: job.status as string | null,
        date: job.date as string | null,
        job_address: job.job_address as string | null,
        job_description: job.job_description as string | null,
        work_done_description: job.work_done_description as string | null,
        total_invoice_amount: job.total_invoice_amount as string | null,
        purchase_order_number: job.purchase_order_number as string | null,
        category: (category?.name as string) ?? null,
        quote_date: job.quote_date as string | null,
        completion_date: job.completion_date as string | null,
        job_count: maps
          ? (maps.jobCountByCompany.get(companyUuid ?? "") ?? 1)
          : 1,
      },
      engineer: engineer
        ? {
            name: `${engineer.first ?? ""} ${engineer.last ?? ""}`.trim(),
            email: (engineer.email as string) ?? null,
            mobile: (engineer.mobile as string) ?? null,
            job_title: (engineer.job_title as string) ?? null,
            status_message: (engineer.status_message as string) ?? null,
          }
        : null,
      payment: {
        status: job.payment_date ? "Paid" : "Unpaid",
        amount: job.payment_amount as string | null,
        method: job.payment_method as string | null,
        date: job.payment_date as string | null,
        total_invoice: job.total_invoice_amount as string | null,
        ready_to_invoice: job.ready_to_invoice === "1",
        payments: payments ?? [],
      },
      activities: (activities ?? []).map((a: Record<string, unknown>) => ({
        start_date: a.start_date,
        end_date: a.end_date,
        scheduled: a.activity_was_scheduled,
      })),
      jobmaterials: (jobmaterials ?? []).map((m: Record<string, unknown>) => ({
        name: m.name as string | null,
        quantity: m.quantity,
        price: m.price,
        total: m.cost,
        displayed_amount: m.displayed_amount,
        cost: m.cost,
        displayed_cost: m.displayed_cost,
      })),
      notes: (jobnotes ?? []).map((n: Record<string, unknown>) => ({
        uuid: n.uuid as string,
        note: n.note as string | null,
        action_required: n.action_required as string | null,
        create_date: n.create_date as string | null,
        edit_date: n.edit_date as string | null,
        active: n.active as number | null,
      })),
    };
  }

  static async getJobDetails(userId: string, generatedJobId: string) {
    const { data: job, error: jobError } = await supabase
      .from("servicem8_jobs")
      .select("*")
      .eq("user_id", userId)
      .eq("generated_job_id", generatedJobId)
      .single();
    if (jobError || !job) throw new Error(`Job #${generatedJobId} not found`);

    const data = await SummaryService.buildJobDetailBlock(userId, job);
    return { success: true, data };
  }

  /**
   * All jobs for any contact row matching email OR phone (servicem8_contacts.email / phone / mobile).
   * Each list item uses the same shape as getJobDetails `data`.
   */
  static async getJobDetailsListByEmailOrPhone(
    userId: string,
    email?: string,
    phone?: string
  ): Promise<{ success: true; data: CustomerJobGroup[] }> {
    const normalizedEmail = email?.trim();
    const normalizedPhone = phone?.trim();
    if (!normalizedEmail && !normalizedPhone) return { success: true, data: [] };

    // Same rationale as preloadJobLookups: do NOT filter contacts by `user_id`.
    // The contacts table's `uuid` is globally unique and the upsert path does
    // not reliably keep `user_id` aligned across users, so an email/phone
    // search that adds `eq("user_id", ...)` returned zero rows even when a
    // matching contact existed in the DB.
    let query = supabase
      .from("servicem8_contacts")
      .select("*");

    if (normalizedEmail && normalizedPhone) {
      query = query.or(
        `email.ilike.${normalizedEmail},phone.ilike.${normalizedPhone}`
      );
    } else if (normalizedEmail) {
      query = query.ilike("email", normalizedEmail);
    } else {
      query = query.or(
        `phone.ilike.${normalizedPhone}`
      );
    }

    const { data: contacts, error: contactError } = await query;

    if (contactError) {
      const apiErr = normalizeDatabaseError(contactError);
      throw apiErr ?? toApiError(contactError);
    }
    console.log(
      `[getJobDetailsListByEmailOrPhone] email=${normalizedEmail ?? "-"} phone=${normalizedPhone ?? "-"} → matched ${contacts?.length ?? 0} contact(s)`
    );
    if (!contacts?.length) return { success: true, data: [] };

    const companySet = new Set(
      contacts
        .map((c) => c.company_uuid)
        .filter(Boolean) as string[]
    );
    
    const companyUuids = [...companySet];
    if (companyUuids.length === 0) return { success: true, data: [] };

    const jobRows = await fetchInChunks(
      companyUuids,
      (chunk) =>
        supabase
          .from("servicem8_jobs")
          .select("*")
          .eq("user_id", userId)
          .in("company_uuid", chunk)
          .order("date", { ascending: false, nullsFirst: false }),
      "emailPhoneLookup:jobs",
    );
    if (!jobRows.length) return { success: true, data: [] };
    const jobs = jobRows;

    const contactByCompany = new Map<string, Record<string, unknown>>();
    for (const c of contacts) {
      if (c.company_uuid && !contactByCompany.has(c.company_uuid)) {
        contactByCompany.set(c.company_uuid, c as Record<string, unknown>);
      }
    }

    // Batch-preload every FK this job set will need so each block resolves
    // synchronously from in-memory maps instead of firing 5–8 queries.
    const maps = await SummaryService.preloadJobLookups(
      userId,
      jobs as Record<string, unknown>[]
    );

    const rawJobs = jobs as Record<string, unknown>[];
    const list = await Promise.all(
      rawJobs.map((job) => {
        const companyUuid = job.company_uuid as string | undefined;
        const contactOverride = companyUuid
          ? contactByCompany.get(companyUuid)
          : undefined;
        return SummaryService.buildJobDetailBlock(userId, job, contactOverride, maps);
      })
    );
    return { success: true, data: SummaryService.groupBlocksByCustomer(rawJobs, list) };
  }

  /**
   * Fetch jobs with full detail blocks.
   * - If `generatedJobId` is supplied → returns a single-item array for that job.
   * - Otherwise → returns ALL jobs for the user, each as a full JobDetailDataBlock.
   */
  static async getJobs(
    userId: string,
    generatedJobId?: string,
    filters?: {
      queueUuid?: string;
      categoryUuid?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      staffUuid?: string;
      companyUuid?: string;
    },
    options?: { forceLive?: boolean; limit?: number; cursor?: string }
  ): Promise<{ success: true; data: CustomerJobGroup[]; meta: { has_more: boolean; next_cursor: string | null; total_returned: number } }> {
    let jobs: Record<string, unknown>[] = [];
    const pageLimit = options?.limit ?? 50;
    const cursor    = options?.cursor;
    const hasFilters = !generatedJobId && options?.forceLive === true;

    if (hasFilters) {
      console.log(
        `[SummaryService.getJobs] path=LIVE_API  filters=${JSON.stringify(filters ?? {})}  forceLive=${options?.forceLive ?? false}`
      );
      const apiFilters: NonNullable<Parameters<typeof ServiceM8Service.listJobsFiltered>[1]> = {};
      if (filters?.queueUuid)    apiFilters.queueUuid = filters.queueUuid;
      if (filters?.categoryUuid) apiFilters.categoryUuid = filters.categoryUuid;
      if (filters?.status)       apiFilters.status = filters.status;
      if (filters?.dateFrom)     apiFilters.dateFrom = filters.dateFrom;
      if (filters?.dateTo)       apiFilters.dateTo = filters.dateTo;
      if (filters?.staffUuid)    apiFilters.staffUuid = filters.staffUuid;
      if (filters?.companyUuid)  apiFilters.companyUuid = filters.companyUuid;
      try {
        const { data: liveJobs } = await ServiceM8Service.listJobsFiltered(userId, apiFilters);
        jobs = (liveJobs ?? []) as Record<string, unknown>[];
        jobs.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
        console.log(`[SummaryService.getJobs] ✓ live API returned ${jobs.length} job(s) after sort`);
      } catch (err) {
        console.warn(`[SummaryService.getJobs] live API failed, falling back to local DB:`, err);
      }
    }

    // Fallback to local DB if live API returned nothing or was skipped
    if (!hasFilters || jobs.length === 0) {
      console.log(
        hasFilters
          ? `[SummaryService.getJobs] live API returned 0 jobs — falling back to LOCAL_DB`
          : `[SummaryService.getJobs] path=LOCAL_DB  generatedJobId=${generatedJobId ?? "(none)"}`
      );

      // ── DEBUG: check how many rows exist in servicem8_jobs ──
      const { count: totalInTable } = await supabase
        .from("servicem8_jobs")
        .select("*", { count: "exact", head: true });
      const { count: totalForUser } = await supabase
        .from("servicem8_jobs")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);
      console.log(
        `[SummaryService.getJobs] DEBUG  userId="${userId}"  totalRowsInTable=${totalInTable ?? "err"}  rowsForThisUser=${totalForUser ?? "err"}`
      );
      if ((totalForUser ?? 0) === 0 && (totalInTable ?? 0) > 0) {
        const { data: sampleRows } = await supabase
          .from("servicem8_jobs")
          .select("user_id")
          .limit(5);
        console.log(
          `[SummaryService.getJobs] DEBUG  sample user_ids in DB:`,
          sampleRows?.map((r) => r.user_id)
        );
        const { data: integration } = await supabase
          .from("servicem8_integrations")
          .select("user_id, created_at, needs_reauth")
          .eq("user_id", userId)
          .maybeSingle();
        console.log(
          `[SummaryService.getJobs] DEBUG  integration for this user:`,
          integration ?? "NOT FOUND"
        );
      }
      // ── END DEBUG ──

      let query = supabase
        .from("servicem8_jobs")
        .select("*")
        .eq("user_id", userId);

      if (generatedJobId) {
        query = query.eq("generated_job_id", generatedJobId);
      } else {
        if (filters?.status)       query = query.eq("status", filters.status);
        if (filters?.queueUuid)    query = query.eq("queue_uuid", filters.queueUuid);
        if (filters?.categoryUuid) query = query.eq("category_uuid", filters.categoryUuid);
        if (filters?.staffUuid)    query = query.eq("completion_actioned_by_uuid", filters.staffUuid);
        if (filters?.companyUuid)  query = query.eq("company_uuid", filters.companyUuid);
        if (filters?.dateFrom)     query = query.gte("date", filters.dateFrom);
        if (filters?.dateTo)       query = query.lte("date", filters.dateTo);
        if (cursor)                query = query.lt("date", cursor);
        query = query.order("date", { ascending: false, nullsFirst: false }).limit(pageLimit + 1);
      }

      const { data, error } = await query;

      if (error) {
        const apiErr = normalizeDatabaseError(error);
        throw apiErr ?? toApiError(error);
      }

      if (generatedJobId && (!data || data.length === 0)) {
        throw new Error(`Job #${generatedJobId} not found`);
      }

      jobs = (data ?? []) as Record<string, unknown>[];
      console.log(`[SummaryService.getJobs] ✓ local DB returned ${jobs.length} job(s)`);
    }

    if (jobs.length === 0) {
      return { success: true, data: [], meta: { has_more: false, next_cursor: null, total_returned: 0 } };
    }

    const hasMore = !generatedJobId && jobs.length > pageLimit;
    if (hasMore) jobs.pop();
    const nextCursor = hasMore ? (String(jobs[jobs.length - 1]?.date ?? "") || null) : null;

    // Batch-load every related row this job set will need (~2 round-trips)
    // before building blocks — avoids the N×6 query storm that exhausts
    // Supabase connections and cascades into "fetch failed" elsewhere.
    const maps = await SummaryService.preloadJobLookups(userId, jobs);

    const BATCH_SIZE = 50;
    const blocks: JobDetailDataBlock[] = [];
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
      const batchBlocks = await Promise.all(
        jobs.slice(i, i + BATCH_SIZE).map((job) => SummaryService.buildJobDetailBlock(userId, job, undefined, maps))
      );
      blocks.push(...batchBlocks);
    }

    return {
      success: true,
      data: SummaryService.groupBlocksByCustomer(jobs, blocks),
      meta: { has_more: hasMore, next_cursor: nextCursor, total_returned: jobs.length },
    };
  }

  static groupBlocksByCustomer(
    jobs: Row[],
    blocks: JobDetailDataBlock[]
  ): CustomerJobGroup[] {
    const orderMap = new Map<string, number>();
    const result: CustomerJobGroup[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const rawJob = jobs[i] as Row;
      const block = blocks[i] as JobDetailDataBlock;
      const companyKey = (rawJob.company_uuid as string | null) ?? `__solo__${rawJob.uuid as string}`;

      if (!orderMap.has(companyKey)) {
        orderMap.set(companyKey, result.length);
        result.push({
          contact: block.contact,
          site: block.site,
          head_office: block.head_office,
          job_count: block.job.job_count,
          jobs: [],
        });
      }

      const groupIdx = orderMap.get(companyKey) as number;
      const group = result[groupIdx] as CustomerJobGroup;
      const { job_count: _jc, ...jobFields } = block.job;
      group.jobs.push({
        job: jobFields,
        engineer: block.engineer,
        payment: block.payment,
        activities: block.activities,
        jobmaterials: block.jobmaterials,
        notes: block.notes,
      });
    }

    return result;
  }

  static async getAllJobIds(userId: string) {
    const { data: jobs, error } = await supabase
      .from("servicem8_jobs")
      .select("uuid, generated_job_id, job_description, company_uuid, status")
      .eq("user_id", userId)
      .order("generated_job_id", { ascending: true });

    if (error) {
      const apiErr = normalizeDatabaseError(error);
      throw apiErr ?? toApiError(error);
    }
    if (!jobs || jobs.length === 0) return [];

    const companyUUIDs = [
      ...new Set(jobs.map((j) => j.company_uuid).filter(Boolean) as string[]),
    ];

    const companiesRows = companyUUIDs.length > 0
      ? await fetchInChunks(
          companyUUIDs,
          (chunk) => supabase.from("servicem8_site_details").select("uuid, name").in("uuid", chunk),
          "getAllJobIds:companies",
        )
      : [];

    const companyMap = new Map(companiesRows.map((c: Row) => [c.uuid as string, c.name as string]));

    const jobCountByCompany = new Map<string, number>();
    for (const job of jobs) {
      if (job.company_uuid) {
        jobCountByCompany.set(job.company_uuid, (jobCountByCompany.get(job.company_uuid) ?? 0) + 1);
      }
    }

    return jobs.map((job) => ({
      generated_job_id: job.generated_job_id,
      job_name: job.job_description || "No Description",
      customer_name: job.company_uuid
        ? companyMap.get(job.company_uuid) ?? "Unknown"
        : "No Customer",
      status: job.status,
      number_of_jobs: job.company_uuid ? (jobCountByCompany.get(job.company_uuid) ?? 1) : 1,
    }));
  }
}

