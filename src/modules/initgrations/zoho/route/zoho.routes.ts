import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";
import { ZohoController } from "../controller/zoho.controller.js";

const router = Router();

// ─── OAuth ────────────────────────────────────────────────────────────────────
router.get("/connect",    catchAsync(ZohoController.getConnectUrl));
router.get("/callback",   catchAsync(ZohoController.handleCallback));
router.get("/status",     catchAsync(ZohoController.connectionStatus));
router.delete("/disconnect", catchAsync(ZohoController.disconnect));

// ─── Sync (Zoho API → Supabase) ───────────────────────────────────────────────
router.post("/sync",               catchAsync(ZohoController.syncAll));
router.post("/sync/contacts",      catchAsync(ZohoController.syncContacts));
router.post("/sync/items",         catchAsync(ZohoController.syncItems));
router.post("/sync/invoices",      catchAsync(ZohoController.syncInvoices));
router.post("/sync/salesorders",   catchAsync(ZohoController.syncSalesorders));

// ─── Triggers: GET from DB (Zapier: New Contact, New Item, New Invoice, New Salesorder) ──
router.get("/contacts",    catchAsync(ZohoController.getContacts));
router.get("/items",       catchAsync(ZohoController.getItems));
router.get("/invoices",    catchAsync(ZohoController.getInvoices));
router.get("/salesorders", catchAsync(ZohoController.getSalesorders));

// ─── Actions: CREATE in Zoho (Zapier: Create Contact, Create Item, Create Invoice, Create Salesorder) ──
router.post("/contacts",    catchAsync(ZohoController.createContact));
router.post("/items",       catchAsync(ZohoController.createItem));
router.post("/invoices",    catchAsync(ZohoController.createInvoice));
router.post("/salesorders", catchAsync(ZohoController.createSalesorder));

export default router;
