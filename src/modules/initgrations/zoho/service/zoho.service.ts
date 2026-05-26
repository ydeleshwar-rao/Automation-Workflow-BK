import axios, { AxiosInstance } from "axios";
import { supabase } from "../../../../config/db.config.js";
import { ApiError } from "../../../../utils/ApiError.js";
import { refreshZohoAccessToken } from "../utils/refreshAccessToken.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ZOHO_API_BASE = "https://www.zohoapis.com/inventory/v1";
const ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com";
const ZOHO_PAGE_SIZE = 200;
const ZOHO_API_TIMEOUT_MS = 30_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const refreshLocks = new Map<string, Promise<any>>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZohoIntegrationRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  organization_id: string;
  needs_reauth: boolean;
}

export type ZohoResourceKey = "contacts" | "items" | "invoices" | "salesorders";

export type ZohoResourceSyncResult = {
  status: "synced" | "failed";
  totalRecords?: number;
  syncedCount?: number;
  durationMs?: number;
  error?: string;
};

export type ZohoSyncAllResult = {
  overall: "success" | "partial" | "failed";
  failedEntities: ZohoResourceKey[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
  results: Partial<Record<ZohoResourceKey, ZohoResourceSyncResult>>;
};

// ─── Integration row helpers ──────────────────────────────────────────────────

const getIntegrationRaw = async (userId: string): Promise<ZohoIntegrationRow> => {
  const { data, error } = await supabase
    .from("zoho_inventory_integrations")
    .select(
      "user_id, access_token, refresh_token, expires_at, organization_id, needs_reauth"
    )
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new ApiError(
      404,
      "Zoho Inventory integration not found. Please connect your account first."
    );
  }
  return data as ZohoIntegrationRow;
};

export const getIntegration = async (
  userId: string,
  forceRefresh = false
): Promise<ZohoIntegrationRow> => {
  const row = await getIntegrationRaw(userId);

  if (row.needs_reauth) {
    throw new ApiError(
      401,
      "Zoho connection requires re-authentication. Please reconnect your Zoho Inventory account."
    );
  }

  const expiresAtMs = new Date(row.expires_at).getTime();
  const isExpiringSoon = expiresAtMs <= Date.now() + REFRESH_BUFFER_MS;

  if (!isExpiringSoon && !forceRefresh) return row;

  const lockKey = `zoho:refresh:${userId}`;
  if (refreshLocks.has(lockKey)) {
    await refreshLocks.get(lockKey);
    return await getIntegrationRaw(userId);
  }

  const refreshPromise = refreshZohoAccessToken(userId, row.refresh_token)
    .then(() => getIntegrationRaw(userId))
    .finally(() => refreshLocks.delete(lockKey));

  refreshLocks.set(lockKey, refreshPromise);
  return await refreshPromise;
};

// ─── Axios instance with 401 auto-retry ──────────────────────────────────────

const getAxiosClient = (token: string): AxiosInstance =>
  axios.create({
    baseURL: ZOHO_API_BASE,
    timeout: ZOHO_API_TIMEOUT_MS,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
  });

async function zohoRequest<T>(
  userId: string,
  fn: (client: AxiosInstance, orgId: string) => Promise<T>
): Promise<T> {
  let integration = await getIntegration(userId);
  let client = getAxiosClient(integration.access_token);

  try {
    return await fn(client, integration.organization_id);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      console.warn(`[Zoho] 401 for user=${userId} — forcing token refresh`);
      integration = await getIntegration(userId, true);
      client = getAxiosClient(integration.access_token);
      return await fn(client, integration.organization_id);
    }
    throw err;
  }
}

// ─── Supabase upsert helper ───────────────────────────────────────────────────

async function upsertToSupabase(
  table: string,
  records: any[],
  userId: string
): Promise<void> {
  if (!records.length) return;

  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK).map((r) => ({
      ...r,
      user_id: userId,
    }));

    const { error } = await supabase.from(table).upsert(chunk, {
      onConflict: "user_id,zoho_id",
    });

    if (error) {
      console.error(`[Zoho] upsert failed on ${table}:`, error.message);
    }
  }
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export class ZohoService {
  static getConnectUrl(userId: string): string {
    const clientId = process.env.ZOHO_CLIENT_ID;
    const redirectUri = process.env.ZOHO_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      throw new ApiError(500, "Zoho client config missing (ZOHO_CLIENT_ID / ZOHO_REDIRECT_URI)");
    }

    const scopes = [
      "ZohoInventory.contacts.ALL",
      "ZohoInventory.items.ALL",
      "ZohoInventory.invoices.ALL",
      "ZohoInventory.salesorders.ALL",
    ].join(",");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      access_type: "offline",
      state: Buffer.from(JSON.stringify({ userId })).toString("base64url"),
    });

    return `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?${params.toString()}`;
  }

  static async exchangeCodeForTokens(
    userId: string,
    code: string
  ): Promise<void> {
    const redirectUri = process.env.ZOHO_REDIRECT_URI!;

    const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ZOHO_CLIENT_ID!,
        client_secret: process.env.ZOHO_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const body: any = await res.json();
    if (!res.ok || body.error) {
      throw new ApiError(400, `Zoho OAuth exchange failed: ${body.error || body.message}`);
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + (body.expires_in || 3600));

    // Fetch organization_id
    const orgRes = await axios.get(`${ZOHO_API_BASE}/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${body.access_token}` },
    });

    const orgId: string =
      orgRes.data?.organizations?.[0]?.organization_id ?? "";

    const { error } = await supabase
      .from("zoho_inventory_integrations")
      .upsert({
        user_id: userId,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: expiresAt.toISOString(),
        organization_id: orgId,
        needs_reauth: false,
      });

    if (error) throw new ApiError(500, `Failed to save Zoho tokens: ${error.message}`);

    console.log(`[Zoho] ✅ Connected user=${userId} org=${orgId}`);
  }

  static async getConnectionStatus(userId: string) {
    const { data } = await supabase
      .from("zoho_inventory_integrations")
      .select("user_id, organization_id, needs_reauth, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) return { connected: false };
    return {
      connected: true,
      organization_id: data.organization_id,
      needs_reauth: data.needs_reauth,
      expires_at: data.expires_at,
    };
  }

  static async disconnect(userId: string) {
    const { error } = await supabase
      .from("zoho_inventory_integrations")
      .delete()
      .eq("user_id", userId);

    if (error) throw new ApiError(500, `Failed to disconnect: ${error.message}`);
    return { disconnected: true };
  }

  // ─── Sync: Contacts ──────────────────────────────────────────────────────

  static async syncContacts(userId: string): Promise<ZohoResourceSyncResult> {
    const start = Date.now();
    try {
      const records: any[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const data = await zohoRequest(userId, (client, orgId) =>
          client
            .get(`/contacts`, {
              params: { organization_id: orgId, page, per_page: ZOHO_PAGE_SIZE },
            })
            .then((r) => r.data)
        );

        const contacts: any[] = data.contacts ?? [];
        contacts.forEach((c: any) =>
          records.push({
            zoho_id: String(c.contact_id),
            contact_name: c.contact_name,
            company_name: c.company_name,
            email: c.email,
            phone: c.phone,
            status: c.status,
            contact_type: c.contact_type,
            raw: c,
          })
        );

        hasMore = data.page_context?.has_more_page === true;
        page++;
      }

      await upsertToSupabase("zoho_contacts", records, userId);

      return {
        status: "synced",
        totalRecords: records.length,
        syncedCount: records.length,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { status: "failed", error: err.message, durationMs: Date.now() - start };
    }
  }

  // ─── Sync: Items ─────────────────────────────────────────────────────────

  static async syncItems(userId: string): Promise<ZohoResourceSyncResult> {
    const start = Date.now();
    try {
      const records: any[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const data = await zohoRequest(userId, (client, orgId) =>
          client
            .get(`/items`, {
              params: { organization_id: orgId, page, per_page: ZOHO_PAGE_SIZE },
            })
            .then((r) => r.data)
        );

        const items: any[] = data.items ?? [];
        items.forEach((item: any) =>
          records.push({
            zoho_id: String(item.item_id),
            name: item.name,
            sku: item.sku,
            rate: item.rate,
            status: item.status,
            description: item.description,
            stock_on_hand: item.stock_on_hand,
            unit: item.unit,
            raw: item,
          })
        );

        hasMore = data.page_context?.has_more_page === true;
        page++;
      }

      await upsertToSupabase("zoho_items", records, userId);

      return {
        status: "synced",
        totalRecords: records.length,
        syncedCount: records.length,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { status: "failed", error: err.message, durationMs: Date.now() - start };
    }
  }

  // ─── Sync: Invoices ──────────────────────────────────────────────────────

  static async syncInvoices(userId: string): Promise<ZohoResourceSyncResult> {
    const start = Date.now();
    try {
      const records: any[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const data = await zohoRequest(userId, (client, orgId) =>
          client
            .get(`/invoices`, {
              params: { organization_id: orgId, page, per_page: ZOHO_PAGE_SIZE },
            })
            .then((r) => r.data)
        );

        const invoices: any[] = data.invoices ?? [];
        invoices.forEach((inv: any) =>
          records.push({
            zoho_id: String(inv.invoice_id),
            invoice_number: inv.invoice_number,
            customer_name: inv.customer_name,
            contact_id: String(inv.customer_id),
            status: inv.status,
            date: inv.date,
            due_date: inv.due_date,
            total: inv.total,
            balance: inv.balance,
            raw: inv,
          })
        );

        hasMore = data.page_context?.has_more_page === true;
        page++;
      }

      await upsertToSupabase("zoho_invoices", records, userId);

      return {
        status: "synced",
        totalRecords: records.length,
        syncedCount: records.length,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { status: "failed", error: err.message, durationMs: Date.now() - start };
    }
  }

  // ─── Sync: Sales Orders ──────────────────────────────────────────────────

  static async syncSalesorders(userId: string): Promise<ZohoResourceSyncResult> {
    const start = Date.now();
    try {
      const records: any[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const data = await zohoRequest(userId, (client, orgId) =>
          client
            .get(`/salesorders`, {
              params: { organization_id: orgId, page, per_page: ZOHO_PAGE_SIZE },
            })
            .then((r) => r.data)
        );

        const orders: any[] = data.salesorders ?? [];
        orders.forEach((so: any) =>
          records.push({
            zoho_id: String(so.salesorder_id),
            salesorder_number: so.salesorder_number,
            customer_name: so.customer_name,
            contact_id: String(so.customer_id),
            status: so.status,
            date: so.date,
            shipment_date: so.shipment_date,
            total: so.total,
            raw: so,
          })
        );

        hasMore = data.page_context?.has_more_page === true;
        page++;
      }

      await upsertToSupabase("zoho_salesorders", records, userId);

      return {
        status: "synced",
        totalRecords: records.length,
        syncedCount: records.length,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return { status: "failed", error: err.message, durationMs: Date.now() - start };
    }
  }

  // ─── Sync All ────────────────────────────────────────────────────────────

  static async syncAll(userId: string): Promise<ZohoSyncAllResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const [contacts, items, invoices, salesorders] = await Promise.allSettled([
      ZohoService.syncContacts(userId),
      ZohoService.syncItems(userId),
      ZohoService.syncInvoices(userId),
      ZohoService.syncSalesorders(userId),
    ]);

    const results: ZohoSyncAllResult["results"] = {
      contacts:    contacts.status === "fulfilled" ? contacts.value : { status: "failed", error: (contacts as any).reason?.message },
      items:       items.status === "fulfilled" ? items.value : { status: "failed", error: (items as any).reason?.message },
      invoices:    invoices.status === "fulfilled" ? invoices.value : { status: "failed", error: (invoices as any).reason?.message },
      salesorders: salesorders.status === "fulfilled" ? salesorders.value : { status: "failed", error: (salesorders as any).reason?.message },
    };

    const failedEntities = (
      Object.entries(results) as [ZohoResourceKey, ZohoResourceSyncResult][]
    )
      .filter(([, r]) => r.status === "failed")
      .map(([k]) => k);

    const overall =
      failedEntities.length === 0
        ? "success"
        : failedEntities.length === 4
        ? "failed"
        : "partial";

    return {
      overall,
      failedEntities,
      durationMs: Date.now() - startMs,
      startedAt,
      completedAt: new Date().toISOString(),
      results,
    };
  }

  // ─── DB reads ────────────────────────────────────────────────────────────

  static async getContacts(userId: string) {
    const { data, error } = await supabase
      .from("zoho_contacts")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getItems(userId: string) {
    const { data, error } = await supabase
      .from("zoho_items")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getInvoices(userId: string) {
    const { data, error } = await supabase
      .from("zoho_invoices")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  static async getSalesorders(userId: string) {
    const { data, error } = await supabase
      .from("zoho_salesorders")
      .select("*")
      .eq("user_id", userId);
    if (error) throw new ApiError(500, error.message);
    return data ?? [];
  }

  // ─── Actions: Create ─────────────────────────────────────────────────────

  static async createContact(userId: string, payload: Record<string, any>) {
    return zohoRequest(userId, async (client, orgId) => {
      const { data } = await client.post(`/contacts`, payload, {
        params: { organization_id: orgId },
      });
      if (data.code !== 0) throw new ApiError(400, data.message ?? "Failed to create contact");
      return data.contact;
    });
  }

  static async createItem(userId: string, payload: Record<string, any>) {
    return zohoRequest(userId, async (client, orgId) => {
      const { data } = await client.post(`/items`, payload, {
        params: { organization_id: orgId },
      });
      if (data.code !== 0) throw new ApiError(400, data.message ?? "Failed to create item");
      return data.item;
    });
  }

  static async createInvoice(userId: string, payload: Record<string, any>) {
    return zohoRequest(userId, async (client, orgId) => {
      const { data } = await client.post(`/invoices`, payload, {
        params: { organization_id: orgId },
      });
      if (data.code !== 0) throw new ApiError(400, data.message ?? "Failed to create invoice");
      return data.invoice;
    });
  }

  static async createSalesorder(userId: string, payload: Record<string, any>) {
    return zohoRequest(userId, async (client, orgId) => {
      const { data } = await client.post(`/salesorders`, payload, {
        params: { organization_id: orgId },
      });
      if (data.code !== 0) throw new ApiError(400, data.message ?? "Failed to create salesorder");
      return data.salesorder;
    });
  }
}
