import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import { useSupabaseAuthState } from "../utils/auth.store.js";
import { dispatchWebhook } from "../utils/webhook.dispatcher.js";
import { supabase } from "../../../../config/db.config.js";
import type { WAStatus } from "../types/whatsapp.types.js";

// ─── Session registry (in-memory) ────────────────────────────────────────────

export interface WASession {
  socket: WASocket;
  status: WAStatus;
  qrCode: string | null;
  phoneNumber: string | null;
}

const sessions = new Map<string, WASession>();

// Silent logger — Baileys is very noisy by default
const logger = pino({ level: "silent" });

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getWebhookConfig(userId: string) {
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("webhook_url, webhook_secret")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

async function upsertStatus(
  userId: string,
  status: WAStatus,
  phoneNumber?: string | null
) {
  await supabase.from("whatsapp_sessions").upsert(
    {
      user_id: userId,
      status,
      ...(phoneNumber !== undefined ? { phone_number: phoneNumber } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export async function createSession(userId: string): Promise<void> {
  const existing = sessions.get(userId);
  if (existing?.status === "connected") return;

  // Close stale socket if any
  if (existing) {
    try { existing.socket.end(undefined); } catch {}
    sessions.delete(userId);
  }

  const { state, saveCreds } = await useSupabaseAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["WhatsApp Engine", "Chrome", "1.0.0"],
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
  });

  sessions.set(userId, {
    socket,
    status: "connecting",
    qrCode: null,
    phoneNumber: null,
  });

  await upsertStatus(userId, "connecting");

  // ─── Persist credentials on every update ──────────────────────────────────
  socket.ev.on("creds.update", saveCreds);

  // ─── Connection state machine ──────────────────────────────────────────────
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const sess = sessions.get(userId);
    if (!sess) return;

    // QR generated — user must scan
    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      sess.qrCode = qrDataUrl;
      sess.status = "qr_ready";
      sessions.set(userId, sess);
      await upsertStatus(userId, "qr_ready");

      const wh = await getWebhookConfig(userId);
      if (wh?.webhook_url) {
        await dispatchWebhook(wh.webhook_url, wh.webhook_secret, {
          user_id: userId,
          event: "qr",
          data: { qr: qrDataUrl },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Connected successfully
    if (connection === "open") {
      const phoneNumber = socket.user?.id?.split(":")[0] ?? null;
      sess.status = "connected";
      sess.qrCode = null;
      sess.phoneNumber = phoneNumber;
      sessions.set(userId, sess);
      await upsertStatus(userId, "connected", phoneNumber);
      console.log(`[WA Engine] ✅ Connected user=${userId} phone=${phoneNumber}`);

      const wh = await getWebhookConfig(userId);
      if (wh?.webhook_url) {
        await dispatchWebhook(wh.webhook_url, wh.webhook_secret, {
          user_id: userId,
          event: "connected",
          data: { phone_number: phoneNumber },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Disconnected
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      sessions.delete(userId);
      await upsertStatus(userId, "disconnected", null);
      console.log(`[WA Engine] Disconnected user=${userId} code=${statusCode} reconnect=${shouldReconnect}`);

      const wh = await getWebhookConfig(userId);
      if (wh?.webhook_url) {
        await dispatchWebhook(wh.webhook_url, wh.webhook_secret, {
          user_id: userId,
          event: "disconnected",
          data: { status_code: statusCode, logged_out: !shouldReconnect },
          timestamp: new Date().toISOString(),
        });
      }

      // Auto-reconnect unless explicitly logged out
      if (shouldReconnect) {
        console.log(`[WA Engine] Reconnecting user=${userId} in 5s...`);
        setTimeout(() => createSession(userId).catch(console.error), 5_000);
      }
    }
  });

  // ─── Incoming messages → dispatch to user webhook ──────────────────────────
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const wh = await getWebhookConfig(userId);
    if (!wh?.webhook_url) return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const messageType = msg.message ? Object.keys(msg.message)[0] : "unknown";

      await dispatchWebhook(wh.webhook_url, wh.webhook_secret, {
        user_id: userId,
        event: "message",
        data: {
          id: msg.key.id,
          from: msg.key.remoteJid,
          push_name: msg.pushName,
          is_group: msg.key.remoteJid?.endsWith("@g.us") ?? false,
          message_type: messageType,
          timestamp: msg.messageTimestamp,
          content: msg.message,
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ─── Message delivery status updates ──────────────────────────────────────
  socket.ev.on("messages.update", async (updates) => {
    const wh = await getWebhookConfig(userId);
    if (!wh?.webhook_url) return;

    for (const upd of updates) {
      if (upd.update.status === undefined) continue;
      await dispatchWebhook(wh.webhook_url, wh.webhook_secret, {
        user_id: userId,
        event: "message_ack",
        data: {
          id: upd.key.id,
          to: upd.key.remoteJid,
          status: upd.update.status, // 0=error,1=pending,2=server,3=delivered,4=read,5=played
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ─── Group participant updates ─────────────────────────────────────────────
  socket.ev.on("group-participants.update", async (update) => {
    const wh = await getWebhookConfig(userId);
    if (!wh?.webhook_url) return;

    await dispatchWebhook(wh.webhook_url, wh.webhook_secret, {
      user_id: userId,
      event: "group_update",
      data: {
        group_jid: update.id,
        action: update.action,
        participants: update.participants,
      },
      timestamp: new Date().toISOString(),
    });
  });
}

// ─── Public accessors ─────────────────────────────────────────────────────────

export function getSession(userId: string): WASession | undefined {
  return sessions.get(userId);
}

export function getAllActiveSessions(): string[] {
  return Array.from(sessions.keys()).filter(
    (uid) => sessions.get(uid)?.status === "connected"
  );
}

export async function terminateSession(userId: string): Promise<void> {
  const sess = sessions.get(userId);
  if (sess) {
    try {
      await sess.socket.logout();
    } catch {}
    try {
      sess.socket.end(undefined);
    } catch {}
    sessions.delete(userId);
  }

  // Wipe stored credentials
  await supabase.from("whatsapp_sessions").delete().eq("user_id", userId);
  await supabase.from("whatsapp_auth_keys").delete().eq("user_id", userId);
}

// ─── Restore persisted sessions on server startup ─────────────────────────────

export async function restoreAllSessions(): Promise<void> {
  const { data: rows } = await supabase
    .from("whatsapp_sessions")
    .select("user_id, status")
    .neq("status", "disconnected");

  if (!rows?.length) return;

  console.log(`[WA Engine] Restoring ${rows.length} session(s)...`);
  await Promise.allSettled(rows.map((r) => createSession(r.user_id)));
}

// ─── JID formatter ────────────────────────────────────────────────────────────

export function formatJid(
  phoneOrId: string,
  type: "user" | "group" = "user"
): string {
  if (phoneOrId.includes("@")) return phoneOrId; // already a JID
  const cleaned = phoneOrId.replace(/[^0-9]/g, "");
  return type === "group" ? `${cleaned}@g.us` : `${cleaned}@s.whatsapp.net`;
}
