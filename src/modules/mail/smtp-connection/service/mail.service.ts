import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../../../../config/db.config.js";
import { rsaDecrypt, aesEncrypt, aesDecrypt } from "../../../../utils/smtp-crypto.util.js";
import { smtpLogger as log } from "../../../../utils/logger.js";

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Build a lookup: normalized key → value, for fuzzy matching prefixed tokens.
function buildNormMap(data: Record<string, any>): Map<string, string> {
  const m = new Map<string, string>();
  for (const key in data) {
    // Strip node-id prefix like "315896032__" before normalizing
    const bare = key.replace(/^[^_]+__/, "");
    m.set(normalize(bare), String(data[key]));
    m.set(normalize(key), String(data[key]));
  }
  return m;
}

function mapTemplate(html: string, data: Record<string, any>): string {
  const normMap = buildNormMap(data);

  // 1. Resolve {{map:fieldId|label|fallback}} tokens
  let output = html.replace(
    /\{\{map:([^|]*)\|([^|]*)\|([^}]*)\}\}/g,
    (_, fieldId, label, fallback) => {
      const v = data[fieldId] ?? data[label] ?? normMap.get(normalize(fieldId)) ?? normMap.get(normalize(label));
      return v !== undefined ? String(v) : fallback;
    }
  );

  // 2. Resolve exact {{key}} matches
  for (const key in data) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, "g"), String(data[key]));
  }

  // 3. Resolve prefixed tokens like {{315896032__firstName}} by stripping the prefix and fuzzy-matching
  output = output.replace(/\{\{(?!map:)([^}]+)\}\}/g, (match, raw) => {
    // Try stripping node-id prefix
    const bare = raw.replace(/^[^_]+__/, "");
    const val = normMap.get(normalize(bare)) ?? normMap.get(normalize(raw));
    return val !== undefined ? val : match;
  });

  return output;
}

// ── Create SMTP ───────────────────────────────────────────────────────────────
// created_by is injected by the controller from req.user.id (admin/developer only).
// Credentials arrive RSA-encrypted — never plaintext in DevTools.
export async function createSmtpConnection(payload: any) {
  const { name, host, port, username, encrypted_password, use_tls, created_by } = payload;

  const cleanHost = (host as string).trim();
  const cleanUsername = (username as string).trim();

  const plainPassword = rsaDecrypt(encrypted_password);

  const transporter = nodemailer.createTransport({
    host: cleanHost,
    port,
    secure: port === 465,
    auth: { user: cleanUsername, pass: plainPassword },
  });

  log.info("verifying SMTP connection", { host: cleanHost, port, username: cleanUsername, createdBy: created_by });

  await transporter.verify();

  log.info("SMTP verified", { host: cleanHost, port });

  // AES-256-GCM at rest — DB stores only ciphertext
  const storedPassword = aesEncrypt(plainPassword);
  const storedUsername = aesEncrypt(cleanUsername);

  const { data, error } = await supabase
    .from("smtp_connections")
    .insert({
      id: uuidv4(),
      created_by,
      name: name?.trim() ?? cleanUsername,
      host: cleanHost,
      port,
      username: storedUsername,
      encrypted_password: storedPassword,
      use_tls,
    })
    .select("id, created_by, name, host, port, use_tls, status, created_at")
    .single();

  if (error) throw error;

  log.info("SMTP account created", {
    smtpId: data.id,
    name: data.name,
    host: data.host,
    port: data.port,
    useTls: data.use_tls,
    createdBy: data.created_by,
  });

  return { data };
}

// ── Send Email ────────────────────────────────────────────────────────────────
// user_id injected by controller from req.user.id.
// Templates are global (no location_id). Logs are per-user (user_id).
export async function sendAndSaveEmail(payload: any) {
  const {
    smtp_id,
    user_id,
    name,
    subject,
    html_template,
    body,
    to_email,
    cc = [],
    bcc = [],
    attachments = [],
    data = {},
  } = payload;

  if (!smtp_id || !user_id || !to_email || !subject || !html_template) {
    throw new Error("Missing required fields");
  }

  const { data: smtp, error: smtpError } = await supabase
    .from("smtp_connections")
    .select("*")
    .eq("id", smtp_id)
    .eq("status", "active")
    .single();

  if (smtpError || !smtp) {
    log.error("active SMTP not found", { smtpId: smtp_id, userId: user_id, to: to_email });
    throw new Error("Active SMTP not found");
  }

  log.info("SMTP resolved", {
    smtpId: smtp.id,
    smtpName: smtp.name,
    host: smtp.host,
    port: smtp.port,
    userId: user_id,
    to: to_email,
    subject,
  });

  const plainPassword = aesDecrypt(smtp.encrypted_password);
  const plainUsername = aesDecrypt(smtp.username);

  // Templates are global — no location_id
  const templateId = uuidv4();
  const { error: templateError } = await supabase.from("email_templates").insert({
    id: templateId,
    name: name || "Auto Template",
    subject,
    html_template,
    body,
    default_reply_to: plainUsername,
  });

  if (templateError) throw templateError;

  const finalHtml = mapTemplate(html_template, data);
  const finalBody = body ? mapTemplate(body, data) : undefined;

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: plainUsername, pass: plainPassword },
  });

  const logId = uuidv4();

  try {
    await transporter.sendMail({
      from: `"${name || plainUsername}" <${plainUsername}>`,
      to: to_email,
      cc,
      bcc,
      replyTo: plainUsername,
      subject,
      html: finalHtml,
      text: finalBody,
    });

    await supabase.from("email_logs").insert({
      id: logId,
      user_id,
      smtp_id,
      template_id: templateId,
      to_email,
      cc,
      bcc,
      attachments,
      subject,
      status: "success",
      attempt_count: 1,
      error_message: null,
    });

    await supabase.rpc("increment_total_mail_sent", { smtp_id_input: smtp_id });

    log.info("email sent", {
      logId,
      smtpId: smtp.id,
      smtpName: smtp.name,
      host: smtp.host,
      userId: user_id,
      to: to_email,
      subject,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      status: "success",
    });

    return { status: "success" };
  } catch (error: any) {
    await supabase.from("email_logs").insert({
      id: logId,
      user_id,
      smtp_id,
      template_id: templateId,
      to_email,
      cc,
      bcc,
      attachments,
      subject,
      status: "failed",
      attempt_count: 1,
      error_message: error.message,
    });

    await supabase.rpc("increment_total_mail_failed", { smtp_id_input: smtp_id });

    log.error("email send failed", {
      logId,
      smtpId: smtp.id,
      smtpName: smtp.name,
      host: smtp.host,
      userId: user_id,
      to: to_email,
      subject,
      error: error.message,
    });

    return { status: "failed", error: error.message };
  }
}

// ── Connections ───────────────────────────────────────────────────────────────
// Global — all authenticated users see all SMTP connections.
// Never returns username or encrypted_password to the client.
export async function getConnectionsService() {
  const { data } = await supabase
    .from("smtp_connections")
    .select("id, created_by, name, host, port, use_tls, status, total_sent, total_failed, created_at");

  return data ?? [];
}

// ── Logs ──────────────────────────────────────────────────────────────────────
// Each user sees only the emails they triggered.
export async function getEmailLogs(userId: string) {
  const { data } = await supabase
    .from("email_logs")
    .select("*")
    .eq("user_id", userId);

  return data ?? [];
}
