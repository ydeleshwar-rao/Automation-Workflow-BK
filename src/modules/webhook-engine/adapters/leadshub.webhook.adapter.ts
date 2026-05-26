import crypto from "crypto";
import axios from "axios";
import type {
  WebhookAdapter,
  WebhookEventNormalized,
  SubscribeResult,
} from "./adapter.interface.js";
import {
  getLocationIdByUserId,
  getValidAccessToken,
} from "../../../common/function.js";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";

// GHL Ed25519 public key for verifying X-GHL-Signature.
// Stable per official GHL marketplace docs; safe to embed.
const GHL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

// Map our codebase's event_key convention (snake_case underscore, matching
// what the polling-engine Leadshub adapter accepts) → GHL's vendor event
// type names (PascalCase). A value can be an array when one frontend trigger
// should fire for multiple GHL event types (e.g. "add_update_opportunity"
// covers both create AND update).
const EVENT_TYPE_MAP: Record<string, string | string[]> = {
  // ─── Existing polling-adapter parity (frontend already uses these) ──────
  "pipeline_stage_changed":  "OpportunityStageUpdate",
  "add_update_opportunity":  ["OpportunityCreate", "OpportunityUpdate"],

  // ─── Additional events available via webhooks ───────────────────────────
  "contact_created":         "ContactCreate",
  "contact_updated":         "ContactUpdate",
  "contact_deleted":         "ContactDelete",
  "contact_tag_updated":     "ContactTagUpdate",
  "opportunity_created":     "OpportunityCreate",
  "opportunity_updated":     "OpportunityUpdate",
  "opportunity_deleted":     "OpportunityDelete",
  "appointment_booked":      "AppointmentCreate",
  "appointment_updated":     "AppointmentUpdate",
  "task_created":            "TaskCreate",
  "task_completed":          "TaskComplete",
  "form_submission":         "FormSubmissionCreate",
  "invoice_created":         "InvoiceCreate",
  "invoice_paid":            "InvoicePaid",
};

// Reverse lookup for the receiver: GHL sends "ContactCreate", we resolve
// back to our internal "contact_created". Array values are flattened so each
// vendor event type points at the same internal key.
const REVERSE_EVENT_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [internal, vendor] of Object.entries(EVENT_TYPE_MAP)) {
    if (Array.isArray(vendor)) {
      for (const v of vendor) m[v] = internal;
    } else {
      m[vendor] = internal;
    }
  }
  return m;
})();

export class LeadshubWebhookAdapter implements WebhookAdapter {
  async subscribe(
    _userId: string,
    eventKey: string,
    _targetUrl: string,
    _config: Record<string, any>
  ): Promise<SubscribeResult> {
    // GHL subscription is configured at the marketplace OAuth-app level — a
    // single webhook URL receives all events for all installed locations. So
    // here we don't make an API call; we just validate that the eventKey is
    // known so the DB row can be created and the receiver can route correctly.
    if (!EVENT_TYPE_MAP[eventKey]) {
      throw new Error(
        `[Leadshub:subscribe] event '${eventKey}' not supported. Add to EVENT_TYPE_MAP.`
      );
    }

    console.log(
      `[Leadshub:subscribe] ✓ event=${eventKey} (no API call — managed at OAuth app level)`
    );

    return {
      // No per-subscription ID; the marketplace app config IS the subscription
      externalSubscriptionId: null,
      // GHL uses Ed25519 with a fixed public key — no per-subscription secret
      signingSecret: null,
    };
  }

  async unsubscribe(
    _userId: string,
    _externalSubscriptionId: string | null
  ): Promise<void> {
    // No-op: marketplace app config remains. Receiver checks subscription row
    // is_active flag to decide whether to dispatch.
  }

  verifyAndNormalize(
    rawBody: string,
    headers: Record<string, string>,
    _signingSecret: string | null
  ): WebhookEventNormalized | null {
    const sigHeader =
      headers["x-ghl-signature"] ||
      headers["X-GHL-Signature"] ||
      headers["x-ghl-Signature"];

    if (!sigHeader || sigHeader === "N/A") {
      console.warn("[Leadshub:verify] missing x-ghl-signature header");
      return null;
    }

    try {
      const ok = crypto.verify(
        null, // null algo — Ed25519 is implied by key type
        Buffer.from(rawBody, "utf8"),
        GHL_PUBLIC_KEY,
        Buffer.from(String(sigHeader), "base64")
      );
      if (!ok) {
        console.warn("[Leadshub:verify] signature verification failed");
        return null;
      }
    } catch (err: any) {
      console.error(`[Leadshub:verify] error: ${err.message}`);
      return null;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn("[Leadshub:verify] invalid JSON body after signature check");
      return null;
    }

    return {
      externalId:
        payload.webhookId ||
        payload.appointment?.id ||
        payload.data?.appointment?.id ||
        payload.id ||
        `${payload.type}-${payload.timestamp}-${payload.locationId ?? ""}`,
      eventType: REVERSE_EVENT_MAP[payload.type] || String(payload.type || "").toLowerCase(),
      data: payload.data || payload,
      receivedAt:
        payload.timestamp ||
        payload.appointment?.dateAdded ||
        payload.data?.appointment?.dateAdded ||
        new Date().toISOString(),
    };
  }
}

/**
 * Helper for the receiver: resolve which subscription a given GHL payload
 * belongs to. GHL sends one stream of webhooks per OAuth app — we use the
 * payload's locationId + event type to find the matching subscription row.
 */
export function getLeadshubLocationIdFromPayload(rawBody: string): string | null {
  try {
    const p = JSON.parse(rawBody);
    return p?.locationId || p?.data?.locationId || p?.location_id || null;
  } catch {
    return null;
  }
}

export function getLeadshubEventKeyFromPayload(rawBody: string): string | null {
  try {
    const t = JSON.parse(rawBody)?.type;
    return t ? (REVERSE_EVENT_MAP[t] || String(t).toLowerCase()) : null;
  } catch {
    return null;
  }
}

// ─── Webhook payload enrichment ─────────────────────────────────────────────
// GHL OpportunityStageUpdate webhook only carries scalar opportunity fields +
// a contactId reference. The workflow needs full opportunity + contact +
// resolved custom fields, all in ONE flat object (no nested `contact`). The
// helpers below fetch + flatten the same way the polling flow used to — but
// kept self-contained here so the webhook path doesn't depend on polling.

type CustomFieldEntry = { id: string; name: string; dataType?: string };

const customFieldCache = new Map<
  string,
  { map: Map<string, CustomFieldEntry>; expiresAt: number }
>();
const CUSTOM_FIELD_TTL_MS = 10 * 60 * 1000;

async function getAuth(
  userId: string
): Promise<{ headers: Record<string, string>; locationId: string }> {
  const locationId = await getLocationIdByUserId(userId);
  const accessToken = await getValidAccessToken(locationId);
  if (!accessToken) {
    throw new Error(
      `[Leadshub:webhook:enrich] Access token not found for location: ${locationId}`
    );
  }
  return {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
    locationId,
  };
}

async function fetchOpportunityById(
  id: string,
  headers: Record<string, string>
): Promise<any | null> {
  try {
    const res = await axios.get(`${GHL_BASE_URL}/opportunities/${id}`, { headers });
    return res.data?.opportunity ?? null;
  } catch (err: any) {
    console.warn(
      `[Leadshub:webhook:enrich] ✖ opportunity fetch failed id=${id} status=${err?.response?.status}`
    );
    return null;
  }
}

async function fetchContactById(
  id: string,
  headers: Record<string, string>
): Promise<any | null> {
  try {
    const res = await axios.get(`${GHL_BASE_URL}/contacts/${id}`, { headers });
    return res.data?.contact ?? null;
  } catch (err: any) {
    console.warn(
      `[Leadshub:webhook:enrich] ✖ contact fetch failed id=${id} status=${err?.response?.status}`
    );
    return null;
  }
}

function formatCommusoftDateTime(value: any): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.slice(0, 19).replace("T", " ");
}

function splitName(contact: any, appointment: any) {
  const firstName = contact?.firstName || contact?.first_name || "";
  const lastName = contact?.lastName || contact?.last_name || "";
  if (firstName || lastName) return { firstName, lastName };

  const fullName = String(contact?.name || appointment?.title || "").trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function flattenAppointmentWithContact(
  appointment: Record<string, any>,
  contact: Record<string, any> | null,
  locationId: string
): Record<string, any> {
  const { firstName, lastName } = splitName(contact, appointment);
  const email = contact?.email || "";
  const phone = contact?.phone || "";
  const address1 = contact?.address1 || appointment?.address || "";
  const city = contact?.city || "";
  const postcode = contact?.postalCode || contact?.postal_code || "";
  const startTime = appointment?.startTime || appointment?.start_time || "";
  const endTime = appointment?.endTime || appointment?.end_time || "";

  return {
    ...appointment,
    locationId,
    appointmentId: appointment?.id || "",
    appointment_id: appointment?.id || "",
    calendarId: appointment?.calendarId || "",
    calendar_id: appointment?.calendarId || "",
    contactId: appointment?.contactId || "",
    contact_id: appointment?.contactId || "",
    appointmentStatus: appointment?.appointmentStatus || "",
    appointment_status: appointment?.appointmentStatus || "",
    assignedUserId: appointment?.assignedUserId || "",
    assigned_user_id: appointment?.assignedUserId || "",
    startTime,
    endTime,
    event_start: formatCommusoftDateTime(startTime),
    event_end: formatCommusoftDateTime(endTime),
    appointment_title: appointment?.title || "",
    appointment_notes: appointment?.notes || "",
    appointment_source: appointment?.source || "",
    contactName: contact?.name || [firstName, lastName].filter(Boolean).join(" "),
    contactFirstName: firstName,
    contactLastName: lastName,
    contactEmail: email,
    contactPhone: phone,
    contactAddress1: address1,
    contactCity: city,
    contactPostalCode: postcode,
    name: firstName,
    surname: lastName,
    email,
    mobile: phone,
    address_line_1: address1,
    town: city,
    postcode,
    job_description:
      appointment?.title ||
      appointment?.notes ||
      `LeadsHub survey booked${startTime ? ` for ${formatCommusoftDateTime(startTime)}` : ""}`,
    description:
      appointment?.title ||
      appointment?.notes ||
      `LeadsHub survey booked${startTime ? ` for ${formatCommusoftDateTime(startTime)}` : ""}`,
    engineer_notes: [
      [firstName, lastName].filter(Boolean).join(" "),
      email,
      phone,
      startTime ? `Appointment: ${formatCommusoftDateTime(startTime)} - ${formatCommusoftDateTime(endTime)}` : "",
      appointment?.notes || "",
    ]
      .filter(Boolean)
      .join(" | "),
    event_type: "job",
    all_day: "false",
  };
}

export async function enrichLeadshubAppointmentWebhook(
  userId: string,
  rawAppointmentPayload: Record<string, any>
): Promise<Record<string, any>> {
  const { headers, locationId } = await getAuth(userId);
  const appointment =
    rawAppointmentPayload?.appointment ||
    rawAppointmentPayload?.data?.appointment ||
    rawAppointmentPayload;
  const contactId = appointment?.contactId || appointment?.contact_id;
  const contact = contactId ? await fetchContactById(contactId, headers) : null;
  return flattenAppointmentWithContact(appointment || {}, contact, locationId);
}

async function getCustomFieldMap(
  locationId: string,
  headers: Record<string, string>
): Promise<Map<string, CustomFieldEntry>> {
  const cached = customFieldCache.get(locationId);
  if (cached && cached.expiresAt > Date.now()) return cached.map;

  try {
    const res = await axios.get(
      `${GHL_BASE_URL}/locations/${locationId}/customFields`,
      { headers }
    );
    const fields: CustomFieldEntry[] = Array.isArray(res.data?.customFields)
      ? res.data.customFields
      : [];
    const map = new Map(fields.map((f) => [f.id, f]));
    customFieldCache.set(locationId, {
      map,
      expiresAt: Date.now() + CUSTOM_FIELD_TTL_MS,
    });
    return map;
  } catch (err: any) {
    console.warn(
      `[Leadshub:webhook:enrich] ✖ custom-field map fetch failed location=${locationId} status=${err?.response?.status}`
    );
    return cached?.map ?? new Map();
  }
}

function slugify(label: string): string {
  return label
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function resolveCustomFields(
  raw: any,
  fieldMap: Map<string, CustomFieldEntry>
): { id: string; label: string | null; value: any }[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((cf: any) => {
    const def = cf?.id ? fieldMap.get(cf.id) : undefined;
    return {
      id: cf?.id,
      label: def?.name ?? cf?.label ?? null,
      value: cf?.value ?? cf?.fieldValue ?? cf?.field_value ?? null,
    };
  });
}

/**
 * Recursively spreads a value into `target` so the final output has zero
 * nested plain objects — every leaf becomes a top-level key.
 *
 *   contactAttributionSource: { sessionSource: "X", medium: "Y" }
 * becomes
 *   "contactAttributionSource.sessionSource": "X"
 *   "contactAttributionSource.medium":        "Y"
 *
 * Arrays are kept as a single value (a tags array stays an array) — splitting
 * those into `tags.0`, `tags.1` would break workflow nodes that expect to
 * iterate them.
 */
function flattenInto(
  target: Record<string, any>,
  key: string,
  value: any
): void {
  if (value === null || value === undefined) {
    target[key] = value;
    return;
  }
  if (Array.isArray(value)) {
    target[key] = value;
    return;
  }
  if (typeof value !== "object") {
    target[key] = value;
    return;
  }
  // Plain object — recurse with dot-joined paths
  const entries = Object.entries(value);
  if (entries.length === 0) {
    target[key] = value;
    return;
  }
  for (const [k, v] of entries) {
    flattenInto(target, `${key}.${k}`, v);
  }
}

function toFlatPayload(
  opp: any,
  contact: any,
  fieldMap: Map<string, CustomFieldEntry>
): Record<string, any> {
  const OPP_DROP = new Set([
    "contact",
    "relations",
    "sort",
    "attributions",
    "isAttribute",
    "internalSource",
    "customFields",
  ]);
  const CONTACT_DROP = new Set([
    "id",
    "locationId",
    "customFields",
    "additionalEmails",
    "additionalPhones",
    "createdBy",
    "firstNameLowerCase",
    "lastNameLowerCase",
    "fullNameLowerCase",
    "emailLowerCase",
    "score",
  ]);

  const flat: Record<string, any> = {};

  for (const [k, v] of Object.entries(opp ?? {})) {
    if (OPP_DROP.has(k)) continue;
    flattenInto(flat, k, v);
  }

  for (const [k, v] of Object.entries(contact ?? {})) {
    if (CONTACT_DROP.has(k)) continue;
    flattenInto(flat, `contact${k.charAt(0).toUpperCase()}${k.slice(1)}`, v);
  }

  for (const cf of resolveCustomFields(opp?.customFields, fieldMap) ?? []) {
    if (cf.label) flattenInto(flat, `cf_${slugify(cf.label)}`, cf.value);
  }
  for (const cf of resolveCustomFields(contact?.customFields, fieldMap) ?? []) {
    if (cf.label) flattenInto(flat, `contactCf_${slugify(cf.label)}`, cf.value);
  }

  return flat;
}

/**
 * Pipeline + stage filter for the webhook receiver. GHL streams every
 * OpportunityStageUpdate for the location regardless of which pipeline the
 * opportunity sits in — so we gate here against the pipelineId/pipelineStageId
 * the user picked when they created the trigger node.
 *
 * Returns true → forward to workflow. Returns false → silently ack and drop.
 */
export function passesPipelineStageFilter(
  payloadData: Record<string, any>,
  triggerConfig: Record<string, any> | null | undefined
): boolean {
  const cfgPipelineId = triggerConfig?.pipelineId;
  const cfgStageId = triggerConfig?.pipelineStageId;
  const incomingPipelineId = payloadData?.pipelineId;
  const incomingStageId = payloadData?.pipelineStageId;

  if (cfgPipelineId && incomingPipelineId !== cfgPipelineId) return false;
  if (cfgStageId && incomingStageId !== cfgStageId) return false;
  return true;
}

/**
 * Core enrichment: turn one raw GHL opportunity payload into the flat shape.
 * Takes pre-resolved auth + (optional) cached fieldMap so callers that process
 * multiple records in a loop pay the auth/customField-fetch cost only once.
 */
async function enrichOpportunityWithAuth(
  rawOpportunity: Record<string, any>,
  headers: Record<string, string>,
  locationId: string,
  fieldMap?: Map<string, CustomFieldEntry>
): Promise<Record<string, any>> {
  const t0 = Date.now();
  const opportunityId = rawOpportunity?.id;
  const contactId =
    rawOpportunity?.contactId ?? rawOpportunity?.contact?.id ?? null;

  console.log(
    `[Leadshub:enrich] ▶ opp=${opportunityId ?? "(missing)"}  contactId=${contactId ?? "(missing)"}  location=${locationId}`
  );

  const map = fieldMap ?? (await getCustomFieldMap(locationId, headers));
  console.log(`[Leadshub:enrich] customField map size=${map.size}`);

  const [fullOpp, fullContact] = await Promise.all([
    opportunityId
      ? fetchOpportunityById(opportunityId, headers)
      : Promise.resolve(null),
    contactId
      ? fetchContactById(contactId, headers)
      : Promise.resolve(null),
  ]);
  console.log(
    `[Leadshub:enrich] fetched  fullOpp=${fullOpp ? "✓" : "✖"}  fullContact=${fullContact ? "✓" : "✖"}`
  );

  const opp = { ...rawOpportunity, ...(fullOpp ?? {}) };
  const contact = { ...(rawOpportunity.contact ?? {}), ...(fullContact ?? {}) };

  const flat = toFlatPayload(opp, contact, map);
  console.log(
    `[Leadshub:enrich] ✓ flattened  keys=${Object.keys(flat).length}  duration=${Date.now() - t0}ms`
  );
  return flat;
}

/**
 * Take the raw GHL OpportunityStageUpdate payload and return a single flat
 * object containing opportunity scalars + contact fields (prefixed `contact*`)
 * + resolved custom fields (`cf_*` and `contactCf_*`). Used as triggerData
 * when a real GHL push event arrives at the webhook receiver.
 */
export async function enrichLeadshubOpportunityWebhook(
  userId: string,
  rawOpportunity: Record<string, any>
): Promise<Record<string, any>> {
  const { headers, locationId } = await getAuth(userId);
  return enrichOpportunityWithAuth(rawOpportunity, headers, locationId);
}

/**
 * Sample-fetch for the "Test Trigger" UI step, owned by the webhook adapter.
 *
 * GHL webhooks have no historical buffer — vendors only push *future* events.
 * So even on the webhook code path, the only way to give the workflow builder
 * a preview is to call GHL's REST API. This function lives in the webhook
 * adapter (not borrowed from polling) so the webhook flow is self-contained:
 *   /opportunities/search → optional stage filter → enrich every record
 *   through enrichLeadshubOpportunityWebhook → return flat single objects.
 *
 * Output shape exactly matches what real webhooks produce after enrichment,
 * so the field-mapping UI sees identical keys regardless of whether the
 * sample came from a Test click or a real GHL push.
 */
export async function fetchLeadshubWebhookSample(
  userId: string,
  eventKey: string,
  config: Record<string, any>,
  limit: number = 3
): Promise<Record<string, any>[]> {
  const t0 = Date.now();
  console.log(
    `\n[Leadshub:webhook:sample] ▶ START  user=${userId}  event=${eventKey}  limit=${limit}  config=${JSON.stringify(config || {})}`
  );

  if (eventKey === "appointment_booked") {
    const { headers, locationId } = await getAuth(userId);
    if (!config?.calendarId) {
      throw new Error("[Leadshub:webhook:sample] calendarId is required for appointment_booked samples");
    }

    const now = Date.now();
    const params = {
      locationId,
      calendarId: config.calendarId,
      startTime: String(now - 30 * 24 * 60 * 60 * 1000),
      endTime: String(now + 60 * 24 * 60 * 60 * 1000),
    };

    let records: any[] = [];
    try {
      const res = await axios.get(`${GHL_BASE_URL}/calendars/events`, {
        headers: { ...headers, Version: "2021-04-15" },
        params,
      });
      records = Array.isArray(res.data?.events) ? res.data.events : [];
      console.log(
        `[Leadshub:webhook:sample] appointments ← /calendars/events returned ${records.length} record(s)  filters=${JSON.stringify(params)}`
      );
    } catch (err: any) {
      console.error(
        `[Leadshub:webhook:sample] ✖ appointment search failed status=${err?.response?.status} body=${JSON.stringify(err?.response?.data)?.slice(0, 300)} message=${err?.message}`
      );
      throw err;
    }

    const newestFirst = records.slice().sort((a: any, b: any) => {
      const keyA = a.dateAdded ?? a.startTime ?? a.dateUpdated;
      const keyB = b.dateAdded ?? b.startTime ?? b.dateUpdated;
      return String(keyB ?? "").localeCompare(String(keyA ?? ""));
    });

    const top = newestFirst.slice(0, limit);
    const enriched = await Promise.all(
      top.map((appointment) =>
        enrichLeadshubAppointmentWebhook(userId, {
          locationId,
          appointment,
        })
      )
    );

    console.log(
      `[Leadshub:webhook:sample] ◀ END appointments  returned=${enriched.length}  duration=${Date.now() - t0}ms\n`
    );
    return enriched;
  }

  if (
    eventKey !== "add_update_opportunity" &&
    eventKey !== "pipeline_stage_changed"
  ) {
    throw new Error(`[Leadshub:webhook:sample] unsupported eventKey: ${eventKey}`);
  }

  const { headers, locationId } = await getAuth(userId);
  console.log(`[Leadshub:webhook:sample] step 1/4 ✓ auth resolved  location=${locationId}`);

  const params: Record<string, any> = { location_id: locationId };
  if (config?.pipelineId) params.pipeline_id = config.pipelineId;
  if (config?.pipelineStageId) params.pipeline_stage_id = config.pipelineStageId;
  if (config?.status) params.status = config.status;

  let records: any[] = [];
  try {
    const res = await axios.get(`${GHL_BASE_URL}/opportunities/search`, {
      headers,
      params,
    });
    records = Array.isArray(res.data?.opportunities) ? res.data.opportunities : [];
    console.log(
      `[Leadshub:webhook:sample] step 2/4 ← /opportunities/search returned ${records.length} record(s)  filters=${JSON.stringify(params)}`
    );
  } catch (err: any) {
    console.error(
      `[Leadshub:webhook:sample] ✖ search failed status=${err?.response?.status} message=${err?.message}`
    );
    throw err;
  }

  // For stage-change events, mirror what the real webhook receiver gates on:
  // only opportunities that actually changed stage, and (if a target stage was
  // configured) that currently sit in it.
  const filtered =
    eventKey === "pipeline_stage_changed"
      ? records.filter((r: any) => {
          if (!r?.lastStageChangeAt) return false;
          if (config?.pipelineStageId && r.pipelineStageId !== config.pipelineStageId)
            return false;
          return true;
        })
      : records;

  console.log(
    `[Leadshub:webhook:sample] step 3/4 stage filter  in=${records.length}  out=${filtered.length}  target_stage=${config?.pipelineStageId ?? "(any)"}`
  );

  if (filtered.length === 0) {
    console.warn(
      `[Leadshub:webhook:sample] ✖ zero records after filter — returning []  duration=${Date.now() - t0}ms\n`
    );
    return [];
  }

  // Sort newest-first so the Test step shows the most recent activity, then
  // cap at `limit`.
  const newestFirst = filtered.slice().sort((a: any, b: any) => {
    const keyA =
      eventKey === "pipeline_stage_changed"
        ? a.lastStageChangeAt ?? a.updatedAt ?? a.createdAt
        : a.updatedAt ?? a.createdAt;
    const keyB =
      eventKey === "pipeline_stage_changed"
        ? b.lastStageChangeAt ?? b.updatedAt ?? b.createdAt
        : b.updatedAt ?? b.createdAt;
    return String(keyB ?? "").localeCompare(String(keyA ?? ""));
  });

  const top = newestFirst.slice(0, limit);
  console.log(
    `[Leadshub:webhook:sample] step 4/4 ▶ enriching top ${top.length} record(s)  ids=[${top.map((r: any) => r.id).join(", ")}]`
  );

  // Auth + customField map resolved ONCE and shared — without this every
  // record would hit `getValidAccessToken` (DB) and `getCustomFieldMap` (HTTP)
  // independently, multiplying the cost of the Test step by `limit`.
  const fieldMap = await getCustomFieldMap(locationId, headers);

  const enriched = await Promise.all(
    top.map((rec) => enrichOpportunityWithAuth(rec, headers, locationId, fieldMap))
  );

  console.log(
    `[Leadshub:webhook:sample] ◀ END  returned=${enriched.length}  duration=${Date.now() - t0}ms\n`
  );
  return enriched;
}
