import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/db.config.js";
import { webhookLogger as log } from "../../utils/logger.js";
import { getWebhookAdapter } from "./adapters/adapter.registry.js";
import {
  getLeadshubLocationIdFromPayload,
  getLeadshubEventKeyFromPayload,
  passesPipelineStageFilter,
  enrichLeadshubOpportunityWebhook,
  enrichLeadshubAppointmentWebhook,
} from "./adapters/leadshub.webhook.adapter.js";
import { enrichServiceM8CompanyWebhook, enrichServiceM8JobWebhook } from "./adapters/serviceM8.webhook.adapter.js";
import { executeWorkflow } from "../workflow-automation/processor/webhookProcessor.js";
import { CommusoftService } from "../initgrations/commusoft/service/commusoft.service.js";

function pickFirst(...values: any[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function formatCommusoftDateTime(value: any): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.slice(0, 19).replace("T", " ");
}

function splitName(fullName: string): { name: string; surname: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    name: parts[0] || "Leadshub",
    surname: parts.slice(1).join(" ") || "Calendar Booking",
  };
}

/**
 * Two receiver shapes:
 *   POST /api/webhooks-receiver/integrations/:integrationKey/:targetPath
 *     → Per-subscription URL (ServiceM8, Commusoft)
 *
 *   POST /api/webhooks-receiver/integrations/:integrationKey
 *     → OAuth-app-level URL (GHL/Leadshub) — lookup via locationId in payload
 */
export async function receiveIntegrationWebhook(
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const { integrationKey, targetPath } = req.params as {
    integrationKey: string;
    targetPath?: string;
  };

  log.info("START", {
    integration: integrationKey,
    targetPath: targetPath ?? "oauth-app-level",
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  const rawBody: string = (req as any).rawBody || JSON.stringify(req.body || {});
  const bodyObj: Record<string, any> = (() => { try { return JSON.parse(rawBody); } catch { return {}; } })();
  log.info("payload received", {
    integration: integrationKey,
    bytes: rawBody.length,
    type: bodyObj?.type ?? bodyObj?.event ?? bodyObj?.eventType ?? "unknown",
    contactName: bodyObj?.full_name ?? bodyObj?.fullName ?? bodyObj?.name ?? bodyObj?.contact?.name ?? "",
    email: bodyObj?.email ?? bodyObj?.contact?.email ?? "",
    locationId: bodyObj?.locationId ?? bodyObj?.location_id ?? "",
  });

  const adapter = getWebhookAdapter(integrationKey);
  if (!adapter) {
    log.warn("no adapter registered", { integration: integrationKey });
    return res
      .status(404)
      .json({ error: `No adapter registered for integration: ${integrationKey}` });
  }

  // ─── 1. Resolve subscription ─────────────────────────────────────────────
  let subscription: any = null;

  if (targetPath) {
    // Per-subscription URL path
    const { data } = await supabase
      .from("integration_webhook_subscriptions")
      .select("*")
      .eq("integration_key", integrationKey)
      .eq("target_path", targetPath)
      .maybeSingle();
    subscription = data;
  } else if (integrationKey === "leadshub") {
    // OAuth-app-level: dispatch by locationId + event type
    const locationId = getLeadshubLocationIdFromPayload(rawBody);
    const eventKey = getLeadshubEventKeyFromPayload(rawBody);
    if (!locationId || !eventKey) {
      return res
        .status(400)
        .json({ error: "Missing locationId or event type in payload" });
    }

    // A single GHL location can have multiple active leadshub_integrations
    // rows (e.g. admin-impersonation flow where different selected users have
    // independently connected the same location). The "latest updated" row is
    // not necessarily the one that owns the workflow subscription. So:
    //   1. Collect ALL active integration users for this location.
    //   2. Find the active subscription for this event whose user_id is among
    //      those users — that user is the actual subscription owner.
    const { data: integrationRows } = await supabase
      .from("leadshub_integrations")
      .select("user_id")
      .eq("location_id", locationId)
      .eq("is_active", true);

    const userIds = (integrationRows ?? [])
      .map((r: any) => r.user_id)
      .filter(Boolean);

    log.info("leadshub lookup", { locationId, eventKey, candidateUsers: userIds.length, userIds });

    if (userIds.length > 0) {
      const { data: subRow, error: subLookupErr } = await supabase
        .from("integration_webhook_subscriptions")
        .select("*")
        .eq("integration_key", "leadshub")
        .eq("event_key", eventKey)
        .in("user_id", userIds)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (subLookupErr) {
        log.error("DB error during subscription lookup", { error: subLookupErr.message });
      }
      subscription = subRow ?? null;

      if (!subscription) {
        const { data: allSubs } = await supabase
          .from("integration_webhook_subscriptions")
          .select("id, event_key, is_active, user_id, workflow_id, created_at")
          .eq("integration_key", "leadshub")
          .in("user_id", userIds);

        log.warn("no subscription matched", {
          eventKey,
          userIds,
          allSubsCount: allSubs?.length ?? 0,
          allSubs: allSubs ?? [],
        });
      }
    } else {
      log.warn("no active leadshub_integrations rows", { locationId });
    }
  }

  if (!subscription) {
    log.warn("no matching subscription found — returning 410", { integration: integrationKey, targetPath });
    return res.status(410).json({ error: "Subscription not found or inactive" });
  }

  if (!subscription.is_active) {
    log.warn("subscription paused", { sub: subscription.id });
    return res.status(410).json({ error: "Subscription is paused" });
  }

  log.info("subscription resolved", {
    sub: subscription.id,
    workflow: subscription.workflow_id,
    event: subscription.event_key,
    user: subscription.user_id,
  });

  // ─── 2. Verify + normalize ───────────────────────────────────────────────
  const normalized = adapter.verifyAndNormalize(
    rawBody,
    req.headers as Record<string, string>,
    subscription.signing_secret
  );
  if (!normalized) {
    log.warn("signature verification failed", { sub: subscription.id });
    return res.status(401).json({ error: "Signature verification failed" });
  }

  log.info("signature verified", {
    sub: subscription.id,
    externalId: normalized.externalId,
    eventType: normalized.eventType,
  });

  // ─── 2b. Pipeline + stage filter (Leadshub stage-change trigger) ─────────
  // GHL streams every OpportunityStageUpdate for the location regardless of
  // pipeline. The trigger node was configured with a specific pipelineId +
  // pipelineStageId (stored on subscription.config) — drop events that don't
  // match. Ack with 200 so GHL doesn't retry.
  if (
    integrationKey === "leadshub" &&
    subscription.event_key === "pipeline_stage_changed" &&
    !passesPipelineStageFilter(normalized.data, subscription.config)
  ) {
    log.info("pipeline/stage filter MISMATCH — dropping", {
      sub: subscription.id,
      cfgPipelineId: subscription.config?.pipelineId,
      cfgStageId: subscription.config?.pipelineStageId,
      payloadPipelineId: normalized.data?.pipelineId,
      payloadStageId: normalized.data?.pipelineStageId,
    });
    return res.status(200).json({
      status: "skipped",
      reason: "pipeline/stage mismatch with subscription config",
    });
  }
  log.debug("pipeline+stage filter PASSED", { sub: subscription.id });

  // ─── 2c. Queue + category filter (ServiceM8 job_queued / job_completed) ───
  // ServiceM8 fires job.queued for every queue and job.completed for every job.
  // The user may have configured specific queue_uuid and/or category_uuid
  // filters on the trigger node (stored in subscription.config). Drop events
  // that don't match either filter — ack 200 so SM8 stops retrying.
  if (integrationKey === "service_m8") {
    const cfgQueue    = subscription.config?.queue_uuid    || null;
    const cfgCategory = subscription.config?.category_uuid || null;

    if (cfgQueue) {
      const payloadQueue = normalized.data?.queue_uuid;
      if (payloadQueue && payloadQueue !== cfgQueue) {
        log.info("SM8 queue filter MISMATCH — dropping", { sub: subscription.id, cfgQueue, payloadQueue });
        return res.status(200).json({ status: "skipped", reason: "queue_uuid mismatch" });
      }
      log.debug("SM8 queue filter PASSED", { sub: subscription.id, queue_uuid: payloadQueue });
    }

    if (cfgCategory) {
      const payloadCategory = normalized.data?.category_uuid;
      if (payloadCategory && payloadCategory !== cfgCategory) {
        log.info("SM8 category filter MISMATCH — dropping", { sub: subscription.id, cfgCategory, payloadCategory });
        return res.status(200).json({ status: "skipped", reason: "category_uuid mismatch" });
      }
      log.debug("SM8 category filter PASSED", { sub: subscription.id, category_uuid: payloadCategory });
    }
  }

  // ─── 3. Idempotency check ────────────────────────────────────────────────
  const { data: dup } = await supabase
    .from("webhook_event_log")
    .select("id")
    .eq("subscription_id", subscription.id)
    .eq("external_event_id", normalized.externalId)
    .maybeSingle();

  if (dup) {
    log.info("DUPLICATE event — skipping", { externalId: normalized.externalId, log_id: dup.id, sub: subscription.id });
    return res.status(200).json({ status: "duplicate", id: dup.id });
  }

  // ─── 4. Log event (insert FIRST — protects against retry races) ──────────
  const { data: logRow, error: logErr } = await supabase
    .from("webhook_event_log")
    .insert({
      subscription_id:   subscription.id,
      external_event_id: normalized.externalId,
      event_type:        normalized.eventType,
      payload:           normalized.data,
      status:            "received",
    })
    .select()
    .single();

  if (logErr || !logRow) {
    log.error("event log insert failed", { error: logErr?.message, sub: subscription.id });
    return res.status(500).json({ error: "Internal logging error" });
  }

  res.status(200).json({ status: "accepted", id: logRow.id });
  log.info("event accepted", { log_id: logRow.id, sub: subscription.id, externalId: normalized.externalId });

  // ─── 6. Verify workflow is active before executing ───────────────────────
  const { data: workflow } = await supabase
    .from("workflows")
    .select("status")
    .eq("id", subscription.workflow_id)
    .maybeSingle();

  if (!workflow || workflow.status !== "active") {
    log.warn("workflow not active — skipping execution", {
      workflow: subscription.workflow_id,
      status: workflow?.status ?? "missing",
      log_id: logRow.id,
    });
    await supabase
      .from("webhook_event_log")
      .update({
        status:       "failed",
        error:        `Workflow not active (status=${workflow?.status ?? "missing"})`,
        processed_at: new Date().toISOString(),
      })
      .eq("id", logRow.id);
    return;
  }
  log.debug("workflow active", { workflow: subscription.workflow_id });

  const needsLeadshubEnrichment =
    integrationKey === "leadshub" &&
    subscription.event_key === "pipeline_stage_changed";

  const needsLeadshubAppointmentEnrichment =
    integrationKey === "leadshub" &&
    subscription.event_key === "appointment_booked";

  const needsServiceM8CompanyEnrichment =
    integrationKey === "service_m8" &&
    subscription.event_key === "new_client";

  const SM8_JOB_EVENTS = ["new_job", "job_completed", "job_queued", "create_job", "job_created", "job_quote_sent", "job_quote_accepted"];
  const needsServiceM8JobEnrichment =
    integrationKey === "service_m8" &&
    SM8_JOB_EVENTS.includes(subscription.event_key);

  const enrichmentType = needsLeadshubEnrichment ? "leadshub_opportunity"
    : needsLeadshubAppointmentEnrichment ? "leadshub_appointment"
    : needsServiceM8CompanyEnrichment ? "sm8_company"
    : needsServiceM8JobEnrichment ? "sm8_job"
    : "none";

  log.info("enrichment", { type: enrichmentType, event: subscription.event_key, sub: subscription.id });

  const triggerDataPromise: Promise<Record<string, any>> = needsLeadshubEnrichment
    ? enrichLeadshubOpportunityWebhook(subscription.user_id, normalized.data)
        .then((flat) => {
          log.info("enrichment done", { type: "leadshub_opportunity", keys: Object.keys(flat).length, sub: subscription.id });
          return flat;
        })
        .catch((err: any) => {
          log.warn("enrichment failed — falling back to raw payload", { type: "leadshub_opportunity", error: err.message, sub: subscription.id });
          return normalized.data;
        })
    : needsLeadshubAppointmentEnrichment
    ? enrichLeadshubAppointmentWebhook(subscription.user_id, normalized.data)
        .then((flat) => {
          log.info("enrichment done", { type: "leadshub_appointment", keys: Object.keys(flat).length, sub: subscription.id });
          return flat;
        })
        .catch((err: any) => {
          log.warn("enrichment failed — falling back to raw payload", { type: "leadshub_appointment", error: err.message, sub: subscription.id });
          return normalized.data;
        })
    : needsServiceM8CompanyEnrichment
    ? enrichServiceM8CompanyWebhook(subscription.user_id, normalized.data)
        .then((flat) => {
          log.info("enrichment done", { type: "sm8_company", keys: Object.keys(flat).length, sub: subscription.id });
          return flat;
        })
        .catch((err: any) => {
          log.warn("enrichment failed — falling back to raw payload", { type: "sm8_company", error: err.message, sub: subscription.id });
          return normalized.data;
        })
    : needsServiceM8JobEnrichment
    ? enrichServiceM8JobWebhook(subscription.user_id, normalized.data)
        .then((flat) => {
          log.info("enrichment done", { type: "sm8_job", keys: Object.keys(flat).length, sub: subscription.id });
          return flat;
        })
        .catch((err: any) => {
          log.warn("enrichment failed — falling back to raw payload", { type: "sm8_job", error: err.message, sub: subscription.id });
          return normalized.data;
        })
    : Promise.resolve(normalized.data);

  triggerDataPromise
    .then((triggerData) => {
      log.info("executing workflow", { workflow: subscription.workflow_id, log_id: logRow.id });
      return executeWorkflow(subscription.workflow_id, triggerData);
    })
    .then(async () => {
      await supabase
        .from("webhook_event_log")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("id", logRow.id);
      await supabase
        .from("integration_webhook_subscriptions")
        .update({
          last_received_at: new Date().toISOString(),
          total_received: (subscription.total_received || 0) + 1,
          error_count: 0,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", subscription.id);
      log.info("END — processed", { log_id: logRow.id, workflow: subscription.workflow_id, integration: integrationKey });
    })
    .catch(async (err: any) => {
      log.error("END — workflow execution failed", {
        log_id: logRow.id,
        workflow: subscription.workflow_id,
        integration: integrationKey,
        error: err.message,
      });
      await supabase
        .from("webhook_event_log")
        .update({
          status:       "failed",
          error:        err.message,
          processed_at: new Date().toISOString(),
        })
        .eq("id", logRow.id);
      await supabase
        .from("integration_webhook_subscriptions")
        .update({
          error_count: (subscription.error_count || 0) + 1,
          last_error:  err.message,
          updated_at:  new Date().toISOString(),
        })
        .eq("id", subscription.id);
    });
}

/**
 * Receiver for GoHighLevel sub-account Workflow → Webhook action.
 *
 * This is intentionally separate from the Marketplace app webhook receiver:
 * sub-account workflow webhooks are user-configured POSTs and do not include
 * GHL's Ed25519 signature header. For local testing, the locationId query/body
 * maps the request back to the connected Leadshub + Commusoft user.
 */
export async function receiveLeadshubWorkflowAppointment(
  req: Request,
  res: Response
) {
  const body: any = req.body || {};
  const contact = body.contact || body.contactData || body.customer || body;
  const appointment = body.appointment || body.appointmentData || body.calendar || body;

  const locationId = pickFirst(
    req.query.locationId,
    body.locationId,
    body.location_id,
    appointment.locationId,
    appointment.location_id
  );

  if (!locationId) {
    return res.status(400).json({
      success: false,
      message: "locationId is required in the URL query string or JSON body",
    });
  }

  const { data: integrations, error: integrationError } = await supabase
    .from("leadshub_integrations")
    .select("user_id, location_id, updated_at")
    .eq("location_id", locationId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (integrationError) {
    return res.status(500).json({
      success: false,
      message: `Failed to look up Leadshub integration: ${integrationError.message}`,
    });
  }

  const userId = integrations?.[0]?.user_id;
  if (!userId) {
    return res.status(404).json({
      success: false,
      message: `No active Leadshub integration found for locationId ${locationId}`,
    });
  }

  const firstName = pickFirst(
    body.firstName,
    body.first_name,
    contact.firstName,
    contact.first_name,
    body.name
  );
  const lastName = pickFirst(
    body.lastName,
    body.last_name,
    contact.lastName,
    contact.last_name,
    body.surname
  );
  const fallbackName = splitName(
    pickFirst(body.fullName, body.full_name, contact.name, appointment.title)
  );

  const customerName = firstName || fallbackName.name;
  const customerSurname = lastName || fallbackName.surname;
  const email = pickFirst(body.email, contact.email);
  const mobile = pickFirst(body.phone, body.mobile, contact.phone, contact.mobile);
  const addressLine1 = pickFirst(
    body.address_line_1,
    body.address1,
    body.address,
    contact.address1,
    contact.address,
    "Address to confirm at survey"
  );
  const town = pickFirst(body.town, body.city, contact.city);
  const postcode = pickFirst(
    body.postcode,
    body.postalCode,
    body.postal_code,
    contact.postalCode,
    contact.postal_code
  );
  const eventStart = formatCommusoftDateTime(
    pickFirst(
      body.event_start,
      body.startTime,
      body.start_time,
      body.appointmentStart,
      appointment.startTime,
      appointment.start_time
    )
  );
  const eventEnd = formatCommusoftDateTime(
    pickFirst(
      body.event_end,
      body.endTime,
      body.end_time,
      body.appointmentEnd,
      appointment.endTime,
      appointment.end_time
    )
  );
  const resourceId = pickFirst(
    req.query.commusoftResourceId,
    body.commusoftResourceId,
    body.resource_id,
    body.resourceId,
    "1"
  );
  const description = pickFirst(
    body.description,
    body.job_description,
    appointment.title,
    "LeadsHub survey booked"
  );

  if (!eventStart || !eventEnd) {
    return res.status(400).json({
      success: false,
      message: "event_start/startTime and event_end/endTime are required",
    });
  }

  try {
    const customer = await CommusoftService.createCustomer(userId, {
      customer_type: pickFirst(body.customer_type, "Private customer"),
      name: customerName,
      surname: customerSurname,
      email,
      mobile,
      country_code: pickFirst(body.country_code, "44"),
      address_line_1: addressLine1,
      town,
      postcode,
    });

    const customerId = String(
      typeof customer === "number" || typeof customer === "string"
        ? customer
        : customer?.id ?? customer?.customer_id ?? customer?.customerId ?? ""
    );

    if (!customerId) {
      throw new Error(`Commusoft customer created but no customer id was returned: ${JSON.stringify(customer)}`);
    }

    const job = await CommusoftService.createJob(userId, {
      customer_id: customerId,
      description,
    });

    const jobId = String(job?.jobId ?? job?.id ?? job?.job_id ?? "");
    if (!jobId) {
      throw new Error(`Commusoft job created but no job id was returned: ${JSON.stringify(job)}`);
    }

    const engineerNotes = [
      `${customerName} ${customerSurname}`.trim(),
      email,
      mobile,
      `Appointment: ${eventStart} - ${eventEnd}`,
      pickFirst(body.notes, body.appointment_notes, appointment.notes),
    ]
      .filter(Boolean)
      .join(" | ");

    const diaryEvent = await CommusoftService.createDiaryEvent(userId, {
      event_type: "job",
      description,
      engineer_notes: engineerNotes || description,
      event_start: eventStart,
      event_end: eventEnd,
      all_day: "false",
      resource_id: resourceId,
      job_id: jobId,
      access_notes: pickFirst(body.access_notes, body.notes, appointment.notes),
    });

    return res.status(201).json({
      success: true,
      message: "Leadshub appointment created in Commusoft",
      data: {
        customerId,
        jobId,
        diaryEvent,
        eventStart,
        eventEnd,
        resourceId,
      },
    });
  } catch (err: any) {
    log.error("LeadshubWorkflowAppointment failed", {
      status: err?.response?.status,
      message: err?.message,
      body: JSON.stringify(err?.response?.data)?.slice(0, 500),
    });
    return res.status(err?.response?.status || 500).json({
      success: false,
      message:
        err?.response?.data?.message ||
        err?.message ||
        "Failed to create Commusoft appointment",
      errors: err?.response?.data || null,
    });
  }
}
