import crypto from "crypto";
import { supabase } from "../../config/db.config.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  getWebhookAdapter,
  supportsWebhook,
} from "./adapters/adapter.registry.js";
import { fetchLeadshubWebhookSample } from "./adapters/leadshub.webhook.adapter.js";
import { getAdapter as getPollingAdapter } from "../polling-engine/adapters/adapter.registry.js";

// ─── Config ─────────────────────────────────────────────────────────────────
// PUBLIC_BASE_URL must be set in the environment to a publicly reachable HTTPS
// URL where vendors can POST webhooks (e.g. https://api.yourdomain.com).
// For local dev, use ngrok / cloudflared to tunnel to your laptop.
const DEFAULT_PUBLIC_BASE_URL = "https://backend-leadshub-production.up.railway.app";

function getPublicBaseUrl(): string {
  const url =
    process.env.PUBLIC_BASE_URL ||
    process.env.BACKEND_URL ||
    process.env.RAILWAY_BACKEND_URL ||
    DEFAULT_PUBLIC_BASE_URL;

  if (!url) {
    throw new ApiError(
      500,
      "PUBLIC_BASE_URL env not set — webhook receiver URL cannot be constructed"
    );
  }
  return url.replace(/\/+$/, "");
}

// ─── Types ──────────────────────────────────────────────────────────────────
export interface CreateWebhookSubscriptionDTO {
  workflow_id: string;
  node_id: string;
  user_id: string;
  integration_key: string;
  event_key: string;
  config?: Record<string, any>;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────
export async function createWebhookSubscription(dto: CreateWebhookSubscriptionDTO) {
  const adapter = getWebhookAdapter(dto.integration_key);
  if (!adapter) {
    throw new ApiError(
      400,
      `No webhook adapter for integration: ${dto.integration_key}`
    );
  }

  // Idempotent on node_id — update existing row instead of duplicating
  const { data: existing } = await supabase
    .from("integration_webhook_subscriptions")
    .select("*")
    .eq("node_id", dto.node_id)
    .maybeSingle();

  if (existing) {
    // Event/config may have changed — unsubscribe old and re-subscribe fresh
    if (existing.external_subscription_id) {
      await adapter
        .unsubscribe(dto.user_id, existing.external_subscription_id)
        .catch((err) =>
          console.warn(
            `[WebhookService] vendor unsubscribe (existing) failed: ${err.message}`
          )
        );
    }

    const targetPath = existing.target_path; // reuse stable URL
    const targetUrl = `${getPublicBaseUrl()}/api/webhooks-receiver/integrations/${dto.integration_key}/${targetPath}`;

    const { externalSubscriptionId, signingSecret } = await adapter.subscribe(
      dto.user_id,
      dto.event_key,
      targetUrl,
      dto.config || {}
    );

    const { data, error } = await supabase
      .from("integration_webhook_subscriptions")
      .update({
        integration_key:          dto.integration_key,
        event_key:                dto.event_key,
        config:                   dto.config || {},
        external_subscription_id: externalSubscriptionId,
        signing_secret:           signingSecret,
        is_active:                true,
        error_count:              0,
        last_error:               null,
        updated_at:               new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      throw new ApiError(500, `Failed to update webhook subscription: ${error.message}`);
    }
    return data;
  }

  // Fresh subscription
  const targetPath = `sub_${crypto.randomBytes(16).toString("hex")}`;
  const targetUrl = `${getPublicBaseUrl()}/api/webhooks-receiver/integrations/${dto.integration_key}/${targetPath}`;

  const { externalSubscriptionId, signingSecret } = await adapter.subscribe(
    dto.user_id,
    dto.event_key,
    targetUrl,
    dto.config || {}
  );

  const { data, error } = await supabase
    .from("integration_webhook_subscriptions")
    .insert({
      workflow_id:              dto.workflow_id,
      node_id:                  dto.node_id,
      user_id:                  dto.user_id,
      integration_key:          dto.integration_key,
      event_key:                dto.event_key,
      config:                   dto.config || {},
      external_subscription_id: externalSubscriptionId,
      target_path:              targetPath,
      signing_secret:           signingSecret,
    })
    .select()
    .single();

  if (error) {
    // Rollback vendor side if DB insert failed
    if (externalSubscriptionId) {
      await adapter
        .unsubscribe(dto.user_id, externalSubscriptionId)
        .catch((err) =>
          console.warn(`[WebhookService] vendor rollback failed: ${err.message}`)
        );
    }
    throw new ApiError(500, `Failed to persist webhook subscription: ${error.message}`);
  }

  // Belt-and-suspenders: if a polling subscription exists for this same node
  // (from a previous failed webhook attempt or pre-migration), deactivate it
  // so the polling cron stops firing — otherwise the workflow would trigger
  // twice for every event (once via webhook, once via polling).
  const { error: deactErr } = await supabase
    .from("polling_subscriptions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("node_id", dto.node_id)
    .eq("is_active", true);
  if (deactErr) {
    console.warn(
      `[WebhookService] could not deactivate sibling polling sub for node=${dto.node_id}: ${deactErr.message}`
    );
  }

  return data;
}

export async function getWebhookSubscriptionById(id: string) {
  const { data, error } = await supabase
    .from("integration_webhook_subscriptions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return null;
  return data;
}

export async function getWebhookSubscriptionByNodeId(nodeId: string) {
  const { data } = await supabase
    .from("integration_webhook_subscriptions")
    .select("*")
    .eq("node_id", nodeId)
    .maybeSingle();
  return data;
}

export async function deleteWebhookSubscription(id: string) {
  const sub = await getWebhookSubscriptionById(id);
  if (!sub) return { message: "Webhook subscription not found" };

  const adapter = getWebhookAdapter(sub.integration_key);
  if (adapter && sub.external_subscription_id) {
    await adapter
      .unsubscribe(sub.user_id, sub.external_subscription_id)
      .catch((err) =>
        console.warn(
          `[WebhookService] vendor unsubscribe failed (proceeding with DB delete): ${err.message}`
        )
      );
  }

  const { error } = await supabase
    .from("integration_webhook_subscriptions")
    .delete()
    .eq("id", id);
  if (error) {
    throw new ApiError(500, `Failed to delete webhook subscription: ${error.message}`);
  }
  return { message: "Webhook subscription deleted successfully" };
}

export async function setWebhookSubscriptionActive(id: string, isActive: boolean) {
  const { data, error } = await supabase
    .from("integration_webhook_subscriptions")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new ApiError(500, `Failed to toggle subscription: ${error.message}`);
  return data;
}

// ─── Test step support ──────────────────────────────────────────────────────
/**
 * Sample-fetching for the workflow builder's "Test" step. Webhook subscriptions
 * have no historical buffer — vendors only push *future* events. So for the
 * test step we still need a REST API call, but we own that call inside the
 * webhook adapter (no dependency on the polling adapter). The sample is
 * enriched through the same pipeline real webhooks use, so the field-mapping
 * UI sees identical keys for both Test clicks and real GHL pushes.
 *
 * Same response shape as polling-engine's pollNowService result.
 */
export async function pollNowForWebhookSubscription(webhookSubId: string) {
  const sub = await getWebhookSubscriptionById(webhookSubId);
  if (!sub) throw new ApiError(404, "Webhook subscription not found");

  // Per-integration dispatch. Leadshub has its own webhook-side sample fetcher.
  // ServiceM8 reuses the polling adapter's fetchSample() — both paths apply the
  // same enrichment (company + first companycontact, flat-merged), so the
  // mapping UI sees identical keys to what the live webhook will deliver.
  let samples: Record<string, any>[];
  if (sub.integration_key === "leadshub") {
    samples = await fetchLeadshubWebhookSample(
      sub.user_id,
      sub.event_key,
      sub.config || {},
      3
    );
  } else if (sub.integration_key === "service_m8") {
    const adapter = getPollingAdapter("service_m8");
    if (!adapter) {
      throw new ApiError(500, "ServiceM8 polling adapter not registered");
    }
    samples = await adapter.fetchSample(
      sub.user_id,
      sub.event_key,
      sub.config || {},
      3
    );
  } else if (sub.integration_key === "simpro") {
    const adapter = getPollingAdapter("simpro");
    if (!adapter) {
      throw new ApiError(500, "simPRO polling adapter not registered");
    }
    samples = await adapter.fetchSample(
      sub.user_id,
      sub.event_key,
      sub.config || {},
      3
    );
  } else {
    throw new ApiError(
      400,
      `Webhook test-sample not implemented for integration: ${sub.integration_key}`
    );
  }

  if (!samples || samples.length === 0) {
    return { found: false, data: [] };
  }

  // Persist sample_payload + output_schema on the workflow node — matches what
  // polling-engine's pollNowService does so the field-mapper UI keeps working.
  const schemaSource = samples[0]!;
  const flatSchema: Record<string, null> = {};
  for (const key of Object.keys(schemaSource)) flatSchema[key] = null;

  const { error: updateError } = await supabase
    .from("workflow_nodes")
    .update({
      sample_payload: schemaSource,
      output_schema: flatSchema,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.node_id);

  if (updateError) {
    console.error(
      `[WebhookService:pollNow] failed to persist sample_payload node=${sub.node_id} error=${updateError.message}`
    );
  }

  return { found: true, data: samples };
}

// ─── Status ─────────────────────────────────────────────────────────────────
export async function getWebhookSubscriptionStatus(id: string) {
  const sub = await getWebhookSubscriptionById(id);
  if (!sub) throw new ApiError(404, "Webhook subscription not found");

  const { count: eventCount } = await supabase
    .from("webhook_event_log")
    .select("id", { count: "exact", head: true })
    .eq("subscription_id", id);

  return {
    id:                sub.id,
    delivery_mode:     "webhook",
    is_active:         sub.is_active,
    last_received_at:  sub.last_received_at,
    total_received:    sub.total_received,
    error_count:       sub.error_count,
    last_error:        sub.last_error,
    total_events_logged: eventCount || 0,
  };
}

// Re-export the registry's gate function so external modules don't need to
// reach into the adapters folder.
export { supportsWebhook };
