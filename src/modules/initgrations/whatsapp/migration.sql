-- ─── WhatsApp Engine: Database Migration ─────────────────────────────────────
-- Run this in your Supabase SQL editor

-- Sessions: one row per user, tracks connection status + webhook config
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  user_id        TEXT        PRIMARY KEY,
  phone_number   TEXT,
  status         TEXT        NOT NULL DEFAULT 'disconnected',
  webhook_url    TEXT,
  webhook_secret TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Baileys auth keys: stores WhatsApp multi-device session credentials
-- Each user can have many key rows (pre-keys, sender keys, creds, etc.)
CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
  user_id   TEXT NOT NULL,
  key_id    TEXT NOT NULL,
  key_data  JSONB NOT NULL,
  PRIMARY KEY (user_id, key_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_whatsapp_auth_keys_user
  ON whatsapp_auth_keys (user_id);

-- Row-level security (optional — enable if using Supabase RLS)
-- ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE whatsapp_auth_keys ENABLE ROW LEVEL SECURITY;
