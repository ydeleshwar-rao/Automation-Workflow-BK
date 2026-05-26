import { supabase } from "../../../../config/db.config.js";
import { IncomingHttpHeaders } from "http";
import { randomBytes, randomUUID } from "crypto";
import { executeWorkflow, findWorkflowByWebhookId } from "../../../workflow-automation/processor/webhookProcessor.js";
import { webhookLogger as log } from "../../../../utils/logger.js";


export async function createWebhookService({
  name,
  action_type,
  user_id,
  workflow_id,
}: {
  name: string;
  user_id: string;
  action_type: string;
  workflow_id: string;
}) {
  try {
    const baseUrl = process.env.BASE_URL || "http://localhost:5000";

    const uniquePath = randomBytes(8).toString("hex");

    const { data, error } = await supabase
      .from("webhooks")
      .insert({
        user_id,
        name,
        unique_path: uniquePath,
        full_url: `${baseUrl}/api/webhooks/${uniquePath}`,
        action_type,
        workflow_id,
        status: "active",
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    const { id, full_url } = data;

    log.info("WEBHOOK CREATED", {
      webhook_id: id,
      name,
      url: full_url,
      path: uniquePath,
      workflow_id,
      user_id,
      mode: "test",
    });

    return { id, full_url };

  } catch (error: any) {
    log.error("create webhook failed", { error: error?.message, name, workflow_id });
    throw new Error(error?.message || "Webhook creation failed");
  }
}


export async function processIncomingWebhook({
  hookPath,
  headers,
  body,
}: {
  hookPath: string;
  headers: IncomingHttpHeaders;
  body: unknown;
 }) {
  const cleanPath = hookPath.trim().toLowerCase();
  const bodyObj = body as Record<string, any>;

  log.info("INCOMING", {
    path: cleanPath,
    email: bodyObj?.email ?? bodyObj?.contact?.email ?? "",
    name: bodyObj?.firstname ?? bodyObj?.firstName ?? bodyObj?.full_name ?? bodyObj?.name ?? "",
    phone: bodyObj?.phone ?? bodyObj?.mobile ?? "",
    fields: Object.keys(bodyObj ?? {}).length,
    userAgent: (headers["user-agent"] ?? "").slice(0, 60),
  });

  // ── STEP 2: Look up webhook in DB ─────────────────────────────────────────────
  const { data: webhook, error } = await supabase
    .from("webhooks")
    .select("*")
    .eq("unique_path", cleanPath)
    .eq("status", "active")
    .is("deleted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .single();

  if (error || !webhook) {
    log.error("webhook not found", { path: cleanPath, error: error?.message ?? "no data" });
    throw new Error("Webhook not found or inactive");
  }

  log.info("webhook resolved", { webhook_id: webhook.id, name: webhook.name, mode: webhook.mode });

  const cleanHeaders = JSON.parse(JSON.stringify(headers ?? {}));
  const cleanBody = JSON.parse(JSON.stringify(body ?? {}));

  // ── STEP 3: Save incoming event to webhook_events ─────────────────────────────
  const { data: event, error: eventError } = await supabase
    .from("webhook_events")
    .insert({
      webhook_id: webhook.id,
      request_headers: cleanHeaders,
      request_body: cleanBody,
      status: "pending",
    })
    .select()
    .single();

  if (eventError) {
    log.error("event save failed", { webhook_id: webhook.id, error: eventError.message });
    throw new Error(eventError.message);
  }

  log.info("event saved", { event_id: event.id, webhook_id: event.webhook_id, mode: webhook.mode });

  // ── STEP 4: Update last_triggered_at ─────────────────────────────────────────
  await supabase
    .from("webhooks")
    .update({ last_triggered_at: new Date().toISOString() })
    .eq("id", webhook.id);

  // ── STEP 5: Route by mode ─────────────────────────────────────────────────────
  if (webhook.mode === "live") {
    const result = await findWorkflowByWebhookId(webhook.id);

    if (result) {
      log.info("executing workflow", { workflow_id: result.workflowId, event_id: event.id, webhook_id: webhook.id });
      executeWorkflow(result.workflowId, cleanBody).then(async ({ success, error: execError }) => {
        if (success) {
          await recordWebhookAttempt(event.id, 200, null);
          await supabase.from("webhook_events").update({ status: "processed", processed_at: new Date().toISOString() }).eq("id", event.id);
          log.info("END — processed", { event_id: event.id, workflow_id: result.workflowId });
        } else {
          await recordWebhookAttempt(event.id, 500, execError ?? "Unknown error");
          await supabase.from("webhook_events").update({ status: "failed" }).eq("id", event.id);
          log.error("END — workflow failed", { event_id: event.id, workflow_id: result.workflowId, error: execError });
        }
      }).catch(async (err) => {
        log.error("END — unexpected error", { event_id: event.id, error: err.message });
        await recordWebhookAttempt(event.id, 500, err.message);
        await supabase.from("webhook_events").update({ status: "failed" }).eq("id", event.id);
      });
    } else {
      log.warn("no active workflow linked", { webhook_id: webhook.id });
    }

  } else if (webhook.mode === "test") {
    log.info("TEST mode — saving sample payload", { webhook_id: webhook.id });

    const { data: triggerNode, error: triggerNodeError } = await supabase
      .from("workflow_nodes")
      .select("id")
      .eq("type", "trigger")
      .eq("integration_key", "webhooks")
      .contains("config", { webhook_id: webhook.id })
      .maybeSingle();

    if (triggerNodeError) {
      log.warn("trigger node lookup error", { webhook_id: webhook.id, error: triggerNodeError.message });
    } else if (!triggerNode) {
      log.warn("no trigger node found", { webhook_id: webhook.id });
    } else {
      const outputSchema = Object.keys(cleanBody).reduce<Record<string, null>>((acc, key) => ({ ...acc, [key]: null }), {});
      const { error: saveError } = await supabase
        .from("workflow_nodes")
        .update({ sample_payload: cleanBody, output_schema: outputSchema, updated_at: new Date().toISOString() })
        .eq("id", triggerNode.id);

      if (saveError) {
        log.error("sample payload save failed", { node_id: triggerNode.id, error: saveError.message });
      } else {
        log.info("sample payload saved", { node_id: triggerNode.id, fields: Object.keys(cleanBody) });
      }
    }
  }

  log.info("DONE", { event_id: event.id, webhook_id: webhook.id, mode: webhook.mode });
  return event;
}


export async function getWebhookByIdService(
  webhookId: string
){
  try {
    const { data, error } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("webhook_id", webhookId)
      .order("received_at", { ascending: false })
//.limit(1)
      .single();

    if (error) throw error;
    const {id,webhook_id,request_body} = data
  return {id,webhook_id,request_body};
  } catch (error: any) {
    throw new Error(error);
  }
   
}

export async function getNextPendingWebhookEvent(
  webhookId: string
) {
  const { data, error } = await supabase
    .from("webhook_events")
    .select("*")
    .eq("webhook_id", webhookId)
    .eq("status", "pending") // 🔥 MOST IMPORTANT
    .order("received_at", { ascending: true }) // oldest first
  

  if (error) throw new Error(error.message);
 return data?.map(({ id, webhook_id, request_body }) => ({
  id,
  webhook_id,
  request_body,
}));

}



export async function markWebhookEventProcessed(eventId: string) {
  const { error } = await supabase
    .from("webhook_events")
    .update({
      status: "processed",
      processed_at: new Date()
    })
    .eq("id", eventId);

  if (error) throw new Error(error.message);
}

// ── Record one attempt into webhook_attempts ──────────────────────────────────
async function recordWebhookAttempt(
  eventId: string,
  responseStatus: number,
  errorMessage: string | null
): Promise<void> {
  // Derive the next attempt_no from how many attempts already exist for this event
  const { count } = await supabase
    .from("webhook_attempts")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId);

  const attemptNo = (count ?? 0) + 1;

  const { error } = await supabase
    .from("webhook_attempts")
    .insert({
      event_id: eventId,
      attempt_no: attemptNo,
      response_status: responseStatus,
      error_message: errorMessage,
    });

  if (error) {
    log.error("attempt record failed", { event_id: eventId, error: error.message });
  } else {
    log.debug("attempt recorded", { event_id: eventId, attempt: attemptNo, status: responseStatus });
  }
}


export async function updateWebhookService(
  id: string,
  updates: {
    mode?: "test"| "live";
    status?: "active" | "disabled";
    request_body?: any;
  }
) {
  // Update webhook_events.request_body when provided
  if (updates.request_body !== undefined) {
    const { data, error: eventError } = await supabase
      .from("webhook_events")
      .update({ request_body: updates.request_body })
      .eq("id", id)
      .select();
    if (eventError) throw new Error(eventError.message);
    return data;
  }

  // Update webhook mode / status
  const updateData: any = {
    updated_at: new Date().toISOString(),
  };

  if (updates.mode) {
    updateData.mode = updates.mode;
    if (updates.mode === "live") {
      updateData.expires_at = null;
    }
  }

  if (updates.status) {
    updateData.status = updates.status;
  }

  const { data, error } = await supabase
    .from("webhooks")
    .update(updateData)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}