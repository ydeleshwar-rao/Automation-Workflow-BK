import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";
import { GoogleFormsController } from "../controller/googleForms.controller.js";

const router = Router();

// ─── OAuth ────────────────────────────────────────────────────────────────────
router.get("/connect",       catchAsync(GoogleFormsController.getConnectUrl));
router.get("/callback",      catchAsync(GoogleFormsController.handleCallback));
router.get("/status",        catchAsync(GoogleFormsController.connectionStatus));
router.delete("/disconnect", catchAsync(GoogleFormsController.disconnect));

// ─── Forms (live from Google Drive + syncs to DB) ─────────────────────────────
router.get("/forms",          catchAsync(GoogleFormsController.listForms));
router.get("/forms/db",       catchAsync(GoogleFormsController.getFormsFromDb));
router.get("/forms/:formId",  catchAsync(GoogleFormsController.getFormDetails));

// ─── Responses ────────────────────────────────────────────────────────────────
// Trigger: "New Form Response" — GET with optional ?since= timestamp
// Trigger: "New or Updated Form Response" — same endpoint, omit since=
router.get("/responses",                  catchAsync(GoogleFormsController.getResponsesFromDb));
router.get("/forms/:formId/responses",    catchAsync(GoogleFormsController.getResponses));

// ─── Sync (polls all watched forms for new responses) ─────────────────────────
router.post("/sync",                      catchAsync(GoogleFormsController.syncNewResponses));

// ─── Watch Management (mark forms to poll for new responses) ─────────────────
router.get("/watches",                    catchAsync(GoogleFormsController.listWatches));
router.post("/forms/:formId/watch",       catchAsync(GoogleFormsController.watchForm));
router.delete("/forms/:formId/watch",     catchAsync(GoogleFormsController.unwatchForm));

export default router;
