import { supabase } from "../../../../config/db.config.js";
import {
  CreateFolderDTO,
  UpdateFolderDTO,
  ReorderFoldersDTO,
} from "./folder.dto.js";

export async function createFolderService(payload: CreateFolderDTO) {
  const insertRow: Record<string, unknown> = {
    name: payload.name,
    user_id: payload.user_id,
    parent_id: payload.parent_id ?? null,
  };
  if (typeof payload.position === "number") {
    insertRow.position = payload.position;
  }

  const { data, error } = await supabase
    .from("workflow_folders")
    .insert(insertRow)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function getFoldersByUserService(userId: string, role?: string) {
  let query = supabase
    .from("workflow_folders")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: false });

  if (role !== "admin") {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);
  return data;
}

export async function updateFolderService(id: string, payload: UpdateFolderDTO) {
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof payload.name === "string") patch.name = payload.name;
  if (payload.parent_id !== undefined) patch.parent_id = payload.parent_id;
  if (typeof payload.position === "number") patch.position = payload.position;

  if (payload.parent_id !== undefined && payload.parent_id !== null) {
    if (payload.parent_id === id) {
      throw new Error("A folder cannot be its own parent");
    }
    const descendantIds = await collectDescendantIds(id);
    if (descendantIds.has(payload.parent_id)) {
      throw new Error("Cannot move a folder into one of its own descendants");
    }
  }

  const { data, error } = await supabase
    .from("workflow_folders")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function deleteFolderService(id: string) {
  const { error } = await supabase
    .from("workflow_folders")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  return { message: "Folder deleted successfully" };
}

export async function reorderFoldersService(payload: ReorderFoldersDTO) {
  const updates = payload.items.map((item) =>
    supabase
      .from("workflow_folders")
      .update({
        parent_id: item.parent_id,
        position: item.position,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id)
  );

  const results = await Promise.all(updates);
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);
  return { message: "Folders reordered successfully" };
}

async function collectDescendantIds(rootId: string): Promise<Set<string>> {
  const descendants = new Set<string>();
  const queue: string[] = [rootId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const { data, error } = await supabase
      .from("workflow_folders")
      .select("id")
      .eq("parent_id", current);

    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (!descendants.has(row.id)) {
        descendants.add(row.id);
        queue.push(row.id);
      }
    }
  }
  return descendants;
}
