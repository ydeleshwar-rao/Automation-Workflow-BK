import type { PollingAdapter } from "./adapter.interface.js";
import { ServiceM8PollingAdapter } from "./serviceM8.adapter.js";
import { CommusoftPollingAdapter } from "./commusoft.adapter.js";
import { LeadshubPollingAdapter } from "./leadshub.adapter.js";
import { SimproPollingAdapter } from "./simpro.adapter.js";

/**
 * Registry of polling adapters keyed by integration_key.
 * Add new integrations here as they're built.
 */
const adapterRegistry: Record<string, PollingAdapter> = {
  service_m8: new ServiceM8PollingAdapter(),
  commusoft: new CommusoftPollingAdapter(),
  leadshub: new LeadshubPollingAdapter(),
  simpro: new SimproPollingAdapter(),
};

export function getAdapter(integrationKey: string): PollingAdapter | null {
  return adapterRegistry[integrationKey] ?? null;
}
