-- ============================================================
-- Job Management — Full Database Setup
-- Run this in: Supabase Dashboard → SQL Editor → Run
-- Safe to run multiple times (CREATE IF NOT EXISTS everywhere)
-- ============================================================

-- ── Enums ─────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "Role" AS ENUM ('admin', 'developer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WebhookMode" AS ENUM ('test', 'live'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WebhookStatus" AS ENUM ('active', 'inactive', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WorkflowTemplateStatus" AS ENUM ('active', 'inactive', 'draft'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WorkflowStatus" AS ENUM ('draft', 'active', 'inactive'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WebhookEventStatus" AS ENUM ('pending', 'processing', 'done', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SmtpStatus" AS ENUM ('active', 'inactive'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── profiles ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "profiles" (
  "id"          UUID           NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  "email"       TEXT           NOT NULL UNIQUE,
  "full_name"   TEXT           NOT NULL DEFAULT '',
  "avatar_url"  TEXT,
  "role"        "Role"         NOT NULL DEFAULT 'developer',
  "is_active"   BOOLEAN        NOT NULL DEFAULT true,
  "created_by"  UUID,
  "created_at"  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "profiles" ADD CONSTRAINT "profiles_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── page_permissions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "page_permissions" (
  "id"          UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     UUID        NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "page_key"    TEXT        NOT NULL,
  "can_view"    BOOLEAN     NOT NULL DEFAULT false,
  "can_edit"    BOOLEAN     NOT NULL DEFAULT false,
  "can_delete"  BOOLEAN     NOT NULL DEFAULT false,
  "granted_by"  UUID        REFERENCES "profiles"("id") ON DELETE SET NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("user_id", "page_key")
);

-- ── servicem8_integrations ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "servicem8_integrations" (
  "id"               UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          UUID        NOT NULL UNIQUE REFERENCES "profiles"("id") ON DELETE CASCADE,
  "access_token"     TEXT        NOT NULL,
  "refresh_token"    TEXT,
  "expires_at"       TIMESTAMPTZ,
  "scopes"           TEXT,
  "sm8_account_uuid" TEXT,
  "needs_reauth"     BOOLEAN     NOT NULL DEFAULT false,
  "last_synced_at"   TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── commusoft_integrations ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "commusoft_integrations" (
  "id"             UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        UUID        NOT NULL UNIQUE REFERENCES "profiles"("id") ON DELETE CASCADE,
  "client_id"      TEXT,
  "username"       TEXT,
  "password"       TEXT,
  "application_id" TEXT,
  "access_token"   TEXT,
  "needs_reauth"   BOOLEAN     NOT NULL DEFAULT false,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── simpro_integrations ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "simpro_integrations" (
  "id"            UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       UUID        NOT NULL UNIQUE REFERENCES "profiles"("id") ON DELETE CASCADE,
  "build_name"    TEXT        NOT NULL DEFAULT '',
  "base_url"      TEXT        NOT NULL DEFAULT '',
  "company_id"    INTEGER     NOT NULL DEFAULT 0,
  "access_token"  TEXT        NOT NULL DEFAULT '',
  "refresh_token" TEXT,
  "expires_at"    TIMESTAMPTZ,
  "scopes"        TEXT,
  "needs_reauth"  BOOLEAN     NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── leadshub_integrations ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "leadshub_integrations" (
  "id"            UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       UUID        NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "company_id"    TEXT,
  "location_id"   TEXT,
  "access_token"  TEXT,
  "refresh_token" TEXT,
  "expires_in"    BIGINT,
  "expires_at"    TIMESTAMPTZ,
  "user_type"     TEXT,
  "is_active"     BOOLEAN     NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── smtp_connections ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "smtp_connections" (
  "id"                 UUID         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            UUID         NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "name"               TEXT         NOT NULL,
  "host"               TEXT         NOT NULL,
  "port"               INTEGER      NOT NULL,
  "username"           TEXT         NOT NULL,
  "encrypted_password" TEXT         NOT NULL,
  "use_tls"            BOOLEAN      NOT NULL DEFAULT true,
  "status"             "SmtpStatus" NOT NULL DEFAULT 'active',
  "total_sent"         INTEGER      NOT NULL DEFAULT 0,
  "total_failed"       INTEGER      NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── workflow_folders ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_folders" (
  "id"         UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "name"       TEXT        NOT NULL,
  "parent_id"  UUID        REFERENCES "workflow_folders"("id"),
  "position"   INTEGER     NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflows ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflows" (
  "id"                     UUID             NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"                UUID             NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "folder_id"              UUID             REFERENCES "workflow_folders"("id") ON DELETE SET NULL,
  "name"                   TEXT             NOT NULL,
  "status"                 "WorkflowStatus" NOT NULL DEFAULT 'draft',
  "version"                INTEGER          NOT NULL DEFAULT 1,
  "tag"                    TEXT,
  "position"               INTEGER          NOT NULL DEFAULT 0,
  "last_edited_by_user_id" UUID             REFERENCES "profiles"("id") ON DELETE SET NULL,
  "last_edited_by_name"    TEXT,
  "last_edited_at"         TIMESTAMPTZ,
  "created_at"             TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- ── webhooks ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhooks" (
  "id"                UUID            NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           UUID            NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "name"              TEXT            NOT NULL,
  "unique_path"       TEXT            NOT NULL UNIQUE,
  "method"            TEXT            NOT NULL DEFAULT 'POST',
  "secret_token"      TEXT,
  "is_active"         BOOLEAN         NOT NULL DEFAULT true,
  "action_type"       TEXT,
  "action_config"     JSONB           NOT NULL DEFAULT '{}',
  "mode"              "WebhookMode"   NOT NULL DEFAULT 'test',
  "status"            "WebhookStatus" NOT NULL DEFAULT 'active',
  "full_url"          TEXT,
  "workflow_id"       UUID            REFERENCES "workflows"("id") ON DELETE SET NULL,
  "last_triggered_at" TIMESTAMPTZ,
  "expires_at"        TIMESTAMPTZ,
  "deleted_at"        TIMESTAMPTZ,
  "created_at"        TIMESTAMPTZ     NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- ── webhook_events ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"              UUID                 NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "webhook_id"      UUID                 REFERENCES "webhooks"("id") ON DELETE SET NULL,
  "request_headers" JSONB,
  "request_body"    JSONB,
  "status"          "WebhookEventStatus" NOT NULL DEFAULT 'pending',
  "error_message"   TEXT,
  "received_at"     TIMESTAMPTZ          NOT NULL DEFAULT now(),
  "processed_at"    TIMESTAMPTZ
);

-- ── workflow_nodes ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_nodes" (
  "id"              UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id"     UUID        NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "type"            TEXT        NOT NULL,
  "integration_key" TEXT        NOT NULL,
  "action_key"      TEXT        NOT NULL,
  "config"          JSONB       NOT NULL DEFAULT '{}',
  "position"        INTEGER     NOT NULL,
  "node_category"   TEXT        NOT NULL DEFAULT 'action',
  "sample_payload"  JSONB       NOT NULL DEFAULT '{}',
  "output_schema"   JSONB       NOT NULL DEFAULT '{}',
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflow_field_mappings ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_field_mappings" (
  "id"               UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_node_id" UUID        NOT NULL UNIQUE REFERENCES "workflow_nodes"("id") ON DELETE CASCADE,
  "mappings"         JSONB       NOT NULL DEFAULT '[]',
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflow_executions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_executions" (
  "id"              UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id"     UUID        REFERENCES "workflows"("id") ON DELETE SET NULL,
  "status"          TEXT        NOT NULL DEFAULT 'running',
  "trigger_payload" JSONB,
  "started_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finished_at"     TIMESTAMPTZ
);

-- ── workflow_execution_logs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_execution_logs" (
  "id"              UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "execution_id"    UUID        NOT NULL REFERENCES "workflow_executions"("id") ON DELETE CASCADE,
  "workflow_id"     UUID,
  "node_id"         UUID        NOT NULL REFERENCES "workflow_nodes"("id") ON DELETE CASCADE,
  "node_position"   INTEGER,
  "integration_key" TEXT,
  "action_key"      TEXT,
  "log_level"       TEXT        NOT NULL DEFAULT 'info',
  "resolved_value"  TEXT,
  "status"          TEXT        NOT NULL,
  "error_message"   TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflow_tags ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_tags" (
  "id"         UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "name"       TEXT        NOT NULL,
  "color"      TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflow_tag_links ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_tag_links" (
  "id"          UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" UUID        NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "tag_id"      UUID        NOT NULL REFERENCES "workflow_tags"("id") ON DELETE CASCADE,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("workflow_id", "tag_id")
);

-- ── integration_webhook_subscriptions ─────────────────────────
CREATE TABLE IF NOT EXISTS "integration_webhook_subscriptions" (
  "id"                       UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id"              UUID        NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "node_id"                  UUID        NOT NULL UNIQUE REFERENCES "workflow_nodes"("id") ON DELETE CASCADE,
  "user_id"                  UUID        NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "integration_key"          TEXT        NOT NULL,
  "event_key"                TEXT        NOT NULL,
  "config"                   JSONB       NOT NULL DEFAULT '{}',
  "external_subscription_id" TEXT,
  "target_path"              TEXT        NOT NULL,
  "signing_secret"           TEXT,
  "is_active"                BOOLEAN     NOT NULL DEFAULT true,
  "last_received_at"         TIMESTAMPTZ,
  "total_received"           INTEGER     NOT NULL DEFAULT 0,
  "error_count"              INTEGER     NOT NULL DEFAULT 0,
  "last_error"               TEXT,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── webhook_event_log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhook_event_log" (
  "id"                UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id"   UUID        NOT NULL REFERENCES "integration_webhook_subscriptions"("id") ON DELETE CASCADE,
  "external_event_id" TEXT,
  "event_type"        TEXT,
  "payload"           JSONB,
  "status"            TEXT        NOT NULL DEFAULT 'received',
  "processed_at"      TIMESTAMPTZ,
  "error"             TEXT,
  "received_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── template_folders ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "template_folders" (
  "id"          UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        TEXT        NOT NULL,
  "description" TEXT,
  "parent_id"   UUID        REFERENCES "template_folders"("id"),
  "created_by"  UUID        REFERENCES "profiles"("id") ON DELETE SET NULL,
  "is_public"   BOOLEAN     NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflow_templates ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_templates" (
  "id"                 UUID                   NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"               TEXT                   NOT NULL,
  "description"        TEXT,
  "category"           TEXT,
  "tag"                TEXT,
  "source_workflow_id" UUID                   REFERENCES "workflows"("id") ON DELETE SET NULL,
  "created_by"         UUID                   REFERENCES "profiles"("id") ON DELETE SET NULL,
  "is_public"          BOOLEAN                NOT NULL DEFAULT false,
  "usage_count"        INTEGER                NOT NULL DEFAULT 0,
  "status"             "WorkflowTemplateStatus" NOT NULL DEFAULT 'active',
  "template_folder_id" UUID                   REFERENCES "template_folders"("id") ON DELETE SET NULL,
  "created_at"         TIMESTAMPTZ            NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ            NOT NULL DEFAULT now()
);

-- ── workflow_template_nodes ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_template_nodes" (
  "id"                   UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id"          UUID        NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "type"                 TEXT        NOT NULL,
  "node_category"        TEXT,
  "integration_key"      TEXT        NOT NULL,
  "action_key"           TEXT,
  "config_schema"        JSONB,
  "required_credentials" JSONB,
  "output_schema"        JSONB,
  "position"             INTEGER     NOT NULL,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── workflow_template_mappings ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "workflow_template_mappings" (
  "id"               UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id"      UUID        NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "template_node_id" UUID        NOT NULL REFERENCES "workflow_template_nodes"("id") ON DELETE CASCADE,
  "mappings"         JSONB,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Auto-update updated_at ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','page_permissions','servicem8_integrations','commusoft_integrations',
    'simpro_integrations','leadshub_integrations','smtp_connections','webhooks',
    'workflow_folders','workflows','workflow_nodes','workflow_tags',
    'integration_webhook_subscriptions','template_folders',
    'workflow_templates','workflow_template_nodes','workflow_template_mappings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_upd ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t, t);
  END LOOP;
END $$;

-- ── Supabase trigger: auto-create profile on new auth user ─────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::"Role", 'developer'),
    true
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
