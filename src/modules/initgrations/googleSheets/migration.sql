-- ─── Google Sheets Integration: Database Migration ───────────────────────────
-- Run this in your Supabase SQL editor

-- OAuth tokens (one row per user)
CREATE TABLE IF NOT EXISTS google_sheets_integrations (
  user_id       TEXT        PRIMARY KEY,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  needs_reauth  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cached spreadsheet list (synced from Google Drive)
CREATE TABLE IF NOT EXISTS google_sheets_list (
  user_id        TEXT        NOT NULL,
  google_id      TEXT        NOT NULL,  -- spreadsheetId from Google
  spreadsheet_id TEXT        NOT NULL,
  title          TEXT,
  url            TEXT,
  created_time   TIMESTAMPTZ,
  modified_time  TIMESTAMPTZ,
  PRIMARY KEY (user_id, google_id)
);

-- Watch subscriptions (polling triggers)
-- Each watch = one Zapier-style trigger subscription
CREATE TABLE IF NOT EXISTS google_sheet_watches (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  spreadsheet_id TEXT        NOT NULL,
  sheet_name     TEXT        NOT NULL DEFAULT 'Sheet1',
  trigger_type   TEXT        NOT NULL,
  -- trigger_type values:
  --   'new_row'            → New Spreadsheet Row
  --   'new_or_updated_row' → New or Updated Spreadsheet Row
  --   'new_spreadsheet'    → New Spreadsheet
  --   'new_worksheet'      → New Worksheet
  last_row_count INTEGER     NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, spreadsheet_id, sheet_name, trigger_type)
);

-- Cached row data (used for new_or_updated_row diff comparison)
CREATE TABLE IF NOT EXISTS google_sheet_rows (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  spreadsheet_id TEXT        NOT NULL,
  sheet_name     TEXT        NOT NULL,
  row_number     INTEGER     NOT NULL,  -- 1-indexed (row 1 = header, data starts at 2)
  row_data       JSONB       NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, spreadsheet_id, sheet_name, row_number)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_gsheets_watches_user
  ON google_sheet_watches (user_id);

CREATE INDEX IF NOT EXISTS idx_gsheets_rows_lookup
  ON google_sheet_rows (user_id, spreadsheet_id, sheet_name);

CREATE INDEX IF NOT EXISTS idx_gsheets_list_user
  ON google_sheets_list (user_id);
