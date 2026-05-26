import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";
import { ZohoFormsController } from "../controller/zohoForms.controller.js";

const router = Router();

// ─── OAuth ────────────────────────────────────────────────────────────────────
router.get("/connect",      catchAsync(ZohoFormsController.getConnectUrl));
router.get("/callback",     catchAsync(ZohoFormsController.handleCallback));
router.get("/status",       catchAsync(ZohoFormsController.connectionStatus));
router.delete("/disconnect", catchAsync(ZohoFormsController.disconnect));

// ─── Forms (live from Zoho API + syncs to DB) ─────────────────────────────────
router.get("/forms",                  catchAsync(ZohoFormsController.listForms));
router.get("/forms/db",               catchAsync(ZohoFormsController.getFormsFromDb));
router.get("/forms/:formId",          catchAsync(ZohoFormsController.getFormDetails));
router.get("/forms/:formId/fields",   catchAsync(ZohoFormsController.getFormFields));

// ─── Submissions ──────────────────────────────────────────────────────────────
router.get("/submissions",                      catchAsync(ZohoFormsController.getSubmissionsFromDb));
router.get("/submissions/sync",                 catchAsync(ZohoFormsController.syncAllSubmissions));
router.get("/forms/:formId/submissions",        catchAsync(ZohoFormsController.getSubmissions));

// ─── Webhook Management ───────────────────────────────────────────────────────
router.get("/webhooks",                   catchAsync(ZohoFormsController.listWebhooks));
router.post("/forms/:formId/webhook",     catchAsync(ZohoFormsController.setupWebhook));
router.delete("/forms/:formId/webhook",   catchAsync(ZohoFormsController.removeWebhook));

// ─── Incoming Webhook Receiver (public — Zoho posts here on submission) ────────
// No authMiddleware — Zoho Forms calls this URL directly
router.post("/webhook/:userId/:formId",   catchAsync(ZohoFormsController.incomingWebhook));

export default router;
