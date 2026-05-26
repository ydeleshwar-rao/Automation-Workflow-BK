import axios from "axios";
import crypto from "crypto";
import type {
  WebhookAdapter,
  WebhookEventNormalized,
  SubscribeResult,
} from "./adapter.interface.js";
import { getSimproContext } from "../../initgrations/simpro/service/simpro.service.js";

/**
 * Simpro webhook adapter.
 *
 * Subscription endpoint (per-tenant):
 *   POST   {baseUrl}/api/v1.0/companies/{companyId}/setup/webhooks/
 *   DELETE {baseUrl}/api/v1.0/companies/{companyId}/setup/webhooks/{id}/
 *   body: { Name, CallbackURL, Events: [...], Status: "Enabled" }
 *
 * Auth model: Simpro signs webhook deliveries with HMAC-SHA256 using a
 * per-subscription secret returned in the create response (`Secret`). The
 * signature arrives in the `X-Simpro-Signature` header.
 *
 * Map our internal event_keys → Simpro vendor event names. Simpro's docs use
 * dotted lowercase form (job.created, job.stage.complete, job.status, etc.).
 * Aliases keep us drop-in compatible with the polling adapter's event_key vocabulary.
 */

const EVENT_MAP: Record<string, string | string[]> = {
  // ─── Job triggers ───────────────────────────────────────────────────────────
  "new_job":                 "job.created",
  "job_stage_pending":       "job.stage.pending",
  "job_stage_in_progress":   "job.stage.progress",
  "job_stage_complete":      "job.stage.complete",
  "job_stage_invoiced":      "job.stage.invoiced",
  "job_stage_archived":      "job.stage.archived",
  "job_status_changed":      "job.status",

  // ─── Quote triggers ─────────────────────────────────────────────────────────
  "new_quote":               "quote.created",
  "quote_accepted":          "quote.status",   // handler must filter to Accepted status
  "quote_status_changed":    "quote.status",

  // ─── Customer triggers ──────────────────────────────────────────────────────
  "new_company_customer":    "company.customer.created",
  "new_individual_customer": "individual.customer.created",

  // ─── Lead triggers ──────────────────────────────────────────────────────────
  "new_lead":                "lead.created",
  "lead_status_changed":     "lead.status",

  // ─── Invoice / Payment triggers ─────────────────────────────────────────────
  "invoice_created":         "invoice.created",
  "payment_received":        "payment.created",

  // ─── Customer update triggers ───────────────────────────────────────────────
  "company_customer_updated":    "company.customer.updated",
  "individual_customer_updated": "individual.customer.updated",

  // ─── Job update trigger ──────────────────────────────────────────────────
  "job_updated":             "job.updated",

  // ─── Schedule triggers ───────────────────────────────────────────────────
  "new_schedule":            "schedule.created",
  "schedule_updated":        "schedule.updated",

  // ─── Site triggers ───────────────────────────────────────────────────────
  "new_site":                "site.created",
  "site_updated":            "site.updated",

  // ─── Quote update trigger ─────────────────────────────────────────────────
  "quote_updated":           "quote.updated",

  // ─── Backward-compat aliases (old keys still accepted) ──────────────────────
  "job_completed":           "job.stage.complete",   // was wrongly "job.completed"
  "new_client":              ["company.customer.created", "individual.customer.created"],
  "new_customer":            ["company.customer.created", "individual.customer.created"],
  "new_invoice":             "invoice.created",
  "invoice_paid":            "payment.created",      // was wrongly "invoice.paid"
};

export class SimproWebhookAdapter implements WebhookAdapter {
  async subscribe(
    userId: string,
    eventKey: string,
    targetUrl: string,
    _config: Record<string, any>
  ): Promise<SubscribeResult> {
    const vendorEventOrEvents = EVENT_MAP[eventKey];
    if (!vendorEventOrEvents) {
      throw new Error(
        `[Simpro:subscribe] event '${eventKey}' not supported. Add to EVENT_MAP.`
      );
    }
    const events = Array.isArray(vendorEventOrEvents)
      ? vendorEventOrEvents
      : [vendorEventOrEvents];

    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/setup/webhooks/`;

    console.log(
      `[Simpro:subscribe] ▶ user=${userId}  events=[${events.join(",")}]  target=${targetUrl}`
    );

    const body = {
      Name:        `wf_${eventKey}_${Date.now()}`,
      CallbackURL: targetUrl,
      Events:      events,
      Status:      "Enabled",
    };

    let response;
    try {
      response = await axios.post(url, body, { headers });
    } catch (err: any) {
      console.error(
        `[Simpro:subscribe] ✖ ${url}  status=${err?.response?.status}  body=${JSON.stringify(err?.response?.data)?.slice(0, 400)}`
      );
      throw err;
    }

    const data = response.data ?? {};
    const subId =
      data.ID ?? data.id ?? data.WebhookID ?? data.webhook_id ?? null;
    const secret = data.Secret ?? data.secret ?? null;

    console.log(
      `[Simpro:subscribe] ✓ sub=${subId}  hasSecret=${!!secret}`
    );

    return {
      externalSubscriptionId: subId ? String(subId) : null,
      // If Simpro didn't return a per-subscription secret, fall back to a
      // locally generated one so DB row is consistent. Verification will fail
      // until a real secret is configured — log loudly so it's noticed.
      signingSecret: secret ?? crypto.randomBytes(32).toString("hex"),
    };
  }

  async unsubscribe(
    userId: string,
    externalSubscriptionId: string | null
  ): Promise<void> {
    if (!externalSubscriptionId) return;

    const { headers, baseUrl, companyId } = await getSimproContext(userId);
    const url = `${baseUrl}/api/v1.0/companies/${companyId}/setup/webhooks/${externalSubscriptionId}/`;

    try {
      await axios.delete(url, { headers });
      console.log(`[Simpro:unsubscribe] ✓ removed sub=${externalSubscriptionId}`);
    } catch (err: any) {
      // 404 = already gone vendor-side; safe to swallow.
      if (err?.response?.status === 404) {
        console.log(`[Simpro:unsubscribe] sub=${externalSubscriptionId} already deleted`);
        return;
      }
      console.error(
        `[Simpro:unsubscribe] ✖ status=${err?.response?.status}  message=${err?.message}`
      );
      throw err;
    }
  }

  verifyAndNormalize(
    rawBody: string,
    headers: Record<string, string>,
    signingSecret: string | null
  ): WebhookEventNormalized | null {
    if (!signingSecret) {
      console.warn("[Simpro:verify] no signing secret stored — refusing");
      return null;
    }

    const sig =
      headers["x-simpro-signature"] ||
      headers["X-Simpro-Signature"] ||
      headers["x-signature"];

    if (!sig) {
      console.warn("[Simpro:verify] no signature header");
      return null;
    }

    const computed = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody, "utf8")
      .digest("hex");

    let ok = false;
    try {
      const a = Buffer.from(computed);
      const b = Buffer.from(String(sig));
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      ok = false;
    }
    if (!ok) {
      console.warn(`[Simpro:verify] signature mismatch  expected=${computed.slice(0, 12)}…  got=${String(sig).slice(0, 12)}…`);
      return null;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn("[Simpro:verify] invalid JSON body after signature check");
      return null;
    }

    // Simpro payload shape (based on docs):
    //   { ID, Event, Reference, Data: {...full record...}, DateTriggered }
    const externalId =
      payload.ID ||
      payload.id ||
      payload.EventID ||
      `${payload.Event ?? "unknown"}-${payload.DateTriggered ?? Date.now()}`;

    return {
      externalId: String(externalId),
      eventType:  String(payload.Event || payload.event || "unknown"),
      data:       payload.Data ?? payload.data ?? payload,
      receivedAt: payload.DateTriggered || payload.timestamp || new Date().toISOString(),
    };
  }
}
