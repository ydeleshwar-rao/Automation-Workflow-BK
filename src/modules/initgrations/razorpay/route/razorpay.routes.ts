import { Router } from "express";
import { catchAsync } from "../../../../utils/catchAsync.js";
import { RazorpayController } from "../controller/razorpay.controller.js";

const router = Router();

// ─── Connect (API Key — no OAuth) ────────────────────────────────────────────
router.post("/connect",      catchAsync(RazorpayController.connect));
router.get("/status",        catchAsync(RazorpayController.connectionStatus));
router.delete("/disconnect", catchAsync(RazorpayController.disconnect));

// ─── Webhook registration on Razorpay (optional — can also set via Dashboard) ─
router.post("/register-webhook", catchAsync(RazorpayController.registerWebhook));

// ─── Sync (Razorpay API → Supabase DB) ───────────────────────────────────────
router.post("/sync",                catchAsync(RazorpayController.syncAll));
router.post("/sync/payments",       catchAsync(RazorpayController.syncPayments));
router.post("/sync/invoices",       catchAsync(RazorpayController.syncInvoices));
router.post("/sync/payment-links",  catchAsync(RazorpayController.syncPaymentLinks));

// ─── Triggers: DB reads ───────────────────────────────────────────────────────
// Trigger: Payment Captured / Payment Failed
router.get("/payments",      catchAsync(RazorpayController.getPayments));

// Trigger: Invoice Paid / Invoice Partially Paid
router.get("/invoices",      catchAsync(RazorpayController.getInvoices));

// Trigger: Payment Link Paid / Partially Paid / Payment Page Paid
router.get("/payment-links", catchAsync(RazorpayController.getPaymentLinks));

// All raw webhook events log (optional ?event_type= filter)
router.get("/events",        catchAsync(RazorpayController.getEvents));

// ─── Incoming Webhook Receiver (PUBLIC — Razorpay posts here instantly) ───────
// No authMiddleware — Razorpay calls this URL directly with HMAC signature
// Handles all 7 Zapier triggers as Instant events:
//   payment.captured | payment.failed
//   invoice.paid | invoice.partially_paid
//   payment_link.paid | payment_link.partially_paid | payment_page.paid
router.post("/webhook/:userId", catchAsync(RazorpayController.incomingWebhook));

export default router;
