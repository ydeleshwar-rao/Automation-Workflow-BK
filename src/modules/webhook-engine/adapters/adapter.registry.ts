import type { WebhookAdapter } from "./adapter.interface.js";
import { ServiceM8WebhookAdapter } from "./serviceM8.webhook.adapter.js";
import { LeadshubWebhookAdapter } from "./leadshub.webhook.adapter.js";
import { CommusoftWebhookAdapter } from "./commusoft.webhook.adapter.js";
import { SimproWebhookAdapter } from "./simpro.webhook.adapter.js";

/**
 * Registry of webhook adapters keyed by integration_key.
 * Keys must match what the polling-engine registry uses so the wrapper in
 * polling.controller can dispatch correctly.
 */
const adapterRegistry: Record<string, WebhookAdapter> = {
  service_m8: new ServiceM8WebhookAdapter(),
  leadshub:   new LeadshubWebhookAdapter(),
  commusoft:  new CommusoftWebhookAdapter(),
  simpro:     new SimproWebhookAdapter(),
};

export function getWebhookAdapter(integrationKey: string): WebhookAdapter | null {
  return adapterRegistry[integrationKey] ?? null;
}

/**
 * THE switch: returns true if this integration has a webhook adapter wired up.
 * The polling.controller wrapper calls this to decide between webhook and
 * polling delivery. Commusoft returns true here but its adapter throws in
 * subscribe() if COMMUSOFT_APP_NAME env isn't set — the wrapper catches that
 * and falls back to polling, so partial-coverage integrations fail gracefully.
 */
export function supportsWebhook(integrationKey: string): boolean {
  return integrationKey in adapterRegistry;
}

export function listSupportedIntegrations(): string[] {
  return Object.keys(adapterRegistry);
}
