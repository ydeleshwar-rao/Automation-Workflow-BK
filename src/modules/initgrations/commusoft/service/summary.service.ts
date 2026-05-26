import { supabase } from "../../../../config/db.config.js";
import { normalizeDatabaseError } from "../../../../lib/errors/normalize-database-error.js";
import { toApiError } from "../../../../lib/errors/to-api-error.js";
import { CommusoftService } from "./commusoft.service.js";

export type JobDetailDataBlock = {
  contact: {
    name: string | null;
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

  head_office: {
    name: string | null;
    address: string | null;
  } | null;

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
    job_uuid: string | null;
    job_property_type: string | null;
    job_property_uuid: string | null;
    is_recall: string | null;
    number_of_certificates: string | null;
    job_stage: string | null;
    created_from: string | null;
    job_on_hold_reasons: string | null;
    customer_contract: string | null;
    job_contract: string | null;
    priority: string | null;
  };

  engineer: {
    name: string | null;
    email: string | null;
    mobile: string | null;
    job_title: string | null;
    status_message: string | null;
    last_engineer_on_site: string | null;
    next_engineer_on_site: string | null;
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

  activities: {
    start_date: unknown;
    end_date: unknown;
    scheduled: unknown;
    last_diary_event: string | null;
    next_diary_event: string | null;
    number_of_diary_events: string | null;
  }[];

  jobmaterials: {
    name: string | null;
    quantity: unknown;
    price: unknown;
    total: unknown;
    displayed_amount: unknown;
    cost: unknown;
    displayed_cost: unknown;
  }[];
};

export type CustomerJobGroup = {
  contact: JobDetailDataBlock["contact"];
  site: JobDetailDataBlock["site"];
  head_office: JobDetailDataBlock["head_office"];
  job_count: number;
  jobs: Array<{
    job: JobDetailDataBlock["job"];
    engineer: JobDetailDataBlock["engineer"];
    payment: JobDetailDataBlock["payment"];
    activities: JobDetailDataBlock["activities"];
    jobmaterials: JobDetailDataBlock["jobmaterials"];
  }>;
};


export class CommusoftSummaryService {

  /**
   * Helper - clean "No Numbers Saved" to null
   */
  private static cleanPhone(value: string | null | undefined): string | null {
    if (!value || value.trim() === "No Numbers Saved") return null;
    return value.trim();
  }

  /**
   * Helper - build full address from parts
   */
  private static buildAddress(...parts: (string | null | undefined)[]): string | null {
    const result = parts
      .map(p => p?.trim())
      .filter(p => p && p !== "")
      .join(", ");
    return result || null;
  }

  private static firstNonEmpty(...values: unknown[]): string | null {
    for (const value of values) {
      const text = String(value ?? "").trim();
      if (text) return text;
    }
    return null;
  }

  private static customerKeyFromParts(...values: unknown[]): string | null {
    return CommusoftSummaryService.firstNonEmpty(...values)?.toLowerCase() ?? null;
  }

  private static customerKeyFromBlock(block: JobDetailDataBlock): string {
    return (
      CommusoftSummaryService.customerKeyFromParts(
        block.contact?.email,
        block.contact?.mobile,
        block.contact?.phone,
        block.contact?.name,
        block.site?.address,
      ) ?? `job-${block.job.generated_job_id ?? Math.random().toString(36).slice(2)}`
    );
  }

  private static customerKeyFromRow(row: Record<string, any>): string | null {
    return CommusoftSummaryService.customerKeyFromParts(
      row.email,
      row.emailaddress,
      row["Customer Email"],
      row.mobile,
      row.phone,
      row.landline,
      row.telephonenumber,
      row.name,
      [row.name, row.surname].filter(Boolean).join(" "),
      row.companyname,
      row["Customer Name"],
      row.id,
      row.uuid,
      row.commusoft_id,
    );
  }

  private static mapCustomerRowToGroup(row: Record<string, any>): CustomerJobGroup {
    const firstName = CommusoftSummaryService.firstNonEmpty(row.name, row["Customer Name"], row.company_name, row.companyname);
    const surname = CommusoftSummaryService.firstNonEmpty(row.surname, row.last_name);
    const companyName = CommusoftSummaryService.firstNonEmpty(row.companyname, row.company_name);
    const personName = [row.name, row.surname].filter(Boolean).join(" ").trim();
    const fullName = companyName || personName || [firstName, surname].filter(Boolean).join(" ").trim() || firstName;
    const address = CommusoftSummaryService.buildAddress(
      row.address,
      row["Address Line 1"],
      row.address_line_1,
      row.addressline1,
      row.addressline2,
      row.addressline3,
      row.town,
      row.county,
      row.postcode,
    );

    return {
      contact: {
        name: fullName,
        email: CommusoftSummaryService.firstNonEmpty(row.email, row.emailaddress, row["Customer Email"]),
        phone: CommusoftSummaryService.cleanPhone(
          CommusoftSummaryService.firstNonEmpty(row.phone, row.landline, row.telephonenumber, row["Customer Landline"]),
        ),
        mobile: CommusoftSummaryService.cleanPhone(
          CommusoftSummaryService.firstNonEmpty(row.mobile, row["Customer Mobile"]),
        ),
        type: CommusoftSummaryService.firstNonEmpty(row.customer_type, row.type, row.customertypesid),
        is_primary_contact: null,
      },
      site: {
        name: fullName,
        website: null,
        abn_number: CommusoftSummaryService.firstNonEmpty(row.commusoft_id, row.id, row.uuid, row.contactid),
        address,
        address_street: CommusoftSummaryService.firstNonEmpty(row.address_line_2, row["Address Line 2"]),
        address_city: CommusoftSummaryService.firstNonEmpty(row.town, row.city),
        address_state: CommusoftSummaryService.firstNonEmpty(row.county, row.state),
        address_postcode: CommusoftSummaryService.firstNonEmpty(row.postcode),
        address_country: CommusoftSummaryService.firstNonEmpty(row.country),
        billing_address: address,
        fax_number: null,
      },
      head_office: {
        name: fullName,
        address,
      },
      job_count: 0,
      jobs: [],
    };
  }

  /** Commusoft workflow statuses (not Yes/No from "Is Job Complete"). */
  private static readonly WORKFLOW_STATUSES = new Set([
    "completed",
    "ongoing",
    "on_hold",
    "waiting_for_customer",
    "reserved",
  ]);

  static resolveWorkflowStatus(job: Record<string, any>): string {
    const candidates = [
      job["Job Status"],
      job.job_status,
      job.status,
    ];

    for (const raw of candidates) {
      if (raw == null || String(raw).trim() === "") continue;
      const normalized = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (normalized === "yes" || normalized === "no" || normalized === "in_progress") {
        continue;
      }
      if (CommusoftSummaryService.WORKFLOW_STATUSES.has(normalized)) {
        return normalized;
      }
    }

    if (String(job["Job on hold reasons"] ?? "").trim()) {
      return "on_hold";
    }
    if (String(job["Is Job Complete"] ?? "").trim().toLowerCase() === "yes") {
      return "completed";
    }
    return "ongoing";
  }

  /**
   * Map raw commusoft_jobs table response to JobDetailDataBlock
   */
  static mapToJobDetailBlock(job: Record<string, any>): JobDetailDataBlock {
    return {
      contact: {
        name: job["Contact Name"] ?? null,
        email: job["Customer Email"] ?? null,
        phone: CommusoftSummaryService.cleanPhone(job["Customer Landline"]),
        mobile: CommusoftSummaryService.cleanPhone(job["Customer Mobile"]),
        type: job["Job Property Type"] ?? null,
        is_primary_contact: null
      },

      site: {
        name: job["Job Address Name"] ?? null,
        website: null,
        abn_number: job["Customer.Account.Number"] ?? null,
        address: job["Job Address Line 1"] ?? null,
        address_street: job["Job Address Line 2"] ?? null,
        address_city: job["Job Address Town"] ?? null,
        address_state: job["Job Address County"] ?? null,
        address_postcode: job["Job Address Postcode"] ?? null,
        address_country: null,
        billing_address: job["Customer Address Line 1"] ?? null,
        fax_number: null
      },

      head_office: {
        name: job["Customer Name"] ?? null,
        address: job["Customer Address Line 1"] ?? null
      },

      job: {
        generated_job_id: job["jobId"] ?? job["Job Number"] ?? null,
        status: CommusoftSummaryService.resolveWorkflowStatus(job),
        date: job["Job Date"] ?? null,
        job_address: CommusoftSummaryService.buildAddress(
          job["Job Address Line 1"],
          job["Job Address Line 2"],
          job["Job Address Line 3"],
          job["Job Address Town"],
          job["Job Address County"],
          job["Job Address Postcode"]
        ),
        job_description: job["Job Description"] ?? null,
        work_done_description: job["Job Notes"] ?? null,
        total_invoice_amount: job["Quoted Amount"] ?? null,
        purchase_order_number: job["Customer reference"] ?? null,
        category: job["Business unit"] ?? null,
        quote_date: job["Preferred date"] ?? null,
        completion_date: job["Completed Date"] ?? null,
        job_uuid: job["Job Uuid"] ?? null,
        job_property_type: job["Job Property Type"] ?? null,
        job_property_uuid: job["Job Property Uuid"] ?? null,
        is_recall: job["Is a Recall"] ?? null,
        number_of_certificates: job["Number of certificates"] ?? null,
        job_stage: job["Job stage"] ?? null,
        created_from: job["Created From"] ?? null,
        job_on_hold_reasons: job["Job on hold reasons"] ?? null,
        customer_contract: job["Customer contract"] ?? null,
        job_contract: job["Job contract"] ?? null,
        priority: job["Priority"] ?? null
      },

      engineer: job["Engineer Name"]
        ? {
            name: job["Engineer Name"] ?? null,
            email: job["Job Address Email"] ?? null,
            mobile: CommusoftSummaryService.cleanPhone(job["Job Address Mobile"]),
            job_title: null,
            status_message: job["Last Engineer Mobile Status"] ?? null,
            last_engineer_on_site: job["Last Engineer Name On Site"] ?? null,
            next_engineer_on_site: job["Next Engineer Name On Site"] ?? null
          }
        : null,

      payment: {
        status: job["Number of Invoices Raised"] ?? "0",
        amount: job["Quoted Amount"] ?? null,
        method: null,
        date: job["Completed Date"] ?? null,
        total_invoice: job["Number of Invoices Raised"] ?? null,
        ready_to_invoice: job["Is Job Complete"] === "Yes",
        payments: []
      },

      activities: [
        {
          start_date: job["Last Diary Event"] ?? null,
          end_date: job["Next Diary Event"] ?? null,
          scheduled: job["Number of Diary Events"] ?? null,
          last_diary_event: job["Last Diary Event"] ?? null,
          next_diary_event: job["Next Diary Event"] ?? null,
          number_of_diary_events: job["Number of Diary Events"] ?? null
        }
      ],

      jobmaterials: []
    };
  }

  /**
   * Build job detail block from supabase
   */
  static async buildJobDetailBlock(userId: string): Promise<JobDetailDataBlock[]>;
  static async buildJobDetailBlock(userId: string, jobId: number): Promise<JobDetailDataBlock>;
  static async buildJobDetailBlock(
    userId: string,
    jobId?: number
  ): Promise<JobDetailDataBlock | JobDetailDataBlock[]> {

    if (jobId !== undefined) {
      const { data: job, error } = await supabase
        .from("commusoft_jobs")
        .select("*")
        .eq("user_id", userId)
        .eq("commusoft_id", jobId)
        .maybeSingle();


      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      return CommusoftSummaryService.mapToJobDetailBlock(job);
    }

    const { data: jobs, error } = await supabase
      .from("commusoft_jobs")
      .select("*")
      .eq("user_id", userId)
      .order("Job Date", { ascending: false });

    return (jobs ?? []).map(job => CommusoftSummaryService.mapToJobDetailBlock(job));
  }

  /**
   * Get single job details
   */
  static async getJobDetails(userId: string, jobId: number) {

    const data = await CommusoftSummaryService.buildJobDetailBlock(userId, jobId);

    return {
      success: true,
      data
    };
  }

   static async getAllJobDetails(
    userId: string,
  ){
      const data = await CommusoftSummaryService.buildJobDetailBlock(userId);
       return {
      success: true,
      data
    };
  }

  /**
   * Fetch jobs with full detail blocks, optionally filtered.
   *
   * Filter keys are kept identical to ServiceM8's getJobs so the UI sends
   * the same query params for both integrations.
   *
   * Commusoft API mappings:
   *   status      → status  (ongoing|reserved|on_hold|waiting_for_customer|completed)
   *   dateFrom    → jobCreatedStartDate
   *   dateTo      → jobCreatedEndDate
   *   companyUuid → customerID  (numeric id looked up from commusoft_customers)
   *
   * staffUuid / categoryUuid / queueUuid are accepted but have no Commusoft
   * jobs-API equivalent — they are silently ignored.
   */
  static async getJobs(
    userId: string,
    filters?: {
      queueUuid?: string;
      categoryUuid?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      staffUuid?: string;
      companyUuid?: string;
    },
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    success: true;
    data: CustomerJobGroup[];
    meta: { has_more: boolean; next_cursor: string | null; total_returned: number };
  }> {
    const pageLimit = options?.limit ?? 50;
    const cursor    = options?.cursor;

    let query = supabase
      .from("commusoft_jobs")
      .select("*")
      .eq("user_id", userId);

    // Apply filters directly on local DB — no live Commusoft API call needed
    if (filters?.dateFrom) query = query.gte("Job Date", filters.dateFrom);
    if (filters?.dateTo)   query = query.lte("Job Date", filters.dateTo);
    if (filters?.status) {
      // Commusoft stores completion as "Is Job Complete" = "Yes" / "No"
      query = query.eq("Is Job Complete", filters.status.toLowerCase() === "completed" ? "Yes" : "No");
    }
    // staffUuid / queueUuid / categoryUuid: no matching Commusoft DB column — ignored
    // companyUuid: no direct UUID column in commusoft_jobs — ignored

    if (cursor) query = query.lt("Job Date", cursor);

    query = query
      .order("Job Date", { ascending: false, nullsFirst: false })
      .limit(pageLimit + 1);

    const { data: rows, error } = await query;

    if (error) {
      const apiErr = normalizeDatabaseError(error);
      throw apiErr ?? toApiError(error);
    }

    const jobs = rows ?? [];

    if (jobs.length === 0) {
      return { success: true, data: [], meta: { has_more: false, next_cursor: null, total_returned: 0 } };
    }

    const hasMore    = jobs.length > pageLimit;
    if (hasMore) jobs.pop();
    const nextCursor = hasMore ? (String(jobs[jobs.length - 1]?.["Job Date"] ?? "") || null) : null;

    const blocks = jobs.map((job) => CommusoftSummaryService.mapToJobDetailBlock(job));
    const data = await CommusoftSummaryService.groupBlocksAndCustomersByCustomer(userId, blocks);

    return {
      success: true,
      data,
      meta: { has_more: hasMore, next_cursor: nextCursor, total_returned: jobs.length },
    };
  }

  static groupBlocksByCustomer(blocks: JobDetailDataBlock[]): CustomerJobGroup[] {
    const groups = new Map<string, CustomerJobGroup>();

    for (const block of blocks) {
      const key = CommusoftSummaryService.customerKeyFromBlock(block);

      if (!groups.has(key)) {
        groups.set(key, {
          contact: block.contact,
          site: block.site,
          head_office: block.head_office,
          job_count: 0,
          jobs: [],
        });
      }

      const group = groups.get(key)!;
      group.job_count += 1;
      group.jobs.push({
        job: block.job,
        engineer: block.engineer,
        payment: block.payment,
        activities: block.activities,
        jobmaterials: block.jobmaterials,
      });
    }

    return Array.from(groups.values());
  }

  static async groupBlocksAndCustomersByCustomer(
    userId: string,
    blocks: JobDetailDataBlock[]
  ): Promise<CustomerJobGroup[]> {
    const groups = new Map<string, CustomerJobGroup>();

    for (const group of CommusoftSummaryService.groupBlocksByCustomer(blocks)) {
      const key = CommusoftSummaryService.customerKeyFromParts(
        group.contact?.email,
        group.contact?.mobile,
        group.contact?.phone,
        group.contact?.name,
        group.site?.address,
      ) ?? `group-${groups.size}`;
      groups.set(key, group);
    }

    const { data: customers, error } = await supabase
      .from("commusoft_customers")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      const apiErr = normalizeDatabaseError(error);
      throw apiErr ?? toApiError(error);
    }

    for (const customer of customers ?? []) {
      const key = CommusoftSummaryService.customerKeyFromRow(customer);
      if (!key || groups.has(key)) continue;
      groups.set(key, CommusoftSummaryService.mapCustomerRowToGroup(customer));
    }

    return Array.from(groups.values()).sort((a, b) => {
      const aHasJobs = a.jobs.length > 0 ? 0 : 1;
      const bHasJobs = b.jobs.length > 0 ? 0 : 1;
      if (aHasJobs !== bHasJobs) return aHasJobs - bHasJobs;
      return String(a.contact?.name ?? "").localeCompare(String(b.contact?.name ?? ""));
    });
  }

  /**
   * Get all job details by customer email or phone
   */
  static async getJobDetailsListByEmailOrPhone(
    userId: string,
    email?: string,
    phone?: string
  ) {

    const normalizedEmail = typeof email === "string" ? email.trim() : "";
    // Strip all non-digit characters, then use last 9 digits for flexible matching
    const digitsOnly = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
    const normalizedPhone = digitsOnly.length >= 9 ? `%${digitsOnly.slice(-9)}` : digitsOnly ? `%${digitsOnly}` : "";
//     Input ' 44 7734328664' → digits only: 447734328664 → last 9: 734328664 → query pattern: %734328664
// The ilike with % prefix will match any DB value ending in those digits — covers +44 7734328664, 07734328664, 447734328664, etc.
      if (!normalizedEmail && !normalizedPhone) return { success: true, data: [] };

       let query = supabase
      .from("commusoft_jobs")
      .select("*")
      .eq("user_id", userId)
       if (normalizedEmail && normalizedPhone) {
      query = query.or(
        `Customer Email.ilike.${normalizedEmail},Customer Mobile.ilike.${normalizedPhone}`
      );
    } else if (normalizedEmail) {
      query = query.ilike("Customer Email", normalizedEmail);
    } else {
      query = query.ilike("Customer Mobile", normalizedPhone);
    }
    query = query.order("Job Date", { ascending: false });

    const { data: jobs, error: jobsError } = await query;
    if (jobsError) {
      const apiError = normalizeDatabaseError(jobsError);
      //throw apiError ?? toApiError(jobsError);
      throw jobsError;
    }

    if (!jobs?.length) {
      return {
        success: false,
        message: "No job records found for the provided email or phone.",
        data: []
      };
    }

    const jobDetails: JobDetailDataBlock[] = jobs.map(job =>
      CommusoftSummaryService.mapToJobDetailBlock(job)
    );

    return {
      success: true,
      data: jobDetails
    };
  }

 
}
