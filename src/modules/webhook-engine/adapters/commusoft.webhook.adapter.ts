import axios from "axios";
import crypto from "crypto";
import type {
  WebhookAdapter,
  WebhookEventNormalized,
  SubscribeResult,
} from "./adapter.interface.js";
import { getParams } from "../../initgrations/commusoft/service/commusoft.service.js";

const COMMUSOFT_BASE = "https://app.commusoft.co.uk/webservice_dev.php/api/v1";

/**
 * Commusoft application name registered as integration partner. Without this,
 * webhook subscribe calls are refused so the polling fallback engages cleanly.
 *
 * Set via env: COMMUSOFT_APP_NAME (NOT the same as COMMUSOFT_APPLICATION_ID,
 * which is the identifier used elsewhere — confirm with the Commusoft partner
 * onboarding which one is the {application} URL segment).
 */
const APPLICATION_NAME = process.env.COMMUSOFT_APP_NAME ?? "";

export class CommusoftWebhookAdapter implements WebhookAdapter {
  async subscribe(
    userId: string,
    eventKey: string,
    targetUrl: string,
    config: Record<string, any>
  ): Promise<SubscribeResult> {
    if (!APPLICATION_NAME) {
      throw new Error(
        "[Commusoft:subscribe] COMMUSOFT_APP_NAME env not set — partner registration pending. " +
        "Falling back to polling engine."
      );
    }

    const params = await getParams(userId);

    // POST /api/v1/integration/{application}/webhooks
    // NOTE: exact body shape will be confirmed via Commusoft partner onboarding.
    // Provisional structure based on public docs.
    const response = await axios.post(
      `${COMMUSOFT_BASE}/integration/${APPLICATION_NAME}/webhooks`,
      {
        event:        eventKey,
        callback_url: targetUrl,
        ...config,
      },
      { params }
    );

    const body = response.data;

    return {
      externalSubscriptionId:
        String(body?.id ?? body?.webhook_id ?? body?.uuid ?? ""),
      // If Commusoft generates a per-subscription HMAC secret, store it;
      // otherwise we generate one for our own bookkeeping (not used unless they
      // sign with it).
      signingSecret:
        body?.secret ?? body?.signing_secret ?? crypto.randomBytes(32).toString("hex"),
    };
  }

  async unsubscribe(
    userId: string,
    externalSubscriptionId: string | null
  ): Promise<void> {
    if (!externalSubscriptionId || !APPLICATION_NAME) return;
    const params = await getParams(userId);

    try {
      await axios.delete(
        `${COMMUSOFT_BASE}/integration/${APPLICATION_NAME}/webhooks/${externalSubscriptionId}`,
        { params }
      );
    } catch (err: any) {
      if (err?.response?.status === 404) return;
      throw err;
    }
  }

  verifyAndNormalize(
    rawBody: string,
    headers: Record<string, string>,
    signingSecret: string | null
  ): WebhookEventNormalized | null {
    if (!signingSecret) {
      console.warn("[Commusoft:verify] no signing secret stored — refusing");
      return null;
    }

    // Provisional HMAC-SHA256 check; exact header name to be confirmed
    // during partner onboarding.
    const sig =
      headers["x-commusoft-signature"] ||
      headers["X-Commusoft-Signature"] ||
      headers["x-signature"];

    if (!sig) {
      console.warn("[Commusoft:verify] no signature header");
      return null;
    }

    const computed = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody, "utf8")
      .digest("hex");

    let ok = false;
    try {
      ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(String(sig)));
    } catch {
      ok = false;
    }
    if (!ok) {
      console.warn("[Commusoft:verify] signature mismatch");
      return null;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    return {
      externalId:
        payload.eventId ||
        payload.id ||
        `${payload.event}-${payload.timestamp ?? Date.now()}`,
      eventType: payload.event,
      data: payload.data || payload.job || payload,
      receivedAt: payload.timestamp || new Date().toISOString(),
    };
  }
}
