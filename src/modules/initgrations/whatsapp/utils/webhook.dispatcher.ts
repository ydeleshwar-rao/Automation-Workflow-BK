import axios from "axios";
import crypto from "crypto";
import type { WAWebhookEvent } from "../types/whatsapp.types.js";

/**
 * Dispatches a WhatsApp event to a user-configured webhook URL.
 * Signs the payload with HMAC-SHA256 if a secret is provided.
 */
export async function dispatchWebhook(
  webhookUrl: string,
  webhookSecret: string | null,
  event: WAWebhookEvent
): Promise<void> {
  const payload = JSON.stringify(event);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "WhatsAppEngine/1.0",
    "x-wa-event": event.event,
    "x-wa-timestamp": event.timestamp,
  };

  if (webhookSecret) {
    const sig = crypto
      .createHmac("sha256", webhookSecret)
      .update(payload)
      .digest("hex");
    headers["x-wa-signature"] = `sha256=${sig}`;
  }

  try {
    await axios.post(webhookUrl, event, { headers, timeout: 10_000 });
  } catch (err: any) {
    console.warn(`[WA Webhook] Dispatch failed → ${webhookUrl}: ${err.message}`);
  }
}
