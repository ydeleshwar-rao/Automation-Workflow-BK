// workflow.service.ts

import { supabase } from "../../../config/db.config.js";
import {
  CreateWorkflowDTO,
  UpdateWorkflowDTO,
  BulkMoveWorkflowsDTO,
  ReorderWorkflowsDTO,
} from "./workflow.dto.js";
import { workflowLogger as log } from "../../../utils/logger.js";


export async function createWorkflowService(
  payload: CreateWorkflowDTO
) {
  const insertRow: Record<string, unknown> = {
    name: payload.name,
    tag: payload.tag || null,
    user_id: payload.user_id,
    status: "draft",
    folder_id: payload.folder_id ?? null,
  };
  if (typeof payload.position === "number") {
    insertRow.position = payload.position;
  }

  const { data, error } = await supabase
    .from("workflows")
    .insert(insertRow)
    .select()
    .single();

  if (error) throw new Error(error.message);

  log.info("workflow created", { workflowId: data.id, name: data.name, userId: data.user_id, status: data.status });
  return data;
}

export async function getWorkflowByIdService(id: string) {
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function getWorkflowsService(userId: string) {
  const { data, error } = await supabase
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return enrichWithOwnerNames(data ?? []);
}

async function enrichWithOwnerNames(workflows: any[]): Promise<any[]> {
  const ids = [...new Set(workflows.map((w) => w.user_id).filter(Boolean))];
  if (!ids.length) return workflows;

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, first_name, last_name")
    .in("id", ids);

  const nameMap = new Map(
    (profiles ?? []).map((p: any) => [
      p.id,
      [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
    ])
  );

  return workflows.map((w) => ({ ...w, owner_name: nameMap.get(w.user_id) ?? null }));
}

export async function updateWorkflowService(
  id: string,
  payload: UpdateWorkflowDTO
) {
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof payload.name === "string") patch.name = payload.name;
  if (typeof payload.tag === "string") patch.tag = payload.tag;
  if (typeof payload.status === "string") patch.status = payload.status;
  if (payload.folder_id !== undefined) patch.folder_id = payload.folder_id;
  if (typeof payload.position === "number") patch.position = payload.position;
  if (payload.last_edited_by) {
    patch.last_edited_by = payload.last_edited_by;
    patch.last_edited_at = new Date().toISOString();
  }
  if (payload.last_edited_by_name) patch.last_edited_by_name = payload.last_edited_by_name;

  const { data, error } = await supabase
    .from("workflows")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  log.info("workflow updated", {
    workflowId: id,
    fields: Object.keys(patch).filter((k) => k !== "updated_at" && k !== "last_edited_at"),
    status: payload.status ?? undefined,
  });

  if (payload.status === "active") {
    log.info("workflow status → active, reactivating polling subscriptions", { workflowId: id });
    // Reactivate subscriptions and reset poll timestamp so next tick fires immediately
    await supabase
      .from("polling_subscriptions")
      .update({
        is_active: true,
        last_polled_at: null,
        error_count: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("workflow_id", id);
  } else if (payload.status === "paused") {
    log.info("workflow status → paused, deactivating polling subscriptions", { workflowId: id });
    await supabase
      .from("polling_subscriptions")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("workflow_id", id);
  }

  return data;
}

export async function deleteWorkflowService(id: string) {
  const { error } = await supabase
    .from("workflows")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);

  log.info("workflow deleted", { workflowId: id });
  return { message: "Workflow deleted successfully" };
}

export async function activateWorkflowService(
  id: string
) {
  const { data, error } = await supabase
    .from("workflows")
    .update({
      status: "active",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  log.info("workflow activated", { workflowId: id });

  // Activate polling subscriptions and reset poll timestamp so the next tick fires immediately
  await supabase
    .from("polling_subscriptions")
    .update({
      is_active: true,
      last_polled_at: null,
      error_count: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workflow_id", id);

  return data;
}

export async function bulkMoveWorkflowsService(payload: BulkMoveWorkflowsDTO) {
  if (!payload.ids.length) return { message: "No workflows to move" };

  const { error } = await supabase
    .from("workflows")
    .update({
      folder_id: payload.folder_id,
      updated_at: new Date().toISOString(),
    })
    .in("id", payload.ids);

  if (error) throw new Error(error.message);
  log.info("workflows bulk moved", { ids: payload.ids, folderId: payload.folder_id });
  return { message: "Workflows moved successfully" };
}

export async function reorderWorkflowsService(payload: ReorderWorkflowsDTO) {
  const updates = payload.items.map((item) =>
    supabase
      .from("workflows")
      .update({
        folder_id: item.folder_id,
        position: item.position,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id)
  );

  const results = await Promise.all(updates);
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);
  log.info("workflows reordered", { count: payload.items.length });
  return { message: "Workflows reordered successfully" };
}
