import { supabase } from "../../config/db.config.js";
import { ApiError } from "../../utils/ApiError.js";
import { pollingLogger as log } from "../../utils/logger.js";
import { getAdapter } from "./adapters/adapter.registry.js";
import { getDefaultPollInterval } from "./polling.runner.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateSubscriptionDTO {
  workflow_id: string;
  node_id: string;
  user_id: string;
  integration_key: string;
  event_key: string;
  config?: Record<string, any>;
  poll_interval?: number;
}

export interface UpdateSubscriptionDTO {
  config?: Record<string, any>;
  poll_interval?: number;
  event_key?: string;
  is_active?: boolean;
}

const COMMUSOFT_STAGE_EVENTS = new Set([
  "proposal_sent",
  "proposal_accepted",
  "opportunity_stage_changed",
]);

const COMMUSOFT_ESTIMATE_EVENTS = new Set([
  "estimate_sent",
  "estimate_accepted",
  "estimate_rejected",
]);

function getSyntheticSample(
  integrationKey: string,
  eventKey: string
): Record<string, any> | null {
  if (integrationKey !== "commusoft") {
    return null;
  }

  if (COMMUSOFT_ESTIMATE_EVENTS.has(eventKey)) {
    return {
      __integration: "commusoft",
      __event_key: eventKey,
      __external_id: "sample-estimate",
      commusoft_estimate_id: "sample-estimate",
      estimateId: "sample-estimate",
      estimateNumber: "EST-001",
      estimateName: "Sample Commusoft estimate",
      estimateStatus:
        eventKey === "estimate_sent"
          ? "waiting_for_customer"
          : eventKey === "estimate_accepted"
          ? "accepted"
          : "rejected",
      opportunityName: "Sample Commusoft estimate",
      customerName: "Sample Customer",
      contactName: "Sample Customer",
      firstName: "Sample",
      lastName: "Customer",
      email: "sample.customer@example.com",
      phone: "+447700900123",
      monetaryValue: 1234,
      estimateValue: 1234,
      quoteValue: 1234,
      value: 1234,
      _sampleOnly: true,
    };
  }

  if (!COMMUSOFT_STAGE_EVENTS.has(eventKey)) {
    return null;
  }

  return {
    __integration: "commusoft",
    __event_key: eventKey,
    __external_id: "sample-opportunity",
    commusoft_opportunity_id: "sample-opportunity",
    opportunityId: "sample-opportunity",
    opportunityName: "Sample Commusoft proposal",
    customerName: "Sample Customer",
    contactName: "Sample Customer",
    firstName: "Sample",
    lastName: "Customer",
    email: "sample.customer@example.com",
    phone: "+447700900123",
    monetaryValue: 1234,
    opportunityValue: 1234,
    quoteValue: 1234,
    _sampleOnly: true,
  };
}

// ─── CRUD Services ───────────────────────────────────────────────────────────

export async function createPollingSubscription(dto: CreateSubscriptionDTO) {
  // Check if subscription already exists for this node
  const { data: existing } = await supabase
    .from("polling_subscriptions")
    .select("id")
    .eq("node_id", dto.node_id)
    .single();

  if (existing) {
    // Update existing subscription instead of creating duplicate
    const { data, error } = await supabase
      .from("polling_subscriptions")
      .update({
        integration_key: dto.integration_key,
        event_key: dto.event_key,
        config: dto.config || {},
        poll_interval: dto.poll_interval ?? getDefaultPollInterval(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw new ApiError(500, `Failed to update subscription: ${error.message}`);
    return data;
  }

  const { data, error } = await supabase
    .from("polling_subscriptions")
    .insert({
      workflow_id: dto.workflow_id,
      node_id: dto.node_id,
      user_id: dto.user_id,
      integration_key: dto.integration_key,
      event_key: dto.event_key,
      config: dto.config || {},
      poll_interval: dto.poll_interval ?? getDefaultPollInterval(),
      is_active: false, // stays inactive until workflow is activated
    })
    .select()
    .single();

  if (error) throw new ApiError(500, `Failed to create subscription: ${error.message}`);
  return data;
}

export async function getSubscriptionByNodeId(nodeId: string) {
  const { data, error } = await supabase
    .from("polling_subscriptions")
    .select("*")
    .eq("node_id", nodeId)
    .single();

  if (error) return null;
  return data;
}

export async function getSubscriptionById(id: string) {
  const { data, error } = await supabase
    .from("polling_subscriptions")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) throw new ApiError(404, "Polling subscription not found");
  return data;
}

export async function updatePollingSubscription(
  id: string,
  dto: UpdateSubscriptionDTO
) {
  const { data, error } = await supabase
    .from("polling_subscriptions")
    .update({
      ...dto,
      // Reset cursor and error state when event changes
      ...(dto.event_key && { cursor_value: null, error_count: 0, last_error: null }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new ApiError(500, `Failed to update subscription: ${error.message}`);
  return data;
}

export async function deletePollingSubscription(id: string) {
  // Cascade delete will also remove polling_seen_records
  const { error } = await supabase
    .from("polling_subscriptions")
    .delete()
    .eq("id", id);

  if (error) throw new ApiError(500, `Failed to delete subscription: ${error.message}`);
  return { message: "Subscription deleted successfully" };
}

/**
 * Manual poll — used by the Test step in the workflow builder.
 *
 * First test per subscription (cursor_value === null) ALSO seeds the
 * polling_seen_records baseline and sets cursor_value, Zapier-style:
 *   • Every record currently returned by the external API is marked "seen"
 *   • cursor_value is set to the max cursorValue
 * Result: when the workflow is activated, the cron only fires for records
 * that become new *after* the test time — no historical flood, no silent
 * first-poll bootstrap window where new jobs can get swallowed.
 *
 * Subsequent tests (cursor_value set) are pure preview — they do NOT rewrite
 * the baseline, so re-testing while configuring the workflow cannot
 * accidentally "consume" records that were supposed to fire after activation.
 */
export async function pollNowService(subscriptionId: string) {
  log.info("loading subscription", { sub: subscriptionId, step: "1/5" });
  const sub = await getSubscriptionById(subscriptionId);
  log.info("subscription loaded", {
    step: "1/5",
    sub: sub.id,
    integration: sub.integration_key,
    event: sub.event_key,
    node: sub.node_id,
    cursor: sub.cursor_value ?? "null",
  });

  const adapter = getAdapter(sub.integration_key);
  if (!adapter) {
    log.error("no adapter registered", { step: "2/5", integration: sub.integration_key });
    throw new ApiError(400, `No adapter for integration: ${sub.integration_key}`);
  }
  log.debug("adapter resolved", { step: "2/5", integration: sub.integration_key });

  const isFirstTest = sub.cursor_value === null;
  let samples: Record<string, any>[] = [];

  if (isFirstTest) {
    // First test: fetch the full current list via adapter.poll(null) so we can
    // seed polling_seen_records as the baseline AND return a preview from the
    // same records (latest 3). This is the Zapier-style "turn-on baseline"
    // except we do it at test-time instead of activation-time.
    log.info("FIRST TEST: fetching all records to seed baseline", { step: "3/5", event: sub.event_key, user: sub.user_id });

    const enrichedConfig = { ...sub.config, _subscriptionCreatedAt: sub.created_at };
    const pollResults = await adapter.poll(
      sub.user_id,
      sub.event_key,
      enrichedConfig,
      null
    );

    log.info("records received for baseline", { step: "3/5", count: pollResults.length });

    if (pollResults.length === 0) {
      const synthetic = getSyntheticSample(sub.integration_key, sub.event_key);
      if (synthetic) {
        log.warn("zero live records — returning synthetic sample", { step: "3/5", integration: sub.integration_key, event: sub.event_key });
        return { found: true, data: [synthetic], sampleOnly: true };
      }
      log.warn("zero records from external API", { step: "3/5", event: sub.event_key });
      return { found: false, data: [] };
    }

    // Seed baseline: mark every currently-visible record as "seen"
    const seenInserts = pollResults.map((r) => ({
      subscription_id: sub.id,
      external_id: r.externalId,
    }));
    const { error: seenErr } = await supabase
      .from("polling_seen_records")
      .upsert(seenInserts, { onConflict: "subscription_id,external_id" });
    if (seenErr) {
      log.error("seeding polling_seen_records failed", { error: seenErr.message, sub: sub.id });
      throw new ApiError(500, `Failed to seed baseline: ${seenErr.message}`);
    }
    log.info("baseline seeded", { rows: pollResults.length, sub: sub.id });

    // Update cursor_value so runPollingTick no longer treats the next cron
    // tick as "first poll" (isFirstPoll === (cursor_value === null)).
    // poll() returns records sorted asc by cursorValue, so last is the max.
    const maxCursor = pollResults[pollResults.length - 1]!.cursorValue;
    const { error: subErr } = await supabase
      .from("polling_subscriptions")
      .update({
        cursor_value: maxCursor,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sub.id);
    if (subErr) {
      log.error("cursor update failed", { error: subErr.message, sub: sub.id });
      throw new ApiError(500, `Failed to set cursor: ${subErr.message}`);
    }
    log.info("cursor_value set", { cursor: maxCursor, sub: sub.id });

    // Preview = newest 3 raw records (poll is asc by cursor, so reverse + slice).
    samples = pollResults.slice().reverse().slice(0, 3).map((r) => r.data);
  } else {
    // Subsequent test: pure preview, no state change.
    log.info("SUBSEQUENT TEST: preview only", { step: "3/5", event: sub.event_key, sub: sub.id });
    samples = await adapter.fetchSample(
      sub.user_id,
      sub.event_key,
      { ...sub.config, _subscriptionCreatedAt: sub.created_at },
      3
    );

    if (!samples || samples.length === 0) {
      const synthetic = getSyntheticSample(sub.integration_key, sub.event_key);
      if (synthetic) {
        log.warn("zero live records — returning synthetic sample", { step: "3/5", integration: sub.integration_key, event: sub.event_key });
        return { found: true, data: [synthetic], sampleOnly: true };
      }
      log.warn("no records returned", { step: "3/5", event: sub.event_key });
      return { found: false, data: [] };
    }
    log.info("samples received", { step: "3/5", count: samples.length, sub: sub.id });
  }

  // Schema is derived from the first record (used by the field-mapper UI).
  const schemaSource = samples[0]!;

  log.debug("building output schema", { step: "4/5", node: sub.node_id });
  const flatSchema: Record<string, null> = {};
  for (const key of Object.keys(schemaSource)) {
    flatSchema[key] = null;
  }
  log.debug("schema built", { step: "4/5", fields: Object.keys(flatSchema).length });
  log.debug("persisting sample_payload", { step: "5/5", node: sub.node_id });
  const { error: updateError } = await supabase
    .from("workflow_nodes")
    .update({
      sample_payload: schemaSource,
      output_schema: flatSchema,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.node_id);

  if (updateError) {
    log.error("failed to persist sample_payload", { step: "5/5", node: sub.node_id, error: updateError.message });
  } else {
    log.info("sample_payload saved", { step: "5/5", node: sub.node_id });
  }

  return { found: true, data: samples, baselineSeeded: isFirstTest };
}

/**
 * Get subscription status — returns polling health info.
 */
export async function getSubscriptionStatus(id: string) {
  const sub = await getSubscriptionById(id);

  const { count } = await supabase
    .from("polling_seen_records")
    .select("id", { count: "exact", head: true })
    .eq("subscription_id", id);

  return {
    id: sub.id,
    is_active: sub.is_active,
    last_polled_at: sub.last_polled_at,
    cursor_value: sub.cursor_value,
    error_count: sub.error_count,
    last_error: sub.last_error,
    total_seen_records: count || 0,
  };
}
