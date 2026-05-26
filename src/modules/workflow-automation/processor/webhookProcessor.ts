import { getLocationIdByUserId } from "../../../common/function.js";
import { supabase } from "../../../config/db.config.js";
import { sendAndSaveEmail } from "../../mail/smtp-connection/service/mail.service.js";
import { processLeadhubCreateAndContact } from "./leadhubProcessor.js";
import { ServiceM8Service } from "../../initgrations/serviceM8/service/serviceM8.service.js";
import { buildDiaryEventPayload } from "../../initgrations/serviceM8/utils/serviceM8DiaryEvent.util.js";
import { CommusoftService } from "../../initgrations/commusoft/service/commusoft.service.js";
import { SimproService } from "../../initgrations/simpro/service/simpro.service.js";
import { workflowLogger as log } from "../../../utils/logger.js";


interface MappingLogEntry {
  mapping_type: string;
  destination_field: string;
  source_field: string | null;
  resolved_value: string | null;
  status: "success" | "failed" | "skipped";
  error_message: string | null;
}

// ─── Find the active workflow linked to a webhook trigger node ─────────────────
export async function findWorkflowByWebhookId(
  webhookId: string
): Promise<{ workflowId: string; triggerNodeId: string } | null> {
  log.info("searching trigger node", { webhookId });

  const { data: node, error } = await supabase
    .from("workflow_nodes")
    .select("id, workflow_id")
    .eq("type", "trigger")
    .eq("integration_key", "webhooks")
    .contains("config", { webhook_id: webhookId })
    .single();

  if (error || !node) {
    log.warn("no trigger node found", {
      webhookId,
      error: error?.message ?? "no data returned",
    });
    return null;
  }

  log.info("trigger node found", { nodeId: node.id, workflowId: node.workflow_id });

  const { data: workflow, error: wfError } = await supabase
    .from("workflows")
    .select("id, status")
    .eq("id", node.workflow_id)
    .eq("status", "active")
    .single();

  if (wfError || !workflow) {
    log.warn("workflow not active or not found", {
      workflowId: node.workflow_id,
      error: wfError?.message ?? "workflow status is not 'active'",
    });
    return null;
  }

  log.info("active workflow confirmed", { workflowId: workflow.id });
  return {
    workflowId: workflow.id,
    triggerNodeId: node.id,
  };
}

// ─── Core execution engine ─────────────────────────────────────────────────────
export async function executeWorkflow(
  workflowId: string,
  triggerData: Record<string, any>
): Promise<{ success: boolean; error?: string }> {
  let executionId: string | null = null;

  log.info("START", { workflowId, triggerFields: Object.keys(triggerData) });

  try {
    // ── STEP 1: Create execution record ──────────────────────────────────────
    const { data: execution, error: execError } = await supabase
      .from("workflow_executions")
      .insert({
        workflow_id: workflowId,
        status: "running",
        trigger_payload: triggerData,
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (execError) throw new Error(execError.message);
    executionId = execution.id;
    log.info("execution record created", { executionId, workflowId });

    // ── STEP 2: Fetch nodes ordered by position ───────────────────────────────
    const { data: nodes, error: nodesError } = await supabase
      .from("workflow_nodes")
      .select("*")
      .eq("workflow_id", workflowId)
      .order("position", { ascending: true });

    if (nodesError) throw new Error(nodesError.message);
    if (!nodes || nodes.length === 0) throw new Error("No nodes found for this workflow");

    // Fetch user_id from workflows table (workflow_nodes does not store user_id)
    const { data: workflowMeta } = await supabase
      .from("workflows")
      .select("user_id")
      .eq("id", workflowId)
      .single();
    const workflowUserId: string | null = workflowMeta?.user_id ?? null;
    nodes.forEach((n) => (n.user_id = workflowUserId));

    log.info("nodes fetched", {
      executionId,
      workflowId,
      count: nodes.length,
      nodes: nodes.map((n) => `${n.type}/${n.integration_key}`),
    });

    // ── STEP 3: Build output map — each node's resolved output is stored here ─
    const nodeOutputsMap = new Map<string, Record<string, any>>();
    const stepResults: any[] = [];

    // ── STEP 4: Process nodes in sequence ────────────────────────────────────
    for (const node of nodes) {
      log.info("processing node", {
        executionId,
        workflowId,
        nodeId: node.id,
        position: node.position,
        type: node.type,
        integration: node.integration_key,
        action: node.action_key,
      });

      // ── Trigger node: seed the output map with raw incoming webhook data ───
      if (node.type === "trigger") {
        nodeOutputsMap.set(node.id, triggerData);
        stepResults.push({
          node_id: node.id,
          type: "trigger",
          output: triggerData,
          status: "completed",
        });
        log.info("trigger node seeded", { executionId, nodeId: node.id });
        continue;
      }

      // ── Action node: resolve field mappings ───────────────────────────────
      const { data: mappingRow, error: mappingError } = await supabase
        .from("workflow_field_mappings")
        .select("mappings")
        .eq("workflow_node_id", node.id)
        .maybeSingle();

      if (mappingError) {
        log.warn("failed to fetch field_mappings", { executionId, nodeId: node.id, error: mappingError.message });
      }
      const mappings: any[] = mappingRow?.mappings ?? [];

      // Start resolved input with static node config (credentials, accountId, etc.)
      const resolvedInput: Record<string, any> = { ...(node.sample_payload || {}) };

      // Collect mapping-level log entries for this node
      const mappingLogs: MappingLogEntry[] = [];

      if (mappings.length > 0) {
        log.debug("resolving field mappings", { executionId, nodeId: node.id, count: mappings.length });

        for (const mapping of mappings) {
          if (mapping.mapping_type === "static") {
            resolvedInput[mapping.destination_field] = mapping.static_value;
            mappingLogs.push({
              mapping_type: "static",
              destination_field: mapping.destination_field,
              source_field: null,
              resolved_value: JSON.stringify(mapping.static_value),
              status: "success",
              error_message: null,
            });
            log.debug("mapping static", {
              executionId,
              nodeId: node.id,
              destination: mapping.destination_field,
              value: mapping.static_value,
            });

          } else if (mapping.mapping_type === "template") {
            const template: string = mapping.template ?? "";
            const sourceOutput = mapping.source_node_id
              ? nodeOutputsMap.get(mapping.source_node_id)
              : undefined;

            let missingSource = false;
            const resolved = template.replace(
              /\{\{map:([^|]*)\|[^|]*\|([^}]*)\}\}/g,
              (_full, srcField: string, fallback: string) => {
                const key = srcField.trim();
                if (!sourceOutput) {
                  missingSource = true;
                  return fallback;
                }
                const v = getNestedValue(sourceOutput, key);
                if (v === undefined || v === null) {
                  missingSource = true;
                  return fallback;
                }
                return String(v);
              }
            );

            resolvedInput[mapping.destination_field] = resolved;
            mappingLogs.push({
              mapping_type: "template",
              destination_field: mapping.destination_field,
              source_field: null,
              resolved_value: JSON.stringify(resolved),
              status: missingSource ? "skipped" : "success",
              error_message: missingSource
                ? `One or more {{map:...}} tokens in template could not be resolved — fell back to sample value`
                : null,
            });
            log.debug("mapping template", {
              executionId,
              nodeId: node.id,
              destination: mapping.destination_field,
              resolved,
              missingSource,
            });

          } else if (mapping.mapping_type === "dynamic") {
            if (!mapping.source_node_id) {
              log.warn("mapping dynamic skip — no source_node_id", {
                executionId,
                nodeId: node.id,
                destination: mapping.destination_field,
              });
              resolvedInput[mapping.destination_field] = null;
              mappingLogs.push({
                mapping_type: "dynamic",
                destination_field: mapping.destination_field,
                source_field: mapping.source_field ?? null,
                resolved_value: null,
                status: "skipped",
                error_message: "No source_node_id configured on this mapping",
              });
              continue;
            }

            const sourceOutput = nodeOutputsMap.get(mapping.source_node_id);

            if (!sourceOutput) {
              log.warn("mapping dynamic skip — source node output not found", {
                executionId,
                nodeId: node.id,
                destination: mapping.destination_field,
                sourceNodeId: mapping.source_node_id,
                availableNodeIds: [...nodeOutputsMap.keys()],
              });
              resolvedInput[mapping.destination_field] = null;
              mappingLogs.push({
                mapping_type: "dynamic",
                destination_field: mapping.destination_field,
                source_field: mapping.source_field ?? null,
                resolved_value: null,
                status: "skipped",
                error_message: `Source node output not found for source_node_id=${mapping.source_node_id}`,
              });
              continue;
            }

            const resolvedValue = getNestedValue(sourceOutput, mapping.source_field);
            resolvedInput[mapping.destination_field] = resolvedValue !== undefined ? resolvedValue : null;

            mappingLogs.push({
              mapping_type: "dynamic",
              destination_field: mapping.destination_field,
              source_field: mapping.source_field ?? null,
              resolved_value: resolvedValue !== undefined ? JSON.stringify(resolvedValue) : null,
              status: resolvedValue !== undefined ? "success" : "skipped",
              error_message: resolvedValue === undefined
                ? `Field "${mapping.source_field}" not found in source node output`
                : null,
            });

            log.debug("mapping dynamic", {
              executionId,
              nodeId: node.id,
              sourceNodeId: mapping.source_node_id,
              sourceField: mapping.source_field,
              destination: mapping.destination_field,
              resolved: resolvedValue !== undefined ? resolvedValue : null,
            });

          } else {
            log.warn("unknown mapping_type", {
              executionId,
              nodeId: node.id,
              mappingType: mapping.mapping_type,
              destination: mapping.destination_field,
            });
            mappingLogs.push({
              mapping_type: mapping.mapping_type,
              destination_field: mapping.destination_field,
              source_field: null,
              resolved_value: null,
              status: "skipped",
              error_message: `Unknown mapping_type="${mapping.mapping_type}"`,
            });
          }
        }
      } else {
        log.warn("no field_mappings — falling back to raw triggerData", { executionId, nodeId: node.id });
        Object.assign(resolvedInput, triggerData);
      }

      log.debug("resolved input", { executionId, nodeId: node.id, fields: Object.keys(resolvedInput) });

      const actionInput =
        node.integration_key === "commusoft" && node.action_key === "create_opportunity"
          ? enrichCommusoftOpportunityInput(resolvedInput, nodeOutputsMap, triggerData)
          : resolvedInput;

      // ── Execute the action ────────────────────────────────────────────────
      log.info("executing action", {
        executionId,
        nodeId: node.id,
        integration: node.integration_key,
        action: node.action_key,
      });

      let actionOutput: Record<string, any>;
      let nodeStatus: "success" | "failed" = "success";
      let nodeError: string | null = null;

      try {
        actionOutput = await executeAction(node, actionInput, triggerData);
        log.info("action success", {
          executionId,
          nodeId: node.id,
          integration: node.integration_key,
          action: node.action_key,
          outputFields: Object.keys(actionOutput),
        });
      } catch (actionErr: any) {
        nodeStatus = "failed";
        nodeError = actionErr.message;
        actionOutput = {};
        log.error("action failed", {
          executionId,
          nodeId: node.id,
          integration: node.integration_key,
          action: node.action_key,
          error: actionErr.message,
        });
      }

      const mappingStatus = mappingLogs.some((ml) => ml.status === "failed")
        ? "failed"
        : mappingLogs.some((ml) => ml.status === "skipped")
        ? "skipped"
        : "success";

      const logRows = [
        ...(mappingLogs.length > 0
          ? [
              {
                execution_id: executionId,
                workflow_id: workflowId,
                node_id: node.id,
                node_position: node.position ?? null,
                integration_key: node.integration_key ?? null,
                action_key: node.action_key ?? null,
                log_level: "mapping",
                resolved_value: JSON.stringify(mappingLogs),
                status: mappingStatus,
                error_message:
                  mappingLogs.find((ml) => ml.error_message)?.error_message ?? null,
              },
            ]
          : []),
        {
          execution_id: executionId,
          workflow_id: workflowId,
          node_id: node.id,
          node_position: node.position ?? null,
          integration_key: node.integration_key ?? null,
          action_key: node.action_key ?? null,
          log_level: "node",
          resolved_value: nodeStatus === "success" ? JSON.stringify(actionOutput) : null,
          status: nodeStatus,
          error_message: nodeError,
        },
      ];

      const { error: logError } = await supabase
        .from("workflow_execution_logs")
        .insert(logRows);

      if (logError) {
        log.warn("failed to save execution logs", { executionId, nodeId: node.id, error: logError.message });
      } else {
        log.debug("execution logs saved", { executionId, nodeId: node.id, rows: logRows.length });
      }

      if (nodeStatus === "failed") {
        throw new Error(nodeError!);
      }

      nodeOutputsMap.set(node.id, actionOutput);

      stepResults.push({
        node_id: node.id,
        type: node.type,
        integration_key: node.integration_key,
        action_key: node.action_key,
        input: actionInput,
        output: actionOutput,
        status: "completed",
      });
    }

    // ── STEP 5: Mark execution completed ─────────────────────────────────────
    await supabase
      .from("workflow_executions")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
      })
      .eq("id", executionId);

    log.info("COMPLETED", { executionId, workflowId, steps: stepResults.length });
    return { success: true };

  } catch (error: any) {
    log.error("WORKFLOW FAILED", { executionId, workflowId, error: error.message });
    if (executionId) {
      await supabase
        .from("workflow_executions")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
        })
        .eq("id", executionId);
    }
    return { success: false, error: error.message };
  }
}

// ─── Resolve dot-notation field paths (e.g. "body.customer.name") ─────────────
function getNestedValue(obj: Record<string, any>, path: string): any {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

function firstNonEmpty(...values: any[]) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function enrichCommusoftOpportunityInput(
  input: Record<string, any>,
  nodeOutputsMap: Map<string, Record<string, any>>,
  triggerData: Record<string, any>
) {
  const enriched = { ...input };
  const outputs = [...nodeOutputsMap.values()];

  if (!firstNonEmpty(enriched.customer_id, enriched.customer_uuid, enriched.customer_name, enriched.email)) {
    for (const output of outputs) {
      const customer = output?.customer ?? output?.data?.customer ?? output;
      enriched.customer_id = firstNonEmpty(
        enriched.customer_id,
        output?.customer_id,
        customer?.customer_id,
        customer?.id,
        customer?.commusoft_id
      );
      enriched.customer_uuid = firstNonEmpty(
        enriched.customer_uuid,
        output?.customer_uuid,
        customer?.uuid
      );
      enriched.customer_name = firstNonEmpty(
        enriched.customer_name,
        customer?.customer_name,
        customer?.name,
        customer?.company_name
      );
      enriched.email = firstNonEmpty(
        enriched.email,
        customer?.email,
        customer?.company_email
      );

      if (firstNonEmpty(enriched.customer_id, enriched.customer_uuid, enriched.customer_name, enriched.email)) {
        break;
      }
    }
  }

  const triggerName = firstNonEmpty(
    triggerData?.fullName,
    triggerData?.full_name,
    triggerData?.name,
    [triggerData?.firstName ?? triggerData?.first_name, triggerData?.lastName ?? triggerData?.last_name]
      .filter(Boolean)
      .join(" ")
  );

  enriched.customer_name = firstNonEmpty(enriched.customer_name, triggerName);
  enriched.email = firstNonEmpty(enriched.email, triggerData?.email, triggerData?.contact?.email);

  return enriched;
}

// ─── Pluggable action executor ─────────────────────────────────────────────────
export async function executeAction(
  node: any,
  input: Record<string, any>,
  triggerData: Record<string, any> = {}
): Promise<Record<string, any>> {
  log.info("action start", {
    integration: node.integration_key,
    action: node.action_key,
    nodeId: node.id,
    inputFields: Object.keys(input),
  });

  // ── Email: send_email ────────────────────────────────────────────────────────
  if (node.integration_key === "email" && node.action_key === "send_email") {
    const smtpId = node.config?.smtp_id ?? node.config?.accountId;
    const locationId = await getLocationIdByUserId(node.user_id);

    if (!smtpId) {
      throw new Error(
        "[Action:email] smtp_id not found in node.config. " +
        "Set config.smtp_id to the ID of the smtp_connections row for this workflow node."
      );
    }
    if (!locationId) {
      throw new Error("[Action:email] location_id not found in node.config or node.client_id.");
    }
    if (!input.to) {
      throw new Error("[Action:email] 'to' field is empty — check the field_mapping for destination_field='to'.");
    }
    if (!input.subject) {
      throw new Error("[Action:email] 'subject' field is empty — check the field_mapping for destination_field='subject'.");
    }

    log.info("sending email", {
      nodeId: node.id,
      smtpId,
      locationId,
      to: input.to,
      subject: input.subject,
    });

    const result = await sendAndSaveEmail({
      smtp_id: smtpId,
      user_id: node.user_id,
      to_email: input.to,
      subject: input.subject,
      html_template: input.htmlBody || `<p>${input.body ?? ""}</p>`,
      body: String(input.body ?? ""),
      name: input.fromName ?? "",
      cc: input.cc ? [input.cc] : [],
      bcc: input.bcc ? [input.bcc] : [],
      data: triggerData,
    });

    log.info("email sent", { nodeId: node.id, to: input.to, status: result?.status ?? "success" });
    return { status: result?.status ?? "success", to: input.to, subject: input.subject };
  }

  // ── Leadshub: add_update_opportunity ────────────────────────────────────────
  if (node.integration_key === "leadshub" && node.action_key === "add_update_opportunity") {
    log.info("delegating to leadshub", { nodeId: node.id });

    const result = await processLeadhubCreateAndContact(node.user_id ?? null, input);

    log.info("leadshub done", {
      nodeId: node.id,
      contactId: result.contactId,
      contactCreated: result.contactCreated,
      opportunityId: result.opportunityId,
      opportunityAction: result.opportunityAction,
    });
    return {
      contactId: result.contactId,
      contactCreated: result.contactCreated,
      opportunityId: result.opportunityId,
      opportunityAction: result.opportunityAction,
    };
  }

  // ── ServiceM8: create_client ────────────────────────────────────────────────
  if ((node.integration_key === "service_m8" || node.integration_key === "servicem8") && node.action_key === "create_client") {
    const t0 = Date.now();
    log.info("service_m8 create_client start", { nodeId: node.id, userId: node.user_id, inputKeys: Object.keys(input) });

    if (!node.user_id) {
      log.error("node.user_id missing", { nodeId: node.id, action: "create_client" });
      throw new Error("[Action:service_m8:create_client] node.user_id missing — cannot resolve ServiceM8 credentials");
    }
    if (!input.name || !String(input.name).trim()) {
      log.error("required field 'name' is empty", { nodeId: node.id, action: "create_client" });
      throw new Error("[Action:service_m8:create_client] required field 'name' is empty");
    }

    const pick = (keys: string[]) =>
      Object.fromEntries(
        keys
          .map((k) => [k, input[k]])
          .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
      );

    const companyPayload = pick([
      "name", "address", "billing_address", "fax_number", "website", "active",
      "abn_number", "address_street", "address_city", "address_state",
      "address_postcode", "address_country",
    ]);
    if ((companyPayload as any).active === undefined) {
      (companyPayload as any).active = 1;
    }

    log.info("service_m8 POST /company.json", { nodeId: node.id, fields: Object.keys(companyPayload) });

    let company: any;
    try {
      company = await ServiceM8Service.createClient(node.user_id, companyPayload);
    } catch (err: any) {
      log.error("service_m8 /company.json failed", {
        nodeId: node.id,
        status: err?.response?.status,
        error: err?.message,
        duration_ms: Date.now() - t0,
      });
      throw err;
    }
    log.info("service_m8 company created", { nodeId: node.id, companyUuid: company?.uuid });

    const contactPayload = pick(["first", "last", "phone", "mobile", "email", "type"]);
    if (input.first_name && !("first" in contactPayload)) (contactPayload as any).first = input.first_name;
    if (input.last_name && !("last" in contactPayload)) (contactPayload as any).last = input.last_name;

    let contact: any = null;
    if (company?.uuid && Object.keys(contactPayload).length > 0) {
      log.info("service_m8 POST /companycontact.json", { nodeId: node.id, fields: Object.keys(contactPayload) });
      try {
        contact = await ServiceM8Service.createCompanyContact(node.user_id, company.uuid, {
          ...contactPayload,
          is_primary_contact: "1",
        });
        log.info("service_m8 contact created", { nodeId: node.id, contactUuid: contact?.uuid });
      } catch (err: any) {
        log.warn("service_m8 /companycontact.json failed — proceeding", {
          nodeId: node.id,
          status: err?.response?.status,
          error: err?.message,
        });
      }
    } else {
      log.info("service_m8 no contact fields — skipping contact create", { nodeId: node.id });
    }

    const result = {
      company_uuid: company?.uuid ?? null,
      contact_uuid: contact?.uuid ?? null,
      created_at: new Date().toISOString(),
    };
    log.info("service_m8 create_client done", { nodeId: node.id, ...result, duration_ms: Date.now() - t0 });
    return result;
  }

  // ── ServiceM8: create_job ───────────────────────────────────────────────────
  if ((node.integration_key === "service_m8" || node.integration_key === "servicem8") && node.action_key === "create_job") {
    log.info("service_m8 create_job start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:service_m8:create_job] node.user_id missing — cannot resolve ServiceM8 credentials");
    }
    if (!input.customer_name || !String(input.customer_name).trim()) {
      throw new Error("[Action:service_m8:create_job] required field 'customer_name' is empty");
    }
    if (!input.job_status || !String(input.job_status).trim()) {
      throw new Error("[Action:service_m8:create_job] required field 'job_status' is empty");
    }

    const nonEmpty = (v: any) =>
      v !== undefined && v !== null && String(v).trim() !== "";

    // 1. Company
    const companyPayload: Record<string, any> = {
      name: String(input.customer_name).trim(),
      active: 1,
    };
    if (nonEmpty(input.billing_address)) companyPayload.billing_address = input.billing_address;

    log.info("service_m8 create_job step 1/4 POST /company.json", { nodeId: node.id });
    const company = await ServiceM8Service.createClient(node.user_id, companyPayload);
    if (!company?.uuid) {
      throw new Error("[Action:service_m8:create_job] company create returned no uuid — aborting");
    }
    log.info("service_m8 company created", { nodeId: node.id, companyUuid: company.uuid });

    // 2. Job contact
    let jobContact: any = null;
    const jobContactPayload: Record<string, any> = {};
    if (nonEmpty(input.job_contact_first_name)) jobContactPayload.first = input.job_contact_first_name;
    if (nonEmpty(input.job_contact_last_name))  jobContactPayload.last  = input.job_contact_last_name;
    if (nonEmpty(input.job_contact_phone))      jobContactPayload.phone = input.job_contact_phone;
    if (nonEmpty(input.job_contact_mobile))     jobContactPayload.mobile = input.job_contact_mobile;
    if (nonEmpty(input.job_contact_email))      jobContactPayload.email = input.job_contact_email;

    if (Object.keys(jobContactPayload).length > 0) {
      jobContactPayload.type = "JOB";
      jobContactPayload.is_primary_contact = "1";
      log.info("service_m8 create_job step 2/4 POST /companycontact.json (JOB)", { nodeId: node.id });
      jobContact = await ServiceM8Service.createCompanyContact(node.user_id, company.uuid, jobContactPayload);
      log.info("service_m8 job contact created", { nodeId: node.id, jobContactUuid: jobContact?.uuid });
    } else {
      log.info("service_m8 create_job step 2/4 — no job contact fields, skipping", { nodeId: node.id });
    }

    // 3. Billing contact
    let billingContact: any = null;
    const billingContactPayload: Record<string, any> = {};
    if (nonEmpty(input.billing_contact_first_name)) billingContactPayload.first = input.billing_contact_first_name;
    if (nonEmpty(input.billing_contact_last_name))  billingContactPayload.last  = input.billing_contact_last_name;
    if (nonEmpty(input.billing_contact_phone))      billingContactPayload.phone = input.billing_contact_phone;
    if (nonEmpty(input.billing_contact_mobile))     billingContactPayload.mobile = input.billing_contact_mobile;
    if (nonEmpty(input.billing_contact_email))      billingContactPayload.email = input.billing_contact_email;

    if (Object.keys(billingContactPayload).length > 0) {
      billingContactPayload.type = "BILLING";
      log.info("service_m8 create_job step 3/4 POST /companycontact.json (BILLING)", { nodeId: node.id });
      billingContact = await ServiceM8Service.createCompanyContact(node.user_id, company.uuid, billingContactPayload);
      log.info("service_m8 billing contact created", { nodeId: node.id, billingContactUuid: billingContact?.uuid });
    } else {
      log.info("service_m8 create_job step 3/4 — no billing contact fields, skipping", { nodeId: node.id });
    }

    // 4. Job
    const jobPayload: Record<string, any> = {
      company_uuid: company.uuid,
      status: String(input.job_status).trim(),
      active: 1,
    };
    if (nonEmpty(input.job_address))           jobPayload.job_address = input.job_address;
    if (nonEmpty(input.billing_address))       jobPayload.billing_address = input.billing_address;
    if (nonEmpty(input.job_description))       jobPayload.job_description = input.job_description;
    if (nonEmpty(input.purchase_order_number)) jobPayload.purchase_order_number = input.purchase_order_number;
    if (nonEmpty(input.work_completed))        jobPayload.work_done_description = input.work_completed;

    log.info("service_m8 create_job step 4/4 POST /job.json", { nodeId: node.id, status: jobPayload.status });
    const job = await ServiceM8Service.createJob(node.user_id, jobPayload);
    log.info("service_m8 job created", { nodeId: node.id, jobUuid: job?.uuid });

    return {
      company_uuid: company.uuid,
      job_contact_uuid: jobContact?.uuid ?? null,
      billing_contact_uuid: billingContact?.uuid ?? null,
      job_uuid: job?.uuid ?? null,
      status: jobPayload.status,
      created_at: new Date().toISOString(),
    };
  }

  // ── ServiceM8: create_diary_event ───────────────────────────────────────────
  if (
    (node.integration_key === "service_m8" || node.integration_key === "servicem8") &&
    node.action_key === "create_diary_event"
  ) {
    const t0 = Date.now();
    log.info("service_m8 create_diary_event start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error(
        "[Action:service_m8:create_diary_event] node.user_id missing — cannot resolve ServiceM8 credentials"
      );
    }

    const payload = buildDiaryEventPayload(input);
    log.info("service_m8 POST /jobactivity.json", { nodeId: node.id });

    const activity = await ServiceM8Service.createDiaryEvent(node.user_id, payload);
    log.info("service_m8 diary event created", { nodeId: node.id, activityUuid: activity?.uuid });

    const result = {
      jobactivity_uuid: activity?.uuid ?? null,
      job_uuid: payload.job_uuid,
      staff_uuid: payload.staff_uuid,
      start_date: payload.start_date,
      end_date: payload.end_date,
      created_at: new Date().toISOString(),
    };
    log.info("service_m8 create_diary_event done", { nodeId: node.id, ...result, duration_ms: Date.now() - t0 });
    return result;
  }

  // ── ServiceM8: move_job_to_queue ────────────────────────────────────────────
  if ((node.integration_key === "service_m8" || node.integration_key === "servicem8") && node.action_key === "move_job_to_queue") {
    const t0 = Date.now();
    log.info("service_m8 move_job_to_queue start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:service_m8:move_job_to_queue] node.user_id missing — cannot resolve ServiceM8 credentials");
    }
    if (!input.job_uuid || !String(input.job_uuid).trim()) {
      throw new Error("[Action:service_m8:move_job_to_queue] required field 'job_uuid' is empty");
    }
    if (!input.queue_uuid || !String(input.queue_uuid).trim()) {
      throw new Error("[Action:service_m8:move_job_to_queue] required field 'queue_uuid' is empty");
    }

    const jobId   = String(input.job_uuid).trim();
    const queueId = String(input.queue_uuid).trim();

    log.info("service_m8 POST /job patch queue", { nodeId: node.id, jobId, queueId });
    await ServiceM8Service.updateJob(node.user_id, jobId, { queue_uuid: queueId });

    const result = {
      job_uuid:    jobId,
      queue_uuid:  queueId,
      updated_at:  new Date().toISOString(),
    };
    log.info("service_m8 move_job_to_queue done", { nodeId: node.id, ...result, duration_ms: Date.now() - t0 });
    return result;
  }

  // ── ServiceM8: update_job ───────────────────────────────────────────────────
  if ((node.integration_key === "service_m8" || node.integration_key === "servicem8") && node.action_key === "update_job") {
    const t0 = Date.now();
    log.info("service_m8 update_job start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:service_m8:update_job] node.user_id missing — cannot resolve ServiceM8 credentials");
    }
    if (!input.job_uuid || !String(input.job_uuid).trim()) {
      throw new Error("[Action:service_m8:update_job] required field 'job_uuid' is empty");
    }

    const jobId = String(input.job_uuid).trim();
    const nonEmpty = (v: any) => v !== undefined && v !== null && String(v).trim() !== "";

    const patch: Record<string, any> = {};
    if (nonEmpty(input.job_status))            patch.status                = String(input.job_status).trim();
    if (nonEmpty(input.queue_uuid))            patch.queue_uuid            = String(input.queue_uuid).trim();
    if (nonEmpty(input.job_address))           patch.job_address           = input.job_address;
    if (nonEmpty(input.billing_address))       patch.billing_address       = input.billing_address;
    if (nonEmpty(input.job_description))       patch.job_description       = input.job_description;
    if (nonEmpty(input.purchase_order_number)) patch.purchase_order_number = input.purchase_order_number;

    if (Object.keys(patch).length === 0) {
      throw new Error("[Action:service_m8:update_job] no fields provided — fill in at least one field to update");
    }

    log.info("service_m8 PATCH /job", { nodeId: node.id, jobId, fields: Object.keys(patch) });
    await ServiceM8Service.updateJob(node.user_id, jobId, patch);

    const result = {
      job_uuid:       jobId,
      fields_updated: Object.keys(patch),
      updated_at:     new Date().toISOString(),
    };
    log.info("service_m8 update_job done", { nodeId: node.id, ...result, duration_ms: Date.now() - t0 });
    return result;
  }

  // ── Simpro: create_client ──────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_client") {
    const t0 = Date.now();
    log.info("simpro create_client start", { nodeId: node.id, userId: node.user_id, inputKeys: Object.keys(input) });

    if (!node.user_id) {
      throw new Error("[Action:simpro:create_client] node.user_id missing — cannot resolve Simpro credentials");
    }

    const customerPayload: Record<string, any> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        dropped.push(k);
        continue;
      }
      customerPayload[k] = v;
    }
    if (dropped.length > 0) {
      log.debug("simpro create_client dropped empty fields", { nodeId: node.id, dropped });
    }

    let customer;
    try {
      customer = await SimproService.createCustomer(node.user_id, customerPayload);
    } catch (err: any) {
      log.error("simpro create_client failed", {
        nodeId: node.id,
        status: err?.response?.status,
        duration_ms: Date.now() - t0,
        error: err?.message,
      });
      throw err;
    }

    const customerId = customer?.ID ?? customer?.id ?? null;
    log.info("simpro create_client done", { nodeId: node.id, customerId, duration_ms: Date.now() - t0 });
    return { customer: customer ?? null, customer_id: customerId, created_at: new Date().toISOString() };
  }

  // ── Simpro: create_job ─────────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_job") {
    const t0 = Date.now();
    log.info("simpro create_job start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:simpro:create_job] node.user_id missing — cannot resolve Simpro credentials");
    }
    if (!input.customer_id && !input.customer_uuid) {
      throw new Error("[Action:simpro:create_job] required field 'customer_id' is empty");
    }

    const jobPayload: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      jobPayload[k] = v;
    }

    try {
      const job = await SimproService.createJob(node.user_id, jobPayload);
      const jobId = job?.ID ?? job?.id ?? null;
      log.info("simpro create_job done", { nodeId: node.id, jobId, duration_ms: Date.now() - t0 });
      return { job: job ?? null, job_id: jobId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_job failed", {
        nodeId: node.id,
        status: err?.response?.status,
        duration_ms: Date.now() - t0,
        error: err?.message,
      });
      throw err;
    }
  }

  // ── Simpro: create_company_customer ───────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_company_customer") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_company_customer] node.user_id missing");
    const payload: Record<string, any> = { customer_type: "company" };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) payload[k] = v;
    }
    try {
      const customer = await SimproService.createCustomer(node.user_id, payload);
      const customerId = customer?.ID ?? customer?.id ?? null;
      log.info("simpro create_company_customer done", { nodeId: node.id, customerId, duration_ms: Date.now() - t0 });
      return { customer: customer ?? null, customer_id: customerId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_company_customer failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: create_individual_customer ────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_individual_customer") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_individual_customer] node.user_id missing");
    const payload: Record<string, any> = { customer_type: "individual" };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) payload[k] = v;
    }
    try {
      const customer = await SimproService.createCustomer(node.user_id, payload);
      const customerId = customer?.ID ?? customer?.id ?? null;
      log.info("simpro create_individual_customer done", { nodeId: node.id, customerId, duration_ms: Date.now() - t0 });
      return { customer: customer ?? null, customer_id: customerId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_individual_customer failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: create_contact ─────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_contact") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_contact] node.user_id missing");
    if (!input.customer_id) throw new Error("[Action:simpro:create_contact] required field 'customer_id' is empty");
    const { customer_id, ...contactFields } = input;
    try {
      const contact = await SimproService.createContact(node.user_id, customer_id, contactFields);
      const contactId = contact?.ID ?? contact?.id ?? null;
      log.info("simpro create_contact done", { nodeId: node.id, contactId, duration_ms: Date.now() - t0 });
      return { contact: contact ?? null, contact_id: contactId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_contact failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: create_lead ────────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_lead") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_lead] node.user_id missing");
    try {
      const lead = await SimproService.createLead(node.user_id, input);
      const leadId = lead?.ID ?? lead?.id ?? null;
      log.info("simpro create_lead done", { nodeId: node.id, leadId, duration_ms: Date.now() - t0 });
      return { lead: lead ?? null, lead_id: leadId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_lead failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: create_schedule_block ─────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_schedule_block") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_schedule_block] node.user_id missing");
    try {
      const schedule = await SimproService.createScheduleBlock(node.user_id, input);
      const scheduleId = schedule?.ID ?? schedule?.id ?? null;
      log.info("simpro create_schedule_block done", { nodeId: node.id, scheduleId, duration_ms: Date.now() - t0 });
      return { schedule: schedule ?? null, schedule_id: scheduleId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_schedule_block failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: create_quote ──────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_quote") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_quote] node.user_id missing");
    try {
      const quote = await SimproService.createQuote(node.user_id, input);
      const quoteId = quote?.ID ?? quote?.id ?? null;
      log.info("simpro create_quote done", { nodeId: node.id, quoteId, duration_ms: Date.now() - t0 });
      return { quote: quote ?? null, quote_id: quoteId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_quote failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: create_site ───────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "create_site") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:create_site] node.user_id missing");
    try {
      const site = await SimproService.createSite(node.user_id, input);
      const siteId = site?.ID ?? site?.id ?? null;
      log.info("simpro create_site done", { nodeId: node.id, siteId, duration_ms: Date.now() - t0 });
      return { site: site ?? null, site_id: siteId, created_at: new Date().toISOString() };
    } catch (err: any) {
      log.error("simpro create_site failed", { nodeId: node.id, status: err?.response?.status, duration_ms: Date.now() - t0 });
      throw err;
    }
  }

  // ── Simpro: find_company_customer ─────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_company_customer") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_company_customer] node.user_id missing");
    const { create_if_not_found, ...searchCriteria } = input;
    const results = await SimproService.findRecords(node.user_id, "customers/companies/", searchCriteria);
    if (results.length > 0) {
      log.info("simpro find_company_customer found", { nodeId: node.id, customerId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, customer: results[0], customer_id: results[0]?.ID ?? null };
    }
    if (create_if_not_found) {
      const customer = await SimproService.createCustomer(node.user_id, { ...searchCriteria, customer_type: "company" });
      const customerId = customer?.ID ?? customer?.id ?? null;
      log.info("simpro find_company_customer created", { nodeId: node.id, customerId, duration_ms: Date.now() - t0 });
      return { found: false, created: true, customer, customer_id: customerId };
    }
    return { found: false, created: false, customer: null, customer_id: null };
  }

  // ── Simpro: find_individual_customer ──────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_individual_customer") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_individual_customer] node.user_id missing");
    const { create_if_not_found, ...searchCriteria } = input;
    const results = await SimproService.findRecords(node.user_id, "customers/individuals/", searchCriteria);
    if (results.length > 0) {
      log.info("simpro find_individual_customer found", { nodeId: node.id, customerId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, customer: results[0], customer_id: results[0]?.ID ?? null };
    }
    if (create_if_not_found) {
      const customer = await SimproService.createCustomer(node.user_id, { ...searchCriteria, customer_type: "individual" });
      const customerId = customer?.ID ?? customer?.id ?? null;
      log.info("simpro find_individual_customer created", { nodeId: node.id, customerId, duration_ms: Date.now() - t0 });
      return { found: false, created: true, customer, customer_id: customerId };
    }
    return { found: false, created: false, customer: null, customer_id: null };
  }

  // ── Simpro: find_contact ──────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_contact") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_contact] node.user_id missing");
    if (!input.customer_id) throw new Error("[Action:simpro:find_contact] required field 'customer_id' is empty");
    const { customer_id, create_if_not_found, ...searchCriteria } = input;
    const results = await SimproService.findRecords(node.user_id, `customers/${customer_id}/contacts/`, searchCriteria);
    if (results.length > 0) {
      log.info("simpro find_contact found", { nodeId: node.id, contactId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, contact: results[0], contact_id: results[0]?.ID ?? null };
    }
    if (create_if_not_found) {
      const contact = await SimproService.createContact(node.user_id, customer_id, searchCriteria);
      const contactId = contact?.ID ?? contact?.id ?? null;
      return { found: false, created: true, contact, contact_id: contactId };
    }
    return { found: false, created: false, contact: null, contact_id: null };
  }

  // ── Simpro: find_job ──────────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_job") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_job] node.user_id missing");
    const results = await SimproService.findRecords(node.user_id, "jobs/", input);
    if (results.length > 0) {
      log.info("simpro find_job found", { nodeId: node.id, jobId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, job: results[0], job_id: results[0]?.ID ?? null };
    }
    return { found: false, job: null, job_id: null };
  }

  // ── Simpro: find_quote ────────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_quote") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_quote] node.user_id missing");
    const { create_if_not_found, ...searchCriteria } = input;
    const results = await SimproService.findRecords(node.user_id, "quotes/", searchCriteria);
    if (results.length > 0) {
      log.info("simpro find_quote found", { nodeId: node.id, quoteId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, quote: results[0], quote_id: results[0]?.ID ?? null };
    }
    if (create_if_not_found) {
      const quote = await SimproService.createQuote(node.user_id, searchCriteria);
      const quoteId = quote?.ID ?? quote?.id ?? null;
      return { found: false, created: true, quote, quote_id: quoteId };
    }
    return { found: false, quote: null, quote_id: null };
  }

  // ── Simpro: find_schedule ─────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_schedule") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_schedule] node.user_id missing");
    const results = await SimproService.findRecords(node.user_id, "activitySchedules/", input);
    if (results.length > 0) {
      log.info("simpro find_schedule found", { nodeId: node.id, scheduleId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, schedule: results[0], schedule_id: results[0]?.ID ?? null };
    }
    return { found: false, schedule: null, schedule_id: null };
  }

  // ── Simpro: find_site ─────────────────────────────────────────────────────
  if (node.integration_key === "simpro" && node.action_key === "find_site") {
    const t0 = Date.now();
    if (!node.user_id) throw new Error("[Action:simpro:find_site] node.user_id missing");
    const { create_if_not_found, ...searchCriteria } = input;
    const results = await SimproService.findRecords(node.user_id, "sites/", searchCriteria);
    if (results.length > 0) {
      log.info("simpro find_site found", { nodeId: node.id, siteId: results[0]?.ID, duration_ms: Date.now() - t0 });
      return { found: true, site: results[0], site_id: results[0]?.ID ?? null };
    }
    if (create_if_not_found) {
      const site = await SimproService.createSite(node.user_id, searchCriteria);
      const siteId = site?.ID ?? site?.id ?? null;
      return { found: false, created: true, site, site_id: siteId };
    }
    return { found: false, site: null, site_id: null };
  }

  // ── Commusoft: create_client ────────────────────────────────────────────────
  if (node.integration_key === "commusoft" && node.action_key === "create_client") {
    const t0 = Date.now();
    log.info("commusoft create_client start", {
      nodeId: node.id,
      userId: node.user_id,
      customerType: input.customer_type ?? "",
      inputKeys: Object.keys(input),
    });

    if (!node.user_id) {
      log.error("node.user_id missing", { nodeId: node.id, action: "commusoft:create_client" });
      throw new Error("[Action:commusoft:create_client] node.user_id missing — cannot resolve Commusoft credentials");
    }
    if (!input.customer_type || !String(input.customer_type).trim()) {
      log.error("required field 'customer_type' is empty", { nodeId: node.id, action: "commusoft:create_client" });
      throw new Error("[Action:commusoft:create_client] required field 'customer_type' is empty");
    }

    const customerPayload: Record<string, any> = {};
    const droppedKeys: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null || String(value).trim() === "") {
        droppedKeys.push(key);
        continue;
      }
      customerPayload[key] = value;
    }
    if (droppedKeys.length > 0) {
      log.debug("commusoft create_client dropped empty fields", { nodeId: node.id, dropped: droppedKeys });
    }

    log.info("commusoft POST /customers", { nodeId: node.id, fields: Object.keys(customerPayload).length });

    let customer;
    try {
      customer = await CommusoftService.createCustomer(node.user_id, customerPayload);
    } catch (err: any) {
      log.error("commusoft create_client API failed", {
        nodeId: node.id,
        status: err?.response?.status,
        error: err?.message,
        duration_ms: Date.now() - t0,
      });
      throw err;
    }

    const customerId = customer?.id ?? customer?.customer_id ?? customer?.uuid;
    log.info("commusoft create_client done", {
      nodeId: node.id,
      customerId: customerId ?? "(unknown)",
      duration_ms: Date.now() - t0,
    });

    return {
      customer: customer ?? null,
      customer_id: customer?.id ?? customer?.customer_id ?? null,
      customer_uuid: customer?.uuid ?? null,
      created_at: new Date().toISOString(),
    };
  }

  // ── Commusoft: create_job ───────────────────────────────────────────────────
  if (node.integration_key === "commusoft" && node.action_key === "create_job") {
    log.info("commusoft create_job start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:commusoft:create_job] node.user_id missing — cannot resolve Commusoft credentials");
    }
    if (!input.customer_id && !input.customer_uuid && !input.customer_name && !input.email) {
      throw new Error("[Action:commusoft:create_job] one of 'customer_id', 'customer_uuid', 'customer_name', 'email' is required");
    }
    if (!input.description && !input.job_description) {
      throw new Error("[Action:commusoft:create_job] required field 'description' (or 'job_description') is empty");
    }

    const jobPayload: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      jobPayload[key] = value;
    }

    log.info("commusoft POST /jobs", { nodeId: node.id, fields: Object.keys(jobPayload) });
    const job = await CommusoftService.createJob(node.user_id, jobPayload);
    log.info("commusoft create_job done", { nodeId: node.id });

    return {
      job: job ?? null,
      created_at: new Date().toISOString(),
    };
  }

  // ── Commusoft: create_diary_event ──────────────────────────────────────────
  if (node.integration_key === "commusoft" && node.action_key === "create_diary_event") {
    log.info("commusoft create_diary_event start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:commusoft:create_diary_event] node.user_id missing — cannot resolve Commusoft credentials");
    }
    if (!input.event_type && !input.eventType) {
      throw new Error("[Action:commusoft:create_diary_event] required field 'event_type' is empty");
    }
    if (!input.description) {
      throw new Error("[Action:commusoft:create_diary_event] required field 'description' is empty");
    }
    if (!input.engineer_notes) {
      throw new Error("[Action:commusoft:create_diary_event] required field 'engineer_notes' is empty");
    }
    if (!input.event_start || !input.event_end) {
      throw new Error("[Action:commusoft:create_diary_event] fields 'event_start' and 'event_end' are required");
    }
    if (!input.resource_id && !input.resourceId) {
      throw new Error("[Action:commusoft:create_diary_event] required field 'resource_id' is empty");
    }

    const eventType = input.event_type ?? input.eventType;
    if (eventType === "job" && !input.job_id && !input.jobid) {
      throw new Error("[Action:commusoft:create_diary_event] field 'job_id' is required when event_type is job");
    }

    const diaryPayload: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      diaryPayload[key] = value;
    }

    log.info("commusoft POST /diary-events", { nodeId: node.id, fields: Object.keys(diaryPayload) });
    const diaryEvent = await CommusoftService.createDiaryEvent(node.user_id, diaryPayload);
    log.info("commusoft create_diary_event done", { nodeId: node.id });

    return {
      diary_event: diaryEvent ?? null,
      created_at: new Date().toISOString(),
    };
  }

  // ── Commusoft: create_opportunity ─────────────────────────────────────────
  if (node.integration_key === "commusoft" && node.action_key === "create_opportunity") {
    log.info("commusoft create_opportunity start", { nodeId: node.id, userId: node.user_id });

    if (!node.user_id) {
      throw new Error("[Action:commusoft:create_opportunity] node.user_id missing — cannot resolve Commusoft credentials");
    }
    if (!input.customer_id && !input.customer_uuid && !input.customer_name && !input.email) {
      throw new Error("[Action:commusoft:create_opportunity] one of 'customer_id', 'customer_uuid', 'customer_name', 'email' is required");
    }
    const opportunityPayload: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      opportunityPayload[key] = value;
    }

    log.info("commusoft POST /opportunities", { nodeId: node.id, fields: Object.keys(opportunityPayload) });
    const opportunity = await CommusoftService.createOpportunity(node.user_id, opportunityPayload);
    log.info("commusoft create_opportunity done", {
      nodeId: node.id,
      opportunityId: opportunity?.id ?? opportunity?.opportunity_id ?? opportunity?.opportunityId ?? null,
    });

    return {
      opportunity: opportunity ?? null,
      opportunity_id: opportunity?.id ?? opportunity?.opportunity_id ?? opportunity?.opportunityId ?? null,
      customer_id: opportunity?.customer_id ?? opportunityPayload.customer_id ?? null,
      created_at: new Date().toISOString(),
    };
  }

  // ── Unregistered handler — passthrough ───────────────────────────────────────
  log.warn("no handler registered — using passthrough", {
    integration: node.integration_key,
    action: node.action_key,
    nodeId: node.id,
  });
  return { ...input, executed_at: new Date().toISOString() };
}
