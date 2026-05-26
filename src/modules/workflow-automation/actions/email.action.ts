import { sendAndSaveEmail } from "../../mail/smtp-connection/service/mail.service.js";

/**
 * handleEmailSend
 *
 * Called by the execution engine when integration_key="email", action_key="send_email".
 *
 * config  → workflow_nodes.config  — static credentials, never changes per-execution
 *           required: { smtp_id, location_id }
 *
 * input   → resolved from field_mappings at runtime — changes per webhook call
 *           expected: { to, subject, body?, htmlBody?, fromName?, cc?, bcc? }
 */
export async function handleEmailSend(
  config: Record<string, any>,
  input: Record<string, any>
): Promise<Record<string, any>> {

  console.log("[EmailAction] Preparing to send email...");

  // Validate required credentials from node config
  if (!config.smtp_id) {
    throw new Error("[EmailAction] Missing smtp_id in workflow_nodes.config. Add smtp_id pointing to an smtp_connections row.");
  }
  if (!config.location_id) {
    throw new Error("[EmailAction] Missing location_id in workflow_nodes.config.");
  }

  // Validate required runtime fields from mappings
  if (!input.to) {
    throw new Error("[EmailAction] Missing 'to' field — ensure a mapping sets destination_field='to'");
  }
  if (!input.subject) {
    throw new Error("[EmailAction] Missing 'subject' field — ensure a mapping sets destination_field='subject'");
  }

  const htmlTemplate = input.htmlBody || `<p>${input.body ?? ""}</p>`;

  console.log("[EmailAction] Sending to:", input.to, "| subject:", input.subject);

  const result = await sendAndSaveEmail({
    smtp_id: config.smtp_id,
    location_id: config.location_id,
    to_email: input.to,
    subject: input.subject,
    html_template: htmlTemplate,
    body: String(input.body ?? ""),
    name: input.fromName ?? "",
    cc: input.cc ? [input.cc] : [],
    bcc: input.bcc ? [input.bcc] : [],
    data: {},
  });

  console.log("[EmailAction] Email sent successfully | to:", input.to);
  return { status: result.status ?? "success", to: input.to, subject: input.subject };
}
