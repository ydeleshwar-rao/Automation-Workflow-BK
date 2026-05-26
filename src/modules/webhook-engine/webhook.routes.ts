import { Router } from "express";
import {
  receiveIntegrationWebhook,
  receiveLeadshubWorkflowAppointment,
} from "./webhook.controller.js";
import { webhookReceiverRateLimiter } from "../../middlewares/rateLimiter.js";

/**
 * Vendor-facing receiver routes.
 *
 * Mounted at /api/webhooks-receiver (see src/app.ts), so final URLs are:
 *   POST /api/webhooks-receiver/integrations/:integrationKey/:targetPath
 *   POST /api/webhooks-receiver/integrations/:integrationKey
 *
 * These URLs are what we register with vendors (ServiceM8 callback_url, GHL
 * marketplace webhook URL, etc.) and they MUST be publicly reachable.
 */
const webhookReceiverRouter = Router();

// GoHighLevel sub-account Workflow → Webhook action.
webhookReceiverRouter.post(
  "/integrations/leadshub/workflow/appointment",
  receiveLeadshubWorkflowAppointment
);

// Per-subscription URL (ServiceM8, Commusoft)
webhookReceiverRouter.post(
  "/integrations/:integrationKey/:targetPath",
  webhookReceiverRateLimiter,
  receiveIntegrationWebhook
);

// OAuth-app-level URL (GHL — single endpoint for all locations)
webhookReceiverRouter.post(
  "/integrations/:integrationKey",
  webhookReceiverRateLimiter,
  receiveIntegrationWebhook
);

export default webhookReceiverRouter;
