import { supabase } from "../../config/db.config.js";
import { getAdapter } from "./adapters/adapter.registry.js";
import { executeWorkflow } from "../workflow-automation/processor/webhookProcessor.js";
import { pollingLogger as log } from "../../utils/logger.js";

const MAX_ERROR_COUNT = 5;

/**
 * Returns true if current time is inside the quiet window defined by
 * POLL_QUIET_START and POLL_QUIET_END env vars (both 0-23 hour values).
 *
 * Examples:
 *   POLL_QUIET_START=23  POLL_QUIET_END=6   → quiet from 11 PM to 6 AM (crosses midnight)
 *   POLL_QUIET_START=2   POLL_QUIET_END=5   → quiet from 2 AM to 5 AM (same day)
 *
 * If either var is missing/invalid, quiet hours are disabled.
 */
function isQuietHour(): boolean {
  const startEnv = parseInt(process.env.POLL_QUIET_START ?? "", 10);
  const endEnv   = parseInt(process.env.POLL_QUIET_END   ?? "", 10);

  if (isNaN(startEnv) || isNaN(endEnv)) return false;

  const currentHour = new Date().getHours();

  // Crosses midnight (e.g. 23 → 6)
  if (startEnv > endEnv) {
    return currentHour >= startEnv || currentHour < endEnv;
  }
  // Same day window (e.g. 2 → 5)
  return currentHour >= startEnv && currentHour < endEnv;
}

/**
 * Default poll interval for new subscriptions — from POLL_DEFAULT_INTERVAL env
 * (seconds). Falls back to 300 (5 min) if not set.
 */
export function getDefaultPollInterval(): number {
  const val = parseInt(process.env.POLL_DEFAULT_INTERVAL ?? "", 10);
  return isNaN(val) || val < 60 ? 300 : val;
}

interface PollingSubscription {
  id: string;
  workflow_id: string;
  node_id: string;
  user_id: string;
  integration_key: string;
  event_key: string;
  config: Record<string, any>;
  poll_interval: number;
  cursor_value: string | null;
  cursor_type: string;
  last_polled_at: string | null;
  last_error: string | null;
  error_count: number;
  is_active: boolean;
  created_at: string;
}

/**
 * Fetch all subscriptions that are due for polling.
 * A subscription is "due" if:
 *   - is_active = true
 *   - error_count < MAX_ERROR_COUNT
 *   - last_polled_at is null OR (now - last_polled_at) >= poll_interval seconds
 */
async function getDueSubscriptions(): Promise<PollingSubscription[]> {
  const { data: subs, error } = await supabase
    .from("polling_subscriptions")
    .select("*")
    .eq("is_active", true)
    .lt("error_count", MAX_ERROR_COUNT)
    .neq("integration_key", "service_m8")   // ServiceM8 auto-poll paused — use poll-now manually
    .or(
      "last_polled_at.is.null," +
      `last_polled_at.lte.${new Date(Date.now() - 60 * 1000).toISOString()}`
    );

  if (error) {
    log.error("failed to fetch subscriptions", { error: error.message });
    return [];
  }

  // Apply per-subscription interval check for custom intervals > 60s
  const now = Date.now();
  return (subs ?? []).filter((sub: PollingSubscription) => {
    if (!sub.last_polled_at) return true;
    const lastPolled = new Date(sub.last_polled_at).getTime();
    const intervalMs = (sub.poll_interval || 300) * 1000;
    return now - lastPolled >= intervalMs;
  });
}

/**
 * Verify that the workflow linked to a subscription is still active.
 */
async function isWorkflowActive(workflowId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("workflows")
    .select("status")
    .eq("id", workflowId)
    .single();

  if (error || !data) return false;
  return data.status === "active";
}

interface SubResult {
  subId: string;
  status: "ok" | "skipped" | "error";
  polled: number;
  seeded: number;
  triggered: number;
  error?: string;
}

/**
 * Process a single subscription: poll the adapter, deduplicate, trigger workflows.
 */
async function processSubscription(
  sub: PollingSubscription,
  tickId: string
): Promise<SubResult> {
  const now = new Date().toISOString();
  const t0 = Date.now();

  // 1. Verify workflow is still active
  const active = await isWorkflowActive(sub.workflow_id);
  if (!active) {
    log.info("workflow not active — skipping", {
      tickId,
      subId: sub.id,
      integration: sub.integration_key,
      event: sub.event_key,
      workflowId: sub.workflow_id,
    });
    return { subId: sub.id, status: "skipped", polled: 0, seeded: 0, triggered: 0 };
  }

  // 2. Get the adapter
  const adapter = getAdapter(sub.integration_key);
  if (!adapter) {
    const msg = `No adapter registered for integration: ${sub.integration_key}`;
    log.error("no adapter registered", {
      tickId,
      subId: sub.id,
      integration: sub.integration_key,
      error: msg,
    });
    await supabase
      .from("polling_subscriptions")
      .update({
        last_polled_at: now,
        last_error: msg,
        error_count: sub.error_count + 1,
        updated_at: now,
      })
      .eq("id", sub.id);
    return { subId: sub.id, status: "error", polled: 0, seeded: 0, triggered: 0, error: msg };
  }

  try {
    // 3. Poll the external API
    const enrichedConfig = { ...sub.config, _subscriptionCreatedAt: sub.created_at };
    const records = await adapter.poll(
      sub.user_id,
      sub.event_key,
      enrichedConfig,
      sub.cursor_value
    );

    log.info("polled records", {
      tickId,
      subId: sub.id,
      integration: sub.integration_key,
      event: sub.event_key,
      polled: records.length,
      adapter_duration_ms: Date.now() - t0,
    });

    if (records.length === 0) {
      // No new records — just update last_polled_at
      await supabase
        .from("polling_subscriptions")
        .update({
          last_polled_at: now,
          last_error: null,
          error_count: 0,
          updated_at: now,
        })
        .eq("id", sub.id);
      log.info("no records — marked polled, no trigger", {
        tickId,
        subId: sub.id,
        duration_ms: Date.now() - t0,
      });
      return { subId: sub.id, status: "ok", polled: 0, seeded: 0, triggered: 0 };
    }

    // 4. Deduplicate against seen records
    const externalIds = [
      ...new Set(
        records.flatMap((r) => [
          r.externalId,
          r.data?.__legacy_external_id,
        ]).filter(Boolean)
      ),
    ];
    const { data: seenRows, error: seenQErr } = await supabase
      .from("polling_seen_records")
      .select("external_id")
      .eq("subscription_id", sub.id)
      .in("external_id", externalIds);

    if (seenQErr) {
      log.error("seen-records query failed", {
        tickId,
        subId: sub.id,
        error: seenQErr.message,
      });
      throw new Error(seenQErr.message);
    }

    const seenSet = new Set(seenRows?.map((s: any) => s.external_id) ?? []);
    const newRecords = records.filter((r) => {
      if (seenSet.has(r.externalId)) return false;

      // Compatibility for proposal subscriptions created before proposal events
      // used versioned IDs. Suppress only the initial sent marker if the old
      // opportunity ID was already seen; later versions still trigger.
      const legacyId = r.data?.__legacy_external_id;
      const initialProposalSentId =
        legacyId && r.externalId === `${legacyId}:proposal_sent:1`;
      return !(initialProposalSentId && seenSet.has(legacyId));
    });

    log.debug("dedup", {
      tickId,
      subId: sub.id,
      externalIds,
      already_seen: [...seenSet],
      new_records: newRecords.map((r) => r.externalId),
      polled: records.length,
      new: newRecords.length,
    });

    // 5. First poll bootstrap: seed seen records + cursor, but DON'T trigger workflows
    const isFirstPoll = sub.cursor_value === null;
    let seeded = 0;
    let triggered = 0;

    if (isFirstPoll) {
      log.info("FIRST POLL — seeding without triggering", {
        tickId,
        subId: sub.id,
        integration: sub.integration_key,
        event: sub.event_key,
        count: records.length,
      });

      const seenInserts = records.map((r) => ({
        subscription_id: sub.id,
        external_id: r.externalId,
      }));

      if (seenInserts.length > 0) {
        const { error: seedErr } = await supabase
          .from("polling_seen_records")
          .upsert(seenInserts, { onConflict: "subscription_id,external_id" });
      }

      const forcedCursor = records
        .map(r => r.cursorValue)
        .filter(v => v && v !== "")
        .sort()
        .pop() ?? new Date().toISOString();

      await supabase
        .from("polling_subscriptions")
        .update({
          cursor_value: forcedCursor,
          last_polled_at: now,
          last_error: null,
          error_count: 0,
          updated_at: now,
        })
        .eq("id", sub.id);

      log.info("first poll complete", {
        tickId,
        subId: sub.id,
        seeded: records.length,
        cursor: forcedCursor,
      });

      return { subId: sub.id, status: "ok", polled: records.length, seeded: records.length, triggered: 0 }; // exit after first poll — no workflows triggered
    } else {
      // 6. Normal poll: trigger workflows for new records
      if (newRecords.length === 0) {
        log.info("no new records — nothing to trigger", { tickId, subId: sub.id });
      }

      for (const record of newRecords) {
        // Mark as seen FIRST to prevent duplicate triggers
        await supabase.from("polling_seen_records").upsert(
          {
            subscription_id: sub.id,
            external_id: record.externalId,
          },
          { onConflict: "subscription_id,external_id" }
        );

        log.info("triggering workflow", {
          tickId,
          subId: sub.id,
          workflowId: sub.workflow_id,
          record: record.externalId,
        });

        // Execute workflow after marking seen
        executeWorkflow(sub.workflow_id, record.data).catch((err) => {
          log.error("workflow execution failed", {
            tickId,
            subId: sub.id,
            workflowId: sub.workflow_id,
            record: record.externalId,
            error: err.message,
          });
        });

        triggered++;
      }
    }

    // 7. Update cursor to the sorted maximum value
    const maxCursor = records.length > 0
      ? (records
          .map(r => r.cursorValue)
          .filter(v => v && v !== "")
          .sort()
          .pop() ?? sub.cursor_value)
      : sub.cursor_value;

    const { error: cursorErr } = await supabase
      .from("polling_subscriptions")
      .update({
        cursor_value: maxCursor,
        last_polled_at: now,
        last_error: null,
        error_count: 0,
        updated_at: now,
      })
      .eq("id", sub.id);

    if (cursorErr) {
      log.error("cursor update failed", {
        tickId,
        subId: sub.id,
        error: cursorErr.message,
      });
      throw new Error(cursorErr.message);
    }

    log.info("subscription done", {
      tickId,
      subId: sub.id,
      integration: sub.integration_key,
      event: sub.event_key,
      polled: records.length,
      seeded,
      triggered,
      cursor: maxCursor,
      duration_ms: Date.now() - t0,
    });
    return { subId: sub.id, status: "ok", polled: records.length, seeded, triggered };
  } catch (err: any) {
    const errMsg = err?.message || "Unknown error";
    log.error("processing failed", {
      tickId,
      subId: sub.id,
      integration: sub.integration_key,
      event: sub.event_key,
      error: errMsg,
      error_count: sub.error_count + 1,
      max: MAX_ERROR_COUNT,
      duration_ms: Date.now() - t0,
    });

    const { error: updErr } = await supabase
      .from("polling_subscriptions")
      .update({
        last_polled_at: now,
        last_error: errMsg,
        error_count: sub.error_count + 1,
        updated_at: now,
      })
      .eq("id", sub.id);

    if (updErr) {
      log.error("failed to persist error state", {
        tickId,
        subId: sub.id,
        error: updErr.message,
      });
    }

    if (sub.error_count + 1 >= MAX_ERROR_COUNT) {
      log.error("MAX_ERROR_COUNT reached — subscription will be skipped", {
        tickId,
        subId: sub.id,
        max: MAX_ERROR_COUNT,
      });
    }

    return { subId: sub.id, status: "error", polled: 0, seeded: 0, triggered: 0, error: errMsg };
  }
}

/**
 * Short correlation ID for grouping all log lines emitted in a single tick.
 * Format: t<base36-timestamp-tail>  e.g. "t1k3b2f7"
 */
function newTickId(): string {
  return "t" + Date.now().toString(36).slice(-6);
}

/**
 * Main polling tick — called by the cron job every 60 seconds.
 * Fetches all due subscriptions and processes them.
 */
export async function runPollingTick(): Promise<void> {
  const tickId = newTickId();
  const tickStart = Date.now();

  if (isQuietHour()) {
    const { POLL_QUIET_START, POLL_QUIET_END } = process.env;
    log.info("quiet hours active — skipping tick", {
      tickId,
      quietStart: POLL_QUIET_START,
      quietEnd: POLL_QUIET_END,
    });
    return;
  }

  let dueSubs: PollingSubscription[];
  try {
    dueSubs = await getDueSubscriptions();
  } catch (err: any) {
    log.error("failed to fetch due subscriptions", { tickId, error: err?.message });
    return;
  }

  if (dueSubs.length === 0) {
    log.debug("idle — no due subscriptions", { tickId });
    return;
  }

  log.info("processing due subscriptions", {
    tickId,
    count: dueSubs.length,
    ids: dueSubs.map((s) => s.id),
  });

  // Process subscriptions sequentially to avoid overwhelming external APIs
  const results: SubResult[] = [];
  for (const sub of dueSubs) {
    results.push(await processSubscription(sub, tickId));
  }

  const duration = Date.now() - tickStart;
  const ok = results.filter((r) => r.status === "ok").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errors = results.filter((r) => r.status === "error").length;
  const totalPolled = results.reduce((s, r) => s + r.polled, 0);
  const totalTriggered = results.reduce((s, r) => s + r.triggered, 0);
  const totalSeeded = results.reduce((s, r) => s + r.seeded, 0);

  log.info("tick complete", {
    tickId,
    subs: dueSubs.length,
    ok,
    skipped,
    errors,
    polled: totalPolled,
    seeded: totalSeeded,
    triggered: totalTriggered,
    duration_ms: duration,
  });

  if (errors > 0) {
    const failed = results.filter((r) => r.status === "error");
    for (const f of failed) {
      log.error("failed subscription", { tickId, subId: f.subId, error: f.error });
    }
  }
}
