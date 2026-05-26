// template.service.ts

import { supabase } from "../../../config/db.config.js";
import {
  ApplyTemplateDTO,
  CreateTemplateFromWorkflowDTO,
  ListTemplatesQuery,
  UpdateTemplateDTO,
} from "./template.dto.js";

// ---------- credential stripping ----------

// Keys whose presence in a node `config` indicates a client-owned credential.
// On template creation these are removed from config_schema and recorded in
// required_credentials so the apply step knows what to prompt for.
const CREDENTIAL_KEYS = [
  "smtp_id",
  "webhook_id",
  "credential_id",
  "connection_id",
  "auth_id",
];

const SECRET_KEY_PATTERNS = [/_token$/i, /_secret$/i, /_key$/i, /password/i];

function isCredentialKey(key: string): boolean {
  if (CREDENTIAL_KEYS.includes(key)) return true;
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function stripCredentials(config: Record<string, any> | null | undefined): {
  config_schema: Record<string, any>;
  required_credentials: Array<{ type: string; field: string }>;
} {
  const source = config ?? {};
  const required: Array<{ type: string; field: string }> = [];
  const clean: Record<string, any> = {};

  for (const [key, value] of Object.entries(source)) {
    if (isCredentialKey(key)) {
      required.push({ type: key.replace(/_id$/, ""), field: key });
    } else {
      clean[key] = value;
    }
  }

  return { config_schema: clean, required_credentials: required };
}

// ---------- create template from an existing workflow ----------

export async function createTemplateFromWorkflowService(
  payload: CreateTemplateFromWorkflowDTO
) {
  console.log(
    `[TemplateService] Creating template from workflow | source=${payload.source_workflow_id} name=${payload.name}`
  );

  // 1. Verify source workflow exists
  const { data: sourceWf, error: wfErr } = await supabase
    .from("workflows")
    .select("id, tag")
    .eq("id", payload.source_workflow_id)
    .single();

  if (wfErr) throw new Error(`Source workflow not found: ${wfErr.message}`);

  // 2. Fetch source nodes
  const { data: sourceNodes, error: nodesErr } = await supabase
    .from("workflow_nodes")
    .select("*")
    .eq("workflow_id", payload.source_workflow_id)
    .order("position", { ascending: true });

  if (nodesErr) throw new Error(nodesErr.message);
  if (!sourceNodes || sourceNodes.length === 0) {
    throw new Error("Source workflow has no nodes to template");
  }

  // 3. Fetch source mappings (one row per node)
  const nodeIds = sourceNodes.map((n) => n.id);
  const { data: sourceMappings, error: mapErr } = await supabase
    .from("workflow_field_mappings")
    .select("*")
    .in("workflow_node_id", nodeIds);

  if (mapErr) throw new Error(mapErr.message);

  // 4. Insert template row
  const { data: template, error: tplErr } = await supabase
    .from("workflow_templates")
    .insert({
      name: payload.name,
      description: payload.description ?? null,
      category: payload.category ?? null,
      tag: payload.tag ?? sourceWf.tag ?? null,
      source_workflow_id: payload.source_workflow_id,
      created_by: payload.created_by,
      is_public: payload.is_public ?? false,
      status: "active",
    })
    .select()
    .single();

  if (tplErr) throw new Error(tplErr.message);

  // 5. Insert template nodes; build old_node_id -> template_node_id map
  const nodeIdMap: Record<string, string> = {};
  const templateNodeRows: any[] = [];

  for (const node of sourceNodes) {
    const { config_schema, required_credentials } = stripCredentials(node.config);

    const { data: tNode, error: tNodeErr } = await supabase
      .from("workflow_template_nodes")
      .insert({
        template_id: template.id,
        type: node.type,
        node_category: node.node_category ?? node.type,
        integration_key: node.integration_key,
        action_key: node.action_key ?? null,
        config_schema,
        required_credentials,
        output_schema: node.output_schema ?? {},
        position: node.position,
      })
      .select()
      .single();

    if (tNodeErr) {
      await supabase.from("workflow_templates").delete().eq("id", template.id);
      throw new Error(`Failed to create template node: ${tNodeErr.message}`);
    }

    nodeIdMap[node.id] = tNode.id;
    templateNodeRows.push(tNode);
  }

  // 6. Insert template mappings — rewrite source_node_id -> source_template_node_id
  for (const row of sourceMappings ?? []) {
    const templateNodeId = nodeIdMap[row.workflow_node_id];
    if (!templateNodeId) continue;

    const rewritten = (row.mappings ?? []).map((m: any) => ({
      mapping_type: m.mapping_type,
      destination_field: m.destination_field,
      source_template_node_id: m.source_node_id ? nodeIdMap[m.source_node_id] ?? null : null,
      source_field: m.source_field ?? null,
      static_value: m.static_value ?? null,
      transformation: m.transformation ?? null,
    }));

    const { error: tMapErr } = await supabase.from("workflow_template_mappings").insert({
      template_id: template.id,
      template_node_id: templateNodeId,
      mappings: rewritten,
    });

    if (tMapErr) {
      await supabase.from("workflow_templates").delete().eq("id", template.id);
      throw new Error(`Failed to create template mapping: ${tMapErr.message}`);
    }
  }

  console.log(`[TemplateService] Template created | id=${template.id} nodes=${templateNodeRows.length}`);
  return { ...template, nodes: templateNodeRows };
}

// ---------- list ----------

export async function listTemplatesService(filters: ListTemplatesQuery) {
  let query = supabase
    .from("workflow_templates")
    .select("*")
    .order("created_at", { ascending: false });

  if (filters.created_by) query = query.eq("created_by", filters.created_by);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.status) query = query.eq("status", filters.status);

  if (filters.template_folder_id) query = query.eq("template_folder_id", filters.template_folder_id);

  if (filters.is_public !== undefined) {
    const boolVal =
      typeof filters.is_public === "string"
        ? filters.is_public === "true"
        : filters.is_public;
    query = query.eq("is_public", boolVal);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

// ---------- get by id (full detail) ----------

export async function getTemplateByIdService(id: string) {
  const { data: template, error: tErr } = await supabase
    .from("workflow_templates")
    .select("*")
    .eq("id", id)
    .single();

  if (tErr) throw new Error(tErr.message);

  const { data: nodes, error: nErr } = await supabase
    .from("workflow_template_nodes")
    .select("*")
    .eq("template_id", id)
    .order("position", { ascending: true });

  if (nErr) throw new Error(nErr.message);

  const { data: mappings, error: mErr } = await supabase
    .from("workflow_template_mappings")
    .select("*")
    .eq("template_id", id);

  if (mErr) throw new Error(mErr.message);

  return { ...template, nodes: nodes ?? [], mappings: mappings ?? [] };
}

// ---------- update (name, description, status, etc.) ----------

export async function updateTemplateService(id: string, payload: UpdateTemplateDTO) {
  const updates: Record<string, any> = {};
  if (payload.name !== undefined) updates.name = payload.name;
  if (payload.description !== undefined) updates.description = payload.description;
  if (payload.category !== undefined) updates.category = payload.category;
  if (payload.tag !== undefined) updates.tag = payload.tag;
  if (payload.is_public !== undefined) updates.is_public = payload.is_public;
  if (payload.status !== undefined) updates.status = payload.status;
  if (payload.template_folder_id !== undefined) updates.template_folder_id = payload.template_folder_id;

  if (Object.keys(updates).length === 0) {
    throw new Error("No fields to update");
  }

  const { data, error } = await supabase
    .from("workflow_templates")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

// ---------- delete ----------

export async function deleteTemplateService(id: string) {
  const { error } = await supabase.from("workflow_templates").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return { message: "Template deleted successfully" };
}

// ---------- apply template -> create new workflow ----------

export async function applyTemplateService(templateId: string, payload: ApplyTemplateDTO) {
  console.log(`[TemplateService] Applying template | template=${templateId} user=${payload.user_id}`);

  // 1. Load template, nodes, mappings
  const { data: template, error: tErr } = await supabase
    .from("workflow_templates")
    .select("*")
    .eq("id", templateId)
    .single();

  if (tErr) throw new Error(`Template not found: ${tErr.message}`);
  if (template.status !== "active") throw new Error("Template is not active");

  const { data: tNodes, error: nErr } = await supabase
    .from("workflow_template_nodes")
    .select("*")
    .eq("template_id", templateId)
    .order("position", { ascending: true });

  if (nErr) throw new Error(nErr.message);
  if (!tNodes || tNodes.length === 0) throw new Error("Template has no nodes");

  const { data: tMappings, error: mErr } = await supabase
    .from("workflow_template_mappings")
    .select("*")
    .eq("template_id", templateId);

  if (mErr) throw new Error(mErr.message);

  // 2. Create new workflow
  const { data: newWf, error: wfErr } = await supabase
    .from("workflows")
    .insert({
      name: payload.name,
      tag: payload.tag ?? template.tag ?? null,
      user_id: payload.user_id,
      status: "draft",
    })
    .select()
    .single();

  if (wfErr) throw new Error(wfErr.message);

  // 3. Create nodes; map template_node_id -> new_node_id
  const overrides = payload.credential_overrides ?? {};
  const nodeIdMap: Record<string, string> = {};

  for (const tNode of tNodes) {
    const nodeOverrides = overrides[tNode.id] ?? {};
    const mergedConfig = { ...(tNode.config_schema ?? {}), ...nodeOverrides };

    const { data: newNode, error: nInsErr } = await supabase
      .from("workflow_nodes")
      .insert({
        workflow_id: newWf.id,
        integration_key: tNode.integration_key,
        type: tNode.type,
        node_category: tNode.node_category ?? tNode.type,
        action_key: tNode.action_key,
        config: mergedConfig,
        sample_payload: {},
        output_schema: tNode.output_schema ?? {},
        position: tNode.position,
      })
      .select()
      .single();

    if (nInsErr) {
      await supabase.from("workflows").delete().eq("id", newWf.id);
      throw new Error(`Failed to create node during apply: ${nInsErr.message}`);
    }

    nodeIdMap[tNode.id] = newNode.id;
  }

  // 4. Create mappings — rewrite source_template_node_id -> new source_node_id
  for (const row of tMappings ?? []) {
    const newNodeId = nodeIdMap[row.template_node_id];
    if (!newNodeId) continue;

    const rewritten = (row.mappings ?? []).map((m: any) => ({
      mapping_type: m.mapping_type,
      destination_field: m.destination_field,
      source_node_id: m.source_template_node_id ? nodeIdMap[m.source_template_node_id] ?? null : null,
      source_field: m.source_field ?? null,
      static_value: m.static_value ?? null,
      transformation: m.transformation ?? null,
    }));

    const { error: mInsErr } = await supabase.from("workflow_field_mappings").insert({
      workflow_node_id: newNodeId,
      mappings: rewritten,
    });

    if (mInsErr) {
      await supabase.from("workflows").delete().eq("id", newWf.id);
      throw new Error(`Failed to create mapping during apply: ${mInsErr.message}`);
    }
  }

  // 5. Bump usage_count
  await supabase
    .from("workflow_templates")
    .update({ usage_count: (template.usage_count ?? 0) + 1 })
    .eq("id", templateId);

  console.log(`[TemplateService] Applied | template=${templateId} workflow=${newWf.id}`);
  return { workflow: newWf, nodes_created: Object.keys(nodeIdMap).length };
}
