import makeWASocket, {
  Browsers,
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
  id: string;
  socket: WASocket;
  status: WAStatus;
  qrCode: string | null;
  phoneNumber: string | null;
}

const sessions = new Map<string, WASession>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const sessionStarts = new Map<string, Promise<void>>();

function disconnectReasonName(code: number | undefined): string {
  const match = Object.entries(DisconnectReason).find(([, value]) => value === code);
  return match?.[0] ?? "unknown";
}

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
  const existingStart = sessionStarts.get(userId);
  if (existingStart) return existingStart;

  const start = doCreateSession(userId).finally(() => {
    if (sessionStarts.get(userId) === start) {
      sessionStarts.delete(userId);
    }
  });
  sessionStarts.set(userId, start);
  return start;
}

async function doCreateSession(userId: string): Promise<void> {
  const pendingReconnect = reconnectTimers.get(userId);
  if (pendingReconnect) {
    clearTimeout(pendingReconnect);
    reconnectTimers.delete(userId);
  }

  const existing = sessions.get(userId);
  if (existing?.status === "connected") return;

  // Close stale socket if any
  if (existing) {
    try { existing.socket.end(undefined); } catch {}
    sessions.delete(userId);
  }

  const { state, saveCreds } = await useSupabaseAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let lastCredsSave: Promise<void> = Promise.resolve();
  console.log(`[WA Engine] Starting session user=${userId} version=${version.join(".")} session=${sessionId}`);

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 15_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sessions.set(userId, {
    id: sessionId,
    socket,
    status: "connecting",
    qrCode: null,
    phoneNumber: null,
  });

  await upsertStatus(userId, "connecting");

  // ─── Persist credentials on every update ──────────────────────────────────
  socket.ev.on("creds.update", () => {
    lastCredsSave = saveCreds()
      .then(() => {
        console.log(`[WA Engine] Creds saved user=${userId} session=${sessionId}`);
      })
      .catch((err) => {
        console.error(`[WA Engine] Failed to save creds user=${userId} session=${sessionId}:`, err?.message ?? err);
      });
  });

  // ─── Connection state machine ──────────────────────────────────────────────
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const sess = sessions.get(userId);
    if (!sess || sess.id !== sessionId) return;

    if (connection || qr) {
      console.log(
        `[WA Engine] Update user=${userId} session=${sessionId} connection=${connection ?? "pending"} qr=${qr ? "yes" : "no"}`
      );
    }

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
      const current = sessions.get(userId);
      if (!current || current.id !== sessionId) return;
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
      const current = sessions.get(userId);
      if (!current || current.id !== sessionId) return;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired;

      if (isRestartRequired) {
        try {
          await lastCredsSave;
          await saveCreds();
          console.log(`[WA Engine] Restart creds flushed user=${userId} session=${sessionId}`);
        } catch (err: any) {
          console.error(`[WA Engine] Restart creds flush failed user=${userId} session=${sessionId}:`, err?.message ?? err);
        }
      }

      if (shouldReconnect) {
        sess.status = "connecting";
        sess.qrCode = null;
        sessions.set(userId, sess);
      } else {
        sessions.delete(userId);
      }
      await upsertStatus(userId, shouldReconnect ? "connecting" : "disconnected", shouldReconnect ? undefined : null);
      console.log(
        `[WA Engine] Disconnected user=${userId} code=${statusCode} reason=${disconnectReasonName(statusCode)} reconnect=${shouldReconnect}`
      );

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
        const delayMs = isRestartRequired ? 1_500 : 1_000;
        console.log(`[WA Engine] Reconnecting user=${userId} in ${delayMs}ms...`);
        const timer = setTimeout(() => {
          reconnectTimers.delete(userId);
          createSession(userId).catch(console.error);
        }, delayMs);
        reconnectTimers.set(userId, timer);
      }
    }
  });

  setTimeout(() => {
    const sess = sessions.get(userId);
    if (!sess || sess.id !== sessionId || sess.status === "connected") return;
    console.warn(
      `[WA Engine] Session still not connected after 45s user=${userId} session=${sessionId} status=${sess.status}`
    );
  }, 45_000);

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
  await clearLocalSession(userId);

  // Wipe stored credentials
  await supabase.from("whatsapp_sessions").delete().eq("user_id", userId);
  await supabase.from("whatsapp_auth_keys").delete().eq("user_id", userId);
}

export async function resetSessionForNewQr(userId: string): Promise<void> {
  await clearLocalSession(userId, { logout: false });
  await supabase.from("whatsapp_sessions").delete().eq("user_id", userId);
  await supabase.from("whatsapp_auth_keys").delete().eq("user_id", userId);
}

async function clearLocalSession(
  userId: string,
  options: { logout?: boolean } = {}
): Promise<void> {
  const sess = sessions.get(userId);
  if (sess) {
    if (options.logout !== false) {
      try {
        await sess.socket.logout();
      } catch {}
    }
    try {
      sess.socket.end(undefined);
    } catch {}
    sessions.delete(userId);
  }

  const pendingReconnect = reconnectTimers.get(userId);
  if (pendingReconnect) {
    clearTimeout(pendingReconnect);
    reconnectTimers.delete(userId);
  }
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
