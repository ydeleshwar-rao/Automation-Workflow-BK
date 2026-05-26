import { supabase } from "../../../config/db.config.js";
import { executeWorkflow } from "../processor/webhookProcessor.js";

export async function triggerWorkflowExecutionService(
  workflowId: string,
  clientId: string,
  triggerData: Record<string, any>
) {
  // Start execution async — does not block the HTTP response
  executeWorkflow(workflowId,triggerData).catch(console.error);
  return { workflow_id: workflowId, status: "started" };
}

export async function getExecutionsByWorkflowService(workflowId: string) {
  const { data, error } = await supabase
    .from("workflow_executions")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data;
}

export async function getExecutionByIdService(executionId: string) {
  const { data, error } = await supabase
    .from("workflow_executions")
    .select("*")
    .eq("id", executionId)
    .single();

  if (error) throw new Error(error.message);
  return data;
}