import { createApp } from "./config/app.config.js";
import { metricsMiddleware, metricsHandler } from "./middlewares/metrics.middleware.js";
import leadsHubRouter from "./modules/leadshub/leadshub.routes.js";
import webhooksRoutes from "./modules/webhooks/dynamicApis/routes/webhook.route.js"
import emailRoutes from "./modules/mail/smtp-connection/routes/mail.routes.js"
import automationRoutes from "./modules/workflow-automation/workflow-automation.routes.js"
import { errorHandler } from "./middlewares/errorHandler.js";

import servicem8Routes from "./modules/initgrations/serviceM8/route/serviceM8.routes.js"
import authRoutes from "./modules/auth/routes/auth.routes.js"
import accessRoutes from "./modules/access/access.routes.js"

import commusoftRoutes from "./modules/initgrations/commusoft/route/commusoft.routes.js"
import simproRoutes from "./modules/initgrations/simpro/route/simpro.routes.js"
import zohoRoutes from "./modules/initgrations/zoho/route/zoho.routes.js"
import whatsappRoutes from "./modules/initgrations/whatsapp/route/whatsapp.routes.js"
import zohoFormsRoutes from "./modules/initgrations/zohoForms/route/zohoForms.routes.js"
import googleFormsRoutes from "./modules/initgrations/googleForms/route/googleForms.routes.js"
import googleSheetsRoutes from "./modules/initgrations/googleSheets/route/googleSheets.routes.js"
import razorpayRoutes from "./modules/initgrations/razorpay/route/razorpay.routes.js"
import bigqueryRoutes from "./modules/bigquery/route/bigqueryClients.routes.js"
import webhookEngineReceiverRoutes from "./modules/webhook-engine/webhook.routes.js"
import pollingRouter from "./modules/polling-engine/polling.routes.js"
import aiWorkflowRouter from "./modules/ai-workflow/ai-workflow.router.js"

import {
  globalRateLimiter,
  integrationRateLimiter,
  getRateLimitEvents,
} from "./middlewares/rateLimiter.js";
import { authMiddleware } from "./middlewares/auth.middleware.js";
import { requireRole } from "./middlewares/access.middleware.js";

const app = createApp();

app.use(metricsMiddleware);
app.get("/metrics", metricsHandler);

// ─── Global rate limiter — applied to every route ────────────────────────────
app.use(globalRateLimiter);

app.use("/auth", authRoutes);           // login / signup / refresh token
app.use("/access", accessRoutes);       // role-based access (clients, assignments, permissions)
app.use("/leadshub", leadsHubRouter);
app.use("/api", webhooksRoutes)
app.use("/mail", emailRoutes)
app.use("/automation", automationRoutes);
app.use("/ai-workflow", authMiddleware, aiWorkflowRouter);

// Third-party integration routes — additional per-user rate limiting
app.use("/servicem8", integrationRateLimiter, servicem8Routes);
app.use("/commusoft", integrationRateLimiter, commusoftRoutes);
app.use("/simpro", integrationRateLimiter, simproRoutes);
app.use("/zoho", integrationRateLimiter, zohoRoutes);
app.use("/whatsapp", authMiddleware, integrationRateLimiter, whatsappRoutes);
app.use("/zoho-forms", integrationRateLimiter, zohoFormsRoutes);
app.use("/google-forms", integrationRateLimiter, googleFormsRoutes);
app.use("/google-sheets", integrationRateLimiter, googleSheetsRoutes);
app.use("/razorpay", integrationRateLimiter, razorpayRoutes);
app.use("/bigquery", integrationRateLimiter, bigqueryRoutes);

// Polling engine (subscriptions + manual poll-now)
app.use("/polling", integrationRateLimiter, pollingRouter);

// Vendor-facing webhook receiver (ServiceM8, GHL, Commusoft push events arrive here)
app.use("/api/webhooks-receiver", webhookEngineReceiverRoutes);

// ─── Admin: rate limit event log (admin / developer only) ────────────────────
app.get(
  "/admin/rate-limit-logs",
  authMiddleware,
  requireRole("admin", "developer"),
  (_req, res) => {
    const events = getRateLimitEvents();
    res.json({ success: true, count: events.length, events });
  }
);

// Global error handler
app.use(errorHandler);

export default app;
