import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";
import { logger } from "../utils/logger.js";

// ─── Tracking Store ───────────────────────────────────────────────────────────

interface RateLimitEvent {
  timestamp: string;
  limiter: string;
  path: string;
  method: string;
  ip: string;
  userId: string | null;
  userEmail: string | null;
  userAgent: string | null;
}

const MAX_EVENTS = 500;
const rateLimitEvents: RateLimitEvent[] = [];

function trackRateLimitHit(req: Request, limiter: string): void {
  const event: RateLimitEvent = {
    timestamp: new Date().toISOString(),
    limiter,
    path: req.originalUrl,
    method: req.method,
    ip: (req.ip ?? req.socket?.remoteAddress ?? "unknown"),
    userId: req.user?.id ?? null,
    userEmail: req.user?.email ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  };

  if (rateLimitEvents.length >= MAX_EVENTS) {
    rateLimitEvents.shift();
  }
  rateLimitEvents.push(event);

  logger.warn("RATE_LIMIT_HIT", event as unknown as Record<string, unknown>);
}

export function getRateLimitEvents(): RateLimitEvent[] {
  return [...rateLimitEvents];
}

// ─── Handler Factory ──────────────────────────────────────────────────────────

function createHandler(limiterName: string) {
  return (req: Request, res: Response): void => {
    trackRateLimitHit(req, limiterName);

    const retryAfter = res.getHeader("Retry-After");

    res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
      code: "RATE_LIMIT_EXCEEDED",
      retryAfter: retryAfter ?? null,
      limiter: limiterName,
    });
  };
}

// ─── IP key helper (handles IPv4-mapped IPv6 like ::ffff:1.2.3.4) ─────────────
const resolveIp = (req: Request): string =>
  req.ip ?? req.socket?.remoteAddress ?? "unknown";

const ipKey = (req: Request) =>
  req.user?.id ?? ipKeyGenerator(resolveIp(req));

const ipOnlyKey = (req: Request) => ipKeyGenerator(resolveIp(req));

// ─── Rate Limiters ────────────────────────────────────────────────────────────

export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_GLOBAL ?? 200),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  handler: createHandler("global"),
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_AUTH ?? 10),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  handler: createHandler("auth"),
});

export const mailSendRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_MAIL_SEND ?? 30),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: createHandler("mail-send"),
});

export const webhookReceiverRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_WEBHOOK_RECEIVER ?? 300),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  handler: createHandler("webhook-receiver"),
});

export const integrationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_INTEGRATION ?? 100),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ipKey,
  handler: createHandler("integration"),
});
