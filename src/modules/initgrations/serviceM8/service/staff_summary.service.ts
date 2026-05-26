import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";

export type JobCustomer = {
  name: string | null;
  email: string | null;
  phone: string | null;
  type: string | null;
  address: string | null;
};

export type StaffJobDetail = {
  generated_job_id: string | null;
  status: string | null;
  job_address: string | null;
  billing_address: string | null;
  job_description: string | null;
  quote_date: string | null;
  work_order_date: string | null;
  completion_date: string | null;
  payment_date: string | null;
  payment_method: string | null;
  payment_amount: string | null;
  total_invoice_amount: string | null;
  customer: JobCustomer | null;
};

/**
 * Common staff response shape — reuse this wherever staff info is returned
 * (e.g. ServiceM8, Commonsoft, or any other integration that exposes staff).
 */
export type StaffDetailDataBlock = {
  name: string;
  email: string | null;
  mobile: string | null;
  job_title: string | null;
  total_jobs: number;
  jobs: StaffJobDetail[];
};

export type StaffFilters = {
  jobTitle?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
};

/** Concatenate address parts from servicem8_site_details into one readable string */
function buildAddress(site: Record<string, string | null>): string | null {
  const parts = [
    site.address,
    site.address_street,
    site.address_city,
    site.address_state,
    site.address_postcode,
    site.address_country,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

export class StaffSummaryService {
  static async getStaffs(userId: string, filters: StaffFilters = {}): Promise<StaffDetailDataBlock[]> {
    const { jobTitle, email, phone } = filters;

    // ── When both email AND phone are provided, validate they belong to the same staff ──
    if (email && phone) {
      const { data: byEmail } = await supabase
        .from("servicem8_staff")
        .select("uuid")
        .eq("user_id", userId)
        .eq("email", email)
        .eq("active", 1)
        .maybeSingle();

      const { data: byPhone } = await supabase
        .from("servicem8_staff")
        .select("uuid")
        .eq("user_id", userId)
        .eq("mobile", phone)
        .eq("active", 1)
        .maybeSingle();

      if (!byEmail && !byPhone) {
        throw new ApiError(404, "No staff member found matching the provided email or phone");
      }
      if (!byEmail) {
        throw new ApiError(404, `No staff member found with email: ${email}`);
      }
      if (!byPhone) {
        throw new ApiError(404, `No staff member found with phone: ${phone}`);
      }
      if (byEmail.uuid !== byPhone.uuid) {
        throw new ApiError(
          400,
          "Email and phone do not belong to the same staff member. Please verify the details and try again."
        );
      }
    }

    // ── Build main staff query ──
    let staffQuery = supabase
      .from("servicem8_staff")
      .select("uuid, first, last, email, mobile, job_title")
      .eq("user_id", userId)
      .eq("active", 1);

    if (jobTitle) staffQuery = staffQuery.ilike("job_title", `%${jobTitle}%`);
    if (email)    staffQuery = staffQuery.eq("email", email);
    if (phone)    staffQuery = staffQuery.eq("mobile", phone);

    const { data: staffList, error: staffError } = await staffQuery;

    if (staffError) throw staffError;
    if (!staffList || staffList.length === 0) return [];

    // ── Fetch jobs for each matched staff member ──
    const results: StaffDetailDataBlock[] = await Promise.all(
      staffList.map(async (staff) => {
        const { data: jobs, error: jobsError } = await supabase
          .from("servicem8_jobs")
          .select(
            "generated_job_id, status, job_address, billing_address, job_description, quote_date, work_order_date, completion_date, payment_date, payment_method, payment_amount, total_invoice_amount, company_uuid"
          )
          .eq("user_id", userId)
          .eq("created_by_staff_uuid", staff.uuid)
          .eq("active", 1);

        if (jobsError) throw jobsError;

        // ── Resolve customer details for each job in parallel ──
        const jobDetails: StaffJobDetail[] = await Promise.all(
          (jobs ?? []).map(async (j) => {
            let customer: JobCustomer | null = null;

            if (j.company_uuid) {
              // company_uuid is a globally unique ServiceM8 UUID — no user_id filter needed on contacts/site
              const [{ data: contacts }, { data: site }] = await Promise.all([
                supabase
                  .from("servicem8_contacts")
                  .select("first, last, email, phone, type")
                  .eq("company_uuid", j.company_uuid)
                  .order("is_primary_contact", { ascending: false })
                  .limit(1),
                supabase
                  .from("servicem8_site_details")
                  .select("address, address_street, address_city, address_state, address_postcode, address_country")
                  .eq("uuid", j.company_uuid)
                  .maybeSingle(),
              ]);

              const contact = contacts?.[0] ?? null;

              if (contact) {
                const contactName = [contact.first ?? "", contact.last ?? ""].filter(Boolean).join(" ") || null;
                customer = {
                  name:               contactName,
                  email:              contact.email ?? null,
                  phone:              contact.phone ?? null,
                  type:               contact.type ?? null,
                  address:            site ? buildAddress(site as Record<string, string | null>) : null,
                };
              }
            }

            return {
              generated_job_id:     j.generated_job_id ?? null,
              status:               j.status ?? null,
              job_address:          j.job_address ?? null,
              billing_address:      j.billing_address ?? null,
              job_description:      j.job_description ?? null,
              quote_date:           j.quote_date ?? null,
              work_order_date:      j.work_order_date ?? null,
              completion_date:      j.completion_date ?? null,
              payment_date:         j.payment_date ?? null,
              payment_method:       j.payment_method ?? null,
              payment_amount:       j.payment_amount != null ? String(j.payment_amount) : null,
              total_invoice_amount: j.total_invoice_amount != null ? String(j.total_invoice_amount) : null,
              customer,
            };
          })
        );

        const name = [staff.first ?? "", staff.last ?? ""].filter(Boolean).join(" ") || "Unknown";

        return {
          name,
          email:      staff.email ?? null,
          mobile:     staff.mobile ?? null,
          job_title:  staff.job_title ?? null,
          total_jobs: jobDetails.length,
          jobs:       jobDetails,
        };
      })
    );

    return results;
  }
}
