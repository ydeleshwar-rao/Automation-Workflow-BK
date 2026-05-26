export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

export interface WASessionRow {
  user_id: string;
  phone_number: string | null;
  status: WAStatus;
  webhook_url: string | null;
  webhook_secret: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Message Payloads ─────────────────────────────────────────────────────────

export interface WASendTextPayload {
  to: string;
  message: string;
}

export interface WASendMediaPayload {
  to: string;
  type: "image" | "video" | "audio" | "document" | "sticker";
  url: string;
  caption?: string;
  filename?: string;
  mimetype?: string;
}

export interface WASendLocationPayload {
  to: string;
  lat: number;
  lng: number;
  name?: string;
  address?: string;
}

export interface WASendContactPayload {
  to: string;
  name: string;
  phone: string;
  org?: string;
}

export interface WASendButtonsPayload {
  to: string;
  text: string;
  footer?: string;
  buttons: Array<{ id: string; text: string }>;
}

export interface WASendListPayload {
  to: string;
  text: string;
  footer?: string;
  title: string;
  buttonText: string;
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

export interface WABulkMessageItem {
  to: string;
  message: string;
  delay_ms?: number;
}

// ─── Group Payloads ───────────────────────────────────────────────────────────

export interface WACreateGroupPayload {
  name: string;
  participants: string[];
}

// ─── Status Payloads ──────────────────────────────────────────────────────────

export interface WATextStatusPayload {
  text: string;
  background_color?: string; // hex e.g. "#000000"
}

// ─── Webhook Event ────────────────────────────────────────────────────────────

export type WAWebhookEventType =
  | "message"
  | "message_ack"
  | "qr"
  | "connected"
  | "disconnected"
  | "group_update"
  | "status_update";

export interface WAWebhookEvent {
  user_id: string;
  event: WAWebhookEventType;
  data: Record<string, any>;
  timestamp: string;
}
