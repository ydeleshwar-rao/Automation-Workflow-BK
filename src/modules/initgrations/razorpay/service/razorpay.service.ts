import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const RAZORPAY_TIMEOUT_MS = 30_000;
const RAZORPAY_PAGE_SIZE = 100;

// ─── Webhook event names (matching Zapier triggers in screenshot) ─────────────

export const RAZORPAY_EVENTS = {
  PAYMENT_CAPTURED:            "payment.captured",
  PAYMENT_FAILED:              "payment.failed",
  INVOICE_PAID:                "invoice.paid",
  INVOICE_PARTIALLY_PAID:      "invoice.partially_paid",
  PAYMENT_LINK_PAID:           "payment_link.paid",
  PAYMENT_LINK_PARTIALLY_PAID: "payment_link.partially_paid",
  PAYMENT_PAGE_PAID:           "payment_page.paid",
} as const;

export type RazorpayEvent = typeof RAZORPAY_EVENTS[keyof typeof RAZORPAY_EVENTS];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RazorpayIntegrationRow {
  user_id: string;
  key_id: string;
  key_secret: string;
  webhook_secret: string | null;
  razorpay_webhook_id: string | null;
}

// ─── Axios client (Basic Auth with key_id:key_secret) ─────────────────────────

const getClient = (keyId: string, keySecret: string): AxiosInstance =>
  axios.create({
    baseURL: RAZORPAY_API_BASE,
    timeout: RAZORPAY_TIMEOUT_MS,
    auth: { username: keyId, password: keySecret },
    headers: { "Content-Type": "application/json" },
  });

const getCredentials = async (userId: string): Promise<RazorpayIntegrationRow> => {
  const { data, error } = await supabase
    .from("razorpay_integrations")
    .select("user_id, key_id, key_secret, webhook_secret, razorpay_webhook_id")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(404, "Razorpay not connected. Please add your API keys first.");
  }
  return data as RazorpayIntegrationRow;
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class RazorpayService {
  // ─── Connect (save API keys) ─────────────────────────────────────────────

  static async connect(userId: string, keyId: string, keySecret: string) {
    // Verify keys are valid by calling a lightweight endpoint
    try {
      await axios.get(`${RAZORPAY_API_BASE}/payments?count=1`, {
        auth: { username: keyId, password: keySecret },
        timeout: RAZORPAY_TIMEOUT_MS,
      });
    } catch (err: any) {
      if (err?.response?.status === 401) {
        throw new ApiError(401, "Invalid Razorpay API keys. Please check key_id and key_secret.");
      }
      throw new ApiError(400, `Razorpay key validation failed: ${err.message}`);
    }

    const webhookSecret = crypto.randomBytes(24).toString("hex");

    const { error } = await supabase.from("razorpay_integrations").upsert({
      user_id: userId,
      key_id: keyId,
      key_secret: keySecret,
      webhook_secret: webhookSecret,
    });

    if (error) throw new ApiError(500, `Failed to save Razorpay credentials: ${error.message}`);

    console.log(`[Razorpay] ✅ Connected user=${userId}`);

    return {
      connected: true,
      webhook_url: `${process.env.BACKEND_URL}/razorpay/webhook/${userId}`,
      webhook_secret: webhookSecret,
      message: "Add the webhook_url and webhook_secret to your Razorpay Dashboard → Webhooks.",
    };
  }

  static async getConnectionStatus(userId: string) {
    const { data } = await supabase
      .from("razorpay_integrations")
      .select("user_id, key_id, webhook_secret, razorpay_webhook_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) return { connected: false };

    return {
      connected: true,
      key_id: data.key_id,
      webhook_url: `${process.env.BACKEND_URL}/razorpay/webhook/${userId}`,
      webhook_secret: data.webhook_secret,
      razorpay_webhook_id: data.razorpay_webhook_id,
    };
  }

  static async disconnect(userId: string) {
    await supabase.from("razorpay_integrations").delete().eq("user_id", userId);

    await Promise.allSettled([
      supabase.from("razorpay_payments").delete().eq("user_id", userId),
      supabase.from("razorpay_invoices").delete().eq("user_id", userId),
      supabase.from("razorpay_payment_links").delete().eq("user_id", userId),
      supabase.from("razorpay_events").delete().eq("user_id", userId),
    ]);

    return { disconnected: true };
  }

  // ─── Auto-register webhook on Razorpay (optional) ────────────────────────
  // Razorpay allows creating webhooks via their API.
  // Users can also add the webhook URL manually in their Dashboard.

  static async registerWebhook(userId: string) {
    const creds = await getCredentials(userId);
    const client = getClient(creds.key_id, creds.key_secret);

    const webhookUrl = `${process.env.BACKEND_URL}/razorpay/webhook/${userId}`;

    const events: Record<string, boolean> = {};
    Object.values(RAZORPAY_EVENTS).forEach((e) => { events[e] = true; });

    try {
      const { data } = await client.post(`/webhooks`, {
        url: webhookUrl,
        secret: creds.webhook_secret,
        alert_email: "",
        active: true,
        events,
      });

      await supabase
        .from("razorpay_integrations")
        .update({ razorpay_webhook_id: data.id })
        .eq("user_id", userId);

      return { registered: true, webhook_id: data.id, webhook_url: webhookUrl };
    } catch (err: any) {
      const msg = err?.response?.data?.description || err.message;
      throw new ApiError(400, `Webhook registration failed: ${msg}`);
    }
  }

  // ─── Webhook Signature Verification ──────────────────────────────────────

  static verifySignature(
    rawBody: Buffer | string,
    signature: string,
    secret: string
  ): boolean {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return expected === signature;
  }

  // ─── Incoming Webhook Handler ─────────────────────────────────────────────
  // All 7 Zapier triggers come through here as real-time Instant events.

  static async handleWebhookEvent(
    userId: string,
    event: string,
    payload: Record<string, any>
  ) {
    const eventId = payload.payload?.payment?.entity?.id
      ?? payload.payload?.invoice?.entity?.id
      ?? payload.payload?.payment_link?.entity?.id
      ?? payload.payload?.payment_page?.entity?.id
      ?? `${event}_${Date.now()}`;

    // Save raw event to DB
    await supabase.from("razorpay_events").upsert(
      {
        user_id: userId,
        event_id: eventId,
        event_type: event,
        event_data: payload,
        received_at: new Date().toISOString(),
      },
      { onConflict: "user_id,event_id" }
    );

    // Fan out to resource-specific tables
    switch (event) {
      case RAZORPAY_EVENTS.PAYMENT_CAPTURED:
      case RAZORPAY_EVENTS.PAYMENT_FAILED: {
        const payment = payload.payload?.payment?.entity;
        if (payment) {
          await supabase.from("razorpay_payments").upsert(
            {
              user_id: userId,
              razorpay_id: payment.id,
              order_id: payment.order_id,
              amount: payment.amount,
              currency: payment.currency,
              status: payment.status,
              method: payment.method,
              email: payment.email,
              contact: payment.contact,
              description: payment.description,
              captured_at: payment.captured_at
                ? new Date(payment.captured_at * 1000).toISOString()
                : null,
              raw: payment,
            },
            { onConflict: "user_id,razorpay_id" }
          );
        }
        break;
      }

      case RAZORPAY_EVENTS.INVOICE_PAID:
      case RAZORPAY_EVENTS.INVOICE_PARTIALLY_PAID: {
        const invoice = payload.payload?.invoice?.entity;
        if (invoice) {
          await supabase.from("razorpay_invoices").upsert(
            {
              user_id: userId,
              razorpay_id: invoice.id,
              invoice_number: invoice.invoice_number,
              customer_name: invoice.customer_details?.name,
              customer_email: invoice.customer_details?.email,
              amount: invoice.amount,
              amount_paid: invoice.amount_paid,
              amount_due: invoice.amount_due,
              currency: invoice.currency,
              status: invoice.status,
              date: invoice.date
                ? new Date(invoice.date * 1000).toISOString()
                : null,
              raw: invoice,
            },
            { onConflict: "user_id,razorpay_id" }
          );
        }
        break;
      }

      case RAZORPAY_EVENTS.PAYMENT_LINK_PAID:
      case RAZORPAY_EVENTS.PAYMENT_LINK_PARTIALLY_PAID:
      case RAZORPAY_EVENTS.PAYMENT_PAGE_PAID: {
        const entity =
          payload.payload?.payment_link?.entity ??
          payload.payload?.payment_page?.entity;
        if (entity) {
          await supabase.from("razorpay_payment_links").upsert(
            {
              user_id: userId,
              razorpay_id: entity.id,
              amount: entity.amount,
              amount_paid: entity.amount_paid,
              currency: entity.currency,
              status: entity.status,
              description: entity.description,
              short_url: entity.short_url,
              customer_name: entity.customer?.name,
              customer_email: entity.customer?.email,
              customer_contact: entity.customer?.contact,
              event_type: event,
              raw: entity,
            },
            { onConflict: "user_id,razorpay_id" }
          );
        }
        break;
      }
    }

    console.log(`[Razorpay] 📥 Event=${event} user=${userId} id=${eventId}`);
    return { received: true, event, event_id: eventId };
  }

  // ─── Sync: Fetch from Razorpay API ───────────────────────────────────────

  static async syncPayments(userId: string) {
    const creds = await getCredentials(userId);
    const client = getClient(creds.key_id, creds.key_secret);
    const records: any[] = [];
    let skip = 0;

    while (true) {
      const { data } = await client.get(`/payments`, {
        params: { count: RAZORPAY_PAGE_SIZE, skip },
      });
      const items: any[] = data.items ?? [];
      records.push(...items);
      if (items.length < RAZORPAY_PAGE_SIZE) break;
      skip += RAZORPAY_PAGE_SIZE;
    }

    if (records.length) {
      await supabase.from("razorpay_payments").upsert(
        records.map((p) => ({
          user_id: userId,
          razorpay_id: p.id,
          order_id: p.order_id,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          method: p.method,
          email: p.email,
          contact: p.contact,
          description: p.description,
          captured_at: p.captured_at
            ? new Date(p.captured_at * 1000).toISOString()
            : null,
          raw: p,
        })),
        { onConflict: "user_id,razorpay_id" }
      );
    }

    return { synced: records.length };
  }

  static async syncInvoices(userId: string) {
    const creds = await getCredentials(userId);
    const client = getClient(creds.key_id, creds.key_secret);
    const records: any[] = [];
    let skip = 0;

    while (true) {
      const { data } = await client.get(`/invoices`, {
        params: { count: RAZORPAY_PAGE_SIZE, skip },
      });
      const items: any[] = data.items ?? [];
      records.push(...items);
      if (items.length < RAZORPAY_PAGE_SIZE) break;
      skip += RAZORPAY_PAGE_SIZE;
    }

    if (records.length) {
      await supabase.from("razorpay_invoices").upsert(
        records.map((inv) => ({
          user_id: userId,
          razorpay_id: inv.id,
          invoice_number: inv.invoice_number,
          customer_name: inv.customer_details?.name,
          customer_email: inv.customer_details?.email,
          amount: inv.amount,
          amount_paid: inv.amount_paid,
          amount_due: inv.amount_due,
          currency: inv.currency,
          status: inv.status,
          date: inv.date ? new Date(inv.date * 1000).toISOString() : null,
          raw: inv,
        })),
        { onConflict: "user_id,razorpay_id" }
      );
    }

    return { synced: records.length };
  }

  static async syncPaymentLinks(userId: string) {
    const creds = await getCredentials(userId);
    const client = getClient(creds.key_id, creds.key_secret);
    const records: any[] = [];
    let skip = 0;

    while (true) {
      const { data } = await client.get(`/payment_links`, {
        params: { count: RAZORPAY_PAGE_SIZE, skip },
      });
      const items: any[] = data.items ?? [];
      records.push(...items);
      if (items.length < RAZORPAY_PAGE_SIZE) break;
      skip += RAZORPAY_PAGE_SIZE;
    }

    if (records.length) {
      await supabase.from("razorpay_payment_links").upsert(
        records.map((pl) => ({
          user_id: userId,
          razorpay_id: pl.id,
          amount: pl.amount,
          amount_paid: pl.amount_paid,
          currency: pl.currency,
          status: pl.status,
          description: pl.description,
          short_url: pl.short_url,
          customer_name: pl.customer?.name,
          customer_email: pl.customer?.email,
          customer_contact: pl.customer?.contact,
          event_type: "payment_link",
          raw: pl,
        })),
        { onConflict: "user_id,razorpay_id" }
      );
    }

    return { synced: records.length };
  }

  static async syncAll(userId: string) {
    const [payments, invoices, paymentLinks] = await Promise.allSettled([
      RazorpayService.syncPayments(userId),
      RazorpayService.syncInvoices(userId),
      RazorpayService.syncPaymentLinks(userId),
    ]);

    return {
      payments: payments.status === "fulfilled" ? payments.value : { error: (payments as any).reason?.message },
      invoices: invoices.status === "fulfilled" ? invoices.value : { error: (invoices as any).reason?.message },
      payment_links: paymentLinks.status === "fulfilled" ? paymentLinks.value : { error: (paymentLinks as any).reason?.message },
    };
  }

  // ─── DB reads ─────────────────────────────────────────────────────────────

  static async getPayments(userId: string) {
    const { data, error } = await supabase
      .from("razorpay_payments")
      .select("*")
      .eq("user_id", userId)
      .order("captured_at", { ascending: false });
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getInvoices(userId: string) {
    const { data, error } = await supabase
      .from("razorpay_invoices")
      .select("*")
      .eq("user_id", userId)
      .order("date", { ascending: false });
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getPaymentLinks(userId: string) {
    const { data, error } = await supabase
      .from("razorpay_payment_links")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getEvents(userId: string, eventType?: string) {
    let query = supabase
      .from("razorpay_events")
      .select("*")
      .eq("user_id", userId)
      .order("received_at", { ascending: false });

    if (eventType) query = query.eq("event_type", eventType);

    const { data, error } = await query;
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }
}
