import axios from "axios";
import type {
  WebhookAdapter,
  WebhookEventNormalized,
  SubscribeResult,
} from "./adapter.interface.js";
import { getServiceM8Headers } from "../../initgrations/serviceM8/service/serviceM8.service.js";

const SM8_BASE = "https://api.servicem8.com";
const SM8_API_BASE = "https://api.servicem8.com/api_1.0";

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

// Map our codebase's event_key convention → ServiceM8's actual vendor event
// names (dot-notation per their API docs).
//
// Naming alias note: the codebase has both styles for "creation" events:
//   • Frontend trigger UI sends:   create_job, create_client
//   • Polling adapter expects:     new_job, new_client
// We accept BOTH so the webhook adapter is drop-in compatible regardless of
// which style the caller uses.
const EVENT_MAP: Record<string, string> = {
  // ─── Frontend trigger dropdown (today's exposed events) ─────────────────
  "job_completed":      "job.completed",
  "job_queued":         "job.queued",
  "create_job":         "job.created",
  "create_client":      "company.created",

  // ─── Polling-adapter aliases (backend symmetry) ─────────────────────────
  "new_job":            "job.created",
  "new_client":         "company.created",
  "new_form_response":  "form.response_created",

  // ─── Additional events available only via webhooks ──────────────────────
  // (Not yet exposed in frontend dropdown — add to fields.ts when ready)
  "job_created":        "job.created",
  "job_updated":        "job.updated",
  "job_status_changed": "job.status_changed",
  "job_checked_in":     "job.checked_in",
  "job_checked_out":    "job.checked_out",
  "job_note_added":     "job.note_added",
  "job_photo_added":    "job.photo_added",
  "job_video_added":    "job.video_added",
  "job_badge_added":    "job.badge_added",
  "job_badge_removed":  "job.badge_removed",
  "job_invoice_paid":   "job.invoice_paid",
  "job_invoice_sent":   "job.invoice_sent",
  "job_quote_sent":     "job.quote_sent",
  "job_quote_accepted": "job.quote_accepted",
  "job_review_received":"job.review_received",
  "company_updated":    "company.updated",
  "inbox_message_received": "inbox.message_received",
  "proposal_sent":      "proposal.sent",
  "proposal_viewed":    "proposal.viewed",
  "staff_clocked_on":   "staff.clocked_on",
  "staff_clocked_off":  "staff.clocked_off",
};

export class ServiceM8WebhookAdapter implements WebhookAdapter {
  async subscribe(
    userId: string,
    eventKey: string,
    targetUrl: string,
    _config: Record<string, any>
  ): Promise<SubscribeResult> {
    const sm8Event = EVENT_MAP[eventKey];
    if (!sm8Event) {
      throw new Error(
        `[SM8:subscribe] event '${eventKey}' not supported. Add to EVENT_MAP.`
      );
    }

    const headers = await getServiceM8Headers(userId);

    console.log(
      `[SM8:subscribe] ▶ user=${userId} event=${sm8Event} target=${targetUrl}`
    );

    const response = await axios.post(
      `${SM8_BASE}/webhook_subscriptions/event`,
      new URLSearchParams({
        event:        sm8Event,
        callback_url: targetUrl,
      }).toString(),
      {
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept":       "application/json",
        },
      }
    );

    const body = response.data;
    const subId =
      body?.uuid ??
      body?.subscription_id ??
      body?.id ??
      null;

    if (!subId) {
      console.warn(
        `[SM8:subscribe] ⚠ no subscription id in response — body=${JSON.stringify(body)}`
      );
    }

    console.log(`[SM8:subscribe] ✓ subscribed sub=${subId}`);

    return {
      externalSubscriptionId: subId ? String(subId) : null,
      // ServiceM8 doesn't use HMAC — payload includes a fresh accessToken proving
      // the call originated from ServiceM8. Origin verification happens via
      // accountUUID match in the receiver.
      signingSecret: null,
    };
  }

  async unsubscribe(
    userId: string,
    externalSubscriptionId: string | null
  ): Promise<void> {
    if (!externalSubscriptionId) return;

    const headers = await getServiceM8Headers(userId);

    try {
      await axios.delete(
        `${SM8_BASE}/webhook_subscriptions/event/${externalSubscriptionId}`,
        { headers }
      );
      console.log(`[SM8:unsubscribe] ✓ removed sub=${externalSubscriptionId}`);
    } catch (err: any) {
      // 404 = already gone; safe to swallow
      if (err?.response?.status === 404) {
        console.log(
          `[SM8:unsubscribe] sub=${externalSubscriptionId} already deleted on vendor`
        );
        return;
      }
      throw err;
    }
  }

  verifyAndNormalize(
    rawBody: string,
    _headers: Record<string, string>,
    _signingSecret: string | null
  ): WebhookEventNormalized | null {
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn("[SM8:verify] invalid JSON body");
      return null;
    }

    // ─── Format A: Current ServiceM8 production payload ────────────────────
    // Verified live: { id: "smwe_<uuid>", type: "job.completed",
    //                  data: {...full object...}, related: {...} }
    // Auth model: URL secrecy. The target_path segment in our callback URL is
    // a 32-char hex random that we generated and only ServiceM8 received during
    // subscribe — anyone hitting it is presumed to be ServiceM8.
    if (typeof payload.id === "string" && typeof payload.type === "string" && payload.data) {
      return {
        externalId: payload.id, // e.g. "smwe_aeb1f39a-e925-4ffa-9ea4-241dcbb4b49b"
        eventType:  payload.type, // e.g. "job.completed"
        data: {
          // Spread full object so workflow steps map fields directly
          ...payload.data,
          // Keep related blob (company, jobContacts) accessible for mapping
          _related: payload.related ?? null,
        },
        receivedAt:
          payload.data.completion_date ||
          payload.data.edit_date ||
          new Date().toISOString(),
      };
    }

    // ─── Format B: Legacy/docs sample format (kept for forward-compat) ─────
    // { eventName: "webhook_subscription", auth: {...}, eventArgs: {...} }
    if (
      payload.eventName === "webhook_subscription" &&
      payload.eventArgs?.entry?.[0]
    ) {
      const auth = payload.auth;
      const ea = payload.eventArgs;
      const entry = ea.entry[0];

      return {
        externalId: `${entry.uuid}-${entry.time}-${(entry.changed_fields || [])
          .slice()
          .sort()
          .join(",")}`,
        eventType: ea.object,
        data: {
          uuid:           entry.uuid,
          changed_fields: entry.changed_fields,
          time:           entry.time,
          resource_url:   ea.resource_url,
          _auth: auth
            ? {
                accountUUID:       auth.accountUUID,
                staffUUID:         auth.staffUUID,
                accessToken:       auth.accessToken,
                accessTokenExpiry: auth.accessTokenExpiry,
              }
            : null,
        },
        receivedAt: entry.time || new Date().toISOString(),
      };
    }

    console.warn(
      `[SM8:verify] payload did not match known formats — keys=${Object.keys(payload).join(",")}`
    );
    return null;
  }
}

// For new_job / job_completed / job_queued webhooks: fetch the company and its
// first companycontact then flat-merge with the job payload. Strips _related —
// workflow mapper expects flat key/value only. Job fields win on conflicts
// (uuid, edit_date) so the cursor/idempotency logic stays intact.
export async function enrichServiceM8JobWebhook(
  userId: string,
  jobData: Record<string, any>
): Promise<Record<string, any>> {
  const { _related, ...flatJob } = jobData ?? {};

  let headers: Record<string, string>;
  try {
    headers = await getServiceM8Headers(userId);
  } catch (err: any) {
    console.warn(`[SM8:enrichJobWebhook] header fetch failed user=${userId}: ${err?.message}`);
    return flatJob;
  }

  // Format B (legacy webhook) only sends {uuid, changed_fields, resource_url}
  // without full job fields. Fetch the full job object so we have company_uuid.
  if (!flatJob.company_uuid && flatJob.uuid) {
    const jobRes = await axios
      .get(`${SM8_API_BASE}/job/${flatJob.uuid}.json`, { headers })
      .catch((err) => {
        console.warn(
          `[SM8:enrichJobWebhook] ✖ job fetch failed uuid=${flatJob.uuid} status=${err?.response?.status}`
        );
        return null;
      });

    if (jobRes?.data) {
      Object.assign(flatJob, jobRes.data);
    }
  }

  const companyUuid = flatJob.company_uuid;
  if (!companyUuid) {
    console.warn(`[SM8:enrichJobWebhook] no company_uuid in payload — returning raw job`);
    return flatJob;
  }

  const [companyRes, contactsRes] = await Promise.all([
    axios
      .get(`${SM8_API_BASE}/company/${companyUuid}.json`, { headers })
      .catch((err) => {
        console.warn(
          `[SM8:enrichJobWebhook] ✖ company fetch failed uuid=${companyUuid} status=${err?.response?.status}`
        );
        return null;
      }),
    axios
      .get(`${SM8_API_BASE}/companycontact.json`, {
        headers,
        params: { $filter: `company_uuid eq '${companyUuid}'` },
      })
      .catch((err) => {
        console.warn(
          `[SM8:enrichJobWebhook] ✖ contacts fetch failed uuid=${companyUuid} status=${err?.response?.status}`
        );
        return null;
      }),
  ]);

  const company = companyRes?.data ?? {};
  const contactList = Array.isArray(contactsRes?.data) ? contactsRes.data : [];
  const contact = contactList[0] ?? {};

  console.log(
    `[SM8:enrichJobWebhook] ✓ enriched job=${flatJob.uuid}  company=${companyUuid}  contacts_found=${contactList.length}`
  );

  // Schema-first: all fields present even when blank. Job wins last.
  return { ...COMPANY_SCHEMA, ...CONTACT_SCHEMA, ...JOB_SCHEMA, ...company, ...contact, ...flatJob };
}

// For new_client (company.created) webhook: fetch the first companycontact for
// the new company and flat-merge so the runtime payload matches the shape the
// polling adapter's fetchSample produces. Strips the nested _related blob —
// workflow mapper expects flat key/value only. Company fields win on conflicts
// (uuid, edit_date) to match the polling cursor convention.
export async function enrichServiceM8CompanyWebhook(
  userId: string,
  companyData: Record<string, any>
): Promise<Record<string, any>> {
  const { _related, ...flatCompany } = companyData ?? {};
  const companyUuid = flatCompany.uuid;
  if (!companyUuid) {
    console.warn(`[SM8:enrichWebhook] no uuid in payload — returning raw data`);
    return flatCompany;
  }

  let headers: Record<string, string>;
  try {
    headers = await getServiceM8Headers(userId);
  } catch (err: any) {
    console.warn(
      `[SM8:enrichWebhook] header fetch failed user=${userId}: ${err?.message}`
    );
    return flatCompany;
  }

  const contactsRes = await axios
    .get(`${SM8_API_BASE}/companycontact.json`, {
      headers,
      params: { $filter: `company_uuid eq '${companyUuid}'` },
    })
    .catch((err) => {
      console.warn(
        `[SM8:enrichWebhook] ✖ contacts fetch failed company_uuid=${companyUuid} status=${err?.response?.status}`
      );
      return null;
    });

  const contactList = Array.isArray(contactsRes?.data) ? contactsRes.data : [];
  const contact = contactList[0] ?? {};

  console.log(
    `[SM8:enrichWebhook] ✓ enriched company=${companyUuid} contacts_found=${contactList.length}`
  );

  // Schema-first: all fields present even when blank. Company wins last.
  return { ...COMPANY_SCHEMA, ...CONTACT_SCHEMA, ...contact, ...flatCompany };
}
