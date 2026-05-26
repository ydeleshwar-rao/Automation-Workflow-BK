/**
 * Auto-migrate active polling subscriptions to webhook subscriptions for one
 * integration. Atomic per row, rollback-safe.
 *
 * Usage:
 *   npx tsx scripts/migrate-polling-to-webhook.ts <integration_key> [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/migrate-polling-to-webhook.ts service_m8 --dry-run
 *   npx tsx scripts/migrate-polling-to-webhook.ts service_m8
 *   npx tsx scripts/migrate-polling-to-webhook.ts leadshub
 *
 * Behavior per row:
 *   1. Call createWebhookSubscription with the same workflow_id/node_id/...
 *   2. On success: deactivate polling row (is_active=false). Polling cron stops
 *      polling it. We DO NOT delete the row — preserved for rollback / audit.
 *   3. On failure: leave polling row untouched, log + skip.
 *
 * Exit code: 0 if all rows migrated cleanly, 1 if any row failed.
 */

import "../src/config/env.config.js";
import { supabase } from "../src/config/db.config.js";
import {
  supportsWebhook,
  createWebhookSubscription,
} from "../src/modules/webhook-engine/webhook.service.js";

interface PollingSubscription {
  id: string;
  workflow_id: string;
  node_id: string;
  user_id: string;
  integration_key: string;
  event_key: string;
  config: Record<string, any> | null;
  is_active: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  const integrationKey = args[0];
  const dryRun = args.includes("--dry-run");

  if (!integrationKey) {
    console.error("Usage: npx tsx scripts/migrate-polling-to-webhook.ts <integration_key> [--dry-run]");
    process.exit(2);
  }

  if (!supportsWebhook(integrationKey)) {
    console.error(
      `[Migrate] integration_key='${integrationKey}' has no webhook adapter registered. Aborting.`
    );
    process.exit(2);
  }

  console.log(
    `[Migrate] ${dryRun ? "DRY RUN " : ""}polling → webhook for integration='${integrationKey}'`
  );

  const { data: rows, error } = await supabase
    .from("polling_subscriptions")
    .select("id, workflow_id, node_id, user_id, integration_key, event_key, config, is_active")
    .eq("integration_key", integrationKey)
    .eq("is_active", true);

  if (error) {
    console.error(`[Migrate] failed to fetch polling subscriptions: ${error.message}`);
    process.exit(1);
  }

  const subs = (rows || []) as PollingSubscription[];
  if (subs.length === 0) {
    console.log("[Migrate] no active polling subscriptions to migrate. Done.");
    process.exit(0);
  }

  console.log(`[Migrate] found ${subs.length} active polling subscription(s)`);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const sub of subs) {
    const ctx = `id=${sub.id} node=${sub.node_id} event=${sub.event_key}`;

    // Skip if a webhook subscription already exists for this node
    const { data: existingWebhook } = await supabase
      .from("integration_webhook_subscriptions")
      .select("id")
      .eq("node_id", sub.node_id)
      .maybeSingle();
    if (existingWebhook) {
      console.log(`[Migrate] ⊘ ${ctx} — webhook subscription already exists, skipping`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[Migrate] ◌ ${ctx} — would migrate`);
      continue;
    }

    try {
      const webhookSub = await createWebhookSubscription({
        workflow_id:     sub.workflow_id,
        node_id:         sub.node_id,
        user_id:         sub.user_id,
        integration_key: sub.integration_key,
        event_key:       sub.event_key,
        config:          sub.config || {},
      });

      const { error: deactErr } = await supabase
        .from("polling_subscriptions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", sub.id);

      if (deactErr) {
        console.warn(
          `[Migrate] ⚠ ${ctx} — webhook created (${webhookSub.id}) but polling deactivate failed: ${deactErr.message}`
        );
      }

      console.log(`[Migrate] ✓ ${ctx} → webhook=${webhookSub.id}`);
      succeeded++;
    } catch (err: any) {
      console.error(`[Migrate] ✖ ${ctx} — ${err?.message}`);
      failed++;
    }
  }

  console.log(
    `\n[Migrate] complete: succeeded=${succeeded}  failed=${failed}  skipped=${skipped}  total=${subs.length}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[Migrate] fatal: ${err?.message}`);
  process.exit(1);
});
