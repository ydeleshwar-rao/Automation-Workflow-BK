// ai-workflow.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Business-logic layer for the AI Visual Workflow builder.
// All persistence is via the Supabase client (same pattern as workflow.service.ts).

import { supabase } from "../../config/db.config.js";
import {
  CreateAiWorkflowDTO,
  UpdateAiWorkflowDTO,
  CreateExecutionDTO,
  UpdateExecutionDTO,
} from "./ai-workflow.dto.js";

// ── Workflows ─────────────────────────────────────────────────────────────────

export async function createAiWorkflowService(payload: CreateAiWorkflowDTO) {
  const { data, error } = await supabase
    .from("ai_workflows")
    .insert({
      user_id: payload.user_id,
      name: payload.name ?? "Untitled Workflow",
      description: payload.description ?? null,
      status: "draft",
      nodes: [],
      edges: [],
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function getAiWorkflowsService(userId: string) {
  const { data, error } = await supabase
    .from("ai_workflows")
    .select("id, name, description, status, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getAiWorkflowByIdService(id: string) {
  const { data, error } = await supabase
    .from("ai_workflows")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function updateAiWorkflowService(
  id: string,
  patch: UpdateAiWorkflowDTO
) {
  const { data, error } = await supabase
    .from("ai_workflows")
    .update({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.nodes !== undefined && { nodes: patch.nodes }),
      ...(patch.edges !== undefined && { edges: patch.edges }),
      ...(patch.viewport !== undefined && { viewport: patch.viewport }),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function deleteAiWorkflowService(id: string) {
  const { error } = await supabase
    .from("ai_workflows")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
  return { id };
}

// ── Executions ────────────────────────────────────────────────────────────────

export async function createExecutionService(payload: CreateExecutionDTO) {
  const { data, error } = await supabase
    .from("ai_workflow_executions")
    .insert({
      workflow_id: payload.workflow_id,
      trigger: payload.trigger ?? "manual",
      status: "pending",
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function getExecutionsService(workflowId: string) {
  const { data, error } = await supabase
    .from("ai_workflow_executions")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function updateExecutionService(
  id: string,
  patch: UpdateExecutionDTO
) {
  const { data, error } = await supabase
    .from("ai_workflow_executions")
    .update({
      ...(patch.status && { status: patch.status }),
      ...(patch.node_results && { node_results: patch.node_results }),
      ...(patch.error && { error: patch.error }),
      ...(patch.finished_at && { finished_at: patch.finished_at }),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}
