import { supabase } from "../../../../config/db.config.js";
import { CreateWorkflowTagDTO, UpdateWorkflowTagDTO } from "./workflow-tags.dto.js";

// ─── Tag CRUD ───

export async function createTagService(payload: CreateWorkflowTagDTO) {
  const { data, error } = await supabase
    .from("workflow_tags")
    .insert({
      name: payload.name,
      color: payload.color || null,
      user_id: payload.user_id,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function getTagsByUserService(userId: string, role?: string) {
  let query = supabase
    .from("workflow_tags")
    .select("*")
    .order("created_at", { ascending: false });

  if (role !== "admin") {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);
  return data;
}

export async function updateTagService(id: string, payload: UpdateWorkflowTagDTO) {
  const { data, error } = await supabase
    .from("workflow_tags")
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function deleteTagService(id: string) {
  // junction rows deleted automatically via ON DELETE CASCADE
  const { error } = await supabase
    .from("workflow_tags")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  return { message: "Tag deleted successfully" };
}

// ─── Workflow ↔ Tag linking ───

export async function addTagToWorkflowService(workflowId: string, tagId: string) {
  const { data, error } = await supabase
    .from("workflow_tag_links")
    .insert({ workflow_id: workflowId, tag_id: tagId })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function removeTagFromWorkflowService(workflowId: string, tagId: string) {
  const { error } = await supabase
    .from("workflow_tag_links")
    .delete()
    .eq("workflow_id", workflowId)
    .eq("tag_id", tagId);

  if (error) throw new Error(error.message);
  return { message: "Tag removed from workflow" };
}

export async function getTagsByWorkflowService(workflowId: string) {
  const { data, error } = await supabase
    .from("workflow_tag_links")
    .select("tag_id, workflow_tags(*)")
    .eq("workflow_id", workflowId);

  if (error) throw new Error(error.message);
  return data;
}

export async function getWorkflowsByTagService(tagId: string) {
  const { data, error } = await supabase
    .from("workflow_tag_links")
    .select("workflow_id, workflows(*)")
    .eq("tag_id", tagId);

  if (error) throw new Error(error.message);
  return data;
}
