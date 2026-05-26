import { Router } from "express";
import { authMiddleware } from "../../../../middlewares/auth.middleware.js";
import { requireRole } from "../../../../middlewares/access.middleware.js";
import { mailSendRateLimiter } from "../../../../middlewares/rateLimiter.js";
import {
  getPublicKeyController,
  createSmtpConnectionController,
  sendEmailController,
  getEmailLogsController,
  getConnectionsController,
} from "../controllers/mail.controller.js";

const router = Router();

// Public — browser must call this before encrypting credentials
router.get("/public-key", getPublicKeyController);

// Admin + developer only — creates a global SMTP connection shared with all users
router.post(
  "/smtpcreate",
  authMiddleware,
  requireRole("admin", "developer"),
  createSmtpConnectionController
);

// Authenticated — any role can list connections, send email, or view their own logs
router.get("/getconnections", authMiddleware, getConnectionsController);
// mailSendRateLimiter prevents SMTP abuse — 30 emails/hour per user
router.post("/send", authMiddleware, mailSendRateLimiter, sendEmailController);
router.get("/logs", authMiddleware, getEmailLogsController);

export default router;
