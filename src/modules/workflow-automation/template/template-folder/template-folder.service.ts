// template-folder.service.ts

import { supabase } from "../../../../config/db.config.js";

// ─── Integration status ───────────────────────────────────────────────────────

// Maps integration_key values (from workflow_template_nodes) to the DB table name.
const INTEGRATION_TABLES: Record<string, string> = {
  service_m8: "servicem8_integrations",
  commusoft: "commusoft_intigrations",   // note: intentional typo in table name
  leadshub: "leadshub_integrations",
  simpro: "simpro_integrations",
};

export interface IntegrationStatusItem {
  connected: boolean;
  needs_reauth?: boolean;
}
export type IntegrationStatusMap = Record<string, IntegrationStatusItem>;

/**
 * Returns which of the known integrations a given user has connected.
 * Only the integrations that are relevant to the provided list (or all if empty) are checked.
 */
export async function getUserIntegrationStatusService(
  userId: string,
  integrationKeys?: string[]
): Promise<IntegrationStatusMap> {
  const keysToCheck = integrationKeys?.length
    ? integrationKeys.filter((k) => k in INTEGRATION_TABLES)
    : Object.keys(INTEGRATION_TABLES);

  console.log(`[IntegrationStatus] userId=${userId} | checking keys:`, keysToCheck);

  const checks = await Promise.all(
    keysToCheck.map(async (key) => {
      const table = INTEGRATION_TABLES[key] as string;
      console.log(`[IntegrationStatus] querying table="${table}" for key="${key}" userId="${userId}"`);

      const { data, error } = await (supabase as any)
        .from(table)
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error(`[IntegrationStatus] ERROR table="${table}" key="${key}":`, error.message ?? error);
        return [key, { connected: false }] as const;
      }

      if (!data) {
        console.log(`[IntegrationStatus] NO ROW found in "${table}" for userId="${userId}" → not connected`);
        return [key, { connected: false }] as const;
      }

      console.log(`[IntegrationStatus] ROW found in "${table}":`, JSON.stringify(data));
      const needsReauth = (data as any).needs_reauth === true;
      console.log(`[IntegrationStatus] key="${key}" needs_reauth=${needsReauth} → connected=${!needsReauth}`);
      return [key, { connected: !needsReauth, needs_reauth: needsReauth }] as const;
    })
  );

  const result = Object.fromEntries(checks);
  console.log(`[IntegrationStatus] final result for userId="${userId}":`, JSON.stringify(result));
  return result;
}

/**
 * Returns the unique integration_keys required by active templates in a folder.
 */
export async function getRequiredIntegrationsService(
  folderId: string
): Promise<string[]> {
  // Step 1: get active template IDs in the folder
  const { data: templates, error: tErr } = await supabase
    .from("workflow_templates")
    .select("id, name")
    .eq("template_folder_id", folderId)
    .eq("status", "active");

  if (tErr) throw new Error(tErr.message);
  if (!templates?.length) return [];

  const templateIds = templates.map((t: any) => t.id);
  console.log(`[RequiredIntegrations] folderId=${folderId} | active templates:`, templates.map((t: any) => `${t.id}(${t.name})`));

  // Step 2: get ALL nodes (including null integration_key) so we can see what's there
  const { data: allNodes, error: allErr } = await supabase
    .from("workflow_template_nodes")
    .select("integration_key, type, name")
    .in("template_id", templateIds);

  console.log(`[RequiredIntegrations] ALL nodes in folder (${allNodes?.length ?? 0} total):`,
    JSON.stringify((allNodes ?? []).map((n: any) => ({ type: n.type, name: n.name, integration_key: n.integration_key }))));

  if (allErr) throw new Error(allErr.message);

  // Step 3: get unique non-null integration_keys
  const { data: nodes, error: nErr } = await supabase
    .from("workflow_template_nodes")
    .select("integration_key")
    .in("template_id", templateIds)
    .not("integration_key", "is", null)
    .neq("integration_key", "");

  if (nErr) throw new Error(nErr.message);

  const unique = [
    ...new Set((nodes ?? []).map((n: any) => n.integration_key).filter(Boolean)),
  ];

  console.log(`[RequiredIntegrations] unique integration_keys found:`, unique);
  return unique;
}
import { applyTemplateService } from "../template.service.js";
import type {
  BulkApplyFolderDTO,
  CreateTemplateFolderDTO,
  ListTemplateFoldersQuery,
  UpdateTemplateFolderDTO,
} from "./template-folder.dto.js";

export async function createTemplateFolderService(payload: CreateTemplateFolderDTO) {
  const { data, error } = await supabase
    .from("template_folders")
    .insert({
      name: payload.name,
      description: payload.description ?? null,
      parent_id: payload.parent_id ?? null,
      created_by: payload.created_by,
      is_public: payload.is_public ?? false,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function listTemplateFoldersService(query: ListTemplateFoldersQuery) {
  let q = supabase
    .from("template_folders")
    .select("*")
    .order("created_at", { ascending: true });

  if (query.created_by) q = q.eq("created_by", query.created_by);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function updateTemplateFolderService(id: string, payload: UpdateTemplateFolderDTO) {
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.description !== undefined) patch.description = payload.description;
  if (payload.parent_id !== undefined) patch.parent_id = payload.parent_id;
  if (payload.is_public !== undefined) patch.is_public = payload.is_public;

  if (Object.keys(patch).length === 1) throw new Error("No fields to update");

  const { data, error } = await supabase
    .from("template_folders")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function deleteTemplateFolderService(id: string) {
  // parent_id ON DELETE CASCADE handles subfolders automatically.
  // Templates in this folder get template_folder_id = NULL via ON DELETE SET NULL.
  const { error } = await supabase.from("template_folders").delete().eq("id", id);
  if (error) throw new Error(error.message);
  return { message: "Folder deleted successfully" };
}

export async function bulkApplyFolderService(folderId: string, payload: BulkApplyFolderDTO) {
  console.log(`[TemplateFolderService] Bulk apply | folder=${folderId} user=${payload.user_id}`);

  const { data: folder, error: folderErr } = await supabase
    .from("template_folders")
    .select("id, name")
    .eq("id", folderId)
    .single();

  if (folderErr) throw new Error(`Folder not found: ${folderErr.message}`);

  const { data: templates, error: tplErr } = await supabase
    .from("workflow_templates")
    .select("id, name, tag, status")
    .eq("template_folder_id", folderId)
    .eq("status", "active");

  if (tplErr) throw new Error(tplErr.message);
  if (!templates || templates.length === 0) {
    throw new Error("No active templates found in this folder");
  }

  const results: Array<{
    template_id: string;
    template_name: string;
    workflow_id: string;
    workflow_name: string;
    status: "draft" | "active" | "disabled";
    error?: string;
  }> = [];

  for (const tpl of templates) {
    try {
      const workflowName = payload.name_prefix
        ? `${payload.name_prefix} — ${tpl.name}`
        : tpl.name;

      const result = await applyTemplateService(tpl.id, {
        name: workflowName,
        user_id: payload.user_id,
        tag: tpl.tag ?? undefined,
      });

      results.push({
        template_id: tpl.id,
        template_name: tpl.name,
        workflow_id: result.workflow.id,
        workflow_name: result.workflow.name,
        status: result.workflow.status as "draft" | "active" | "disabled",
      });
    } catch (err: any) {
      results.push({
        template_id: tpl.id,
        template_name: tpl.name,
        workflow_id: "",
        workflow_name: "",
        status: "draft",
        error: err?.message ?? "Unknown error",
      });
    }
  }

  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => !!r.error).length;

  console.log(
    `[TemplateFolderService] Bulk apply done | folder=${folderId} succeeded=${succeeded} failed=${failed}`
  );

  return {
    folder_id: folderId,
    folder_name: folder.name,
    total: templates.length,
    succeeded,
    failed,
    results,
  };
}
