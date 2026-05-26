import axios from "axios";
import type { PollingAdapter, PollResult } from "./adapter.interface.js";
import { getServiceM8Headers } from "../../initgrations/serviceM8/service/serviceM8.service.js";

const SERVICEM8_BASE_URL = "https://api.servicem8.com/api_1.0";

// Full field schemas — ServiceM8 omits keys entirely when values are empty.
// Spreading these first ensures every field is always present in the output
// (as null) so the workflow field-mapper can show and pre-select all fields
// even when the test record has blanks.
const COMPANY_SCHEMA: Record<string, null> = {
  uuid: null, name: null, active: null, edit_date: null,
  abn_number: null, is_individual: null, parent_company_uuid: null,
  address: null, address_street: null, address_city: null,
  address_state: null, address_postcode: null, address_country: null,
  billing_address: null, billing_attention: null,
  phone: null, fax_number: null, website: null,
  badges: null, tax_rate_uuid: null, payment_terms: null,
  notes: null, category_uuid: null,
};

const CONTACT_SCHEMA: Record<string, null> = {
  uuid: null, company_uuid: null, first: null, last: null,
  email: null, phone: null, mobile: null, type: null,
  is_primary_contact: null, active: null, edit_date: null,
};

const JOB_SCHEMA: Record<string, null> = {
  uuid: null, active: null, edit_date: null, status: null,
  date: null, company_uuid: null,
  job_address: null, billing_address: null, job_description: null,
  work_done_description: null, generated_job_id: null,
  created_by_staff_uuid: null, completion_actioned_by_uuid: null,
  completion_date: null, unsuccessful_date: null,
  category_uuid: null, queue_uuid: null,
  queue_expiry_date: null, queue_assigned_staff_uuid: null,
  lat: null, lng: null,
  geo_is_valid: null, geo_country: null, geo_postcode: null,
  geo_state: null, geo_city: null, geo_street: null, geo_number: null,
  total_invoice_amount: null, payment_processed: null,
  payment_processed_stamp: null, payment_received: null,
  payment_received_stamp: null, payment_date: null,
  payment_actioned_by_uuid: null, payment_method: null,
  payment_amount: null, payment_note: null,
  invoice_sent: null, invoice_sent_stamp: null,
  ready_to_invoice: null, ready_to_invoice_stamp: null,
  purchase_order_number: null,
  quote_date: null, quote_sent: null, quote_sent_stamp: null,
  work_order_date: null, job_is_scheduled_until_stamp: null,
  badges: null, active_network_request_uuid: null,
  related_knowledge_articles: null,
};

interface QueryConfig {
  endpoint: string;
  filter: string | undefined;
}

export class ServiceM8PollingAdapter implements PollingAdapter {
  async poll(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    cursorValue: string | null
  ): Promise<PollResult[]> {
    const headers = await getServiceM8Headers(userId);
    const { endpoint, filter } = this.buildQuery(eventKey, config, cursorValue);

    const url = `${SERVICEM8_BASE_URL}/${endpoint}`;
    const params: Record<string, string> = {};
    if (filter) params["$filter"] = filter;

    const response = await axios.get(url, { headers, params });
    const records: any[] = response.data;

    if (!Array.isArray(records)) return [];

    const filtered = records
      .filter((r) => r.uuid && r.edit_date)
      .sort((a, b) => a.edit_date.localeCompare(b.edit_date));

    const JOB_EVENTS = ["new_job", "job_completed", "job_queued", "job_quote_sent", "job_quote_accepted"];
    const enriched =
      JOB_EVENTS.includes(eventKey)
        ? await Promise.all(
            filtered.map((r) => this.enrichWithContacts(r, headers))
          )
        : eventKey === "new_client"
        ? await Promise.all(
            filtered.map((r) => this.enrichCompanyWithContact(r, headers))
          )
        : filtered;

    return enriched.map((record: Record<string, any>) => ({
      externalId: record.uuid,
      data: record,
      cursorValue: record.edit_date,
    }));
  }

  async fetchSample(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    limit: number = 3
  ): Promise<Record<string, any>[]> {
    console.log(
      `[SM8:fetchSample] ▶ event=${eventKey}  user=${userId}  limit=${limit}  config=${JSON.stringify(config)}`
    );

    const headers = await getServiceM8Headers(userId);
    const { endpoint, filter } = this.buildQuery(eventKey, config, null);

    const url = `${SERVICEM8_BASE_URL}/${endpoint}`;
    const params: Record<string, string> = {};
    if (filter) params["$filter"] = filter;

    console.log(
      `[SM8:fetchSample] → GET ${url}  $filter=${filter || "(none)"}`
    );

    let response;
    try {
      response = await axios.get(url, { headers, params });
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      console.error(
        `[SM8:fetchSample] ✖ API request failed  status=${status}  body=${JSON.stringify(body)}  message=${err?.message}`
      );
      throw err;
    }

    const records: any[] = response.data;

    if (!Array.isArray(records)) {
      console.warn(
        `[SM8:fetchSample] ✖ response is not an array  type=${typeof records}  body=${JSON.stringify(records)?.slice(0, 200)}`
      );
      return [];
    }

    console.log(`[SM8:fetchSample] ← received ${records.length} record(s)`);

    if (records.length === 0) {
      console.warn(
        `[SM8:fetchSample] ✖ zero records matched  event=${eventKey}  filter=${filter || "(none)"}  → try relaxing the filter or verify that data exists in ServiceM8`
      );
      return [];
    }

    const samples = records
      .sort((a, b) => (b.edit_date || "").localeCompare(a.edit_date || ""))
      .slice(0, limit);

    const JOB_EVENTS = ["new_job", "job_completed", "job_queued", "job_quote_sent", "job_quote_accepted"];
    const enriched =
      JOB_EVENTS.includes(eventKey)
        ? await Promise.all(
            samples.map((r) => this.enrichWithContacts(r, headers))
          )
        : eventKey === "new_client"
        ? await Promise.all(
            samples.map((r) => this.enrichCompanyWithContact(r, headers))
          )
        : samples;

    console.log(
      `[SM8:fetchSample] ✓ returning ${enriched.length} sample(s)  first_uuid=${enriched[0]?.uuid}  first_edit_date=${enriched[0]?.edit_date}`
    );
    return enriched;
  }

  private async enrichWithContacts(
    job: Record<string, any>,
    headers: Record<string, string>
  ): Promise<Record<string, any>> {
    const companyUuid = job.company_uuid;
    if (!companyUuid) return job;

    const [companyRes, contactsRes] = await Promise.all([
      axios
        .get(`${SERVICEM8_BASE_URL}/company/${companyUuid}.json`, { headers })
        .catch((err) => {
          console.warn(
            `[SM8:enrich] ✖ company fetch failed  uuid=${companyUuid}  status=${err?.response?.status}`
          );
          return null;
        }),
      axios
        .get(`${SERVICEM8_BASE_URL}/companycontact.json`, {
          headers,
          params: { $filter: `company_uuid eq '${companyUuid}'` },
        })
        .catch((err) => {
          console.warn(
            `[SM8:enrich] ✖ contacts fetch failed  company_uuid=${companyUuid}  status=${err?.response?.status}`
          );
          return null;
        }),
    ]);

    const company = companyRes?.data ?? {};
    const contactList = Array.isArray(contactsRes?.data) ? contactsRes.data : [];
    const contact = contactList[0] ?? {};

    // Schema-first merge: null defaults ensure every field is visible in the
    // workflow mapper even when the test record has blank values. Job wins last.
    return { ...COMPANY_SCHEMA, ...CONTACT_SCHEMA, ...JOB_SCHEMA, ...company, ...contact, ...job };
  }

  // For new_client trigger: the record IS the company. Fetch its first contact
  // and flat-merge so test sample matches the shape produced by the webhook
  // adapter's enrichment path. Company's uuid/edit_date must win for cursor.
  private async enrichCompanyWithContact(
    company: Record<string, any>,
    headers: Record<string, string>
  ): Promise<Record<string, any>> {
    const companyUuid = company.uuid;
    if (!companyUuid) return company;

    const contactsRes = await axios
      .get(`${SERVICEM8_BASE_URL}/companycontact.json`, {
        headers,
        params: { $filter: `company_uuid eq '${companyUuid}'` },
      })
      .catch((err) => {
        console.warn(
          `[SM8:enrichCompany] ✖ contacts fetch failed  company_uuid=${companyUuid}  status=${err?.response?.status}`
        );
        return null;
      });

    const contactList = Array.isArray(contactsRes?.data) ? contactsRes.data : [];
    const contact = contactList[0] ?? {};

    // Schema-first: all company+contact fields present even when blank.
    // Company wins last (uuid/edit_date cursor integrity).
    return { ...COMPANY_SCHEMA, ...CONTACT_SCHEMA, ...contact, ...company };
  }

  private buildQuery(
    eventKey: string,
    config: Record<string, any>,
    cursor: string | null
  ): QueryConfig {
    const filters: string[] = [];

    if (cursor) {
      filters.push(`edit_date gt '${cursor}'`);
    }

    switch (eventKey) {
      case "job_completed":
        filters.push("status eq 'Completed'");
        if (config.category_uuid)
          filters.push(`category_uuid eq '${config.category_uuid}'`);
        if (config.queue_uuid)
          filters.push(`queue_uuid eq '${config.queue_uuid}'`);
        return { endpoint: "job.json", filter: filters.join(" and ") };

      case "job_queued":
        // ServiceM8 has no literal status "Queued" — a job is "in a queue"
        // when it carries a queue_uuid. Filter on the uuid(s) only.
        if (config.queue_uuid)
          filters.push(`queue_uuid eq '${config.queue_uuid}'`);
        if (config.category_uuid)
          filters.push(`category_uuid eq '${config.category_uuid}'`);
        return {
          endpoint: "job.json",
          filter: filters.length > 0 ? filters.join(" and ") : undefined,
        };

      case "job_quote_sent":
        // Jobs where a quote has been sent to the client.
        // quote_sent_stamp updates when the quote is emailed — edit_date cursor
        // catches the change on subsequent polls.
        filters.push("quote_sent eq 1");
        if (config.category_uuid)
          filters.push(`category_uuid eq '${config.category_uuid}'`);
        return { endpoint: "job.json", filter: filters.join(" and ") };

      case "job_quote_accepted":
        // A quote is "accepted" when the client approves and the job converts
        // to Work Order status. work_order_date is set at that moment and
        // edit_date is bumped, so the cursor picks it up cleanly.
        filters.push("status eq 'Work Order'");
        if (config.category_uuid)
          filters.push(`category_uuid eq '${config.category_uuid}'`);
        if (config.queue_uuid)
          filters.push(`queue_uuid eq '${config.queue_uuid}'`);
        return { endpoint: "job.json", filter: filters.join(" and ") };

      case "new_job":
        return {
          endpoint: "job.json",
          filter: filters.length > 0 ? filters.join(" and ") : undefined,
        };

      case "new_client":
        return {
          endpoint: "company.json",
          filter: filters.length > 0 ? filters.join(" and ") : undefined,
        };

      case "new_form_response":
        return {
          endpoint: "formresponse.json",
          filter: filters.length > 0 ? filters.join(" and ") : undefined,
        };

      default:
        throw new Error(`Unknown ServiceM8 event: ${eventKey}`);
    }
  }
}
